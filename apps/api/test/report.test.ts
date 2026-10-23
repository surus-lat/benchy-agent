import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { schema } from "@benchy/db";
import { createConversationsApp, type CurrentUser } from "../src/conversations";
import type { HermesClient } from "../src/hermes";

// The findings report the platform shows and exports: the edit made by hand
// (benchReportEdits) when there is one, else the report.md the agent writes in
// the workspace — which is never written from these routes. Hermes is a fake
// that serves a generated report.md for the bench "qa" and records its calls.

const db = drizzle(env.DB, { schema });

const ana: CurrentUser = { id: "user_ana", name: "Ana Pérez", email: "ana@uni.edu", orgId: "org_uni" };
const ceci: CurrentUser = { id: "user_ceci", name: "Ceci Ruiz", email: "ceci@otra.edu", orgId: "org_otra" };
const orphan: CurrentUser = { id: "user_orphan", name: "", email: "o@x.edu", orgId: null };

const GENERATED = "# Informe generado\n\nLo escribió el agente.\n";
// Saved edits go through the schema's trim (like every text input in the app).
const EDITED = "# Informe editado\n\nLo tocó Ana a mano.";
const MODIFIED = 1_700_000_000;

type Call = { op: string; args: unknown[] };

function fakeHermes() {
  const calls: Call[] = [];
  let generated: string | null = GENERATED;
  const client: HermesClient = {
    async createSession() {
      return "hermes_1";
    },
    async chat() {
      return { reply: "ok", usage: {} };
    },
    async listFiles() {
      return { files: [], truncated: false };
    },
    async validate(path) {
      return { ok: true, path };
    },
    async exam(path) {
      return { ok: true, total: 0, rows: [] };
    },
    async analysis(path) {
      return { ok: true, models: [], questions: [] };
    },
    async models() {
      return { provider: "bedrock", models: [] };
    },
    async writeFile(path) {
      calls.push({ op: "writeFile", args: [path] });
      return { status: "ok", path, modified: 1 };
    },
    async review() {
      return { ok: true, rows: [] };
    },
    async quality() {
      return { ok: true, rows: [] };
    },
    async addSource() {
      return { ok: false, error: { code: "no", message: "no" } };
    },
    async uploadSource() {
      return { ok: false, error: { code: "no", message: "no" } };
    },
    async removeSource() {
      return { ok: true };
    },
    async backup() {
      return new ArrayBuffer(0);
    },
    async evaluation(path) {
      return { ok: true, evaluation: null, path };
    },
    async startEvaluation() {
      return { status: "started", body: { ok: true } };
    },
    async startReport() {
      return { status: "started", body: { ok: true } };
    },
    async readFile(path) {
      calls.push({ op: "readFile", args: [path] });
      if (path === "qa/report.md" && generated !== null) {
        return { path, size: generated.length, modified: MODIFIED, truncated: false, content: generated };
      }
      return null;
    },
  };
  return {
    client,
    calls,
    regenerate(text: string | null) {
      generated = text;
    },
  };
}

function makeApp(hermes: HermesClient | null) {
  return createConversationsApp({
    db,
    async currentUser(request) {
      const who = request.headers.get("x-test-user");
      return [ana, ceci, orphan].find((u) => u.id === who) ?? null;
    },
    async agentFor() {
      return hermes;
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

type Report = { bench: string; source: "edited" | "generated" | null; markdown: string | null; updatedAt: string | null };

beforeEach(async () => {
  // Saving or dropping an edit logs activity rows that point at the org.
  await db.delete(schema.activity);
  await db.delete(schema.benchReportEdits);
  await db.delete(schema.user);
  await db.delete(schema.orgs);
  const now = new Date();
  await db.insert(schema.orgs).values([
    { id: "org_uni", name: "Uni", slug: "uni", createdAt: now },
    { id: "org_otra", name: "Otra", slug: "otra", createdAt: now },
  ]);
  for (const u of [ana, ceci, orphan]) {
    await db.insert(schema.user).values({ id: u.id, name: u.name, email: u.email, orgId: u.orgId, createdAt: now, updatedAt: now });
  }
});

it("requires auth and a valid bench, and says when there is no report at all", async () => {
  const hermes = fakeHermes();
  const app = makeApp(hermes.client);
  expect((await req(app, "GET", "/api/workspace/report?bench=qa")).status).toBe(401);
  expect((await req(app, "PUT", "/api/workspace/report", undefined, { bench: "qa", markdown: EDITED })).status).toBe(401);
  expect((await req(app, "GET", "/api/workspace/report?bench=qa", orphan)).status).toBe(403);
  expect((await req(app, "PUT", "/api/workspace/report", orphan, { bench: "qa", markdown: EDITED })).status).toBe(403);

  expect((await req(app, "GET", "/api/workspace/report", ana)).status).toBe(400);
  expect((await req(app, "GET", "/api/workspace/report?bench=../etc", ana)).status).toBe(400);
  expect((await req(app, "PUT", "/api/workspace/report", ana, { bench: "a/b", markdown: EDITED })).status).toBe(400);
  expect((await req(app, "PUT", "/api/workspace/report", ana, { bench: "qa" })).status).toBe(400);
  expect((await req(app, "PUT", "/api/workspace/report", ana, { bench: "qa", markdown: 5 })).status).toBe(400);
  expect((await req(app, "PUT", "/api/workspace/report", ana, { bench: "qa", markdown: "   " })).status).toBe(400);
  expect((await req(app, "PUT", "/api/workspace/report", ana, { bench: "qa", markdown: "x".repeat(100_001) })).status).toBe(400);

  // The bench has no report.md in the workspace: nothing to show.
  const res = await req(app, "GET", "/api/workspace/report?bench=sin-reporte", ana);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ bench: "sin-reporte", source: null, markdown: null, updatedAt: null });
});

it("serves the generated report when there is no edit, and the edit wins once saved", async () => {
  const hermes = fakeHermes();
  const app = makeApp(hermes.client);

  // No edit: the workspace's report.md, marked as generated.
  const gen = (await (await req(app, "GET", "/api/workspace/report?bench=qa", ana)).json()) as Report;
  expect(gen).toMatchObject({ bench: "qa", source: "generated", markdown: GENERATED });
  expect(gen.updatedAt).toBe(new Date(MODIFIED * 1000).toISOString());

  // Saving the hand edit persists it keyed by org and bench.
  const put = await req(app, "PUT", "/api/workspace/report", ana, { bench: "qa", markdown: EDITED });
  expect(put.status).toBe(200);
  expect(await put.json()).toMatchObject({ bench: "qa", source: "edited", markdown: EDITED });
  const [row] = await db.select().from(schema.benchReportEdits);
  expect(row).toMatchObject({ orgId: "org_uni", bench: "qa", markdown: EDITED });

  // The edit takes precedence over the generated report.
  const eff = (await (await req(app, "GET", "/api/workspace/report?bench=qa", ana)).json()) as Report;
  expect(eff).toMatchObject({ source: "edited", markdown: EDITED });

  // Even if the agent rewrites report.md, the edit keeps winning, and the
  // workspace file was never touched from these routes.
  hermes.regenerate("# Informe rehecho\n\nEl agente lo rehizo.\n");
  const after = (await (await req(app, "GET", "/api/workspace/report?bench=qa", ana)).json()) as Report;
  expect(after).toMatchObject({ source: "edited", markdown: EDITED });
  expect(hermes.calls.filter((c) => c.op === "writeFile")).toHaveLength(0);

  // Saving again overwrites: only the latest edit is kept.
  const AGAIN = "# Informe editado, segunda vuelta";
  expect((await req(app, "PUT", "/api/workspace/report", ana, { bench: "qa", markdown: AGAIN })).status).toBe(200);
  expect(await db.select().from(schema.benchReportEdits)).toHaveLength(1);
  expect(((await (await req(app, "GET", "/api/workspace/report?bench=qa", ana)).json()) as Report).markdown).toBe(AGAIN);

  // Dropping the edit shows the generated report again.
  expect((await req(app, "PUT", "/api/workspace/report", ana, { bench: "qa", markdown: null })).status).toBe(200);
  expect(await db.select().from(schema.benchReportEdits)).toHaveLength(0);
  const back = (await (await req(app, "GET", "/api/workspace/report?bench=qa", ana)).json()) as Report;
  expect(back).toMatchObject({ source: "generated", markdown: "# Informe rehecho\n\nEl agente lo rehizo.\n" });
});

it("keeps each org's edit its own: another org never reads it", async () => {
  const hermes = fakeHermes();
  const app = makeApp(hermes.client);

  await req(app, "PUT", "/api/workspace/report", ana, { bench: "qa", markdown: EDITED });

  // Ceci's org has no edit for the same bench: she gets the generated one.
  const ceciSees = (await (await req(app, "GET", "/api/workspace/report?bench=qa", ceci)).json()) as Report;
  expect(ceciSees).toMatchObject({ source: "generated", markdown: GENERATED });

  // Her own edit lives beside Ana's, each keyed to its org.
  const CECI_EDIT = "# Informe de Ceci";
  await req(app, "PUT", "/api/workspace/report", ceci, { bench: "qa", markdown: CECI_EDIT });
  expect(await db.select().from(schema.benchReportEdits)).toHaveLength(2);
  const rows = await db.select().from(schema.benchReportEdits).where(and(eq(schema.benchReportEdits.bench, "qa")));
  expect(new Set(rows.map((r) => r.orgId))).toEqual(new Set(["org_uni", "org_otra"]));
  expect(((await (await req(app, "GET", "/api/workspace/report?bench=qa", ana)).json()) as Report).markdown).toBe(EDITED);
  expect(((await (await req(app, "GET", "/api/workspace/report?bench=qa", ceci)).json()) as Report).markdown).toBe(CECI_EDIT);

  // Dropping Ceci's edit leaves Ana's untouched.
  await req(app, "PUT", "/api/workspace/report", ceci, { bench: "qa", markdown: null });
  const left = await db.select().from(schema.benchReportEdits);
  expect(left).toHaveLength(1);
  expect(left[0]).toMatchObject({ orgId: "org_uni", markdown: EDITED });
});
