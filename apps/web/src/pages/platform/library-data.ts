// The paper library (CONICET Digital, through the Worker's /api/library) and
// a benchmark's papers: the sources its questions are written from, kept by
// the org's agent in <bench>/sources.json and <bench>/sources/<id>.md.

import { ApiError } from "../app/api";

export type LibraryHit = {
  id: number;
  /** "conicet" (CONICET Digital) or "bicyt" (a BICyT record not in the repository). */
  origin: string;
  title: string;
  creators: string[];
  year: number | null;
  type: string;
  language: string;
  hasPdf: boolean;
  excerpt: string;
};

export type SearchResult = { total: number; more: boolean; page: number; pageSize: number; papers: LibraryHit[] };

export type Paper = {
  id: number;
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
  pdfUrl: string | null;
  url: string;
};

export type LibraryStats = { papers: number; withPdf: number; snapshot: string | null };

/** A paper in a benchmark (sources.json). */
export type Source = {
  id: string;
  origin: "conicet" | "bicyt" | "upload";
  title: string;
  authors: string[];
  year: number | null;
  url: string | null;
  pdf_url: string | null;
  file: string;
  pages: number;
  chars: number;
  text: "full" | "abstract";
  added: number;
};

export type SourceResult = { ok: true; source: Source } | { ok: false; error: { code: string; message: string } };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, credentials: "same-origin" });
  } catch {
    throw new ApiError("NETWORK", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `HTTP_${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export const library = {
  search: (q: { q: string; author: string; pdf: boolean; page: number }) => {
    const params = new URLSearchParams({ q: q.q, author: q.author, page: String(q.page) });
    if (q.pdf) params.set("pdf", "1");
    return call<SearchResult>(`/api/library/search?${params}`);
  },
  paper: (id: number) => call<Paper>(`/api/library/papers/${id}`),
  stats: () => call<LibraryStats>("/api/library/stats"),
};

export const sources = {
  add: (bench: string, paperId: number) =>
    call<SourceResult>("/api/workspace/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bench, paperId }),
    }),
  upload: (bench: string, file: File) =>
    call<SourceResult>(`/api/workspace/sources/upload?bench=${encodeURIComponent(bench)}&name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: file,
    }),
  remove: (bench: string, id: string) =>
    call<{ ok: boolean }>(`/api/workspace/sources?bench=${encodeURIComponent(bench)}&id=${encodeURIComponent(id)}`, { method: "DELETE" }),
};

/** The library paper a benchmark's source came from (conicet-179477 → 179477); an uploaded PDF has none. */
export function libraryId(s: Source): number | null {
  const m = /^(?:conicet|bicyt)-(\d+)$/.exec(s.id);
  return m ? Number(m[1]) : null;
}

/** An item of the org's checklist for validating new material before the agent
 *  writes questions from it. Seeded with the placeholder list; the org edits it. */
export type ChecklistItem = { id: string; label: string };
/** One source's validation: which items were ticked, and who completed it and
 *  when (null while pending). */
export type SourceValidation = { sourceId: string; checked: string[]; validatedAt: string | null; validatedByName: string | null };

export const validation = {
  checklist: () => call<{ items: ChecklistItem[] }>("/api/org/source-checklist"),
  saveChecklist: (items: { id?: string; label: string }[]) =>
    call<{ items: ChecklistItem[] }>("/api/org/source-checklist", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
    }),
  forBench: (bench: string) =>
    call<{ validations: SourceValidation[] }>(`/api/workspace/sources/validation?bench=${encodeURIComponent(bench)}`),
  setChecked: (bench: string, sourceId: string, checked: string[]) =>
    call<{ validation: SourceValidation }>("/api/workspace/sources/validation", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bench, sourceId, checked }),
    }),
};

/** A source's validation state. A source without a row predates this feature:
 *  it counts as validated (grandfathered); only material added from the
 *  platform afterwards starts pending. */
export function sourceState(v: SourceValidation | undefined): "validated" | "pending" {
  return !v || v.validatedAt ? "validated" : "pending";
}

export function parseSources(text: string | null | undefined): Source[] {
  if (!text) return [];
  try {
    const list = (JSON.parse(text) as { sources?: unknown }).sources;
    return Array.isArray(list) ? list.filter((s): s is Source => !!s && typeof s === "object" && typeof (s as Source).id === "string") : [];
  } catch {
    return [];
  }
}

/** "conicet-179477 p. 4" → the paper it cites and the page, if the benchmark has that paper. */
export function citation(text: string, list: Source[]): { source: Source; page: string | null } | null {
  const m = text.trim().match(/^((?:conicet|bicyt|pdf)-[a-z0-9-]+?)(?:[\s,;:]+(?:p(?:ág)?\.?|pp?\.)\s*([\d–-]+))?\s*$/i);
  if (!m) return null;
  const source = list.find((s) => s.id === m[1].toLowerCase());
  return source ? { source, page: m[2] ?? null } : null;
}

/** "Cassiodoro, G. E.; Goñi, R. y 3 más" */
export function authorsLine(names: string[], max = 3): string {
  if (names.length === 0) return "Sin autores registrados";
  const shown = names.slice(0, max).join("; ");
  return names.length > max ? `${shown} y ${names.length - max} más` : shown;
}

export const TYPE_LABEL: Record<string, string> = {
  article: "Artículo",
  thesis: "Tesis doctoral",
  book: "Libro",
  dataset: "Datos",
  other: "Publicación",
};

export const LANGUAGE_LABEL: Record<string, string> = { spa: "Español", eng: "Inglés", por: "Portugués", fra: "Francés", ita: "Italiano", deu: "Alemán" };

export function libraryErrorText(code: string): string {
  switch (code) {
    case "bench_not_found":
      return "No encontramos ese benchmark en el workspace.";
    case "pdf_unavailable":
      return "No pudimos bajar el PDF. Probá de nuevo en un momento.";
    case "pdf_too_large":
    case "TOO_LARGE":
      return "El PDF pesa demasiado (máximo 24 MB).";
    case "no_text":
      return "El PDF no tiene texto extraíble: probablemente está escaneado.";
    case "unreadable_pdf":
    case "not_pdf":
    case "NOT_PDF":
      return "No pudimos leer ese archivo como PDF.";
    case "PAPER_NOT_FOUND":
      return "Ese paper ya no está en la biblioteca.";
    default:
      return "No se pudo agregar el paper. Probá de nuevo en un momento.";
  }
}
