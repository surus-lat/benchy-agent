import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import schema from "../library/schema.sql?raw";
import { byThatAuthor, createLibraryApp, ftsQuery } from "../src/library";
import { agentOrgFor } from "../src/agent-auth";

// The paper library: the query a search box becomes, and the routes over the
// real schema (apps/api/library/schema.sql) with three papers in it.

const app = createLibraryApp({
  library: env.LIBRARY,
  files: env.LIBRARY_FILES,
  publicUrl: "https://getbenchy.lat",
  async authorize(request) {
    return !!request.headers.get("x-test-user");
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
  // A BICyT record that is not in CONICET Digital, its PDF kept by us.
  await env.LIBRARY.prepare(
    "INSERT INTO papers (id, title, creators, subjects, description, date, year, type, language, publisher, rights, pdf, origin, url) VALUES (12599897, 'Mucho más que palabras', '[\"Chávez, Martín Nicolás\"]', '[\"Bariloche\"]', 'Tesis de sociolingüística.', '2025', 2025, 'article', 'spa', '', '', 'files/bicyt/12599897.pdf', 'bicyt', 'https://bicyt.conicet.gov.ar/fichas/produccion/12599897')",
  ).run();
  await env.LIBRARY_FILES.put("bicyt/12599897.pdf", "%PDF-1.4 test");
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

it("puts the papers of the author typed before papers by two people with those names", () => {
  expect(byThatAuthor(["Chavez, Martín Nicolás"], "Chávez Martín")).toBe(2);
  expect(byThatAuthor(["Misischia Bibiana", "Chavez, Martín Nicolás"], "martin chavez")).toBe(2);
  expect(byThatAuthor(["Martínez Chávez, Ana"], "Chávez Martín")).toBe(1);
  expect(byThatAuthor(["Martin, Gabriel Mario", "González Chávez, Baltazar"], "Chávez Martín")).toBe(0);
  expect(byThatAuthor(["Nuñez, Paula Gabriela"], "nunez")).toBe(2);
  expect(byThatAuthor(["Nuñez, Paula Gabriela"], "")).toBe(0);
});

it("searches signed-in only, ignoring accents, by words, authors and PDF", async () => {
  expect((await get("/api/library/search?q=glaciar", false)).status).toBe(401);
  // Nothing typed: the newest papers, the library's size as the total.
  const newest = (await (await get("/api/library/search?q=")).json()) as { total: number; papers: { id: number }[] };
  expect(newest.papers.length).toBeGreaterThan(1);
  expect(newest.papers.map((p) => p.id)).toEqual([...newest.papers.map((p) => p.id)].sort((a, b) => b - a));

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

it("serves papers that are not in CONICET Digital, with the PDF we keep", async () => {
  const mine = (await (await get("/api/library/search?author=chavez%20martin")).json()) as { papers: { id: number; origin: string; hasPdf: boolean }[] };
  expect(mine.papers).toEqual([expect.objectContaining({ id: 12599897, origin: "bicyt", hasPdf: true })]);
  expect(await (await get("/api/library/papers/12599897")).json()).toMatchObject({
    origin: "bicyt",
    url: "https://bicyt.conicet.gov.ar/fichas/produccion/12599897",
    pdfUrl: "https://getbenchy.lat/api/library/files/bicyt/12599897.pdf",
  });
  const pdf = await get("/api/library/files/bicyt/12599897.pdf");
  expect(pdf.headers.get("content-type")).toBe("application/pdf");
  expect(await pdf.text()).toBe("%PDF-1.4 test");
  expect((await get("/api/library/files/bicyt/12599897.pdf", false)).status).toBe(401);
  expect((await get("/api/library/files/bicyt/999.pdf")).status).toBe(404);
  expect((await get("/api/library/files/bicyt/..%2Fx.pdf")).status).toBe(404);
});

it("knows an org's agent by its key, and nothing else", () => {
  const endpoints = [
    { orgId: "org_surus", apiKeyRef: "AGENT_KEY_SURUS" },
    { orgId: "org_uni", apiKeyRef: "AGENT_KEY_UNI" },
    { orgId: "org_new", apiKeyRef: "AGENT_KEY_UNSET" },
  ];
  const secrets = { AGENT_KEY_SURUS: "s".repeat(64), AGENT_KEY_UNI: "u".repeat(64) };
  const call = (auth?: string) => new Request("https://x/api/library/stats", { headers: auth ? { authorization: auth } : {} });
  expect(agentOrgFor(call(`Bearer ${"u".repeat(64)}`), endpoints, secrets)).toBe("org_uni");
  expect(agentOrgFor(call(`Bearer ${"s".repeat(64)}`), endpoints, secrets)).toBe("org_surus");
  expect(agentOrgFor(call(`Bearer ${"s".repeat(63)}`), endpoints, secrets)).toBeNull();
  expect(agentOrgFor(call("Bearer short"), endpoints, secrets)).toBeNull();
  expect(agentOrgFor(call(), endpoints, secrets)).toBeNull();
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
