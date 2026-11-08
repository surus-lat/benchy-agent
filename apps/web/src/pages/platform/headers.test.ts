import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Item 5: regression guard — the org name in both headers MUST be a link to /app.
// Without a DOM renderer we verify the source directly; if the component changes
// to a <span> or drops the href, this test breaks.

const platformApp = readFileSync(resolve(__dirname, "platform-app.tsx"), "utf-8");
const workspace = readFileSync(resolve(__dirname, "workspace.tsx"), "utf-8");
const criteria = readFileSync(resolve(__dirname, "criteria.tsx"), "utf-8");
const fuentes = readFileSync(resolve(__dirname, "fuentes.tsx"), "utf-8");
const results = readFileSync(resolve(__dirname, "results.tsx"), "utf-8");
const publication = readFileSync(resolve(__dirname, "publication.tsx"), "utf-8");

describe("org name links to /app", () => {
  it("Shell renders the org name as <Link href=\"/app\">", () => {
    // Inside function Shell(), the org line must be a Link (not a span/div)
    const shellFn = platformApp.slice(platformApp.indexOf("function Shell()"));
    expect(shellFn).toMatch(/<Link\s+href=["']\/app["'].*className=["']bp-org["']/);
  });

  it("WsHeader renders the org name as <Link href=\"/app\">", () => {
    const wsFn = workspace.slice(workspace.indexOf("function WsHeader("));
    expect(wsFn).toMatch(/<Link\s+href=["']\/app["'].*className=["']ws-org["']/);
  });
});

// Bench identity on stage pages ("si voy al baño y vuelvo, no sé dónde estoy"):
// every stage header carries the benchmark display name, in the eyebrow spot.
describe("benchmark name on every stage page", () => {
  it("criteria hero eyebrow names the benchmark", () => {
    const hero = criteria.slice(criteria.indexOf("ws-crit-hero"));
    expect(hero.slice(0, 500)).toMatch(/01 · Criterios de evaluación · \{benchTitle\} · Paso/);
  });

  it("fuentes collection header names the benchmark", () => {
    const head = fuentes.slice(fuentes.indexOf("ws-fnt-col-head"));
    expect(head.slice(0, 500)).toMatch(/02 · Fuentes · \{benchTitle\}/);
  });

  it("preguntas (Authoring) names the benchmark over the question list", () => {
    expect(workspace).toMatch(/03 · Preguntas · \{benchTitle\}/);
  });

  it("evaluación names the benchmark over the board", () => {
    expect(workspace).toMatch(/04 · Evaluación · \{bench\.doc\?\.title \?\? bench\.slug\}/);
  });

  it("resultados names the benchmark over the analysis", () => {
    expect(results).toMatch(/05 · Resultados · \{bench\.doc\?\.title \?\? bench\.slug\}/);
  });

  it("publicación names the benchmark over the tabs", () => {
    expect(publication).toMatch(/06 · Publicación · \{bench\.doc\?\.title \?\? bench\.slug\}/);
  });

  it("workspace hands the display name to the stages that take it as a prop", () => {
    expect(workspace.match(/benchTitle=\{exam\.doc\?\.title \?\? slug\}/g)?.length).toBe(3);
  });
});

// Your own PDF, findable: 02 · Fuentes has its own upload entry point, wired
// to the same sources.upload the Papers drawer uses.
describe("upload your own PDF from 02 · Fuentes", () => {
  it("the collection header offers «Subí un PDF propio», wired to sources.upload", () => {
    expect(fuentes).toMatch(/Subí un PDF propio/);
    expect(fuentes).toMatch(/accept="application\/pdf,\.pdf"/);
    expect(fuentes).toMatch(/sourcesApi\.upload\(bench, file\)/);
  });

  it("a successful upload joins the picked collection; a failure shows its note", () => {
    expect(fuentes).toMatch(/onChanged\(`\+ \$\{r\.source\.title\}`\)/);
    expect(fuentes).toMatch(/state: "error", note: libraryErrorText/);
  });

  it("the old pointer to the Papers drawer is gone", () => {
    expect(fuentes).not.toMatch(/Se sube desde el botón Papers/);
  });
});
