import { describe, expect, it } from "vitest";
import { groupByBench, keyOf, scoreOf, truncate, type PeerQuestion } from "./questions-model";

// View logic of the Preguntas page (issue #1): grouping by benchmark with the
// best peer score first.

function q(bench: string, num: number, up = 0, down = 0, validated = false): PeerQuestion {
  return {
    bench,
    q: num,
    question: `pregunta ${num} de ${bench}`,
    expectedAnswer: null,
    votes: { up, down },
    myVote: null,
    hash: "0".repeat(64),
    validated,
  };
}

describe("scoreOf", () => {
  it("is validates minus rejections", () => {
    expect(scoreOf(q("b", 1, 2, 1))).toBe(1);
    expect(scoreOf(q("b", 1, 0, 3))).toBe(-3);
  });
});

describe("groupByBench", () => {
  it("groups by bench alphabetically and sorts by score desc inside", () => {
    const groups = groupByBench([
      q("zeta", 1, 0),
      q("alfa", 1, 1),
      q("zeta", 2, 5),
      q("alfa", 2, 1),
      q("alfa", 3, -2),
    ]);
    expect(groups.map(([bench]) => bench)).toEqual(["alfa", "zeta"]);
    expect(groups[0][1].map((x) => x.q)).toEqual([1, 2, 3]); // ties by q number
    expect(groups[1][1].map((x) => x.q)).toEqual([2, 1]); // score leads
  });

  it("handles an empty list", () => {
    expect(groupByBench([])).toEqual([]);
  });
});

describe("keyOf", () => {
  it("uniquely addresses a question", () => {
    expect(keyOf(q("mi bench", 7))).toBe("mi bench#7");
  });
});

describe("truncate", () => {
  it("shortens long questions with an ellipsis", () => {
    const long = "x".repeat(200);
    expect(truncate(long)).toBe(`${"x".repeat(180)}…`);
    expect(truncate("corta")).toBe("corta");
  });
});
