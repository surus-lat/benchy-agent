import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { schema } from "@benchy/db";
import { createConversationsApp, type CurrentUser } from "../src/conversations";
import type { HermesClient, Source } from "../src/hermes";
import type { Paper } from "../src/library";

// Deleting a benchmark (DELETE /api/workspace/benchmark?bench=…): the agent
// removes the workspace folder (exam, sources, runs, report) and, when that
// succeeds, the Worker drops the org's rows about it (source validations,
// report edits, judge override) and logs the deletion. Another org's rows —
// and this org's rows for other benchmarks — stay. When the agent refuses
// (no such benchmark) nothing is deleted.

const db = drizzle(env.DB, { schema });

const ana: CurrentUser = { id: "user_ana", name: "Ana Pérez", email: "ana@uni.edu", orgId: "org_uni" };
const ceci: CurrentUser = { id: "user_ceci", name: "Ceci Ruiz", email: "ceci@otra.edu", orgId: "org_otra" };
const orphan: CurrentUser = { id: "user_orphan", name: "", email: "o@x.edu", orgId: null };

function source(id: string): Source {
  return {
    id,
    origin: id.startsWith("pdf-") ? "upload" : "conicet",
    title: `Paper ${id}`,
    authors: ["Pérez, Juan"],
    year: 2020,
    url: "https://x",
    pdf_url: "https://x/pdf",
    file: `${id}.md`,
    pages: 10,
    chars: 5000,
    text: "full",
    added: 1_700_000_000,
  };
}

function fakeHermes(opts: { ok?: boolean } = {}): { client: HermesClient; deleted: string[] } {
  const deleted: string[] = [];
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
      return { status: "ok", path, modified: 1 };
    },
    async review() {
      return { ok: true, rows: [] };
    },
    async quality() {
      return { ok: true, rows: [] };
    },
    async addSource(bench, paper: Paper) {
      return { ok: true as const, source: source(`${paper.origin}-${paper.id}`) };
    },
    async uploadSource() {
      return { ok: true as const, source: source("pdf-9f8e7d") };
    },
    async removeSource() {
      return { ok: true };
    },
    async removeQuestion(bench, q) {
      deleted.push(`${bench}#${q}`);
      return opts.ok === false
        ? { ok: false as const, error: { code: "bench_not_found", message: "no such benchmark" } }
        : { ok: true as const };
    },
    async removeBenchmark(bench) {
      deleted.push(bench);
      return opts.ok === false
        ? { ok: false as const, error: { code: "bench_not_found", message: "no such benchmark" } }
        : { ok: true as const };
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
    async readFile() {
      return null;
    },
  };
  return { client, deleted };
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

function req(app: ReturnType<typeof makeApp>, method: string, path: string, user?: CurrentUser) {
  const headers: Record<string, string> = {};
  if (user) headers["x-test-user"] = user.id;
  return app.request(path, { method, headers });
}

beforeEach(async () => {
  await db.delete(schema.activity);
  await db.delete(schema.sourceValidations);
  await db.delete(schema.benchReportEdits);
  await db.delete(schema.benchJudgeOverrides);
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

// Rows for org_uni's "qa" and "otro" benchmarks, and org_otra's "qa".
async function seed() {
  const now = new Date();
  for (const [orgId, bench] of [
    ["org_uni", "qa"],
    ["org_uni", "otro"],
    ["org_otra", "qa"],
  ] as const) {
    await db.insert(schema.sourceValidations).values({ orgId, bench, sourceId: "conicet-42", checked: "[]", updatedAt: now });
    await db.insert(schema.benchReportEdits).values({ orgId, bench, markdown: "# informe", updatedAt: now });
    await db.insert(schema.benchJudgeOverrides).values({ orgId, bench, judgeModel: "claude-opus", updatedAt: now });
  }
}

async function counts(): Promise<{ validations: number; edits: number; judges: number }> {
  return {
    validations: (await db.select().from(schema.sourceValidations)).length,
    edits: (await db.select().from(schema.benchReportEdits)).length,
    judges: (await db.select().from(schema.benchJudgeOverrides)).length,
  };
}

it("requires auth and a valid bench slug", async () => {
  const app = makeApp(fakeHermes().client);
  expect((await req(app, "DELETE", "/api/workspace/benchmark?bench=qa")).status).toBe(401);
  expect((await req(app, "DELETE", "/api/workspace/benchmark?bench=qa", orphan)).status).toBe(403);
  expect((await req(app, "DELETE", "/api/workspace/benchmark", ana)).status).toBe(400);
  expect((await req(app, "DELETE", "/api/workspace/benchmark?bench=../etc", ana)).status).toBe(400);
  expect((await req(app, "DELETE", "/api/workspace/benchmark?bench=a/b", ana)).status).toBe(400);
});

it("answers 503 when the org has no agent yet", async () => {
  const app = makeApp(null);
  expect((await req(app, "DELETE", "/api/workspace/benchmark?bench=qa", ana)).status).toBe(503);
});

it("deletes the org's rows for that benchmark only, and logs the deletion", async () => {
  await seed();
  const hermes = fakeHermes();
  const app = makeApp(hermes.client);

  const res = await req(app, "DELETE", "/api/workspace/benchmark?bench=qa", ana);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(hermes.deleted).toEqual(["qa"]);

  // org_uni's "qa" rows are gone; "otro" and org_otra's "qa" stay.
  expect(await counts()).toEqual({ validations: 2, edits: 2, judges: 2 });
  const remaining = await db.select().from(schema.sourceValidations).where(eq(schema.sourceValidations.bench, "qa"));
  expect(remaining.map((r) => r.orgId)).toEqual(["org_otra"]);

  const rows = await db.select().from(schema.activity).where(eq(schema.activity.orgId, "org_uni"));
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ bench: "qa", kind: "delete", userId: "user_ana", who: "Ana Pérez" });
});

it("deletes nothing when the agent refuses (no such benchmark)", async () => {
  await seed();
  const app = makeApp(fakeHermes({ ok: false }).client);

  const res = await req(app, "DELETE", "/api/workspace/benchmark?bench=qa", ana);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; error?: { code: string } };
  expect(body.ok).toBe(false);
  expect(body.error?.code).toBe("bench_not_found");

  expect(await counts()).toEqual({ validations: 3, edits: 3, judges: 3 });
  expect((await db.select().from(schema.activity)).length).toBe(0);
});
