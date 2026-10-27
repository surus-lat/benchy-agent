import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "@benchy/db";
import { createAdminApp, type AdminDeps } from "../src/admin";
import type { CurrentUser } from "../src/conversations";

// The admin panel: cross-org management restricted to the surus org. The
// cardinal rule is the gate: nobody outside org_4eb2a44fdc5ef17b reaches any
// /api/admin/* route, whatever the method.

const db = drizzle(env.DB, { schema });

const ADMIN_ORG = "org_4eb2a44fdc5ef17b";
const surus: CurrentUser = { id: "user_surus", name: "Surus Admin", email: "admin@surus.lat", orgId: ADMIN_ORG };
const ana: CurrentUser = { id: "user_ana", name: "Ana Pérez", email: "ana@uni.edu", orgId: "org_uni" };
const orphan: CurrentUser = { id: "user_orphan", name: "", email: "o@x.edu", orgId: null };

function makeApp(): ReturnType<typeof createAdminApp> {
  const deps: AdminDeps = {
    db,
    async currentUser(request) {
      const who = request.headers.get("x-test-user");
      return [surus, ana, orphan].find((u) => u.id === who) ?? null;
    },
  };
  return createAdminApp(deps);
}

function req(app: ReturnType<typeof makeApp>, method: string, path: string, user?: CurrentUser, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = user.id;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

type OrgRow = {
  id: string;
  name: string;
  slug: string;
  domains: string[];
  endpoint: { baseUrl: string; apiKeyRef: string } | null;
  userCount: number;
};

beforeEach(async () => {
  await db.delete(schema.invites);
  await db.delete(schema.accessRequests);
  await db.delete(schema.activity);
  await db.delete(schema.user);
  await db.delete(schema.orgDomains);
  await db.delete(schema.orgAgentEndpoints);
  await db.delete(schema.orgs);
  const now = new Date();
  await db.insert(schema.orgs).values([
    { id: ADMIN_ORG, name: "SURUS", slug: "surus", createdAt: now },
    { id: "org_uni", name: "Uni", slug: "uni", createdAt: now },
  ]);
  for (const u of [surus, ana, orphan]) {
    await db.insert(schema.user).values({ id: u.id, name: u.name, email: u.email, orgId: u.orgId, createdAt: now, updatedAt: now });
  }
});

it("gates every route to the surus org", async () => {
  const app = makeApp();
  // Unauthenticated.
  expect((await req(app, "GET", "/api/admin/orgs")).status).toBe(401);
  // Another org's member.
  expect((await req(app, "GET", "/api/admin/orgs", ana)).status).toBe(403);
  expect((await req(app, "POST", "/api/admin/orgs", ana, { name: "X", slug: "x" })).status).toBe(403);
  expect((await req(app, "GET", "/api/admin/users", ana)).status).toBe(403);
  expect((await req(app, "GET", "/api/admin/invites", ana)).status).toBe(403);
  expect((await req(app, "GET", "/api/admin/access-requests", ana)).status).toBe(403);
  expect((await req(app, "GET", "/api/admin/activity", ana)).status).toBe(403);
  // No org at all.
  expect((await req(app, "GET", "/api/admin/orgs", orphan)).status).toBe(403);
  // Surus passes.
  expect((await req(app, "GET", "/api/admin/orgs", surus)).status).toBe(200);
});

it("creates an org and lists orgs with domains, endpoint, and user count", async () => {
  const app = makeApp();
  const created = await req(app, "POST", "/api/admin/orgs", surus, { name: "Nueva", slug: "nueva" });
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  expect(id).toMatch(/^org_[0-9a-f]{16}$/);

  // Bad bodies are rejected.
  expect((await req(app, "POST", "/api/admin/orgs", surus, { name: "", slug: "x" })).status).toBe(400);
  expect((await req(app, "POST", "/api/admin/orgs", surus, { name: "X", slug: "NO SPACES" })).status).toBe(400);

  const list = (await (await req(app, "GET", "/api/admin/orgs", surus)).json()) as { orgs: OrgRow[] };
  expect(list.orgs.length).toBe(3);
  const uni = list.orgs.find((o) => o.id === "org_uni")!;
  expect(uni.userCount).toBe(1);
  expect(uni.domains).toEqual([]);
  expect(uni.endpoint).toBeNull();
});

it("patches an org's name, slug, and branding", async () => {
  const app = makeApp();
  const res = await req(app, "PATCH", "/api/admin/orgs/org_uni", surus, {
    name: "Universidad",
    brandColor: "#1a2b3c",
    brandTagline: "Ciencia",
  });
  expect(res.status).toBe(200);
  const list = (await (await req(app, "GET", "/api/admin/orgs", surus)).json()) as { orgs: OrgRow[] };
  const uni = list.orgs.find((o) => o.id === "org_uni")!;
  expect(uni.name).toBe("Universidad");
  expect(uni.slug).toBe("uni");

  expect((await req(app, "PATCH", "/api/admin/orgs/org_missing", surus, { name: "X" })).status).toBe(404);
  expect((await req(app, "PATCH", "/api/admin/orgs/org_uni", surus, {})).status).toBe(400);
  expect((await req(app, "PATCH", "/api/admin/orgs/org_uni", surus, { brandColor: "red" })).status).toBe(400);
});

it("manages an org's domains", async () => {
  const app = makeApp();
  expect((await req(app, "POST", "/api/admin/orgs/org_uni/domains", surus, { domain: "UNI.EDU.AR" })).status).toBe(201);

  const list = (await (await req(app, "GET", "/api/admin/orgs/org_uni/domains", surus)).json()) as { domains: { domain: string }[] };
  expect(list.domains.map((d) => d.domain)).toEqual(["uni.edu.ar"]); // lowercased

  // Adding the same domain again is a no-op, not an error.
  expect((await req(app, "POST", "/api/admin/orgs/org_uni/domains", surus, { domain: "uni.edu.ar" })).status).toBe(201);

  expect((await req(app, "DELETE", "/api/admin/orgs/org_uni/domains/uni.edu.ar", surus)).status).toBe(200);
  expect((await req(app, "DELETE", "/api/admin/orgs/org_uni/domains/uni.edu.ar", surus)).status).toBe(404);
});

it("sets and reads an org's agent endpoint", async () => {
  const app = makeApp();
  const before = (await (await req(app, "GET", "/api/admin/orgs/org_uni/endpoint", surus)).json()) as { endpoint: null };
  expect(before.endpoint).toBeNull();

  const put = await req(app, "PUT", "/api/admin/orgs/org_uni/endpoint", surus, {
    baseUrl: "https://agent.uni.edu",
    apiKeyRef: "AGENT_KEY_UNI",
  });
  expect(put.status).toBe(200);

  const after = (await (await req(app, "GET", "/api/admin/orgs/org_uni/endpoint", surus)).json()) as {
    endpoint: { baseUrl: string; apiKeyRef: string };
  };
  expect(after.endpoint.baseUrl).toBe("https://agent.uni.edu");
  expect(after.endpoint.apiKeyRef).toBe("AGENT_KEY_UNI");

  // PUT again updates in place (one row per org).
  await req(app, "PUT", "/api/admin/orgs/org_uni/endpoint", surus, { baseUrl: "https://a2.uni.edu", apiKeyRef: "AGENT_KEY_UNI2" });
  const updated = (await (await req(app, "GET", "/api/admin/orgs/org_uni/endpoint", surus)).json()) as {
    endpoint: { baseUrl: string };
  };
  expect(updated.endpoint.baseUrl).toBe("https://a2.uni.edu");
  expect((await db.select().from(schema.orgAgentEndpoints)).length).toBe(1);

  expect((await req(app, "PUT", "/api/admin/orgs/org_uni/endpoint", surus, { baseUrl: "not-a-url", apiKeyRef: "K" })).status).toBe(400);
});

it("lists all users with their org name", async () => {
  const app = makeApp();
  const { users } = (await (await req(app, "GET", "/api/admin/users", surus)).json()) as {
    users: { id: string; email: string; orgName: string | null }[];
  };
  expect(users.length).toBe(3);
  expect(users.find((u) => u.id === "user_ana")!.orgName).toBe("Uni");
  expect(users.find((u) => u.id === "user_orphan")!.orgName).toBeNull();
});

it("creates and lists invites", async () => {
  const app = makeApp();
  const created = await req(app, "POST", "/api/admin/invites", surus, { orgId: "org_uni", email: "New@Uni.edu", expiresInDays: 14 });
  expect(created.status).toBe(201);
  const invite = (await created.json()) as { id: string; email: string; token: string; expiresAt: string };
  expect(invite.id).toMatch(/^inv_[0-9a-f]{16}$/);
  expect(invite.email).toBe("new@uni.edu"); // lowercased
  expect(invite.token.length).toBe(36); // uuid

  const { invites } = (await (await req(app, "GET", "/api/admin/invites", surus)).json()) as {
    invites: { email: string; orgName: string; status: string }[];
  };
  expect(invites.length).toBe(1);
  expect(invites[0].orgName).toBe("Uni");
  expect(invites[0].status).toBe("pending");

  expect((await req(app, "POST", "/api/admin/invites", surus, { orgId: "org_uni", email: "not-an-email" })).status).toBe(400);
});

it("lists access requests and updates their status", async () => {
  const now = new Date();
  await db.insert(schema.accessRequests).values({
    id: "ar_1",
    orgName: "Colegio",
    email: "dir@colegio.edu",
    name: "Director",
    message: null,
    status: "pending",
    createdAt: now,
  });
  const app = makeApp();
  const { accessRequests } = (await (await req(app, "GET", "/api/admin/access-requests", surus)).json()) as {
    accessRequests: { id: string; status: string }[];
  };
  expect(accessRequests.length).toBe(1);
  expect(accessRequests[0].status).toBe("pending");

  expect((await req(app, "PATCH", "/api/admin/access-requests/ar_1", surus, { status: "invited" })).status).toBe(200);
  const after = (await (await req(app, "GET", "/api/admin/access-requests", surus)).json()) as {
    accessRequests: { status: string }[];
  };
  expect(after.accessRequests[0].status).toBe("invited");

  expect((await req(app, "PATCH", "/api/admin/access-requests/ar_1", surus, { status: "pending" })).status).toBe(400);
  expect((await req(app, "PATCH", "/api/admin/access-requests/ar_x", surus, { status: "invited" })).status).toBe(404);
});

it("lists activity across all orgs with org names", async () => {
  const now = new Date();
  await db.insert(schema.activity).values([
    { id: "act_1", orgId: "org_uni", userId: "user_ana", who: "Ana Pérez", bench: "b1", kind: "create", detail: "creó b1", createdAt: now },
    { id: "act_2", orgId: ADMIN_ORG, userId: "user_surus", who: "Surus Admin", bench: null, kind: "evaluate", detail: "evaluó", createdAt: now },
  ]);
  const app = makeApp();
  const { activity } = (await (await req(app, "GET", "/api/admin/activity", surus)).json()) as {
    activity: { id: string; orgName: string; detail: string }[];
  };
  expect(activity.length).toBe(2);
  expect(activity.find((a) => a.id === "act_1")!.orgName).toBe("Uni");
  expect(activity.find((a) => a.id === "act_2")!.orgName).toBe("SURUS");
});
