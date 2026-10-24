import { Hono } from "hono";

// The paper library: CONICET Digital's publications (UNRN/ri-conicet), plus
// papers from CONICET's BICyT/SIGEVA records that are not in the repository,
// in their own D1 database (schema and import: apps/api/library/). Their PDFs
// are either in the Hugging Face dataset or in our KV namespace. Anyone signed
// in may search it, and so may an org's agent with its key; the papers are
// public. Adding one to a benchmark goes through the org's agent, which
// fetches the PDF.

export type LibraryDeps = {
  library: D1Database;
  /** PDFs of papers that are not in the dataset (keys like bicyt/<id>.pdf). */
  files: KVNamespace;
  /** A signed-in researcher, or an org's agent with its key. */
  authorize: (request: Request) => Promise<boolean>;
  /** This site's origin, for links to PDFs the Worker serves. */
  publicUrl: string;
};

export const PAGE_SIZE = 20;
/** Broad queries rank only their newest matches; ranking 70k rows per keystroke is not worth it. */
const CANDIDATES = 4000;
const COUNT_CAP = 1000;
const AUTHOR_POOL = 400;
const DATASET = "https://huggingface.co/datasets/UNRN/ri-conicet/resolve/main/";

export type PaperRow = {
  id: number;
  origin: string;
  url: string | null;
  title: string;
  creators: string;
  subjects: string;
  description: string;
  date: string;
  year: number | null;
  type: string;
  language: string;
  publisher: string;
  rights: string;
  pdf: string | null;
};

export type Paper = {
  id: number;
  /** "conicet" (CONICET Digital) or "bicyt" (a BICyT/SIGEVA record not in the repository). */
  origin: string;
  title: string;
  creators: string[];
  subjects: string[];
  description: string;
  date: string;
  year: number | null;
  type: string;
  language: string;
  publisher: string;
  rights: string;
  /** The open-access PDF (Hugging Face, or this Worker for the files we keep); null when the paper has none. */
  pdfUrl: string | null;
  /** EmbeddingGemma-2 768d vector from the dataset, base64-encoded (null if not computed). */
  embedding: string | null;
  /** The paper's record: CONICET Digital, or its BICyT page. */
  url: string;
};

// Too common to narrow anything; dropped unless they are all the query has.
const STOPWORDS = new Set(
  (
    "a al and as at by con de del el en for from in is la las los of on or para por the to un una y with " +
    "e o u da do das dos em no na nos nas le les des du et"
  ).split(" "),
);

/** Lowercase, no accents: "Chávez" and "chavez" are the same name. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** Base64-encode an ArrayBuffer (D1 BLOB column) without spreading. */
function encodeBlob(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}


/**
 * Is every word of the author box in one and the same author? FTS matches the
 * authors as one text, so "Chávez Martín" also finds a paper by Martín X and
 * Chávez Y; those go after the papers by Chávez, Martín.
 */
export function byThatAuthor(creators: string[], author: string): 0 | 1 | 2 {
  const wanted = terms(fold(author));
  if (!wanted.length) return 0;
  let best: 0 | 1 | 2 = 0;
  for (const c of creators) {
    const words = terms(fold(c));
    // 2: every word is one of theirs (Martín); 1: a start of one (Martínez).
    if (wanted.every((w) => words.includes(w))) return 2;
    if (wanted.every((w) => words.some((x) => (w.length >= 3 ? x.startsWith(w) : x === w)))) best = 1;
  }
  return best;
}

function terms(text: string): string[] {
  return (text.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12);
}

/**
 * The FTS5 query for a search box and an optional author box, or null if
 * neither has a usable word. Words are quoted (no FTS syntax gets through);
 * longer words also match as prefixes (glaciar → glaciares).
 */
export function ftsQuery(q: string, author = ""): string | null {
  const words = terms(q);
  const useful = words.filter((w) => !STOPWORDS.has(w));
  const parts = (useful.length ? useful : words).slice(0, 8).map((w) => (w.length >= 4 ? `"${w}"*` : `"${w}"`));
  const names = terms(author)
    .slice(0, 6)
    .map((w) => (w.length >= 3 ? `"${w}"*` : `"${w}"`));
  if (names.length) parts.push(`creators : (${names.join(" AND ")})`);
  // Explicit AND: FTS5 rejects an implicit one before a column filter.
  return parts.length ? parts.join(" AND ") : null;
}

type Hit = { id: number; origin: string; title: string; creators: string; year: number | null; type: string; language: string; has_pdf: number; excerpt: string };

function list(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** A search result as the app and the agent read it. */
function hit(h: Hit) {
  return {
    id: h.id,
    origin: h.origin,
    title: h.title,
    creators: list(h.creators),
    year: h.year,
    type: h.type,
    language: h.language,
    hasPdf: h.has_pdf === 1,
    excerpt: h.excerpt,
  };
}

const FILE_KEY = /^[a-z]+\/\d+\.pdf$/;

function pdfUrl(pdf: string | null, publicUrl: string): string | null {
  if (!pdf) return null;
  if (/^papers\/\d{3}\/\d+\.pdf$/.test(pdf)) return DATASET + pdf;
  const key = pdf.replace(/^files\//, "");
  return pdf.startsWith("files/") && FILE_KEY.test(key) ? `${publicUrl}/api/library/files/${key}` : null;
}

export function toPaper(r: PaperRow, publicUrl: string): Paper {
  return {
    id: r.id,
    origin: r.origin ?? "conicet",
    title: r.title,
    creators: list(r.creators),
    subjects: list(r.subjects),
    description: r.description,
    date: r.date,
    year: r.year,
    type: r.type,
    language: r.language,
    publisher: r.publisher,
    rights: r.rights,
    pdfUrl: pdfUrl(r.pdf, publicUrl),
    embedding: r.embedding ? encodeBlob(r.embedding as ArrayBuffer) : null,
    url: r.url ?? `https://ri.conicet.gov.ar/handle/11336/${r.id}`,
  };
}

/** One paper, or null. Shared with the route that adds a paper to a benchmark. */
export async function getPaper(library: D1Database, id: number, publicUrl: string): Promise<Paper | null> {
  const row = await library.prepare("SELECT * FROM papers WHERE id = ?").bind(id).first<PaperRow>();
  return row ? toPaper(row, publicUrl) : null;
}

export function createLibraryApp(deps: LibraryDeps) {
  const app = new Hono();

  app.use("/api/library/*", async (c, next) => {
    if (!(await deps.authorize(c.req.raw))) return c.json({ error: "UNAUTHENTICATED" }, 401);
    await next();
  });

  app.get("/api/library/search", async (c) => {
    const match = ftsQuery(c.req.query("q") ?? "", c.req.query("author") ?? "");
    const pdfOnly = c.req.query("pdf") === "1" ? 1 : 0;
    const page = Math.max(0, Math.min(Number.parseInt(c.req.query("page") ?? "0", 10) || 0, CANDIDATES / PAGE_SIZE - 1));
    if (!match) {
      // Nothing typed: the newest papers, so a list is there before any search.
      const [newest, meta] = await deps.library.batch([
        deps.library
          .prepare(
            `SELECT id, origin, title, creators, year, type, language, pdf IS NOT NULL AS has_pdf, substr(description, 1, 320) AS excerpt
             FROM papers WHERE ?1 = 0 OR pdf IS NOT NULL ORDER BY rowid DESC LIMIT ?2 OFFSET ?3`,
          )
          .bind(pdfOnly, PAGE_SIZE, page * PAGE_SIZE),
        deps.library.prepare("SELECT value FROM library_meta WHERE key = ?1").bind(pdfOnly ? "with_pdf" : "papers"),
      ]);
      const total = Number((meta.results[0] as { value: string } | undefined)?.value ?? 0);
      return c.json({ total, more: false, page, pageSize: PAGE_SIZE, papers: (newest.results as Hit[]).map(hit) });
    }
    const author = (c.req.query("author") ?? "").trim();
    // With an author, rank the first AUTHOR_POOL here, that author's papers first.
    const [limit, offset] = author ? [AUTHOR_POOL, 0] : [PAGE_SIZE, page * PAGE_SIZE];

    // Rank the newest matches, then keep those with a PDF if asked: a join
    // inside the ranking makes broad queries several times slower.
    const [hits, count] = await deps.library.batch([
      deps.library
        .prepare(
          `WITH hits AS (
             SELECT rowid AS id, bm25(papers_fts, 10.0, 6.0, 3.0, 1.0) AS score
             FROM papers_fts WHERE papers_fts MATCH ?1
             ORDER BY rowid DESC LIMIT ${CANDIDATES}
           )
           SELECT p.id, p.origin, p.title, p.creators, p.year, p.type, p.language, p.pdf IS NOT NULL AS has_pdf,
                  substr(p.description, 1, 320) AS excerpt
           FROM hits JOIN papers p ON p.id = hits.id
           WHERE ?2 = 0 OR p.pdf IS NOT NULL
           ORDER BY hits.score LIMIT ?3 OFFSET ?4`,
        )
        .bind(match, pdfOnly, limit, offset),
      pdfOnly
        ? deps.library
            .prepare(
              `SELECT count(*) AS n FROM (
                 SELECT 1 FROM papers_fts f JOIN papers p ON p.id = f.rowid
                 WHERE papers_fts MATCH ?1 AND p.pdf IS NOT NULL LIMIT ${COUNT_CAP + 1}
               )`,
            )
            .bind(match)
        : deps.library.prepare("SELECT count(*) AS n FROM papers_fts WHERE papers_fts MATCH ?1").bind(match),
    ]);
    const total = (count.results[0] as { n: number } | undefined)?.n ?? 0;
    let rows = hits.results as Hit[];
    if (author) {
      // A stable sort keeps the FTS rank within each tier.
      const tier = new Map(rows.map((h) => [h.id, byThatAuthor(list(h.creators), author)]));
      rows = [...rows].sort((a, b) => tier.get(b.id)! - tier.get(a.id)!).slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    }
    return c.json({
      // With the PDF filter the count stops at COUNT_CAP: "more than 1.000".
      total: pdfOnly ? Math.min(total, COUNT_CAP) : total,
      more: pdfOnly === 1 && total > COUNT_CAP,
      page,
      pageSize: PAGE_SIZE,
      papers: rows.map(hit),
    });
  });

  // How big the library is and how fresh, as of its last import (no table scan).
  app.get("/api/library/stats", async (c) => {
    const { results } = await deps.library.prepare("SELECT key, value FROM library_meta").all<{ key: string; value: string }>();
    const meta = new Map(results.map((r) => [r.key, r.value]));
    return c.json({ papers: Number(meta.get("papers") ?? 0), withPdf: Number(meta.get("with_pdf") ?? 0), snapshot: meta.get("snapshot") ?? null });
  });

  app.get("/api/library/papers/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: "NOT_FOUND" }, 404);
    const paper = await getPaper(deps.library, id, deps.publicUrl);
    return paper ? c.json(paper) : c.json({ error: "NOT_FOUND" }, 404);
  });

  // PDFs we keep ourselves (papers not in the dataset), for the reader and the agent.
  app.get("/api/library/files/:folder/:name", async (c) => {
    const key = `${c.req.param("folder")}/${c.req.param("name")}`;
    if (!FILE_KEY.test(key)) return c.json({ error: "NOT_FOUND" }, 404);
    const body = await deps.files.get(key, "stream");
    if (!body) return c.json({ error: "NOT_FOUND" }, 404);
    return new Response(body, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${c.req.param("name")}"`,
        "cache-control": "private, max-age=3600",
      },
    });
  });

  return app;
}
