import { describe, expect, it } from "vitest";
import { coverage, coverageNote, mergeBuckets, pickedFromSources, searchTerms, sourceOfPaper, suggestedQuery, MAX_SEARCH_TERMS } from "./fuentes-model";
import { togglePaper, type PickedPaper } from "./new-bench-model";
import type { LibraryHit, Source } from "./library-data";

const conicet: Source = {
  id: "conicet-179477",
  origin: "conicet",
  title: "Paisajes mesetarios en Patagonia",
  authors: ["Cassiodoro, Gisela Eva"],
  year: 2016,
  url: "https://ri.conicet.gov.ar/handle/11336/179477",
  pdf_url: null,
  file: "sources/conicet-179477.md",
  pages: 22,
  chars: 64022,
  text: "full",
  added: 1,
};
const bicyt: Source = { ...conicet, id: "bicyt-12599897", origin: "bicyt", title: "Sin texto completo", text: "abstract", added: 2 };
const upload: Source = { ...conicet, id: "pdf-mi-paper-6d7fd460", origin: "upload", title: "Mi paper", url: null, added: 3 };

it("shows the benchmark's library papers as the picker's chosen list, uploads aside", () => {
  expect(pickedFromSources([conicet, bicyt, upload])).toEqual([
    { id: 179477, title: conicet.title, creators: conicet.authors, year: 2016, hasPdf: true },
    { id: 12599897, title: bicyt.title, creators: bicyt.authors, year: 2016, hasPdf: false },
  ]);
  expect(pickedFromSources([])).toEqual([]);
  expect(pickedFromSources([upload])).toEqual([]);
});

it("finds the source a picked paper toggles out of the benchmark", () => {
  const paper: PickedPaper = { id: 179477, title: conicet.title, creators: conicet.authors, year: 2016 };
  expect(sourceOfPaper([conicet, upload], paper)).toBe(conicet);
  expect(sourceOfPaper([upload], paper)).toBeUndefined();
  expect(sourceOfPaper([conicet], { ...paper, id: 999 })).toBeUndefined();
});

it("toggles a paper against the sources the same way the wizard toggles its list", () => {
  const paper: PickedPaper = { id: 179477, title: conicet.title, creators: conicet.authors, year: 2016 };
  const picked = pickedFromSources([conicet]);
  // Toggling off an elegido leaves the list empty; toggling on adds it back once.
  expect(togglePaper(picked, paper)).toEqual([]);
  expect(togglePaper([], paper).map((p) => p.id)).toEqual([179477]);
});

it("summarizes what the collection hands the agent: full texts vs abstracts only", () => {
  expect(coverage([])).toEqual({ total: 0, full: 0, abstract: 0 });
  expect(coverage([conicet])).toEqual({ total: 1, full: 1, abstract: 0 });
  expect(coverage([conicet, bicyt, upload])).toEqual({ total: 3, full: 2, abstract: 1 });
});

it("does not count papers still being read (or that failed) as text the agent has", () => {
  const reading: Source = { ...conicet, id: "conicet-55", status: "reading", text: undefined, pages: undefined, chars: undefined };
  const failed: Source = { ...reading, id: "conicet-56", status: "failed", error: { code: "pdf_unavailable", message: "no se pudo bajar" } };
  expect(coverage([reading, failed, conicet])).toEqual({ total: 1, full: 1, abstract: 0 });
});

it("words the collection summary, empty and mixed", () => {
  expect(coverageNote(coverage([]))).toBe("");
  expect(coverageNote(coverage([conicet]))).toBe("1 con texto completo");
  expect(coverageNote(coverage([bicyt]))).toBe("1 solo con el resumen");
  expect(coverageNote(coverage([conicet, bicyt, upload]))).toBe("2 con texto completo · 1 solo con el resumen");
});

const hit = (id: number, origin: string, title: string): LibraryHit => ({
  id,
  origin,
  title,
  creators: ["Autora, A."],
  year: 2020,
  type: "article",
  language: "spa",
  hasPdf: true,
  excerpt: "",
});

describe("search box with several terms", () => {
  it("reads one term as typed and a comma-separated box as several searches", () => {
    expect(searchTerms("reciprocidad ritual andina")).toEqual(["reciprocidad ritual andina"]);
    expect(searchTerms("ritual, domesticidad andina")).toEqual(["ritual", "domesticidad andina"]);
    // Spaces around a term are noise; a term of one word still counts.
    expect(searchTerms("  ritual ,\n domesticidad ; ritual ")).toEqual(["ritual", "domesticidad"]);
    expect(searchTerms("ritual,, ,domesticidad")).toEqual(["ritual", "domesticidad"]);
    expect(searchTerms("   ")).toEqual([]);
    // Same word twice is one search, whatever the case.
    expect(searchTerms("Ritual, ritual")).toEqual(["Ritual"]);
    expect(searchTerms(Array.from({ length: 12 }, (_, i) => `t${i}`).join(", "))).toHaveLength(MAX_SEARCH_TERMS);
  });

  it("puts several searches together: one row per paper, and which term found it", () => {
    const merged = mergeBuckets([
      { term: "ritual", total: 3, papers: [hit(1, "conicet", "A"), hit(2, "conicet", "B"), hit(4, "conicet", "D")] },
      { term: "domesticidad", total: 2, papers: [hit(2, "conicet", "B"), hit(3, "bicyt", "C")] },
    ]);
    // Each term's page before the next page of any term: a broad term does not
    // bury a narrow one below the fold. B was found by both, and says so.
    expect(merged.papers.map((p) => p.title)).toEqual(["A", "B", "C", "D"]);
    expect(merged.papers.map((p) => p.via)).toEqual([["ritual"], ["domesticidad", "ritual"], ["domesticidad"], ["ritual"]]);
    expect(merged.total).toBe(5);
    expect(merged.more).toBe(false);
  });

  it("keeps conicet and bicyt papers apart, and knows when a term has more pages", () => {
    const merged = mergeBuckets([
      { term: "a", total: 50, papers: [hit(7, "conicet", "Misma id en otra fuente")] },
      { term: "b", total: 1, papers: [hit(7, "bicyt", "Misma id en otra fuente")] },
    ]);
    expect(merged.papers).toHaveLength(2);
    // "a" has 50 and only one loaded; "b" is done.
    expect(merged.more).toBe(true);
    expect(mergeBuckets([{ term: "b", total: 1, papers: [hit(7, "bicyt", "x")] }]).more).toBe(false);
    expect(mergeBuckets([])).toEqual({ papers: [], total: 0, more: false });
  });
});

describe("the design's keywords as the first search", () => {
  it("applies them as one comma-separated query", () => {
    expect(suggestedQuery(["reciprocidad ritual", "domesticidad andina"], null)).toBe("reciprocidad ritual, domesticidad andina");
    // A design without keywords leaves the box empty, as always.
    expect(suggestedQuery([], null)).toBe("");
    // The researcher dismissed this exact set: it does not come back. New
    // keywords, though, suggest themselves again.
    expect(suggestedQuery(["ritual"], "ritual")).toBe("");
    expect(suggestedQuery(["ritual", "domesticidad"], "ritual")).toBe("ritual, domesticidad");
  });
});
