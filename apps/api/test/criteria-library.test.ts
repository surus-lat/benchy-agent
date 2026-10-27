import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "@benchy/db";
import { createCriteriaLibraryApp, type CriteriaLibraryDeps } from "../src/library-criteria";
import type { CurrentUser } from "../src/conversations";

// The org's library of reusable evaluation criteria (issue #12): CRUD over
// /api/criteria. The cardinal rule is asserted throughout: org A never sees,
// edits, or deletes org B's criteria, and nobody without an org reaches the
// routes at all.

const db = drizzle(env.DB, { schema });

const ana: CurrentUser = { id: "user_ana", name: "Ana Pérez", email: "ana@uni.edu", orgId: "org_uni" };
const ceci: CurrentUser = { id: "user_ceci", name: "Ceci Ruiz", email: "ceci@otra.edu", orgId: "org_otra" };
// A second member of org_uni: the library is org-wide, not per-user.
const ana2: CurrentUser = { id: "user_ana2", name: "Ana Segunda", email: "ana2@uni.edu", orgId: "org_uni" };
const orphan: CurrentUser = { id: "user_orphan", name: "", email: "o@x.edu", orgId: null };

function makeApp(): ReturnType<typeof createCriteriaLibraryApp> {
  const deps: CriteriaLibraryDeps = {
    db,
    async currentUser(request) {
      const who = request.headers.get("x-test-user");
      return [ana, ana2, ceci, orphan].find((u) => u.id === who) ?? null;
    },
  };
  return createCriteriaLibraryApp(deps);
}

function req(app: ReturnType<typeof makeApp>, method: string, path: string, user?: CurrentUser, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = user.id;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const CRITERION = {
  name: "Precisión conceptual",
  description: "Menciona los conceptos clave del campo con precisión.",
  weight: 3,
  levels: { "0": "No lo cumple", "1": "Lo cumple" },
};

type Criterion = {
  id: string;
  name: string;
  description: string;
  weight: number;
  levels: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

beforeEach(async () => {
  await db.delete(schema.benchCriteriaLibrary);
  await db.delete(schema.activity);
  await db.delete(schema.user);
  await db.delete(schema.orgDomains);
  await db.delete(schema.orgAgentEndpoints);
  await db.delete(schema.orgs);
  const now = new Date();
  await db.insert(schema.orgs).values([
    { id: "org_uni", name: "Uni", slug: "uni", createdAt: now },
    { id: "org_otra", name: "Otra", slug: "otra", createdAt: now },
  ]);
  for (const u of [ana, ana2, ceci, orphan]) {
    await db.insert(schema.user).values({ id: u.id, name: u.name, email: u.email, orgId: u.orgId, createdAt: now, updatedAt: now });
  }
});

it("requires auth and an org", async () => {
  const app = makeApp();
  expect((await req(app, "GET", "/api/criteria")).status).toBe(401);
  expect((await req(app, "POST", "/api/criteria", undefined, CRITERION)).status).toBe(401);
  expect((await req(app, "GET", "/api/criteria", orphan)).status).toBe(403);
  expect((await req(app, "PATCH", "/api/criteria/crit_x", orphan, { name: "x" })).status).toBe(403);
  expect((await req(app, "DELETE", "/api/criteria/crit_x", orphan)).status).toBe(403);
});

it("creates and lists the org's criteria", async () => {
  const app = makeApp();
  const created = await req(app, "POST", "/api/criteria", ana, CRITERION);
  expect(created.status).toBe(201);
  const { criterion } = (await created.json()) as { criterion: Criterion };
  expect(criterion.id).toMatch(/^crit_[0-9a-f]{20}$/);
  expect(criterion).toMatchObject({ ...CRITERION });
  expect(Number.isFinite(Date.parse(criterion.createdAt))).toBe(true);

  const list = (await (await req(app, "GET", "/api/criteria", ana)).json()) as { criteria: Criterion[] };
  expect(list.criteria.length).toBe(1);
  expect(list.criteria[0].id).toBe(criterion.id);

  // The org's other members see the same library.
  const list2 = (await (await req(app, "GET", "/api/criteria", ana2)).json()) as { criteria: Criterion[] };
  expect(list2.criteria.map((x) => x.id)).toEqual([criterion.id]);
});

it("rejects bodies that are not a criterion", async () => {
  const app = makeApp();
  for (const body of [
    null,
    {},
    { ...CRITERION, name: "" },
    { ...CRITERION, description: "   " },
    { ...CRITERION, weight: 0 },
    { ...CRITERION, weight: 6 },
    { ...CRITERION, weight: 2.5 },
    { ...CRITERION, levels: {} },
    { ...CRITERION, levels: { "-1": "mal" } },
    { ...CRITERION, levels: { "0": "" } },
    "nope",
  ]) {
    expect((await req(app, "POST", "/api/criteria", ana, body)).status).toBe(400);
  }
  expect((await db.select().from(schema.benchCriteriaLibrary)).length).toBe(0);
});

it("patches one field at a time within the org", async () => {
  const app = makeApp();
  const created = ((await (await req(app, "POST", "/api/criteria", ana, CRITERION)).json()) as { criterion: Criterion }).criterion;
  const res = await req(app, "PATCH", `/api/criteria/${created.id}`, ana, { weight: 5 });
  expect(res.status).toBe(200);
  const { criterion } = (await res.json()) as { criterion: Criterion };
  expect(criterion.weight).toBe(5);
  expect(criterion.name).toBe(CRITERION.name);

  const patched = (await (await req(app, "GET", "/api/criteria", ana)).json()) as { criteria: Criterion[] };
  expect(patched.criteria[0].weight).toBe(5);

  // An invalid patch changes nothing.
  expect((await req(app, "PATCH", `/api/criteria/${created.id}`, ana, { weight: 9 })).status).toBe(400);
  const still = (await (await req(app, "GET", "/api/criteria", ana)).json()) as { criteria: Criterion[] };
  expect(still.criteria[0].weight).toBe(5);
});

it("never crosses orgs: read, patch, or delete", async () => {
  const app = makeApp();
  const created = ((await (await req(app, "POST", "/api/criteria", ana, CRITERION)).json()) as { criterion: Criterion }).criterion;

  // Ceci (org_otra) has her own empty library.
  const list = (await (await req(app, "GET", "/api/criteria", ceci)).json()) as { criteria: Criterion[] };
  expect(list.criteria).toEqual([]);

  // She cannot edit or delete Ana's criterion: the (orgId, id) pair misses.
  expect((await req(app, "PATCH", `/api/criteria/${created.id}`, ceci, { name: "robada" })).status).toBe(404);
  expect((await req(app, "DELETE", `/api/criteria/${created.id}`, ceci)).status).toBe(200);

  // Ana's row is untouched, and Ana's delete of her own works.
  const uni = (await (await req(app, "GET", "/api/criteria", ana)).json()) as { criteria: Criterion[] };
  expect(uni.criteria.length).toBe(1);
  expect(uni.criteria[0].name).toBe(CRITERION.name);
  expect((await req(app, "DELETE", `/api/criteria/${created.id}`, ana)).status).toBe(200);
  const after = (await (await req(app, "GET", "/api/criteria", ana)).json()) as { criteria: Criterion[] };
  expect(after.criteria).toEqual([]);
});

it("deleting an unknown id is ok, patching it is 404", async () => {
  const app = makeApp();
  expect((await req(app, "DELETE", "/api/criteria/crit_missing", ana)).status).toBe(200);
  expect((await req(app, "PATCH", "/api/criteria/crit_missing", ana, { name: "x" })).status).toBe(404);
});
