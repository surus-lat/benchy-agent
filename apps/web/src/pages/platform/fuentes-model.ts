import { libraryId, type LibraryHit, type Source } from "./library-data";
import type { PickedPaper } from "./new-bench-model";

// The Fuentes screen's model: how the benchmark's sources (sources.json)
// appear in the shared library picker. Sources that came from the library
// (conicet, bicyt) are the picker's chosen list; an uploaded PDF has no
// library id, so it shows in the screen's own list but never in the search.

// The search box also holds a list: several terms separated by comma, each
// searched on its own and put together. The library reads words as AND, so
// "ritual, domesticidad" as one query would ask for papers about both at once
// and usually answer none — the terms have to be searched one by one.

/** More than this and the screen waits on too many requests at once. */
export const MAX_SEARCH_TERMS = 6;
/** What the Worker will page through for one term (its own CANDIDATES cap). */
const MAX_PER_TERM = 1000;

/** The searches typed in the box: "ritual, domesticidad andina" is two. A box
 *  with no comma is one term, spaces and all. */
export function searchTerms(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,;\n]/)) {
    const term = part.trim().replace(/\s+/g, " ");
    if (!term || out.some((x) => x.toLowerCase() === term.toLowerCase())) continue;
    out.push(term);
    if (out.length === MAX_SEARCH_TERMS) break;
  }
  return out;
}

/** One term's page of results, as the library sent them. */
export type TermBucket = { term: string; total: number; papers: LibraryHit[] };

/** A hit plus the terms that found it: with several searches, the screen says
 *  which one brought the paper in. */
export type MatchedHit = LibraryHit & { via: string[] };

/**
 * Several searches as one list. A paper appears once, keeping the terms that
 * found it; the pages are taken in turn — first of each term, then second of
 * each — so a broad term does not bury a narrow one below the fold.
 */
export function mergeBuckets(buckets: TermBucket[]): { papers: MatchedHit[]; total: number; more: boolean } {
  const seen = new Map<string, MatchedHit>();
  const papers: MatchedHit[] = [];
  const deepest = Math.max(0, ...buckets.map((b) => b.papers.length));
  for (let i = 0; i < deepest; i++) {
    for (const b of buckets) {
      const hit = b.papers[i];
      if (!hit) continue;
      // conicet and bicyt number their papers separately: the pair is the paper.
      const known = seen.get(`${hit.origin}-${hit.id}`);
      if (known) {
        if (!known.via.includes(b.term)) known.via.push(b.term);
        continue;
      }
      const kept: MatchedHit = { ...hit, via: [b.term] };
      seen.set(`${hit.origin}-${hit.id}`, kept);
      papers.push(kept);
    }
  }
  return {
    papers,
    total: buckets.reduce((sum, b) => sum + b.total, 0),
    more: buckets.some((b) => b.papers.length < Math.min(b.total, MAX_PER_TERM)),
  };
}

/**
 * What the box starts with when the design has keywords: they are the design's
 * own searches, so they arrive applied — as a suggestion the researcher can
 * edit away. A set they already dismissed stays dismissed; new keywords (the
 * agent wrote the criteria again) suggest themselves once more.
 */
export function suggestedQuery(keywords: string[], dismissed: string | null): string {
  const joined = keywords.join(", ");
  return !joined || joined === dismissed ? "" : joined;
}

/** The benchmark's library papers as the picker's chosen list, in the order they were added. */
export function pickedFromSources(list: Source[]): PickedPaper[] {
  return list.flatMap((s) => {
    const id = libraryId(s);
    return id === null ? [] : [{ id, title: s.title, creators: s.authors, year: s.year, hasPdf: s.text === "full" }];
  });
}

/** The source a picked paper came from — the row "Sacar" (or the picker's toggle off) removes. */
export function sourceOfPaper(list: Source[], paper: PickedPaper): Source | undefined {
  return list.find((s) => libraryId(s) === paper.id);
}

/** What the collection hands the agent: full texts it can cite page-by-page vs
 *  abstracts only. Papers still being read (or that failed) are not yet text
 *  the agent can write from, so they are not counted here. */
export function coverage(list: Source[]): { total: number; full: number; abstract: number } {
  const settled = list.filter((s) => !s.status);
  let full = 0;
  for (const s of settled) if (s.text === "full") full++;
  return { total: settled.length, full, abstract: settled.length - full };
}

/** The collection's one-line summary for the panel head: "2 con texto completo · 1 solo con el resumen". */
export function coverageNote(cov: { total: number; full: number; abstract: number }): string {
  if (cov.total === 0) return "";
  const parts: string[] = [];
  if (cov.full > 0) parts.push(`${cov.full} con texto completo`);
  if (cov.abstract > 0) parts.push(`${cov.abstract} solo con el resumen`);
  return parts.join(" · ");
}
