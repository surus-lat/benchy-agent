import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { schema } from "@benchy/db";
import { createConversationsApp, type CurrentUser } from "../src/conversations";
import type { HermesClient } from "../src/hermes";

// Deleting one question (DELETE /api/workspace/benchmark/question?bench=…&q=…): the
// Worker forwards to the agent, which drops the row from exam.jsonl and
// reindexes runs/ and review.json. The Worker only logs on success and
// validates the slug and the 1-based question number.

const db = drizzle(env.DB, { schema });

const ana: CurrentUser = { id: "user_ana", name: "Ana Pérez", email: "ana@uni.edu", orgId: "org_uni" };
const orphan: CurrentUser = { id: "user_orphan", name: "", email: "o@x.edu", orgId: null };

function fakeHermes(opts: { ok?: boolean } = {}): { client: HermesClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
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
    async addSource() {
      return { ok: true as const, source: null as never };
    },
    async uploadSource() {
      return { ok: true as const, source: null as never };
    },
    async removeSource() {
      return { ok: true };
    },
    async removeBenchmark() {
      return { ok: true };
    },
    async removeQuestion(bench, q) {
      calls.push(`${bench}#${q}`);
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
  } as unknown as HermesClient;
  return { client, calls };
}

function makeApp(hermes: HermesClient | null) {
  return createConversationsApp({
    db,
    async currentUser(request) {
      const who = request.headers.get("x-test-user");
      return [ana, orphan].find((u) => u.id === who) ?? null;
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
  await db.delete(schema.user);
  await db.delete(schema.orgs);
  const now = new Date();
  await db.insert(schema.orgs).values({ id: "org_uni", name: "Uni", slug: "uni", createdAt: now });
  await db.insert(schema.user).values({ id: ana.id, name: ana.name, email: ana.email, orgId: ana.orgId, createdAt: now, updatedAt: now });
});

it("requires auth and validates bench and q", async () => {
  const app = makeApp(fakeHermes().client);
  expect((await req(app, "DELETE", "/api/workspace/benchmark/question?bench=qa&q=2")).status).toBe(401);
  expect((await req(app, "DELETE", "/api/workspace/benchmark/question?bench=qa&q=2", orphan)).status).toBe(403);
  for (const q of ["bench=qa", "bench=qa&q=0", "bench=qa&q=-1", "bench=qa&q=1.5", "bench=qa&q=abc", "bench=qa&q=10001", "bench=../etc&q=2"]) {
    expect((await req(app, "DELETE", `/api/workspace/benchmark/question?${q}`, ana)).status).toBe(400);
  }
});

it("answers 503 when the org has no agent yet", async () => {
  const app = makeApp(null);
  expect((await req(app, "DELETE", "/api/workspace/benchmark/question?bench=qa&q=2", ana)).status).toBe(503);
});

it("forwards the question to the agent and logs on success", async () => {
  const hermes = fakeHermes();
  const app = makeApp(hermes.client);
  const res = await req(app, "DELETE", "/api/workspace/benchmark/question?bench=qa&q=3", ana);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(hermes.calls).toEqual(["qa#3"]);
  const rows = await db.select().from(schema.activity).where(eq(schema.activity.orgId, "org_uni"));
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ bench: "qa", kind: "exam", userId: "user_ana" });
});

it("does not log when the agent refuses", async () => {
  const hermes = fakeHermes({ ok: false });
  const app = makeApp(hermes.client);
  const res = await req(app, "DELETE", "/api/workspace/benchmark/question?bench=qa&q=3", ana);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; error?: { code: string } };
  expect(body.ok).toBe(false);
  expect(body.error?.code).toBe("bench_not_found");
  expect((await db.select().from(schema.activity)).length).toBe(0);
});
