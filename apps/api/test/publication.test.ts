import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { schema } from "@benchy/db";
import { createConversationsApp, type CurrentUser } from "../src/conversations";
import type { HermesClient, Source } from "../src/hermes";
import type { Paper } from "../src/library";

// Publishing a benchmark (POST /api/workspace/publication/publish) and reverting
// it (…/revert). The container keeps the frozen copy of the workspace files in
// <bench>/published/vN; the Worker mirrors that in its own rows, because those
// rows are what the benchmark list and the editors read. While a benchmark is
// published its definition is locked: writing one of its files, adding or
// removing a paper, and removing a question are answered 409 PUBLISHED.
// Reverting leaves vN exactly where it is and unlocks the working copy, still
// pointing at vN, so the next publish is vN+1. What a new evaluation produces
// keeps being written, and deleting the benchmark takes its publication with it.

const db = drizzle(env.DB, { schema });

const ana: CurrentUser = { id: "user_ana", name: "Ana Pérez", email: "ana@uni.edu", orgId: "org_uni" };
const ceci: CurrentUser = { id: "user_ceci", name: "Ceci Ruiz", email: "ceci@otra.edu", orgId: "org_otra" };

const headers = (user: CurrentUser) => ({ "content-type": "application/json", "x-test-user": user.id });

function source(id: string): Source {
  return {
    id,
    origin: "conicet",
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

/** Where the container says one benchmark stands, as its publish.json would. */
type ContainerState = { state: "published" | "editing"; version: number; basedOn: number | null } | null;

/**
 * The container's side of publishing: the version counter and the frozen-copy
 * decision live there, and its write guard mirrors the real one so a Worker row
 * that fell behind still loses the write.
 */
function fakeHermes(opts: { published: { current: ContainerState }; removed?: string[]; written?: string[] } = { published: { current: null } }) {
  const removed = opts.removed ?? [];
  const written = opts.written ?? [];
  const state = opts.published;
  let modified = 100;
  const client: HermesClient = {
    async createSession() {
      throw new Error("the publication routes never open a Hermes session");
    },
    async chat() {
      throw new Error("the publication routes never open a Hermes session");
    },
    async listFiles() {
      return { files: [{ path: "medrag/benchmark.yaml", size: 100, modified }], truncated: false };
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
      const [bench, ...rest] = path.split("/");
      if (rest.length >= 2 && rest[0] === "published") return { status: "forbidden" as const };
      if (state.current?.state === "published" && !["report.md", "report.previous.md", "review.json", "quality.json"].includes(rest[rest.length - 1] ?? "")) {
        return { status: "published" as const };
      }
      written.push(path);
      modified += 1;
      return { status: "ok" as const, path, modified };
    },
    async review() {
      return { ok: true, rows: [] };
    },
    async quality() {
      return { ok: true, rows: [] };
    },
    async addSource(bench, paper: Paper) {
      return { ok: true as const, source: source(`${paper.id}`) };
    },
    async uploadSource() {
      return { ok: true as const, source: source("pdf-9f8e7d") };
    },
    async removeSource(bench) {
      removed.push(`source:${bench}`);
      return { ok: true };
    },
    async removeBenchmark(bench) {
      removed.push(`bench:${bench}`);
      return { ok: true };
    },
    async removeQuestion(bench, q) {
      removed.push(`question:${bench}#${q}`);
      return { ok: true };
    },
    async publication(bench) {
      return { ok: true as const, state: state.current, versions: [] };
    },
    async publish(bench, note) {
      const version = (state.current?.version ?? 0) + 1;
      state.current = { state: "published", version, basedOn: state.current?.basedOn ?? null };
      return {
        ok: true as const,
        version,
        publishedAt: 1_769_900_000 + version,
        path: `${bench}/published/v${version}`,
        files: [
          { path: "benchmark.yaml", size: 200, modified: 1 },
          { path: "exam.jsonl", size: 900, modified: 1 },
          ...(note ? [{ path: "note.txt", size: 4, modified: 1 }] : []),
        ],
      };
    },
    async revert(bench) {
      if (state.current?.state !== "published") return { ok: false as const, error: { code: "not_published", message: "nunca publicado" } };
      const version = state.current.version;
      state.current = { state: "editing", version, basedOn: version };
      return { ok: true as const, version, updatedAt: 1_769_900_500, state: "editing" as const };
    },
    async backup() {
      return new ArrayBuffer(0);
    },
    async evaluation(path) {
      return { ok: true, evaluation: null, path };
    },
    async startEvaluation() {
      return { status: "started" as const, body: { ok: true } };
    },
    async startReport() {
      return { status: "started" as const, body: { ok: true } };
    },
    async readFile() {
      return null;
    },
  };
  return { client, removed, written };
}

/** Each org has its own container, so each gets its own fake of one. */
function makeApp(agentFor: (orgId: string) => HermesClient | null) {
  return createConversationsApp({
    db,
    async currentUser(request) {
      const who = request.headers.get("x-test-user");
      return [ana, ceci].find((u) => u.id === who) ?? null;
    },
    async agentFor(orgId) {
      return agentFor(orgId);
    },
    async paper(id) {
      return { id, title: `Paper ${id}`, abstract: "a", year: 2024, authors: [], hasPdf: false } as Paper;
    },
    library: {} as D1Database,
  });
}

/** The Worker's own row for a benchmark. */
async function rowOf(orgId: string, bench: string) {
  const [row] = await db
    .select()
    .from(schema.benchPublications)
    .where(and(eq(schema.benchPublications.orgId, orgId), eq(schema.benchPublications.bench, bench)));
  return row ?? null;
}

async function publish(app: ReturnType<typeof makeApp>, bench: string, note?: string) {
  return app.request("/api/workspace/publication/publish", {
    method: "POST",
    headers: headers(ana),
    body: JSON.stringify(note === undefined ? { bench } : { bench, note }),
  });
}

async function revert(app: ReturnType<typeof makeApp>, bench: string) {
  return app.request("/api/workspace/publication/revert", { method: "POST", headers: headers(ana), body: JSON.stringify({ bench }) });
}

async function readPublication(app: ReturnType<typeof makeApp>, user = ana, bench = "medrag") {
  const res = await app.request(`/api/workspace/publication?bench=${bench}`, { headers: headers(user) });
  return (await res.json()) as {
    bench: string;
    state: string;
    version: number;
    basedOn: number | null;
    by: string | null;
    versions: { version: number; note: string | null; at: string; by: string; files: number }[];
  };
}

async function putFile(app: ReturnType<typeof makeApp>, user: CurrentUser, path: string, content = "x\n") {
  return app.request("/api/workspace/file", { method: "PUT", headers: headers(user), body: JSON.stringify({ path, content }) });
}

beforeEach(async () => {
  await db.delete(schema.benchPublicationVersions);
  await db.delete(schema.benchPublications);
  await db.delete(schema.activity);
  await db.delete(schema.sourceValidations);
  await db.delete(schema.benchJudgeOverrides);
  await db.delete(schema.user);
  await db.delete(schema.orgDomains);
  await db.delete(schema.orgAgentEndpoints);
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

it("publishing freezes the benchmark and records what the version was", async () => {
  const state = { current: null as ContainerState };
  const app = makeApp(() => fakeHermes({ published: state }).client);

  const res = await publish(app, "medrag", "primera versión pública");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, version: 1, at: new Date(1_769_900_001 * 1000).toISOString(), files: 3 });

  // The container's copy and the Worker's row agree about where things stand.
  expect(state.current).toEqual({ state: "published", version: 1, basedOn: null });
  expect(await rowOf(ana.orgId, "medrag")).toMatchObject({ state: "published", version: 1, basedOn: null, userName: "Ana Pérez" });

  const [version] = await db.select().from(schema.benchPublicationVersions).where(eq(schema.benchPublicationVersions.bench, "medrag"));
  expect(version).toMatchObject({ version: 1, note: "primera versión pública", userName: "Ana Pérez" });
  expect(JSON.parse(version.manifest)).toHaveLength(3);

  const read = await readPublication(app);
  expect(read).toMatchObject({ bench: "medrag", state: "published", version: 1, basedOn: null, by: "Ana Pérez" });
  expect(read.versions).toEqual([
    { version: 1, note: "primera versión pública", at: new Date(1_769_900_001 * 1000).toISOString(), by: "Ana Pérez", files: 3 },
  ]);

  // And the org's record says who published it.
  const [entry] = await db.select().from(schema.activity).where(eq(schema.activity.bench, "medrag"));
  expect(entry).toMatchObject({ kind: "publish", who: "Ana Pérez", detail: "publicó la versión 1" });
});

it("a published benchmark's definition is locked; its results are not", async () => {
  const state = { current: null as ContainerState };
  const { client, removed, written } = fakeHermes({ published: state });
  const app = makeApp(() => client);
  await publish(app, "medrag");

  const exam = await putFile(app, ana, "medrag/exam.jsonl", '{"input":"x","expected":"y"}\n');
  expect(exam.status).toBe(409);
  expect(await exam.json()).toEqual({ error: "PUBLISHED", bench: "medrag", version: 1 });

  for (const path of ["medrag/benchmark.yaml", "medrag/design.json", "medrag/questions.json"]) {
    expect((await putFile(app, ana, path)).status).toBe(409);
  }

  // A published version's snapshot is never written, published or not.
  expect((await putFile(app, ana, "medrag/published/v1/exam.jsonl")).status).toBe(403);

  expect((await app.request("/api/workspace/benchmark/question?bench=medrag&q=1", { method: "DELETE", headers: headers(ana) })).status).toBe(409);
  expect((await app.request("/api/workspace/sources", { method: "POST", headers: headers(ana), body: JSON.stringify({ bench: "medrag", paperId: 1 }) })).status).toBe(409);
  expect((await app.request("/api/workspace/sources?bench=medrag&id=1", { method: "DELETE", headers: headers(ana) })).status).toBe(409);
  expect(removed).toEqual([]);
  expect(written).toEqual([]);

  // What a new evaluation produces is not part of the frozen definition: the
  // grader's files and the findings report keep being written, and a published
  // benchmark is still run and cited.
  expect((await putFile(app, ana, "medrag/report.md", "# Informe nuevo\n")).status).toBe(200);
  expect((await putFile(app, ana, "medrag/quality.json")).status).toBe(200);
  expect(written).toEqual(["medrag/report.md", "medrag/quality.json"]);

  const evaluation = await app.request("/api/workspace/evaluation", {
    method: "POST",
    headers: headers(ana),
    body: JSON.stringify({ path: "medrag/benchmark.yaml", models: ["us.moonshotai.kimi-k3"] }),
  });
  expect(evaluation.status).toBe(200);
});

it("reverting unlocks the working copy without touching the published version", async () => {
  const state = { current: null as ContainerState };
  const { client, removed } = fakeHermes({ published: state });
  const app = makeApp(() => client);
  await publish(app, "medrag");

  const res = await revert(app, "medrag");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, state: "editing", version: 1 });

  // v1 stays the published version, and the draft says it grew out of it.
  expect(state.current).toEqual({ state: "editing", version: 1, basedOn: 1 });
  expect(await rowOf(ana.orgId, "medrag")).toMatchObject({ state: "editing", version: 1, basedOn: 1 });
  const versions = await db.select().from(schema.benchPublicationVersions).where(eq(schema.benchPublicationVersions.bench, "medrag"));
  expect(versions).toHaveLength(1);
  expect(await readPublication(app)).toMatchObject({ state: "editing", version: 1, basedOn: 1 });

  // The editors and the question list work again.
  expect((await putFile(app, ana, "medrag/exam.jsonl", '{"input":"x","expected":"y"}\n')).status).toBe(200);
  expect((await app.request("/api/workspace/benchmark/question?bench=medrag&q=1", { method: "DELETE", headers: headers(ana) })).status).toBe(200);
  expect(removed).toEqual(["question:medrag#1"]);

  // The next publish is v2, and the list knows the benchmark is published again.
  const second = await publish(app, "medrag", "segunda versión");
  expect(second.status).toBe(200);
  expect(await second.json()).toMatchObject({ ok: true, version: 2 });
  expect(await rowOf(ana.orgId, "medrag")).toMatchObject({ state: "published", version: 2, basedOn: 1 });

  const list = (await (await app.request("/api/workspace/publications", { headers: headers(ana) })).json()) as {
    publications: { bench: string; state: string; version: number; basedOn: number | null; updatedAt: string }[];
  };
  expect(list.publications.map(({ updatedAt, ...rest }) => rest)).toEqual([{ bench: "medrag", state: "published", version: 2, basedOn: 1 }]);
  expect(new Date(list.publications[0].updatedAt).getTime()).toBeGreaterThan(0);
});

it("the container's own refusal answers PUBLISHED when the Worker's row fell behind", async () => {
  // The container has the benchmark published as v4; the Worker lost its rows.
  const state = { current: { state: "published", version: 4, basedOn: null } as ContainerState };
  const app = makeApp(() => fakeHermes({ published: state }).client);

  const write = await putFile(app, ana, "medrag/exam.jsonl", "no\n");
  expect(write.status).toBe(409);
  expect(await write.json()).toEqual({ error: "PUBLISHED", bench: "medrag" });
});

it("reverting a benchmark that is not published says so instead of pretending", async () => {
  const state = { current: null as ContainerState };
  const app = makeApp(() => fakeHermes({ published: state }).client);

  const never = await revert(app, "medrag");
  expect(never.status).toBe(200);
  expect(await never.json()).toEqual({ ok: false, error: { code: "not_published", message: "nunca publicado" } });
  expect(await rowOf(ana.orgId, "medrag")).toBeNull();

  await publish(app, "medrag");
  await revert(app, "medrag");
  const twice = await revert(app, "medrag");
  expect(twice.status).toBe(200);
  expect(await twice.json()).toMatchObject({ ok: false, error: { code: "not_published" } });
  // The row still says where it stands: a draft of v1, not an edit gone wrong.
  expect(await rowOf(ana.orgId, "medrag")).toMatchObject({ state: "editing", version: 1, basedOn: 1 });
});

it("another org's benchmark keeps its own publication state", async () => {
  const uni = { current: null as ContainerState };
  const otra = { current: null as ContainerState };
  const app = makeApp((orgId) => (orgId === ana.orgId ? fakeHermes({ published: uni }).client : fakeHermes({ published: otra }).client));
  await publish(app, "medrag");

  expect(await readPublication(app, ceci)).toMatchObject({ state: "draft", version: 0, basedOn: null, by: null });
  expect((await putFile(app, ceci, "medrag/exam.jsonl", "sí\n")).status).toBe(200);
  expect(otra.current).toBeNull();

  const list = (await (await app.request("/api/workspace/publications", { headers: headers(ceci) })).json()) as { publications: unknown[] };
  expect(list.publications).toEqual([]);
});

it("deleting a benchmark takes its publication with it", async () => {
  const state = { current: null as ContainerState };
  const { client, removed } = fakeHermes({ published: state });
  const app = makeApp(() => client);
  await publish(app, "medrag");
  await revert(app, "medrag");
  await publish(app, "medrag");

  const res = await app.request("/api/workspace/benchmark?bench=medrag", { method: "DELETE", headers: headers(ana) });
  expect(res.status).toBe(200);
  expect(removed).toEqual(["bench:medrag"]);
  expect(await rowOf(ana.orgId, "medrag")).toBeNull();
  expect(await db.select().from(schema.benchPublicationVersions).where(eq(schema.benchPublicationVersions.bench, "medrag"))).toEqual([]);
});

it("a benchmark that was never published reads as a draft and edits as before", async () => {
  const state = { current: null as ContainerState };
  const app = makeApp(() => fakeHermes({ published: state }).client);

  expect(await readPublication(app)).toEqual({ bench: "medrag", state: "draft", version: 0, basedOn: null, at: null, by: null, versions: [] });
  expect((await putFile(app, ana, "medrag/exam.jsonl", '{"input":"x","expected":"y"}\n')).status).toBe(200);
  expect((await app.request("/api/workspace/benchmark/question?bench=medrag&q=2", { method: "DELETE", headers: headers(ana) })).status).toBe(200);
});

it("refuses a bench that is not one folder name, a note that is too long, and an org with no agent", async () => {
  const state = { current: null as ContainerState };
  const app = makeApp(() => fakeHermes({ published: state }).client);

  expect((await publish(app, "../secret")).status).toBe(400);
  expect((await publish(app, "medrag", "x".repeat(501))).status).toBe(400);
  expect((await app.request("/api/workspace/publication?bench=../secret", { headers: headers(ana) })).status).toBe(400);
  expect((await revert(app, "medrag/../x")).status).toBe(400);

  const noAgent = makeApp(() => null);
  expect((await publish(noAgent, "medrag")).status).toBe(503);
  expect((await revert(noAgent, "medrag")).status).toBe(503);
});
