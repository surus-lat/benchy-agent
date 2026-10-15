import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import schema from "../library/schema.sql?raw";
import { createLibraryApp, ftsQuery } from "../src/library";

// The paper library: the query a search box becomes, and the routes over the
// real schema (apps/api/library/schema.sql) with three papers in it.

const app = createLibraryApp({
  library: env.LIBRARY,
  async currentUser(request) {
    return request.headers.get("x-test-user") ? { id: "user_ana" } : null;
  },
});

const get = (path: string, signedIn = true) => app.request(path, { headers: signedIn ? { "x-test-user": "1" } : {} });

const PAPERS = [
  [179477, "Paisajes mesetarios en Patagonia", ["Cassiodoro, Gisela Eva"], ["Arqueología"], "Recursos hídricos en la meseta.", "2016-12", 2016, "papers/089/179477.pdf"],
  [116972, "Distancias entre la ecología y la praxis ambiental", ["Nuñez, Paula Gabriela"], ["Ecofeminismo"], "Poblaciones humanas y sus entornos.", "2011", 2011, null],
  [11651, "Habitantes microscópicos de los glaciares", ["de Garcia, Virginia"], ["Levaduras"], "Levaduras en glaciares patagónicos.", "2014", 2014, "papers/005/11651.pdf"],
] as const;

beforeAll(async () => {
  const statements = schema
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sql of statements) await env.LIBRARY.prepare(sql).run();
  for (const [id, title, creators, subjects, description, date, year, pdf] of PAPERS) {
    await env.LIBRARY.prepare(
      "INSERT INTO papers (id, title, creators, subjects, description, date, year, type, language, publisher, rights, pdf) VALUES (?, ?, ?, ?, ?, ?, ?, 'article', 'spa', '', '', ?)",
    )
      .bind(id, title, JSON.stringify(creators), JSON.stringify(subjects), description, date, year, pdf)
      .run();
  }
  await env.LIBRARY.prepare(
    "INSERT INTO papers_fts(rowid, title, creators, subjects, description) SELECT id, title, creators, subjects, description FROM papers",
  ).run();
  await env.LIBRARY.prepare("INSERT INTO library_meta (key, value) VALUES ('papers', '3'), ('with_pdf', '2'), ('snapshot', '2026-10-11')").run();
});

it("turns what a researcher types into a quoted FTS query, never raw syntax", () => {
  expect(ftsQuery("Glaciares de la Patagonia")).toBe('"glaciares"* AND "patagonia"*');
  expect(ftsQuery("the")).toBe('"the"');
  expect(ftsQuery('agua" OR title:*')).toBe('"agua"* AND "title"*');
  expect(ftsQuery("", "Núñez, Paula")).toBe('creators : ("núñez"* AND "paula"*)');
  expect(ftsQuery("ADN", "li")).toBe('"adn" AND creators : ("li")');
  expect(ftsQuery("  ¿? ")).toBeNull();
});

it("searches signed-in only, ignoring accents, by words, authors and PDF", async () => {
  expect((await get("/api/library/search?q=glaciar", false)).status).toBe(401);
  expect((await get("/api/library/search?q=")).status).toBe(400);

  const glaciar = (await (await get("/api/library/search?q=glaciar")).json()) as { total: number; papers: { id: number; hasPdf: boolean }[] };
  expect(glaciar.total).toBe(1);
  expect(glaciar.papers[0]).toMatchObject({ id: 11651, hasPdf: true });

  const hidricos = (await (await get("/api/library/search?q=HIDRICOS")).json()) as { papers: { id: number; creators: string[] }[] };
  expect(hidricos.papers.map((p) => p.id)).toEqual([179477]);
  expect(hidricos.papers[0].creators).toEqual(["Cassiodoro, Gisela Eva"]);

  const author = (await (await get("/api/library/search?author=nunez%20paula")).json()) as { papers: { id: number }[] };
  expect(author.papers.map((p) => p.id)).toEqual([116972]);
  // A topic and an author together (FTS5 needs the explicit AND before the column filter).
  const both = (await (await get("/api/library/search?q=meseta&author=cassiodoro")).json()) as { papers: { id: number }[] };
  expect(both.papers.map((p) => p.id)).toEqual([179477]);
  const withPdf = (await (await get("/api/library/search?author=nunez&pdf=1")).json()) as { total: number; papers: unknown[] };
  expect(withPdf).toMatchObject({ total: 0, papers: [] });
});

it("says how big and how fresh the library is", async () => {
  expect((await get("/api/library/stats", false)).status).toBe(401);
  expect(await (await get("/api/library/stats")).json()).toEqual({ papers: 3, withPdf: 2, snapshot: "2026-10-11" });
});

it("shows one paper with its PDF and repository links", async () => {
  expect((await get("/api/library/papers/179477", false)).status).toBe(401);
  expect((await get("/api/library/papers/999")).status).toBe(404);
  expect((await get("/api/library/papers/abc")).status).toBe(404);
  expect(await (await get("/api/library/papers/179477")).json()).toMatchObject({
    id: 179477,
    subjects: ["Arqueología"],
    pdfUrl: "https://huggingface.co/datasets/UNRN/ri-conicet/resolve/main/papers/089/179477.pdf",
    url: "https://ri.conicet.gov.ar/handle/11336/179477",
  });
  expect(await (await get("/api/library/papers/116972")).json()).toMatchObject({ pdfUrl: null });
});
