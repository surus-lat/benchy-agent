import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { schema } from "@benchy/db";
import { createConversationsApp, type CurrentUser } from "../src/conversations";
import type { HermesClient } from "../src/hermes";

// Semantic search inside a benchmark (POST /api/workspace/search): the Worker
// forwards {bench, q} to the agent, which embeds the benchmark's papers and
// exam questions in its own container. The Worker validates the slug and the
// query (1..300 chars, trimmed), and logs the search either way the agent
// answers.

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
    async removeQuestion() {
      return { ok: true };
    },
    async search(bench, q) {
      calls.push(`${bench}#${q}`);
      return opts.ok === false
        ? { ok: false as const, error: { code: "embed_not_configured", message: "no key" } }
        : { ok: true as const, query: q, results: [{ id: "exam:2", text: "Pregunta 3", score: 0.81, title: null }] };
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

function req(app: ReturnType<typeof makeApp>, body: unknown, user?: CurrentUser) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = user.id;
  return app.request("/api/workspace/search", { method: "POST", headers, body: JSON.stringify(body) });
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
  expect((await req(app, { bench: "qa", q: "transformación digital" })).status).toBe(401);
  expect((await req(app, { bench: "qa", q: "transformación digital" }, orphan)).status).toBe(403);
  const bad: unknown[] = [
    { bench: "qa" },
    { bench: "qa", q: "" },
    { bench: "qa", q: "   " },
    { bench: "qa", q: "x".repeat(301) },
    { bench: "qa", q: 5 },
    { bench: "", q: "algo" },
    { bench: "../etc", q: "algo" },
    null,
  ];
  for (const body of bad) {
    expect((await req(app, body, ana)).status).toBe(400);
  }
});

it("answers 503 when the org has no agent yet", async () => {
  const app = makeApp(null);
  expect((await req(app, { bench: "qa", q: "memoria" }, ana)).status).toBe(503);
});

it("forwards the search to the agent, returns its results and logs", async () => {
  const hermes = fakeHermes();
  const app = makeApp(hermes.client);
  const res = await req(app, { bench: "qa", q: "  identidad territorial  " }, ana);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; results: { id: string }[] };
  expect(body.ok).toBe(true);
  expect(body.results[0].id).toBe("exam:2");
  // The query reaches the agent trimmed.
  expect(hermes.calls).toEqual(["qa#identidad territorial"]);
  const rows = await db.select().from(schema.activity).where(eq(schema.activity.orgId, "org_uni"));
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ bench: "qa", kind: "search", userId: "user_ana" });
});

it("returns the agent's refusal without hiding it, and still logs the search", async () => {
  const hermes = fakeHermes({ ok: false });
  const app = makeApp(hermes.client);
  const res = await req(app, { bench: "qa", q: "memoria" }, ana);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; error?: { code: string } };
  expect(body.ok).toBe(false);
  expect(body.error?.code).toBe("embed_not_configured");
  expect((await db.select().from(schema.activity)).length).toBe(1);
});
