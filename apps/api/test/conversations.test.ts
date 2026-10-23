import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { schema } from "@benchy/db";
import { createConversationsApp, type CurrentUser } from "../src/conversations";
import { HermesError, type HermesClient } from "../src/hermes";
import type { Paper } from "../src/library";

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
  let running = false;
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
    async analysis(path) {
      calls.push({ op: "analysis", args: [path] });
      return { ok: true, models: [], questions: [] };
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
    async quality(path) {
      calls.push({ op: "quality", args: [path] });
      return { ok: true, rows: [] };
    },
    async addSource(bench, paper) {
      calls.push({ op: "addSource", args: [bench, paper.id] });
      return { ok: true, source: { id: `conicet-${paper.id}`, origin: "conicet", title: paper.title, authors: paper.creators, year: paper.year, url: paper.url, pdf_url: paper.pdfUrl, file: `sources/conicet-${paper.id}.md`, pages: 3, chars: 900, text: "full", added: 1 } };
    },
    async uploadSource(bench, filename, pdf) {
      calls.push({ op: "uploadSource", args: [bench, filename, pdf.byteLength] });
      return { ok: false, error: { code: "no_text", message: "sin texto" } };
    },
    async removeSource(bench, id) {
      calls.push({ op: "removeSource", args: [bench, id] });
      return { ok: true };
    },
    async backup() {
      return new ArrayBuffer(0);
    },
    async evaluation(path) {
      calls.push({ op: "evaluation", args: [path] });
      return { ok: true, evaluation: running ? { state: "running", models: [] } : null };
    },
    async startEvaluation(path, models) {
      calls.push({ op: "startEvaluation", args: [path, models] });
      if (models.includes("nope")) return { status: "refused", body: { ok: false, error: { code: "adapter_not_bound", message: "no" } } };
      if (running) return { status: "busy", body: { error: "busy", evaluation: { state: "running" } } };
      running = true;
      return { status: "started", body: { ok: true, evaluation: { state: "running", models: models.map((m) => ({ model: m, state: "pending" })) } } };
    },
    async startReport(path) {
      calls.push({ op: "startReport", args: [path] });
      return running ? { status: "busy", body: { error: "busy" } } : { status: "started", body: { ok: true, evaluation: { state: "reporting" } } };
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
    async paper(id) {
      return id === 179477 ? PAPER : null;
    },
  });
}

const PAPER: Paper = {
  id: 179477,
  title: "Paisajes mesetarios en Patagonia",
  creators: ["Cassiodoro, Gisela Eva"],
  subjects: ["Arqueología"],
  description: "La disponibilidad de recursos hídricos…",
  date: "2016-12",
  year: 2016,
  type: "article",
  language: "spa",
  publisher: "INAPL",
  rights: "info:eu-repo/semantics/openAccess",
  pdfUrl: "https://huggingface.co/datasets/UNRN/ri-conicet/resolve/main/papers/089/179477.pdf",
  url: "https://ri.conicet.gov.ar/handle/11336/179477",
};

function req(app: ReturnType<typeof makeApp>, method: string, path: string, user?: CurrentUser, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = user.id;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

beforeEach(async () => {
  await db.delete(schema.activity);
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
  expect(await (await req(app, "GET", "/api/workspace/analysis?path=x/benchmark.yaml", beto)).json()).toMatchObject({ ok: true, models: [] });
  expect((await req(app, "GET", "/api/workspace/validate", ana)).status).toBe(400);
  expect((await req(app, "GET", "/api/workspace/analysis?path=x/benchmark.yaml")).status).toBe(401);
  expect(calls.map((c) => c.op)).toEqual(["models", "validate", "exam", "analysis"]);
  const me = await (await req(app, "GET", "/api/me", ana)).json();
  expect(me).toEqual({ user: { id: ana.id, name: ana.name, email: ana.email }, org: { id: "org_uni", name: "Uni", slug: "uni" } });
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
  expect(await (await req(app, "POST", "/api/workspace/quality?path=qa/benchmark.yaml", beto)).json()).toMatchObject({ ok: true });
  expect((await req(app, "POST", "/api/workspace/quality", beto)).status).toBe(400);
  expect(calls.map((c) => c.op)).toEqual(["writeFile", "writeFile", "writeFile", "review", "quality"]);
  expect((await req(makeApp(null), "PUT", "/api/workspace/file", ana, body)).status).toBe(503);
});

it("adds library papers and uploaded PDFs to a benchmark through the org's agent", async () => {
  const { client, calls } = fakeHermes();
  const app = makeApp(client);
  expect((await req(app, "POST", "/api/workspace/sources", undefined, { bench: "qa", paperId: 179477 })).status).toBe(401);
  expect((await req(app, "POST", "/api/workspace/sources", orphan, { bench: "qa", paperId: 179477 })).status).toBe(403);

  const added = await req(app, "POST", "/api/workspace/sources", ana, { bench: "qa", paperId: 179477 });
  expect(await added.json()).toMatchObject({ ok: true, source: { id: "conicet-179477", text: "full" } });
  expect((await req(app, "POST", "/api/workspace/sources", ana, { bench: "qa", paperId: 1 })).status).toBe(404);
  for (const bench of ["", "../etc", ".hidden", "a/b"]) {
    expect((await req(app, "POST", "/api/workspace/sources", ana, { bench, paperId: 179477 })).status).toBe(400);
  }
  expect((await req(app, "POST", "/api/workspace/sources", ana, { bench: "qa", paperId: "179477" })).status).toBe(400);

  const upload = (body: BodyInit, query = "bench=qa&name=mi%20paper.pdf") =>
    app.request(`/api/workspace/sources/upload?${query}`, {
      method: "POST",
      headers: { "x-test-user": ana.id, "content-type": "application/pdf" },
      body,
    });
  expect(await (await upload(new TextEncoder().encode("\n%PDF-1.7 rest"))).json()).toMatchObject({ ok: false, error: { code: "no_text" } });
  expect((await upload(new TextEncoder().encode("<html>"))).status).toBe(415);
  expect((await upload(new TextEncoder().encode("%PDF-1.7"), "bench=../x&name=a.pdf")).status).toBe(400);
  expect((await upload(new TextEncoder().encode("%PDF-1.7"), "bench=qa")).status).toBe(400);

  expect(await (await req(app, "DELETE", "/api/workspace/sources?bench=qa&id=conicet-179477", ana)).json()).toEqual({ ok: true });
  expect((await req(app, "DELETE", "/api/workspace/sources?bench=qa&id=../x", ana)).status).toBe(400);
  expect(calls).toEqual([
    { op: "addSource", args: ["qa", 179477] },
    { op: "uploadSource", args: ["qa", "mi paper.pdf", 14] },
    { op: "removeSource", args: ["qa", "conicet-179477"] },
  ]);
});

it("finds a researcher's conversation for a benchmark from any device, and only theirs", async () => {
  const app = makeApp(fakeHermes().client);
  const made = (await (await req(app, "POST", "/api/conversations", ana, { bench: "new" })).json()) as { id: string; bench: string };
  expect(made.bench).toBe("new");
  await req(app, "POST", "/api/conversations", beto, { bench: "qa" });
  expect((await req(app, "POST", "/api/conversations", ana, { bench: "../x" })).status).toBe(400);

  // The agent created "qa": the conversation moves there.
  expect((await req(app, "PATCH", `/api/conversations/${made.id}`, ana, { bench: "qa" })).status).toBe(200);
  expect((await req(app, "PATCH", `/api/conversations/${made.id}`, beto, { bench: "qa" })).status).toBe(404);
  const mine = (await (await req(app, "GET", "/api/conversations?bench=qa", ana)).json()) as { conversations: { id: string }[] };
  expect(mine.conversations.map((c) => c.id)).toEqual([made.id]);
  expect((await req(app, "GET", "/api/conversations?bench=.x", ana)).status).toBe(400);
});

it("keeps the org's record of who did what, never what was said to the agent", async () => {
  const app = makeApp(fakeHermes().client);
  const conv = (await (await req(app, "POST", "/api/conversations", ana, { bench: "qa" })).json()) as { id: string };
  await req(app, "POST", `/api/conversations/${conv.id}/turns`, ana, { message: "algo privado sobre mi examen" });
  await req(app, "PUT", "/api/workspace/file", ana, { path: "qa/exam.jsonl", content: "{}\n" });
  await req(app, "PUT", "/api/workspace/file", ana, { path: "qa/exam.jsonl", content: "{}\n{}\n" }); // same edit: one entry
  await req(app, "PUT", "/api/workspace/file", beto, { path: "qa/questions.json", content: "{}" });
  await req(app, "POST", "/api/workspace/review?path=qa/benchmark.yaml", beto);
  await req(app, "POST", "/api/workspace/quality?path=qa/benchmark.yaml", beto);
  await req(app, "POST", "/api/workspace/sources", ana, { bench: "qa", paperId: 179477 });
  expect((await req(app, "POST", "/api/activity", ana, { bench: "qa", kind: "create", detail: "creó el benchmark" })).status).toBe(201);
  expect((await req(app, "POST", "/api/activity", ana, { bench: "qa", kind: "delete", detail: "borró la pregunta 02" })).status).toBe(201);
  expect((await req(app, "POST", "/api/activity", ana, { bench: "qa", kind: "approve", detail: "aprobó la pregunta 01" })).status).toBe(201);
  expect((await req(app, "POST", "/api/activity", ana, { bench: "qa", kind: "edit", detail: "x" })).status).toBe(400);

  const res = await req(app, "GET", "/api/activity?bench=qa", beto);
  const { activity } = (await res.json()) as { activity: { who: string; kind: string; detail: string }[] };
  expect(activity.map((a) => `${a.who}|${a.kind}|${a.detail}`).sort()).toEqual(
    [
      "Ana Pérez|agent|trabajó con el agente",
      "Ana Pérez|edit|exam.jsonl",
      "beto@uni.edu|edit|questions.json",
      "beto@uni.edu|review|revisión del juez de las respuestas expertas",
      "beto@uni.edu|quality|midió la calidad de las preguntas",
      "Ana Pérez|paper|agregó «Paisajes mesetarios en Patagonia»",
      "Ana Pérez|create|creó el benchmark",
      "Ana Pérez|delete|borró la pregunta 02",
      "Ana Pérez|approve|aprobó la pregunta 01",
    ].sort(),
  );
  expect(JSON.stringify(activity)).not.toContain("privado");
  expect((await req(app, "GET", "/api/activity", orphan)).status).toBe(403);
});

it("starts an evaluation in the container, refuses a second one while it runs, and records it", async () => {
  const { client, calls } = fakeHermes();
  const app = makeApp(client);
  const path = "qa/benchmark.yaml";
  expect((await req(app, "POST", "/api/workspace/evaluation", ana, { path, models: [] })).status).toBe(400);
  expect((await req(app, "POST", "/api/workspace/evaluation", ana, { path: "", models: ["a"] })).status).toBe(400);
  const refused = await req(app, "POST", "/api/workspace/evaluation", ana, { path, models: ["nope"] });
  expect(((await refused.json()) as { ok: boolean }).ok).toBe(false);

  const started = await req(app, "POST", "/api/workspace/evaluation", ana, { path, models: ["us.moonshotai.kimi-k3", "zai.glm-5"] });
  expect(started.status).toBe(200);
  expect(((await started.json()) as { evaluation: { state: string } }).evaluation.state).toBe("running");
  const again = await req(app, "POST", "/api/workspace/evaluation", beto, { path, models: ["zai.glm-5"] });
  expect(again.status).toBe(409);
  expect(((await again.json()) as { error: string }).error).toBe("EVALUATION_RUNNING");
  expect((await req(app, "POST", `/api/workspace/report?path=${path}`, beto)).status).toBe(409);

  const status = await req(app, "GET", `/api/workspace/evaluation?path=${path}`, beto);
  expect(((await status.json()) as { evaluation: { state: string } }).evaluation.state).toBe("running");
  expect(calls.filter((x) => x.op === "startEvaluation").map((x) => x.args[1])).toEqual([["nope"], ["us.moonshotai.kimi-k3", "zai.glm-5"], ["zai.glm-5"]]);

  const res = await req(app, "GET", "/api/activity?bench=qa", ana);
  const { activity } = (await res.json()) as { activity: { kind: string; detail: string }[] };
  expect(activity.map((a) => `${a.kind}|${a.detail}`)).toEqual(["evaluate|evaluó 2 modelos: us.moonshotai.kimi-k3, zai.glm-5"]);
  expect((await req(makeApp(null), "GET", `/api/workspace/evaluation?path=${path}`, ana)).status).toBe(503);
});

it("asks the container for the findings report and records who asked", async () => {
  const { client, calls } = fakeHermes();
  const app = makeApp(client);
  const res = await req(app, "POST", "/api/workspace/report?path=qa/benchmark.yaml", ana);
  expect(((await res.json()) as { evaluation: { state: string } }).evaluation.state).toBe("reporting");
  expect(calls.at(-1)).toEqual({ op: "startReport", args: ["qa/benchmark.yaml"] });
  const act = (await (await req(app, "GET", "/api/activity?bench=qa", ana)).json()) as { activity: { kind: string }[] };
  expect(act.activity.map((a) => a.kind)).toEqual(["report"]);
});
