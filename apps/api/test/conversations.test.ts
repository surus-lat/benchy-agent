import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { schema } from "@benchy/db";
import { createConversationsApp, type CurrentUser } from "../src/conversations";
import { HermesError, type HermesClient } from "../src/hermes";

// The Worker side of the agent: auth, per-user scoping, org routing from the
// session, the per-conversation turn lock, and persistence. Hermes is a fake
// that records calls; the real one is exercised in apps/agent.

const db = drizzle(env.DB, { schema });

const ana: CurrentUser = { id: "user_ana", name: "Ana Pérez", email: "ana@uni.edu", orgId: "org_uni" };
const beto: CurrentUser = { id: "user_beto", name: "", email: "beto@uni.edu", orgId: "org_uni" };
const orphan: CurrentUser = { id: "user_orphan", name: "", email: "o@x.edu", orgId: null };

type Call = { op: string; args: unknown[] };

function fakeHermes(opts: { fail?: "chat" | "session" } = {}) {
  const calls: Call[] = [];
  let sessions = 0;
  const client: HermesClient = {
    async createSession(userId) {
      calls.push({ op: "createSession", args: [userId] });
      if (opts.fail === "session") throw new HermesError("agent unreachable", 502);
      return `hermes_${++sessions}`;
    },
    async chat(sessionId, userId, message, speaker) {
      calls.push({ op: "chat", args: [sessionId, userId, message, speaker] });
      if (opts.fail === "chat") throw new HermesError("agent timed out", 504);
      return { reply: `eco: ${message}`, usage: { input_tokens: 1 } };
    },
    async listFiles() {
      calls.push({ op: "listFiles", args: [] });
      return { files: [{ path: "capitales/benchmark.yaml", size: 10, modified: 1 }], truncated: false };
    },
    async validate(path) {
      calls.push({ op: "validate", args: [path] });
      return { ok: true, path };
    },
    async exam(path) {
      calls.push({ op: "exam", args: [path] });
      return { ok: true, total: 0, rows: [] };
    },
    async models() {
      calls.push({ op: "models", args: [] });
      return { provider: "bedrock", models: ["us.moonshotai.kimi-k3"] };
    },
    async writeFile(path, content, baseModified) {
      calls.push({ op: "writeFile", args: [path, content, baseModified] });
      if (path.includes("/runs/")) return { status: "forbidden" };
      if (baseModified !== undefined && baseModified < 5) return { status: "conflict", modified: 5 };
      return { status: "ok", path, modified: 6 };
    },
    async review(path) {
      calls.push({ op: "review", args: [path] });
      return { ok: true, rows: [] };
    },
    async readFile(path) {
      calls.push({ op: "readFile", args: [path] });
      return path === "capitales/benchmark.yaml"
        ? { path, size: 10, modified: 1, truncated: false, content: "version: 1.0" }
        : null;
    },
  };
  return { client, calls };
}

function makeApp(hermes: HermesClient | null, orgsSeen: string[] = []) {
  return createConversationsApp({
    db,
    async currentUser(request) {
      const who = request.headers.get("x-test-user");
      return [ana, beto, orphan].find((u) => u.id === who) ?? null;
    },
    async agentFor(orgId) {
      orgsSeen.push(orgId);
      return hermes;
    },
  });
}

function req(app: ReturnType<typeof makeApp>, method: string, path: string, user?: CurrentUser, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = user.id;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

beforeEach(async () => {
  await db.delete(schema.conversationMessages);
  await db.delete(schema.conversations);
  await db.delete(schema.user);
  await db.delete(schema.orgs);
  const now = new Date();
  await db.insert(schema.orgs).values({ id: "org_uni", name: "Uni", slug: "uni", createdAt: now });
  for (const u of [ana, beto, orphan]) {
    await db.insert(schema.user).values({
      id: u.id, name: u.name, email: u.email, orgId: u.orgId, createdAt: now, updatedAt: now,
    });
  }
});

it("refuses anonymous callers and users without an org", async () => {
  const app = makeApp(fakeHermes().client);
  expect((await req(app, "GET", "/api/conversations")).status).toBe(401);
  expect((await req(app, "POST", "/api/conversations", undefined, {})).status).toBe(401);
  expect((await req(app, "GET", "/api/conversations", orphan)).status).toBe(403);
});

it("creates a conversation backed by a Hermes session in the caller's org", async () => {
  const { client, calls } = fakeHermes();
  const orgsSeen: string[] = [];
  const app = makeApp(client, orgsSeen);
  // An orgId in the body must be ignored: the org comes from the session.
  const res = await req(app, "POST", "/api/conversations", ana, { orgId: "org_other" });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  const [row] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, body.id));
  expect(row).toMatchObject({ userId: ana.id, orgId: "org_uni", hermesSessionId: "hermes_1" });
  expect(orgsSeen).toEqual(["org_uni"]);
  expect(calls).toEqual([{ op: "createSession", args: [ana.id] }]);
});

it("does not create a conversation when the org has no agent or Hermes fails", async () => {
  expect((await req(makeApp(null), "POST", "/api/conversations", ana, {})).status).toBe(503);
  const failing = makeApp(fakeHermes({ fail: "session" }).client);
  expect((await req(failing, "POST", "/api/conversations", ana, {})).status).toBe(502);
  expect(await db.select().from(schema.conversations)).toHaveLength(0);
});

it("lists only the caller's own conversations, even within the same org", async () => {
  const app = makeApp(fakeHermes().client);
  await req(app, "POST", "/api/conversations", ana, { title: "de Ana" });
  await req(app, "POST", "/api/conversations", beto, { title: "de Beto" });
  const res = await req(app, "GET", "/api/conversations", ana);
  const { conversations } = (await res.json()) as { conversations: { title: string }[] };
  expect(conversations.map((c) => c.title)).toEqual(["de Ana"]);
});

it("runs a turn: forwards speaker attribution, persists both messages, titles the chat", async () => {
  const { client, calls } = fakeHermes();
  const app = makeApp(client);
  const { id } = (await (await req(app, "POST", "/api/conversations", ana, {})).json()) as { id: string };

  const res = await req(app, "POST", `/api/conversations/${id}/turns`, ana, { message: "Hola, armemos un benchmark" });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ reply: "eco: Hola, armemos un benchmark" });

  const chat = calls.find((c) => c.op === "chat")!;
  expect(chat.args.slice(0, 3)).toEqual(["hermes_1", ana.id, "Hola, armemos un benchmark"]);
  expect(chat.args[3]).toContain("Ana Pérez");

  const msgs = await (await req(app, "GET", `/api/conversations/${id}/messages`, ana)).json() as {
    messages: { role: string; content: string }[];
  };
  expect(msgs.messages.map((m) => [m.role, m.content])).toEqual([
    ["user", "Hola, armemos un benchmark"],
    ["assistant", "eco: Hola, armemos un benchmark"],
  ]);
  const [row] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, id));
  expect(row.title).toBe("Hola, armemos un benchmark");
  expect(row.turnStartedAt).toBeNull();
});

it("falls back to the email when the researcher has no name", async () => {
  const { client, calls } = fakeHermes();
  const app = makeApp(client);
  const { id } = (await (await req(app, "POST", "/api/conversations", beto, {})).json()) as { id: string };
  await req(app, "POST", `/api/conversations/${id}/turns`, beto, { message: "hola" });
  expect(calls.find((c) => c.op === "chat")!.args[3]).toContain("beto@uni.edu");
});

it("hides another researcher's conversation behind 404", async () => {
  const app = makeApp(fakeHermes().client);
  const { id } = (await (await req(app, "POST", "/api/conversations", ana, {})).json()) as { id: string };
  expect((await req(app, "GET", `/api/conversations/${id}/messages`, beto)).status).toBe(404);
  expect((await req(app, "POST", `/api/conversations/${id}/turns`, beto, { message: "x" })).status).toBe(404);
});

it("rejects a second turn while one is in flight, and reclaims a stale lock", async () => {
  const app = makeApp(fakeHermes().client);
  const { id } = (await (await req(app, "POST", "/api/conversations", ana, {})).json()) as { id: string };

  await db.update(schema.conversations).set({ turnStartedAt: new Date() }).where(eq(schema.conversations.id, id));
  expect((await req(app, "POST", `/api/conversations/${id}/turns`, ana, { message: "x" })).status).toBe(409);

  const longAgo = new Date(Date.now() - 60 * 60 * 1000);
  await db.update(schema.conversations).set({ turnStartedAt: longAgo }).where(eq(schema.conversations.id, id));
  expect((await req(app, "POST", `/api/conversations/${id}/turns`, ana, { message: "x" })).status).toBe(200);
});

it("releases the lock and reports a timeout when Hermes fails mid-turn", async () => {
  const create = makeApp(fakeHermes().client);
  const { id } = (await (await req(create, "POST", "/api/conversations", ana, {})).json()) as { id: string };
  const failing = makeApp(fakeHermes({ fail: "chat" }).client);
  const res = await req(failing, "POST", `/api/conversations/${id}/turns`, ana, { message: "corré" });
  expect(res.status).toBe(504);
  expect(await res.json()).toEqual({ error: "AGENT_TIMEOUT" });
  const [row] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, id));
  expect(row.turnStartedAt).toBeNull();
});

it("validates turn bodies", async () => {
  const app = makeApp(fakeHermes().client);
  const { id } = (await (await req(app, "POST", "/api/conversations", ana, {})).json()) as { id: string };
  expect((await req(app, "POST", `/api/conversations/${id}/turns`, ana, { message: "  " })).status).toBe(400);
  expect((await req(app, "POST", `/api/conversations/${id}/turns`, ana, {})).status).toBe(400);
});

it("serves the org workspace to any member, through the org's agent", async () => {
  const { client, calls } = fakeHermes();
  const orgsSeen: string[] = [];
  const app = makeApp(client, orgsSeen);
  expect((await req(app, "GET", "/api/workspace/files")).status).toBe(401);
  expect((await req(app, "GET", "/api/workspace/files", orphan)).status).toBe(403);

  const list = await req(app, "GET", "/api/workspace/files", beto);
  expect(await list.json()).toMatchObject({ files: [{ path: "capitales/benchmark.yaml" }] });
  const file = await req(app, "GET", "/api/workspace/file?path=capitales/benchmark.yaml", ana);
  expect(await file.json()).toMatchObject({ content: "version: 1.0" });
  expect((await req(app, "GET", "/api/workspace/file?path=nope.yaml", ana)).status).toBe(404);
  expect((await req(app, "GET", "/api/workspace/file", ana)).status).toBe(400);
  expect(orgsSeen.every((o) => o === "org_uni")).toBe(true);
  expect(calls.map((c) => c.op)).toEqual(["listFiles", "readFile", "readFile"]);
  expect((await req(makeApp(null), "GET", "/api/workspace/files", ana)).status).toBe(503);
});

it("exposes engine checks, models and the caller's org to members", async () => {
  const { client, calls } = fakeHermes();
  const app = makeApp(client);
  expect((await req(app, "GET", "/api/models")).status).toBe(401);
  expect(await (await req(app, "GET", "/api/models", ana)).json()).toMatchObject({ models: ["us.moonshotai.kimi-k3"] });
  expect(await (await req(app, "GET", "/api/workspace/validate?path=x/benchmark.yaml", beto)).json()).toMatchObject({ ok: true });
  expect(await (await req(app, "GET", "/api/workspace/exam?path=x/benchmark.yaml", ana)).json()).toMatchObject({ ok: true });
  expect((await req(app, "GET", "/api/workspace/validate", ana)).status).toBe(400);
  expect(calls.map((c) => c.op)).toEqual(["models", "validate", "exam"]);
  const me = await (await req(app, "GET", "/api/me", ana)).json();
  expect(me).toEqual({ user: { id: ana.id, name: ana.name, email: ana.email }, org: { id: "org_uni", name: "Uni" } });
  expect((await req(app, "GET", "/api/me", orphan)).status).toBe(403);
});

it("lets members edit benchmark files and run the answer review, never past a newer version", async () => {
  const { client, calls } = fakeHermes();
  const app = makeApp(client);
  const body = { path: "qa/exam.jsonl", content: "{}\n" };
  expect((await req(app, "PUT", "/api/workspace/file", undefined, body)).status).toBe(401);
  expect((await req(app, "PUT", "/api/workspace/file", orphan, body)).status).toBe(403);

  const ok = await req(app, "PUT", "/api/workspace/file", beto, { ...body, baseModified: 5 });
  expect(await ok.json()).toEqual({ path: "qa/exam.jsonl", modified: 6 });
  const stale = await req(app, "PUT", "/api/workspace/file", ana, { ...body, baseModified: 1 });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ error: "CONFLICT", modified: 5 });
  expect((await req(app, "PUT", "/api/workspace/file", ana, { path: "qa/runs/x.json", content: "" })).status).toBe(403);
  expect((await req(app, "PUT", "/api/workspace/file", ana, { path: "qa/a.yaml" })).status).toBe(400);
  expect((await req(app, "PUT", "/api/workspace/file", ana, { ...body, baseModified: "1" })).status).toBe(400);

  expect(await (await req(app, "POST", "/api/workspace/review?path=qa/benchmark.yaml", ana)).json()).toMatchObject({ ok: true });
  expect((await req(app, "POST", "/api/workspace/review", ana)).status).toBe(400);
  expect(calls.map((c) => c.op)).toEqual(["writeFile", "writeFile", "writeFile", "review"]);
  expect((await req(makeApp(null), "PUT", "/api/workspace/file", ana, body)).status).toBe(503);
});
