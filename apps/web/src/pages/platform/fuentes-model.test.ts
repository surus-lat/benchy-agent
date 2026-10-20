import { expect, it } from "vitest";
import { coverage, coverageNote, pickedFromSources, sourceOfPaper } from "./fuentes-model";
import { togglePaper, type PickedPaper } from "./new-bench-model";
import type { Source } from "./library-data";

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

it("words the collection summary, empty and mixed", () => {
  expect(coverageNote(coverage([]))).toBe("");
  expect(coverageNote(coverage([conicet]))).toBe("1 con texto completo");
  expect(coverageNote(coverage([bicyt]))).toBe("1 solo con el resumen");
  expect(coverageNote(coverage([conicet, bicyt, upload]))).toBe("2 con texto completo · 1 solo con el resumen");
});
