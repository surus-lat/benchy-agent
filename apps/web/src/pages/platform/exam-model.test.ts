import { describe, expect, it } from "vitest";
import {
  byAgent,
  correctOptionKey,
  criterionMet,
  criteriaEntryStep,
  designKeywords,
  groupsOf,
  parseBenchDoc,
  parseDesign,
  parseExam,
  parseMeta,
  questionsFrom,
  questionsQuality,
  readCriteria,
  readInputFields,
  readMetric,
  readOptions,
  rubricMissing,
  addCriterion,
  removeCriterion,
  removeQuestion,
  reviewMatchesRubric,
  serializeDesign,
  serializeExam,
  serializeMeta,
  setCriterion,
  shareOf,
  hasDesign,
  MAX_KEYWORDS,
  EMPTY_DESIGN,
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

  it("reads the rows the agent writes flat as the program's own shape", () => {
    // What the model answers with when it says the program out loud: the fields
    // at the top level, the answer under `answer`, nothing nested.
    const text = [
      JSON.stringify({ question: "¿Ayni?", answer: "Reciprocidad." }),
      JSON.stringify({ question: "¿Minka?", answer: "Trabajo colectivo.", group: "obra" }),
      row("¿Yaku?", "Agua."),
    ].join("\n");
    const rows = parseExam(text, ["question"]);
    expect(rows).toEqual([
      { input: { question: "¿Ayni?" }, expected: { answer: "Reciprocidad." } },
      { input: { question: "¿Minka?" }, expected: { answer: "Trabajo colectivo." } },
      { input: { question: "¿Yaku?" }, expected: { answer: "Agua." } },
    ]);
    // A save puts the file in the shape the engine reads.
    expect(serializeExam(rows)).toBe([row("¿Ayni?", "Reciprocidad."), row("¿Minka?", "Trabajo colectivo."), row("¿Yaku?", "Agua.")].join("\n") + "\n");
    const qs = questionsFrom(rows, [{}, {}, {}], null);
    expect(qs.map((q) => [q.text, q.answer])).toEqual([
      ["¿Ayni?", "Reciprocidad."],
      ["¿Minka?", "Trabajo colectivo."],
      ["¿Yaku?", "Agua."],
    ]);
    // Without the program at hand nothing is dropped: the engine is what says
    // a key does not belong there.
    expect(parseExam(JSON.stringify({ question: "¿Ayni?", group: "obra", answer: "Reciprocidad." }))).toEqual([
      { input: { question: "¿Ayni?", group: "obra" }, expected: { answer: "Reciprocidad." } },
    ]);
  });

  it("keeps a line that is neither shape as raw text", () => {
    const flat = JSON.stringify({ question: "¿Ayni?" });
    const answerOnly = JSON.stringify({ answer: "Reciprocidad." });
    expect(parseExam([flat, answerOnly].join("\n"))).toEqual([{ raw: flat }, { raw: answerOnly }]);
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

  it("reads the input fields the program declares", () => {
    expect(readInputFields(parseBenchDoc(YAML))).toEqual(["question"]);
    expect(readInputFields(parseBenchDoc('version: "1.0"\n'))).toBeNull();
  });

  it("reads what the agent calls importance as the why of the question", () => {
    const [m] = parseMeta(JSON.stringify({ rows: [{ question: "¿Ayni?", importance: "Pone a prueba c5", status: "draft", by: "agente" }] }));
    expect(m.why).toBe("Pone a prueba c5");
    expect(m.by).toBe("agente");
    expect(parseMeta(JSON.stringify({ rows: [{ why: "ya escrito", importance: "otra" }] }))[0].why).toBe("ya escrito");
    expect(parseMeta(JSON.stringify({ rows: [{ reason: "por qué importa" }] }))[0].why).toBe("por qué importa");
    expect(parseMeta(JSON.stringify({ rows: [{ group: "x" }] }))[0].why).toBeUndefined();
  });
});

describe("multiple-choice rows", () => {
  // The shape the MC editor and the engine agree on: options as an a-d object,
  // expected.answer the exact text of the correct option.
  const mcRow = (q: string, opts: [string, string, string, string], correct: number) =>
    JSON.stringify({
      input: { question: q, options: { a: opts[0], b: opts[1], c: opts[2], d: opts[3] } },
      expected: { answer: opts[correct] },
    });

  it("round-trips a multiple-choice row through parse and serialize", () => {
    const text = mcRow("¿Qué es la mitosis?", ["División celular", "Fotosíntesis", "Respiración", "Digestión"], 0) + "\n";
    const rows = parseExam(text);
    expect(serializeExam(rows)).toBe(text);
    const qs = questionsFrom(rows, [{}], null);
    expect(qs[0].options).toEqual([
      { key: "a", text: "División celular" },
      { key: "b", text: "Fotosíntesis" },
      { key: "c", text: "Respiración" },
      { key: "d", text: "Digestión" },
    ]);
    expect(qs[0].status).toBe("progress");
  });

  it("reads a flat multiple-choice row the way the agent writes it", () => {
    const opts: [string, string, string, string] = ["División celular", "Fotosíntesis", "Respiración", "Digestión"];
    const flat = JSON.stringify({ question: "¿Qué es la mitosis?", options: { a: opts[0], b: opts[1], c: opts[2], d: opts[3] }, answer: opts[0] });
    const rows = parseExam(flat);
    expect(serializeExam(rows)).toBe(mcRow("¿Qué es la mitosis?", opts, 0) + "\n");
    expect(readOptions(rows[0])).toEqual([
      { key: "a", text: "División celular" },
      { key: "b", text: "Fotosíntesis" },
      { key: "c", text: "Respiración" },
      { key: "d", text: "Digestión" },
    ]);
    expect(correctOptionKey(readOptions(rows[0]), "división celular")).toBe("a");
  });

  it("reads options from a list too and finds the correct option by exact text", () => {
    expect(readOptions({ input: { options: ["x", "y"] }, expected: {} })).toEqual([
      { key: "a", text: "x" },
      { key: "b", text: "y" },
    ]);
    expect(readOptions({ input: { question: "q" }, expected: {} })).toBeNull();
    const opts = [
      { key: "a", text: "División celular" },
      { key: "b", text: "Fotosíntesis" },
    ];
    expect(correctOptionKey(opts, "División celular")).toBe("a");
    // The metric the engine scores with is forgiving about case and accents; the radio is too.
    expect(correctOptionKey(opts, "división CELULAR ")).toBe("a");
    expect(correctOptionKey(opts, "otra")).toBeNull();
  });

  it("reads the metric that marks a multiple-choice benchmark", () => {
    const mcYaml = `# Ciclo del agua
version: "1.0"
ontology_version: "1.1"
benchmark: { task: answer, domain: biology, language: es }
program:
  input: { question: string, options: { a: string, b: string, c: string, d: string } }
  output: { answer: string }
scoring:
  weights: { answer: 1 }
  aggregator: weighted_mean
  field_metrics:
    answer: { metric: casefold_strip }
data: { path: ./exam.jsonl }
`;
    expect(readMetric(parseBenchDoc(mcYaml))).toBe("casefold_strip");
    expect(readMetric(parseBenchDoc(YAML))).toBe("rubric");
    expect(readMetric(parseBenchDoc("benchmark: { task: extract }"))).toBeNull();
  });
});

describe("benchmark design (design.json)", () => {
  it("reads an empty design from a missing or unreadable file", () => {
    expect(parseDesign(null)).toEqual(EMPTY_DESIGN);
    expect(parseDesign(undefined)).toEqual(EMPTY_DESIGN);
    expect(parseDesign("nope")).toEqual(EMPTY_DESIGN);
    expect(parseDesign("{}")).toEqual(EMPTY_DESIGN);
  });

  it("reads the fields and ignores anything else", () => {
    const d = parseDesign(
      JSON.stringify({ purpose: "qué", construct: "puede", failureModes: "errores", notes: "límites", keywords: ["reciprocidad ritual"], updatedAt: "ayer" }),
    );
    expect(d).toEqual({ purpose: "qué", construct: "puede", failureModes: "errores", notes: "límites", keywords: ["reciprocidad ritual"] });
    expect(hasDesign(d)).toBe(true);
    expect(hasDesign({ ...EMPTY_DESIGN, notes: "  " })).toBe(false);
    // Searches alone are not a design: the researcher still has to say what the
    // benchmark is about.
    expect(hasDesign({ ...EMPTY_DESIGN, keywords: ["ritual"] })).toBe(false);
  });

  it("reads keywords as the list of searches it means, however they arrive", () => {
    // The agent writes a list; the researcher types two searches in one phrase.
    expect(parseDesign('{"keywords":["reciprocidad ritual, domesticidad andina","Reciprocidad ritual","",123]}').keywords).toEqual([
      "reciprocidad ritual",
      "domesticidad andina",
    ]);
    expect(parseDesign('{"keywords":"a; b\\nc"}').keywords).toEqual(["a", "b", "c"]);
    expect(parseDesign('{"keywords":"a, a, a"}').keywords).toEqual(["a"]);
    expect(parseDesign('{"keywords":{}}').keywords).toEqual([]);
    expect(parseDesign(`{"keywords":${JSON.stringify(Array.from({ length: 30 }, (_, i) => `t${i}`))}}`).keywords).toHaveLength(12);
  });

  it("caps the keywords at twelve, folding case-insensitive duplicates first", () => {
    const many = Array.from({ length: 20 }, (_, i) => `t${i}`);
    expect(designKeywords(many)).toEqual(many.slice(0, MAX_KEYWORDS));
    // Duplicates fold before the cap, so they never take a slot.
    expect(designKeywords(["A", "a", " b "])).toEqual(["A", "b"]);
    // A partial add: ten already in, four typed at once — only the first two fit.
    const ten = Array.from({ length: 10 }, (_, i) => `k${i}`);
    expect(designKeywords([...ten, "n1, n2, n3, n4"])).toEqual([...ten, "n1", "n2"]);
    expect(MAX_KEYWORDS).toBe(12);
  });

  it("round-trips through serializeDesign with an updatedAt stamp", () => {
    const d = { purpose: "qué", construct: "puede", failureModes: "errores", notes: "límites", keywords: ["reciprocidad ritual", "domesticidad andina"] };
    const text = serializeDesign(d);
    expect(parseDesign(text)).toEqual(d);
    expect(JSON.parse(text).updatedAt).toEqual(expect.any(String));
  });
});

describe("which screen 01 · Criterios opens on", () => {
  /** Criteria of the benchmark's own: written by the researcher or generated. */
  const own = [{ key: "c1", weight: 5, description: "Identifica las posiciones centrales.", levels: [0, 1] }];
  /** The generic set every new benchmark starts with. */
  const generic = [
    { key: "c1", weight: 3, description: "Responde con precisión.", levels: [0, 1] },
    { key: "c2", weight: 3, description: "Usa la terminología del campo.", levels: [0, 1] },
  ];

  it("comes back to the rubric when its criteria are already its own, design or not", () => {
    expect(criteriaEntryStep(EMPTY_DESIGN, own, false)).toBe("criteria");
    expect(criteriaEntryStep({ ...EMPTY_DESIGN, purpose: "qué" }, own, false)).toBe("criteria");
  });

  it("opens on the design while the rubric is the generic one and nothing is defined", () => {
    expect(criteriaEntryStep(EMPTY_DESIGN, generic, true)).toBe("design");
    expect(criteriaEntryStep(EMPTY_DESIGN, [], true)).toBe("design");
  });

  it("opens on the rubric once the design is written, starter rubric or none", () => {
    expect(criteriaEntryStep({ ...EMPTY_DESIGN, purpose: "qué" }, generic, true)).toBe("criteria");
    expect(criteriaEntryStep({ ...EMPTY_DESIGN, construct: "puede" }, [], true)).toBe("criteria");
  });
});

describe("the rubric as a blocker for what comes after 01 · Criterios", () => {
  const own = [{ key: "c1", weight: 5, description: "Identifica las posiciones centrales.", levels: [0, 1] }];

  it("blocks an open exam the judge has nothing to measure with", () => {
    expect(rubricMissing(true, [])).toBe(true);
    expect(rubricMissing(true, null)).toBe(true);
    expect(rubricMissing(true, own)).toBe(false);
  });

  it("never blocks an exam scored by exact match", () => {
    expect(rubricMissing(false, null)).toBe(false);
    expect(rubricMissing(false, [])).toBe(false);
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

  it("removes criteria down to none, and a new one starts the numbering again", () => {
    const one = removeCriterion(YAML, "c1");
    expect(readCriteria(parseBenchDoc(one))!.map((c) => c.key)).toEqual(["c2"]);
    const empty = removeCriterion(one, "c2");
    expect(readCriteria(parseBenchDoc(empty))).toEqual([]);
    // An empty rubric is still a rubric: the first criterion written lands in c1.
    expect(readCriteria(parseBenchDoc(addCriterion(empty, "Vuelve con una.", 3)))!.map((c) => c.key)).toEqual(["c1"]);
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
