import { libraryId, type Source } from "./library-data";
import type { PickedPaper } from "./new-bench-model";

// The Fuentes screen's model: how the benchmark's sources (sources.json)
// appear in the shared library picker. Sources that came from the library
// (conicet, bicyt) are the picker's chosen list; an uploaded PDF has no
// library id, so it shows in the screen's own list but never in the search.

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

/** What the collection hands the agent: full texts it can cite page-by-page vs abstracts only. */
export function coverage(list: Source[]): { total: number; full: number; abstract: number } {
  let full = 0;
  for (const s of list) if (s.text === "full") full++;
  return { total: list.length, full, abstract: list.length - full };
}

/** The collection's one-line summary for the panel head: "2 con texto completo · 1 solo con el resumen". */
export function coverageNote(cov: { total: number; full: number; abstract: number }): string {
  if (cov.total === 0) return "";
  const parts: string[] = [];
  if (cov.full > 0) parts.push(`${cov.full} con texto completo`);
  if (cov.abstract > 0) parts.push(`${cov.abstract} solo con el resumen`);
  return parts.join(" · ");
}
