import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Item 5: regression guard — the org name in both headers MUST be a link to /app.
// Without a DOM renderer we verify the source directly; if the component changes
// to a <span> or drops the href, this test breaks.

const platformApp = readFileSync(resolve(__dirname, "platform-app.tsx"), "utf-8");
const workspace = readFileSync(resolve(__dirname, "workspace.tsx"), "utf-8");

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
