import { describe, expect, it } from "vitest";
import { extractResultRows } from "./d1";

describe("extractResultRows", () => {
  it("returns the results of the first statement", () => {
    const raw = [{ results: [{ id: "a" }, { id: "b" }], success: true, meta: {} }];
    expect(extractResultRows(raw, "testing")).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("fails loudly when the response is not an array", () => {
    expect(() => extractResultRows({ results: [] }, "testing")).toThrow(
      /Unexpected response shape/,
    );
  });

  it("fails loudly when the first element has no results array", () => {
    expect(() => extractResultRows([{ success: true }], "testing")).toThrow(
      /Unexpected response shape/,
    );
  });
});
