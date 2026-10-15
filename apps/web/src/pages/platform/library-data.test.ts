import { describe, expect, it } from "vitest";
import { authorsLine, citation, parseSources, type Source } from "./library-data";

const paper: Source = {
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
const upload: Source = { ...paper, id: "pdf-mi-paper-6d7fd460", origin: "upload", title: "Mi paper", url: null };

describe("citations in questions.json", () => {
  it("resolves a paper id and page the agent wrote, in the forms it writes them", () => {
    expect(citation("conicet-179477 p. 4", [paper])).toEqual({ source: paper, page: "4" });
    expect(citation("conicet-179477, pp. 4-6", [paper])).toEqual({ source: paper, page: "4-6" });
    expect(citation("CONICET-179477 pág. 12", [paper])).toEqual({ source: paper, page: "12" });
    expect(citation("conicet-179477", [paper])).toEqual({ source: paper, page: null });
    expect(citation("pdf-mi-paper-6d7fd460 p. 2", [paper, upload])).toEqual({ source: upload, page: "2" });
  });

  it("leaves anything else as a plain reference", () => {
    expect(citation("conicet-1 p. 4", [paper])).toBeNull();
    expect(citation("10.1016/j.jas.2016.01.002", [paper])).toBeNull();
    expect(citation("Goñi 2010, p. 3", [paper])).toBeNull();
  });
});

describe("sources.json", () => {
  it("reads the list and survives a broken or missing file", () => {
    expect(parseSources(JSON.stringify({ sources: [paper, { title: "sin id" }, null] }))).toEqual([paper]);
    expect(parseSources("{oops")).toEqual([]);
    expect(parseSources(undefined)).toEqual([]);
  });
});

it("shortens long author lists", () => {
  expect(authorsLine(["A", "B", "C", "D", "E"])).toBe("A; B; C y 2 más");
  expect(authorsLine(["A"])).toBe("A");
  expect(authorsLine([])).toBe("Sin autores registrados");
});
