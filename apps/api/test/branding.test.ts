import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { schema } from "@benchy/db";
import { createConversationsApp, type CurrentUser } from "../src/conversations";
import type { HermesClient } from "../src/hermes";

// The org's visual identity (issue #5): PATCH /api/org/branding stores a hex
// accent color and a short tagline on the caller's org row, and /api/me hands
// them back for the letterhead and the publication card.

const db = drizzle(env.DB, { schema });

const ana: CurrentUser = { id: "user_ana", name: "Ana Pérez", email: "ana@uni.edu", orgId: "org_uni" };
const ceci: CurrentUser = { id: "user_ceci", name: "Ceci Ruiz", email: "ceci@otra.edu", orgId: "org_otra" };

function makeApp() {
  return createConversationsApp({
    db,
    async currentUser(request) {
      const who = request.headers.get("x-test-user");
      return [ana, ceci].find((u) => u.id === who) ?? null;
    },
    async agentFor() {
      return null as HermesClient | null;
    },
    async paper() {
      return null;
    },
  });
}

function req(app: ReturnType<typeof makeApp>, method: string, path: string, user?: CurrentUser, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = user.id;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function brand(orgId: string) {
  const [org] = await db.select({ brandColor: schema.orgs.brandColor, brandColorSecondary: schema.orgs.brandColorSecondary, brandTagline: schema.orgs.brandTagline, brandLogoUrl: schema.orgs.brandLogoUrl }).from(schema.orgs).where(eq(schema.orgs.id, orgId)).limit(1);
  return org;
}

beforeEach(async () => {
  await db.delete(schema.activity);
  await db.delete(schema.user);
  await db.delete(schema.orgs);
  const now = new Date();
  await db.insert(schema.orgs).values([
    { id: "org_uni", name: "Uni", slug: "uni", createdAt: now },
    { id: "org_otra", name: "Otra", slug: "otra", createdAt: now },
  ]);
  for (const u of [ana, ceci]) {
    await db.insert(schema.user).values({ id: u.id, name: u.name, email: u.email, orgId: u.orgId, createdAt: now, updatedAt: now });
  }
});

it("requires a session", async () => {
  const app = makeApp();
  expect((await req(app, "PATCH", "/api/org/branding", undefined, { color: "#1e6fd9", tagline: null })).status).toBe(401);
});

it("saves the brand on the caller's org and returns it on /api/me", async () => {
  const app = makeApp();
  const res = await req(app, "PATCH", "/api/org/branding", ana, { color: "#1E6FD9", tagline: "Ciencia para la política pública" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ color: "#1E6FD9", colorSecondary: null, tagline: "Ciencia para la política pública", logoUrl: null });
  expect(await brand("org_uni")).toEqual({ brandColor: "#1E6FD9", brandColorSecondary: null, brandTagline: "Ciencia para la política pública", brandLogoUrl: null });

  const me = await (await req(app, "GET", "/api/me", ana)).json();
  expect(me.org).toMatchObject({ id: "org_uni", brandColor: "#1E6FD9", brandTagline: "Ciencia para la política pública" });
});

it("accepts null to clear the identity", async () => {
  const app = makeApp();
  await req(app, "PATCH", "/api/org/branding", ana, { color: "#0f766e", tagline: "bajada" });
  const res = await req(app, "PATCH", "/api/org/branding", ana, { color: null, tagline: null });
  expect(res.status).toBe(200);
  expect(await brand("org_uni")).toEqual({ brandColor: null, brandColorSecondary: null, brandTagline: null, brandLogoUrl: null });
});

it("rejects malformed colors and overlong taglines", async () => {
  const app = makeApp();
  for (const body of [
    { color: "red", tagline: null },
    { color: "#12g456", tagline: null },
    { color: "#12345", tagline: null },
    { color: "#1e6fd9", tagline: "x".repeat(121) },
    { color: "#1e6fd9" }, // tagline missing
    null,
  ]) {
    const res = await req(app, "PATCH", "/api/org/branding", ana, body);
    expect(res.status, JSON.stringify(body)).toBe(400);
  }
  expect(await brand("org_uni")).toEqual({ brandColor: null, brandColorSecondary: null, brandTagline: null, brandLogoUrl: null });
});

it("never touches another org's row", async () => {
  const app = makeApp();
  await req(app, "PATCH", "/api/org/branding", ana, { color: "#1e6fd9", tagline: "de Uni" });
  await req(app, "PATCH", "/api/org/branding", ceci, { color: "#ff0000", tagline: "de Otra" });
  expect(await brand("org_uni")).toEqual({ brandColor: "#1e6fd9", brandColorSecondary: null, brandTagline: "de Uni", brandLogoUrl: null });
  expect(await brand("org_otra")).toEqual({ brandColor: "#ff0000", brandColorSecondary: null, brandTagline: "de Otra", brandLogoUrl: null });
});

it("records the change in the org's activity", async () => {
  const app = makeApp();
  await req(app, "PATCH", "/api/org/branding", ana, { color: "#1e6fd9", tagline: null });
  const rows = await db.select({ kind: schema.activity.kind, who: schema.activity.who }).from(schema.activity).where(eq(schema.activity.orgId, "org_uni"));
  expect(rows.some((r) => r.kind === "org" && r.who === "Ana Pérez")).toBe(true);
});


it("rejects non-http(s) logo URLs", async () => {
  const app = makeApp();
  for (const logoUrl of ["javascript:alert(1)", "ftp://x/y.png", "data:image/svg+xml;base64,PHN2Zy8+"]) {
    const res = await req(app, "PATCH", "/api/org/branding", ana, { color: "#1e6fd9", tagline: null, logoUrl });
    expect(res.status, `logoUrl=${logoUrl}`).toBe(400);
  }
  // http and https must pass
  const res = await req(app, "PATCH", "/api/org/branding", ana, { color: "#1e6fd9", tagline: null, logoUrl: "https://cdn.example.com/logo.png" });
  expect(res.status).toBe(200);
});

it("rejects colors with extreme luminance (too light or too dark)", async () => {
  const app = makeApp();
  // White-ish: should fail
  const r1 = await req(app, "PATCH", "/api/org/branding", ana, { color: "#ffffff", tagline: null });
  expect(r1.status).toBe(400);
  const b1 = await r1.json();
  expect(b1.error).toBe("COLOR_LOW_CONTRAST");

  // Near-black: should fail
  const r2 = await req(app, "PATCH", "/api/org/branding", ana, { color: "#020202", tagline: null });
  expect(r2.status).toBe(400);

  // Light yellow: should fail
  const r3 = await req(app, "PATCH", "/api/org/branding", ana, { color: "#ffffcc", tagline: null });
  expect(r3.status).toBe(400);

  // Reasonable color: should pass
  const r4 = await req(app, "PATCH", "/api/org/branding", ana, { color: "#1e6fd9", tagline: null });
  expect(r4.status).toBe(200);

  // Secondary color luminance also checked
  const r5 = await req(app, "PATCH", "/api/org/branding", ana, { color: "#1e6fd9", tagline: null, colorSecondary: "#ffffff" });
  expect(r5.status).toBe(400);
});