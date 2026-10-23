import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { schema } from "@benchy/db";
import { createConversationsApp, type CurrentUser } from "../src/conversations";
import type { HermesClient } from "../src/hermes";

// The org's judge model config: the org's default (orgs.judgeModel), a
// benchmark's override (benchJudgeOverrides), and which judge an evaluation
// starts with — the override, else the org's default, else none (the container
// keeps the benchmark's own scoring.grader). Hermes is a fake that records the
// judge it is told to run with.

const db = drizzle(env.DB, { schema });

const ana: CurrentUser = { id: "user_ana", name: "Ana Pérez", email: "ana@uni.edu", orgId: "org_uni" };
const ceci: CurrentUser = { id: "user_ceci", name: "Ceci Ruiz", email: "ceci@otra.edu", orgId: "org_otra" };
const orphan: CurrentUser = { id: "user_orphan", name: "", email: "o@x.edu", orgId: null };

const ORG_JUDGE = "zai.glm-5";
const BENCH_JUDGE = "qwen.qwen3-32b-v1:0";

type Call = { op: string; args: unknown[] };

function fakeHermes() {
  const calls: Call[] = [];
  const client: HermesClient = {
    async createSession(userId) {
      calls.push({ op: "createSession", args: [userId] });
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
      return { provider: "bedrock", models: ["us.moonshotai.kimi-k3", ORG_JUDGE, BENCH_JUDGE] };
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
      calls.push({ op: "evaluation", args: [path] });
      return { ok: true, evaluation: null };
    },
    async startEvaluation(path, models, graderModel) {
      calls.push({ op: "startEvaluation", args: [path, models, graderModel] });
      return { status: "started", body: { ok: true, evaluation: { state: "running", models: models.map((m) => ({ model: m, state: "pending" })) } } };
    },
    async startReport() {
      return { status: "started", body: { ok: true, evaluation: { state: "reporting" } } };
    },
    async readFile() {
      return null;
    },
  };
  return { client, calls };
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

type Judge = { override: string | null; orgDefault: string | null; effective: string | null; source: string };

beforeEach(async () => {
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

it("keeps the org's default judge, scoped to the org", async () => {
  const app = makeApp(fakeHermes().client);
  expect((await req(app, "GET", "/api/org/judge")).status).toBe(401);
  expect((await req(app, "PUT", "/api/org/judge", undefined, { judgeModel: ORG_JUDGE })).status).toBe(401);
  expect((await req(app, "GET", "/api/org/judge", orphan)).status).toBe(403);
  expect((await req(app, "PUT", "/api/org/judge", orphan, { judgeModel: ORG_JUDGE })).status).toBe(403);

  // No config yet: no judge, the benchmark's own grader judges.
  expect(await (await req(app, "GET", "/api/org/judge", ana)).json()).toEqual({ judgeModel: null });

  expect((await req(app, "PUT", "/api/org/judge", ana, { judgeModel: ORG_JUDGE })).status).toBe(200);
  const [row] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, "org_uni"));
  expect(row.judgeModel).toBe(ORG_JUDGE);
  expect(await (await req(app, "GET", "/api/org/judge", ana)).json()).toEqual({ judgeModel: ORG_JUDGE });

  // Bad bodies are refused; null clears the setting again.
  expect((await req(app, "PUT", "/api/org/judge", ana, { judgeModel: "" })).status).toBe(400);
  expect((await req(app, "PUT", "/api/org/judge", ana, { judgeModel: 5 })).status).toBe(400);
  expect((await req(app, "PUT", "/api/org/judge", ana, {})).status).toBe(400);
  expect((await req(app, "PUT", "/api/org/judge", ana, { judgeModel: "x".repeat(101) })).status).toBe(400);
  expect((await req(app, "PUT", "/api/org/judge", ana, { judgeModel: null })).status).toBe(200);
  expect(await (await req(app, "GET", "/api/org/judge", ana)).json()).toEqual({ judgeModel: null });

  // Another org never sees it.
  await req(app, "PUT", "/api/org/judge", ana, { judgeModel: ORG_JUDGE });
  expect(await (await req(app, "GET", "/api/org/judge", ceci)).json()).toEqual({ judgeModel: null });
});

it("keeps a benchmark's judge override, scoped to the org, and clears it by deleting its row", async () => {
  const app = makeApp(fakeHermes().client);
  expect((await req(app, "GET", "/api/workspace/judge?bench=qa")).status).toBe(401);
  expect((await req(app, "GET", "/api/workspace/judge?bench=qa", orphan)).status).toBe(403);
  expect((await req(app, "GET", "/api/workspace/judge", ana)).status).toBe(400);
  expect((await req(app, "GET", "/api/workspace/judge?bench=../etc", ana)).status).toBe(400);
  expect((await req(app, "PUT", "/api/workspace/judge", ana, { bench: "a/b", judgeModel: BENCH_JUDGE })).status).toBe(400);

  // Neither setting: the system's default (the benchmark's own grader).
  expect(await (await req(app, "GET", "/api/workspace/judge?bench=qa", ana)).json()).toEqual({
    override: null,
    orgDefault: null,
    effective: null,
    source: "system",
  });

  // The override alone decides.
  const put = await req(app, "PUT", "/api/workspace/judge", ana, { bench: "qa", judgeModel: BENCH_JUDGE });
  expect(put.status).toBe(200);
  expect(await put.json()).toEqual({ override: BENCH_JUDGE, orgDefault: null, effective: BENCH_JUDGE, source: "override" });
  const [row] = await db.select().from(schema.benchJudgeOverrides);
  expect(row).toMatchObject({ orgId: "org_uni", bench: "qa", judgeModel: BENCH_JUDGE });

  // The org's default shows under the override, which still wins.
  await req(app, "PUT", "/api/org/judge", ana, { judgeModel: ORG_JUDGE });
  expect(((await (await req(app, "GET", "/api/workspace/judge?bench=qa", ana)).json()) as Judge)).toMatchObject({
    override: BENCH_JUDGE,
    orgDefault: ORG_JUDGE,
    effective: BENCH_JUDGE,
    source: "override",
  });
  // Without an override, the org's default decides.
  expect(((await (await req(app, "GET", "/api/workspace/judge?bench=otro", ana)).json()) as Judge)).toMatchObject({
    override: null,
    orgDefault: ORG_JUDGE,
    effective: ORG_JUDGE,
    source: "org",
  });

  // Another org never sees the override.
  expect(((await (await req(app, "GET", "/api/workspace/judge?bench=qa", ceci)).json()) as Judge)).toMatchObject({ override: null, source: "system" });

  // Clearing the override deletes its row; the org's default applies again.
  expect((await req(app, "PUT", "/api/workspace/judge", ana, { bench: "qa", judgeModel: null })).status).toBe(200);
  expect(await db.select().from(schema.benchJudgeOverrides)).toHaveLength(0);
  expect(((await (await req(app, "GET", "/api/workspace/judge?bench=qa", ana)).json()) as Judge)).toMatchObject({ effective: ORG_JUDGE, source: "org" });
});

it("starts each evaluation with the judge the config resolves to — override, then org, then the benchmark's own", async () => {
  const { client, calls } = fakeHermes();
  const app = makeApp(client);
  const path = "qa/benchmark.yaml";
  const models = ["us.moonshotai.kimi-k3"];
  const judge = () => calls.filter((c) => c.op === "startEvaluation").map((c) => c.args[2]);

  // Nothing configured: no judge travels — the container keeps the benchmark's grader.
  await req(app, "POST", "/api/workspace/evaluation", ana, { path, models });
  expect(judge()).toEqual([undefined]);

  // The org's default travels.
  await req(app, "PUT", "/api/org/judge", ana, { judgeModel: ORG_JUDGE });
  await req(app, "POST", "/api/workspace/evaluation", ana, { path, models });
  expect(judge()).toEqual([undefined, ORG_JUDGE]);

  // The benchmark's override wins over the org's default.
  await req(app, "PUT", "/api/workspace/judge", ana, { bench: "qa", judgeModel: BENCH_JUDGE });
  await req(app, "POST", "/api/workspace/evaluation", ana, { path, models });
  expect(judge()).toEqual([undefined, ORG_JUDGE, BENCH_JUDGE]);

  // Cleared, the org's default applies again; another org starts with none.
  await req(app, "PUT", "/api/workspace/judge", ana, { bench: "qa", judgeModel: null });
  await req(app, "POST", "/api/workspace/evaluation", ana, { path, models });
  await req(app, "POST", "/api/workspace/evaluation", ceci, { path, models });
  expect(judge()).toEqual([undefined, ORG_JUDGE, BENCH_JUDGE, ORG_JUDGE, undefined]);
});
