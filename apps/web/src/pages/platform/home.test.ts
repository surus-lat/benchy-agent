import { describe, expect, it } from "vitest";
import { isBrandColor, isValidUrl, orgStats } from "./home";

// The org home's pure helpers: the stats strip's numbers and the brand color
// the settings card accepts.

const bench = (over: Record<string, unknown>) =>
  ({ slug: "b", modified: 1, yamlPath: "b/benchmark.yaml", runs: [], ...over }) as never;

describe("orgStats", () => {
  it("is empty for no benchmarks", () => {
    expect(orgStats([])).toEqual({ benches: 0, items: 0, evaluated: 0, best: null });
  });

  it("sums items, counts evaluated benchmarks, and takes the best score", () => {
    const stats = orgStats([
      bench({ items: 12, runs: [{ path: "b/runs/x.json", modified: 1 }], best: 0.72 }),
      bench({ items: 8, runs: [], best: null }),
      bench({ items: undefined, runs: [{ path: "b/runs/y.json", modified: 2 }], best: 0.81 }),
    ] as never);
    expect(stats).toEqual({ benches: 3, items: 20, evaluated: 2, best: 0.81 });
  });
});

describe("isBrandColor", () => {
  it("accepts only #rrggbb hex", () => {
    expect(isBrandColor("#1e6fd9")).toBe(true);
    expect(isBrandColor("#1E6FD9")).toBe(true);
    expect(isBrandColor("1e6fd9")).toBe(false);
    expect(isBrandColor("#12345")).toBe(false);
    expect(isBrandColor("#1234567")).toBe(false);
    expect(isBrandColor("red")).toBe(false);
    expect(isBrandColor("")).toBe(false);
  });
});

describe("isValidUrl", () => {
  it("accepts https and http URLs", () => {
    expect(isValidUrl("https://example.com/logo.png")).toBe(true);
    expect(isValidUrl("http://example.com/logo.png")).toBe(true);
    expect(isValidUrl("https://cdn.org/img/brand.svg")).toBe(true);
  });

  it("rejects non-URL strings", () => {
    expect(isValidUrl("not-a-url")).toBe(false);
    expect(isValidUrl("")).toBe(false);
    expect(isValidUrl("ftp://example.com")).toBe(false);
    expect(isValidUrl("javascript:alert(1)")).toBe(false);
    expect(isValidUrl("/relative/path")).toBe(false);
  });
});
