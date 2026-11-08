import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Regression guard: the keyword box caps at MAX_KEYWORDS and the cap must be
// VISIBLE — a counter, a disabled input and button, and a note — never a
// silent no-op that eats what the researcher typed (reported by an external
// researcher: past the limit, "Agregar" appeared to do nothing). Without a
// DOM renderer we verify the source directly; if the editor drops the guard,
// this test breaks.

const criteria = readFileSync(resolve(__dirname, "criteria.tsx"), "utf-8");
const editor = criteria.slice(criteria.indexOf("function KeywordEditor("));

describe("KeywordEditor at the keyword cap", () => {
  it("shows a counter 'N de 12' near the chips", () => {
    expect(editor).toMatch(/ws-crit-count mono/);
    expect(editor).toMatch(/\{keywords\.length\} de \{MAX_KEYWORDS\}/);
  });

  it("disables the input and the Agregar button when at the cap", () => {
    expect(editor).toMatch(/keywords\.length >= MAX_KEYWORDS/);
    expect(editor).toMatch(/disabled=\{frozen \|\| atCap\}/);
    expect(editor).toMatch(/disabled=\{frozen \|\| atCap \|\| !pending\.length\}/);
  });

  it("shows the cap note instead of failing silently", () => {
    expect(editor).toMatch(/Máximo \{MAX_KEYWORDS\} palabras clave — quitá alguna para agregar otra\./);
  });

  it("keeps in the draft what did not fit, instead of eating it", () => {
    expect(editor).toMatch(/setDraft\(remaining\.join\(", "\)\)/);
  });
});
