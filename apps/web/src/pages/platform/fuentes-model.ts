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
