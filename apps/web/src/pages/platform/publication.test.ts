import { expect, it } from "vitest";
import { letterheadName } from "./publication";

it("puts the organization beside SURUS on the letterhead, and SURUS alone for SURUS", () => {
  expect(letterheadName("CONICET")).toBe("SURUS × CONICET");
  expect(letterheadName("Universidad Nacional de Río Negro")).toBe("SURUS × UNIVERSIDAD NACIONAL DE RÍO NEGRO");
  expect(letterheadName("SURUS")).toBe("SURUS");
  expect(letterheadName(" surus ")).toBe("SURUS");
  expect(letterheadName(null)).toBe("SURUS");
});
