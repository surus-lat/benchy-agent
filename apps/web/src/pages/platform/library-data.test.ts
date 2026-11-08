import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { authorsLine, citation, parseSources, sourceNeedsValidation, sourceState, type Source } from "./library-data";

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
    const bicyt: Source = { ...paper, id: "bicyt-12599897", origin: "bicyt" };
    expect(citation("bicyt-12599897 p. 18", [paper, bicyt])).toEqual({ source: bicyt, page: "18" });
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

  it("keeps a paper's reading and failed state, which the container writes before the text is in", () => {
    const reading = { ...paper, id: "conicet-55", status: "reading" as const };
    const failed = { ...reading, id: "conicet-56", status: "failed" as const, error: { code: "pdf_unavailable", message: "no se pudo bajar" } };
    expect(parseSources(JSON.stringify({ sources: [reading, failed] }))).toEqual([reading, failed]);
  });
});

describe("validation of new material", () => {
  it("treats a source with no row as validated (grandfathered), a row without validatedAt as pending", () => {
    // Material that predates the feature has no validation row at all.
    expect(sourceState(undefined)).toBe("validated");
    expect(sourceState({ sourceId: "pdf-1", checked: [], validatedAt: null, validatedByName: null })).toBe("pending");
    expect(sourceState({ sourceId: "pdf-1", checked: ["respaldo"], validatedAt: null, validatedByName: null })).toBe("pending");
    expect(sourceState({ sourceId: "pdf-1", checked: [], validatedAt: "2026-10-20T00:00:00.000Z", validatedByName: "Ana" })).toBe("validated");
  });
});

describe("who goes through the source checklist", () => {
  it("library papers (conicet / bicyt) are validated by construction; only an upload needs the checklist", () => {
    const bicyt: Source = { ...paper, id: "bicyt-12599897", origin: "bicyt" };
    expect(sourceNeedsValidation(paper)).toBe(false);
    expect(sourceNeedsValidation(bicyt)).toBe(false);
    expect(sourceNeedsValidation(upload)).toBe(true);
  });
});

// The Papers drawer's ValidationRow, without a DOM renderer: guard the source.
describe("ValidationRow in the Papers drawer", () => {
  const workspace = readFileSync(resolve(__dirname, "workspace.tsx"), "utf-8");
  const rowFn = workspace.slice(workspace.indexOf("function ValidationRow("), workspace.indexOf("function ChecklistSection("));

  it("settles a library source as validated by its repository, before any checkbox", () => {
    expect(rowFn).toMatch(/sourceNeedsValidation\(source\)/);
    expect(rowFn).toMatch(/✓ Validada · viene de la biblioteca/);
    expect(rowFn.indexOf("viene de la biblioteca")).toBeLessThan(rowFn.indexOf('type="checkbox"'));
  });
});

it("shortens long author lists", () => {
  expect(authorsLine(["A", "B", "C", "D", "E"])).toBe("A; B; C y 2 más");
  expect(authorsLine(["A"])).toBe("A");
  expect(authorsLine([])).toBe("Sin autores registrados");
});
