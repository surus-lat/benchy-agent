import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Docked layout regression guard (feat/agent-panel-compress-layout): on desktop
// the agent panel COMPRESSES the workbench instead of overlapping it — B docked
// on the right, A reflowing. Without a DOM renderer we pin the source: the
// canvas is a flex row, A is the flexible child, B's desktop rules carry no
// absolute positioning (the mobile overlay re-adds it inside the media query).

const css = readFileSync(resolve(__dirname, "workspace.css"), "utf-8");
const tsx = readFileSync(resolve(__dirname, "workspace.tsx"), "utf-8");

// One rule block, from its selector to the closing brace.
function block(re: RegExp): string {
  const m = css.match(re);
  if (!m) throw new Error(`rule not found: ${re}`);
  return m[0];
}

describe("docked A/B layout", () => {
  it(".ws-canvas is a flex row", () => {
    const b = block(/\.ws-canvas\s*\{[^}]*\}/);
    expect(b).toMatch(/display:\s*flex/);
    expect(b).toMatch(/flex-direction:\s*row/);
  });

  it(".ws-a takes the remaining space and can shrink", () => {
    const b = block(/\.ws-a\s*\{[^}]*\}/);
    expect(b).toMatch(/flex:\s*1/);
    expect(b).toMatch(/min-width:\s*0/);
    expect(b).not.toMatch(/position:\s*absolute/);
  });

  it(".ws-b is docked: no absolute positioning or offsets on desktop", () => {
    for (const re of [/\.ws-b\s*\{[^}]*\}/, /\.ws-b\.front\s*\{[^}]*\}/]) {
      const b = block(re);
      expect(b).not.toMatch(/position:\s*absolute/);
      expect(b).not.toMatch(/(^|[;{])\s*(top|bottom|left|right)\s*:/);
    }
  });

  it(".ws-b docks at min(560px, 42vw) and animates its width", () => {
    expect(block(/\.ws-b\.front\s*\{[^}]*\}/)).toMatch(/width:\s*min\(560px,\s*42vw\)/);
    expect(block(/\.ws-b\s*\{[^}]*\}/)).toMatch(/transition:[^;]*\bwidth\b/);
  });

  it("collapsed B is the slim strip: the chat hides, the strip shows only then", () => {
    expect(css).toMatch(/\.ws-b:not\(\.front\)\s+\.ws-b-main\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.ws-b\.front\s+\.ws-strip\s*\{[^}]*display:\s*none/);
  });

  it("the overlay click-veil is gone from css and markup", () => {
    expect(css).not.toMatch(/ws-win-back/);
    expect(tsx).not.toMatch(/ws-win-back/);
  });

  it("mobile keeps the overlay: absolute positioning lives only in the media query", () => {
    const mobile = css.slice(css.indexOf("@media (max-width: 900px)"));
    expect(block(/\.ws-win\s*\{[^}]*\}/)).not.toMatch(/position:\s*absolute/);
    expect(mobile).toMatch(/\.ws-win\s*\{[^}]*position:\s*absolute/);
    expect(mobile).toMatch(/\.ws-win:not\(\.front\)\s*\{[^}]*visibility:\s*hidden/);
  });

  it("the panel collapses from its head and expands from the strip", () => {
    expect(tsx).toMatch(/className="ws-b-collapse"[^>]*onClick=\{\(\) => onFront\("A"\)\}/);
    expect(tsx).toMatch(/className="ws-strip"[^>]*onClick=\{\(\) => onFront\("B"\)\}/);
  });
});
