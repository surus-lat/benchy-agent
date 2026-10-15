import { expect, it } from "vitest";
import { letterheadName } from "./publication";

it("puts the organization beside SURUS on the letterhead, and SURUS alone for SURUS", () => {
  expect(letterheadName("CONICET")).toBe("SURUS × CONICET");
  expect(letterheadName("Universidad Nacional de Río Negro")).toBe("SURUS × UNIVERSIDAD NACIONAL DE RÍO NEGRO");
  expect(letterheadName("SURUS")).toBe("SURUS");
  expect(letterheadName(" surus ")).toBe("SURUS");
  expect(letterheadName(null)).toBe("SURUS");
});

it("publishes a benchmark under its organization", async () => {
  const { publicPath } = await import("./data");
  expect(publicPath({ name: "CONICET", slug: "conicet" }, "historia-argentina-siglo-xx")).toBe("getbenchy.lat/b/conicet/historia-argentina-siglo-xx");
  expect(publicPath({ name: "Universidad Nacional de Río Negro" }, "x")).toBe("getbenchy.lat/b/universidad-nacional-de-rio-negro/x");
});
