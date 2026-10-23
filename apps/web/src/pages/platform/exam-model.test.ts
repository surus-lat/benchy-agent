import { describe, expect, it } from "vitest";
import {
  byAgent,
  criterionMet,
  groupsOf,
  parseBenchDoc,
  parseExam,
  parseMeta,
  questionsFrom,
  questionsQuality,
  readCriteria,
  addCriterion,
  removeCriterion,
  removeQuestion,
  reviewMatchesRubric,
  serializeExam,
  serializeMeta,
  setCriterion,
  shareOf,
  type Quality,
  type Review,
} from "./exam-model";

const YAML = `# Etnografía andina
version: "1.0"
ontology_version: "1.1"
benchmark: { task: answer, domain: anthropology, language: es }
program:
  input: { question: string }
  output: { answer: string }
scoring:
  weights: { answer: 1 }
  aggregator: weighted_mean
  field_metrics:
    answer:
      metric: rubric
      params:
        criteria:
          c1:
            weight: 5 # la más importante
            description: Identifica las posiciones centrales.
            levels: { 0: No lo cumple, 1: Lo cumple }
          c2:
            weight: 3
            description: Sitúa el caso.
            levels: { 0: No lo cumple, 1: Lo cumple }
  grader: { type: model, provider: bedrock, model: us.moonshotai.kimi-k3 }
data: { path: ./exam.jsonl }
`;

const row = (q: string, a: string) => JSON.stringify({ input: { question: q }, expected: { answer: a } });

describe("exam rows", () => {
  it("round-trips the exam and keeps lines it cannot parse", () => {
    const text = [row("¿Ayni?", "Reciprocidad."), "{not json", row("¿Minka?", "")].join("\n") + "\n";
    const rows = parseExam(text);
    expect(rows).toHaveLength(3);
    expect(serializeExam(rows)).toBe(text);
    expect(serializeExam([])).toBe("");
  });

  it("derives each question's status from its text, answer, notes and review", () => {
    const rows = parseExam([row("a?", "A"), row("b?", ""), row("", ""), row("d?", "D"), row("e?", "E"), row("f?", "F")].join("\n"));
    const meta = parseMeta(serializeMeta([{ status: "approved" }, {}, {}, { by: "agente" }, { status: "approved" }, { status: "approved" }]));
    const review: Review = {
      created: 1,
      grader: {},
      criteria: ["c1"],
      rows: [
        { index: 4, input: { question: "e?" }, answer: "E", missed: ["c1"] },
        { index: 5, input: { question: "f?" }, answer: "old", missed: ["c1"] },
      ],
    };
    const qs = questionsFrom(rows, meta, review);
    expect(qs.map((q) => q.status)).toEqual(["done", "error", "empty", "new", "attention", "done"]);
    expect(qs[5].stale).toBe(true);
    expect(qs[5].review).toBeNull();
    expect(qs[4].review?.missed).toEqual(["c1"]);
    expect(qs[0].num).toBe("01");
  });

  it("groups questions by their topic, in exam order", () => {
    const qs = questionsFrom(parseExam([row("a", "A"), row("b", "B"), row("c", "C")].join("\n")), [{ group: "X" }, {}, { group: "X" }], null);
    expect(groupsOf(qs).map((g) => [g.title, g.items.length])).toEqual([["X", 2], ["Preguntas", 1]]);
  });

  it("treats unreadable notes as none", () => {
    expect(parseMeta("nope")).toEqual([]);
    expect(parseMeta(undefined)).toEqual([]);
  });
});

describe("rubric in benchmark.yaml", () => {
  it("reads the criteria with weights, descriptions and levels", () => {
    const cs = readCriteria(parseBenchDoc(YAML))!;
    expect(cs).toEqual([
      { key: "c1", weight: 5, description: "Identifica las posiciones centrales.", levels: [0, 1] },
      { key: "c2", weight: 3, description: "Sitúa el caso.", levels: [0, 1] },
    ]);
    expect(shareOf(cs[0], cs)).toBe("63%");
    expect(readCriteria(parseBenchDoc("benchmark: { task: extract }"))).toBeNull();
  });

  it("edits one criterion and keeps the rest of the file, comments included", () => {
    const out = setCriterion(setCriterion(YAML, "c2", { weight: 4 }), "c1", { description: "Nueva." });
    const cs = readCriteria(parseBenchDoc(out))!;
    expect(cs.map((c) => [c.weight, c.description])).toEqual([[5, "Nueva."], [4, "Sitúa el caso."]]);
    expect(out.startsWith("# Etnografía andina\n")).toBe(true);
    expect(out).toContain("# la más importante");
    expect(out).toContain("grader: { type: model, provider: bedrock, model: us.moonshotai.kimi-k3 }");
  });

  it("adds a criterion after the highest c<n>, in the shape the engine reads", () => {
    const out = addCriterion(YAML, "Usa la terminología del campo.", 2);
    const cs = readCriteria(parseBenchDoc(out))!;
    expect(cs.map((c) => [c.key, c.weight, c.description, c.levels])).toEqual([
      ["c1", 5, "Identifica las posiciones centrales.", [0, 1]],
      ["c2", 3, "Sitúa el caso.", [0, 1]],
      ["c3", 2, "Usa la terminología del campo.", [0, 1]],
    ]);
    expect(out).toContain("levels: { 0: No lo cumple, 1: Lo cumple }");
    expect(out).toContain("# la más importante");
    // Numbering follows the highest name, so removing c1 does not hand its name to a new criterion.
    expect(readCriteria(parseBenchDoc(addCriterion(removeCriterion(YAML, "c1"), "Otro.", 1)))!.map((c) => c.key)).toEqual(["c2", "c3"]);
  });

  it("adds a criterion with a library's own grade wordings", () => {
    const out = addCriterion(YAML, "Distingue las fuentes primarias.", 4, { "0": "No lo cumple", "1": "Lo cumple a medias", "2": "Lo cumple" });
    const [c] = readCriteria(parseBenchDoc(out))!.filter((x) => x.key === "c3");
    expect([c.weight, c.description, c.levels]).toEqual([4, "Distingue las fuentes primarias.", [0, 1, 2]]);
    expect(out).toContain("1: Lo cumple a medias");
  });

  it("removes a criterion but never the last one", () => {
    const one = removeCriterion(YAML, "c1");
    expect(readCriteria(parseBenchDoc(one))!.map((c) => c.key)).toEqual(["c2"]);
    expect(removeCriterion(one, "c2")).toBe(one);
  });

  it("counts a review only for the rubric it was made with", () => {
    const cs = readCriteria(parseBenchDoc(YAML))!;
    const review: Review = {
      created: 1,
      grader: {},
      criteria: ["c1", "c2"],
      rubric: [
        { name: "c1", description: "Identifica las posiciones centrales." },
        { name: "c2", description: "Sitúa el caso." },
      ],
      rows: [{ index: 0, input: { question: "a?" }, answer: "A", missed: [] }],
    };
    expect(reviewMatchesRubric(review, cs)).toBe(true);
    expect(reviewMatchesRubric({ ...review, rubric: undefined }, cs)).toBe(true);
    expect(reviewMatchesRubric(review, readCriteria(parseBenchDoc(setCriterion(YAML, "c2", { weight: 1 })))!)).toBe(true);
    expect(reviewMatchesRubric(review, readCriteria(parseBenchDoc(setCriterion(YAML, "c2", { description: "Otro." })))!)).toBe(false);
    const added = readCriteria(parseBenchDoc(addCriterion(YAML, "Nuevo.", 3)))!;
    expect(reviewMatchesRubric({ ...review, rubric: undefined }, added)).toBe(false);
    const [q] = questionsFrom(parseExam(row("a?", "A")), [{}], review, added);
    expect([q.review, q.stale]).toEqual([null, false]);
  });

  it("knows whether a review row met a criterion", () => {
    const [c1] = readCriteria(parseBenchDoc(YAML))!;
    expect(criterionMet({ index: 0, input: {}, answer: "", criteria: { c1: { grade: 1, justification: "" } } }, c1)).toBe(true);
    expect(criterionMet({ index: 0, input: {}, answer: "", criteria: { c1: { grade: 0, justification: "" } } }, c1)).toBe(false);
    expect(criterionMet({ index: 0, input: {}, answer: "" }, c1)).toBeNull();
  });
});

it("marks as new only what the agent wrote; a colleague's question is in progress", () => {
  const rows = [
    { input: { question: "¿A?" }, expected: { answer: "a" } },
    { input: { question: "¿B?" }, expected: { answer: "b" } },
    { input: { question: "¿C?" }, expected: { answer: "c" } },
  ];
  const qs = questionsFrom(rows, [{ by: "agente" }, { by: "Ana Pérez" }, { by: "vos", status: "approved", approved_by: "Ana Pérez" }], null);
  expect(qs.map((q) => q.status)).toEqual(["new", "progress", "done"]);
  expect(byAgent({ by: "Agente " })).toBe(true);
  expect(byAgent({ by: "Ana" })).toBe(false);
});

it("deletes a question and its notes; the questions after it keep their review", () => {
  const rows = parseExam([row("a?", "A"), row("b?", "B"), row("c?", "C")].join("\n"));
  const review: Review = {
    created: 1,
    grader: {},
    criteria: ["c1"],
    rows: [
      { index: 1, input: { question: "b?" }, answer: "B", missed: [] },
      { index: 2, input: { question: "c?" }, answer: "C", missed: ["c1"] },
    ],
  };
  const out = removeQuestion(rows, [{ why: "A" }, { why: "B", status: "approved" }, { why: "C" }], 0);
  expect(out.meta.map((m) => m.why)).toEqual(["B", "C"]);
  const qs = questionsFrom(out.rows, out.meta, review);
  expect(qs.map((q) => [q.text, q.status, q.stale])).toEqual([
    ["b?", "done", false],
    ["c?", "attention", false],
  ]);
});

describe("question quality", () => {
  const quality: Quality = {
    created: 1,
    grader: { model: "us.moonshotai.kimi-k3" },
    criteria: ["claridad", "relevancia", "respaldo", "calibre"],
    rows: [
      { index: 0, input: { question: "a?" }, score: 1, criteria: { claridad: { grade: 1, justification: "clara" } }, missed: [] },
      { index: 1, input: { question: "b?" }, score: 0.5, criteria: { respaldo: { grade: 0, justification: "sin respaldo" } }, missed: ["respaldo"] },
    ],
  };

  it("attaches each score to its question and marks an edited one stale", () => {
    const qs = questionsFrom(parseExam([row("a?", "A"), row("b editada", "B"), row("c?", "C")].join("\n")), [{}, {}, {}], null);
    const withQ = questionsQuality(qs, quality);
    // The edited question keeps no live score (quality null) but is flagged stale.
    expect(withQ.map((x) => [x.quality?.score ?? null, x.qualityStale])).toEqual([[1, false], [null, true], [null, false]]);
    expect(withQ[1].quality).toBeNull();
    expect(withQ[0].quality?.missed).toEqual([]);
    expect(withQ[0].quality?.criteria?.claridad.justification).toBe("clara");
  });

  it("a deleted question passes its score to the one that took its place only if the text matches", () => {
    const qs = questionsFrom(parseExam([row("b?", "B"), row("c?", "C")].join("\n")), [{}, {}], null);
    const withQ = questionsQuality(qs, { ...quality, rows: [{ index: 1, input: { question: "b?" }, score: 0.5, missed: [] }] });
    expect([withQ[0].quality?.score, withQ[0].qualityStale, withQ[1].quality]).toEqual([0.5, false, null]);
  });

  it("no scoring leaves the questions untouched", () => {
    const qs = questionsFrom(parseExam(row("a?", "A")), [{}], null);
    expect(questionsQuality(qs, null)).toBe(qs);
  });
});
