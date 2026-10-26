import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import schema from "../library/schema.sql?raw";
import { createLibraryApp } from "../src/library";

// Semantic search: the POST /api/library/semantic endpoint that finds papers
// by cosine similarity over pre-computed EmbeddingGemma-2 768-d embeddings.

const app = createLibraryApp({
  library: env.LIBRARY,
  files: env.LIBRARY_FILES,
  publicUrl: "https://getbenchy.lat",
  async authorize(request) {
    return !!request.headers.get("x-test-user");
  },
});

const post = (path: string, body: unknown, signedIn = true) =>
  app.request(path, {
    method: "POST",
    headers: {
      ...(signedIn ? { "x-test-user": "1" } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

/** Build a little-endian float32 BLOB from an array of numbers. */
function embeddingBlob(vec: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(vec.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < vec.length; i++) view.setFloat32(i * 4, vec[i], true);
  return buf;
}

/** A normalized 768-d vector with a spike at `index`. */
function spikeVec(index: number): number[] {
  const v = new Array(768).fill(0);
  v[index] = 1.0;
  return v;
}

beforeAll(async () => {
  const statements = schema
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sql of statements) await env.LIBRARY.prepare(sql).run();

  // Three papers: two with embeddings (spike at different dims), one without.
  const papers = [
    { id: 1001, title: "Glaciares patagónicos", pdf: "papers/001/1001.pdf", emb: spikeVec(0) },
    { id: 1002, title: "Ecología marina", pdf: null, emb: spikeVec(1) },
    { id: 1003, title: "Sin embedding", pdf: "papers/001/1003.pdf", emb: null },
  ];
  for (const p of papers) {
    const blob = p.emb ? embeddingBlob(p.emb) : null;
    await env.LIBRARY.prepare(
      "INSERT INTO papers (id, title, creators, subjects, description, date, year, type, language, publisher, rights, pdf, embedding) VALUES (?, ?, '[]', '[]', 'desc', '2024', 2024, 'article', 'spa', '', '', ?, ?)",
    )
      .bind(p.id, p.title, p.pdf, blob)
      .run();
  }
  await env.LIBRARY.prepare(
    "INSERT INTO papers_fts(rowid, title, creators, subjects, description) SELECT id, title, creators, subjects, description FROM papers",
  ).run();
  await env.LIBRARY.prepare("INSERT INTO library_meta (key, value) VALUES ('papers', '3'), ('with_pdf', '2'), ('snapshot', '2026-10-11')").run();
});

it("rejects semantic search without auth", async () => {
  const res = await post("/api/library/semantic", { vector: spikeVec(0) }, false);
  expect(res.status).toBe(401);
});

it("rejects invalid vectors", async () => {
  // Not an array
  expect((await post("/api/library/semantic", { vector: "hello" })).status).toBe(400);
  // Wrong dimension
  expect((await post("/api/library/semantic", { vector: [1, 2, 3] })).status).toBe(400);
  // Missing vector
  expect((await post("/api/library/semantic", {})).status).toBe(400);
  // Contains non-finite
  const bad = spikeVec(0);
  bad[5] = NaN;
  expect((await post("/api/library/semantic", { vector: bad })).status).toBe(400);
});

it("finds papers by cosine similarity, sorted by score", async () => {
  const res = await post("/api/library/semantic", { vector: spikeVec(0) });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { papers: { id: number; score: number; title: string }[] };
  // Paper 1001 has spike at 0 → score 1.0; paper 1002 spike at 1 → score 0.0.
  // Paper 1003 has no embedding → excluded.
  expect(data.papers.length).toBe(2);
  expect(data.papers[0]).toMatchObject({ id: 1001, score: 1 });
  expect(data.papers[1]).toMatchObject({ id: 1002, score: 0 });
  // Each result has the standard hit fields.
  expect(data.papers[0]).toHaveProperty("title");
  expect(data.papers[0]).toHaveProperty("hasPdf");
  expect(data.papers[0]).toHaveProperty("excerpt");
});

it("respects pdf filter", async () => {
  const res = await post("/api/library/semantic", { vector: spikeVec(1), pdf: true });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { papers: { id: number }[] };
  // Paper 1002 (spike at 1, score=1) has no PDF → filtered out; only 1001 remains.
  expect(data.papers.map((p) => p.id)).toEqual([1001]);
});

it("respects k parameter", async () => {
  const res = await post("/api/library/semantic", { vector: spikeVec(0), k: 1 });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { papers: { id: number }[] };
  expect(data.papers.length).toBe(1);
  expect(data.papers[0].id).toBe(1001);
});
