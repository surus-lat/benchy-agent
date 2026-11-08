// The exam as the workspace window edits it. Pure functions over the three
// files a rubric benchmark keeps (the agent skill writes the same shapes):
//
//   benchmark.yaml   program, rubric (scoring.field_metrics.answer.params.criteria)
//   exam.jsonl       one {"input": {"question"}, "expected": {"answer"}} per line
//   questions.json   {"rows": [{why, sources, tags, group, status, by}]}, aligned
//                    with the exam's rows (the engine rejects extra keys in a row)
//
// and review.json, written by the grader review (apps/agent/mcp/benchy_review.py);
// and quality.json, written by the question quality scorer (apps/agent/mcp/benchy_quality.py).
//
// The agent writes an exam row flat as often as it nests it (`{"question": …,
// "answer": …}`); both read as the same row here, and the file is put back in the
// nested shape, which is the only one the engine accepts.

import { parseDocument, YAMLMap, type Document } from "yaml";

export type ExamRow = { input: Record<string, unknown>; expected: Record<string, unknown> };

export type QuestionMeta = {
  why?: string;
  sources?: string[];
  tags?: string[];
  group?: string;
  status?: "draft" | "approved";
  /** Who wrote it: "agente", or the researcher's name ("vos" in older files). */
  by?: string;
  /** Who approved it and when (ISO), set by the app. */
  approved_by?: string;
  approved_at?: string;
};

/** Written by the org's agent (the skill writes by: "agente"). */
export const byAgent = (m: QuestionMeta) => /^(agente|agent)$/i.test(m.by?.trim() ?? "");

export type ReviewRow = {
  index: number;
  input: Record<string, unknown>;
  answer: unknown;
  score?: number;
  criteria?: Record<string, { grade: number; justification: string }>;
  missed?: string[];
  error?: { code: string; message: string };
};
export type Review = {
  created: number;
  grader: { model?: string };
  /** The criteria the grader applied, and (newer reviews) their wording. */
  criteria: string[];
  rubric?: { name: string; description: string }[];
  rows: ReviewRow[];
};

// Quality of the question itself (not the expert answer): the four criteria
// are fixed for every benchmark (apps/agent/mcp/benchy_quality.py).
export type QualityRow = {
  index: number;
  input: Record<string, unknown>;
  score?: number;
  criteria?: Record<string, { grade: number; justification: string }>;
  missed?: string[];
  error?: { code: string; message: string };
};
/** The four fixed criteria (apps/agent/mcp/benchy_quality.py), in order. */
export const QUALITY_CRITERIA = ["claridad", "relevancia", "respaldo", "calibre"];

export type Quality = {
  created: number;
  grader: { model?: string };
  /** Always the same four: claridad, relevancia, respaldo, calibre. */
  criteria: string[];
  rows: QualityRow[];
};

export type Criterion = { key: string; weight: number; description: string; levels: number[] };

/**
 * The benchmark's design, written before any question: what we set out to find
 * out, what a model that masters the subject should do, the errors the exam
 * should expose, and what the score leaves out. It lives in `design.json` so
 * the researcher and the agent work on the same explicit text.
 */
export type Design = {
  /** The question the benchmark answers: what we want to find out. */
  purpose: string;
  /** What a model that masters the subject should be able to do. */
  construct: string;
  /** The errors or blind spots the exam should expose. */
  failureModes: string;
  /** What the score captures and what it hides. */
  notes: string;
  /** Short library searches that come out of the design. The app starts 02 ·
   *  Fuentes with them, so the papers are looked up for what is being measured
   *  instead of for the benchmark's title. */
  keywords: string[];
};

export const EMPTY_DESIGN: Design = { purpose: "", construct: "", failureModes: "", notes: "", keywords: [] };

const designField = (v: unknown) => (typeof v === "string" ? v : "");

/** One design's worth of searches: more than this and the researcher is typing
 *  the library's whole vocabulary into the design. */
export const MAX_KEYWORDS = 12;

/**
 * The keywords box: short search strings, deduplicated. The agent often hands
 * over one comma-separated string instead of a list, and a keyword typed in the
 * app can name two searches at once; either reads as the list it means.
 */
export function designKeywords(v: unknown): string[] {
  const items = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    for (const part of item.split(/[,;\n]/)) {
      const term = part.trim().replace(/\s+/g, " ").slice(0, 80);
      if (!term || out.some((x) => x.toLowerCase() === term.toLowerCase())) continue;
      out.push(term);
      if (out.length === MAX_KEYWORDS) return out;
    }
  }
  return out;
}

/** Read `design.json`; a missing or unreadable file reads as an empty design. */
export function parseDesign(text: string | null | undefined): Design {
  if (!text) return { ...EMPTY_DESIGN };
  try {
    const d = JSON.parse(text) as Partial<Design>;
    return {
      purpose: designField(d.purpose),
      construct: designField(d.construct),
      failureModes: designField(d.failureModes),
      notes: designField(d.notes),
      keywords: designKeywords(d.keywords),
    };
  } catch {
    return { ...EMPTY_DESIGN };
  }
}

export function serializeDesign(d: Design): string {
  return JSON.stringify({ ...d, updatedAt: new Date().toISOString() }, null, 2) + "\n";
}

/** Has the researcher said anything about what the benchmark evaluates? */
export function hasDesign(d: Design): boolean {
  return !!(d.purpose.trim() || d.construct.trim() || d.failureModes.trim() || d.notes.trim());
}

/** The two screens 01 · Criterios is made of: the design first, then the rubric. */
export type CriteriaStep = "design" | "criteria";

/**
 * Which of the two screens 01 · Criterios opens on. What says the stage's
 * decision was already made is its rubric: criteria of their own — written by
 * the researcher, or generated from the design and never touched since — open
 * it on the rubric, even when design.json never got written down. A benchmark
 * still on the generic starter rubric has the design missing, and one with
 * nothing defined starts at the design.
 */
export function criteriaEntryStep(design: Design, criteria: Criterion[], starter: boolean): CriteriaStep {
  const decided = criteria.length > 0 && !starter;
  return decided || hasDesign(design) ? "criteria" : "design";
}

/**
 * Whether the rubric blocks what comes after 01 · Criterios. An open exam with
 * no criteria has nothing for the judge to measure with: picking sources and
 * writing questions over it would test nothing, so the way forward stays shut
 * until the researcher writes them or asks the agent for them. A multiple
 * choice or closed exam is scored by exact match, so an empty rubric never
 * blocks it.
 */
export function rubricMissing(openExam: boolean, criteria: Criterion[] | null): boolean {
  return openExam && (criteria?.length ?? 0) === 0;
}

/** Status in the question list. */
export type QStatus = "done" | "progress" | "attention" | "new" | "error" | "empty";

/** One option of a multiple-choice question: its key in the program (a, b, c, d) and its text. */
export type QuestionOption = { key: string; text: string };

export type Question = {
  index: number;
  num: string;
  text: string;
  answer: string;
  /** The options of a multiple-choice question, in declaration order; null for open questions. */
  options: QuestionOption[] | null;
  meta: QuestionMeta;
  status: QStatus;
  /** The grader review of this exact text and answer, if there is one. */
  review: ReviewRow | null;
  /** Reviewed before, but the text or answer changed since. */
  stale: boolean;
  /** The grader's quality score of this exact question text, if there is one. */
  quality: QualityRow | null;
  /** Scored before, but the question text changed since. */
  qualityStale: boolean;
};

// ---- exam.jsonl -----------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * One exam row as the program reads it: exactly `input` and `expected`. The agent
 * answers the program out loud as often as it nests it — `{"question": …,
 * "answer": …}`, with `options` beside the question for a multiple-choice exam —
 * and the engine rejects that flat row, so both read as the same row here.
 * `inputFields` are the fields the program declares: what is not one of them is
 * the agent's own note (a `group`, an `id`), not part of a row.
 */
function examRowOf(row: unknown, inputFields: string[] | null): ExamRow | null {
  if (!isObject(row)) return null;
  if (isObject(row.input) && isObject(row.expected)) return { input: row.input, expected: row.expected };
  if (!("answer" in row)) return null;
  const { answer, input, ...rest } = row;
  const fields = isObject(input) ? { ...input, ...rest } : rest;
  const kept = inputFields ? Object.fromEntries(Object.entries(fields).filter(([k]) => inputFields.includes(k))) : fields;
  if (!Object.keys(kept).length) return null;
  return { input: kept, expected: { answer } };
}

/** Parse the exam. Unparseable lines are kept as raw text so a save never drops them. */
export function parseExam(text: string, inputFields: string[] | null = null): (ExamRow | { raw: string })[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      try {
        const row = examRowOf(JSON.parse(line), inputFields);
        if (row) return row;
      } catch {
        // fall through
      }
      return { raw: line };
    });
}

export function serializeExam(rows: (ExamRow | { raw: string })[]): string {
  return rows.map((r) => ("raw" in r ? r.raw : JSON.stringify(r))).join("\n") + (rows.length ? "\n" : "");
}

// ---- questions.json ----------------------------------------------------------

export function parseMeta(text: string | null | undefined): QuestionMeta[] {
  if (!text) return [];
  try {
    const rows = (JSON.parse(text) as { rows?: unknown }).rows;
    return Array.isArray(rows)
      ? rows.map((r) => {
          if (!r || typeof r !== "object") return {};
          // The agent calls what a question tests `importance` (or `reason`);
          // the app's column is `why`, and either reads as it.
          const { why, ...rest } = r as QuestionMeta & { importance?: string; reason?: string };
          const alias = rest.importance ?? rest.reason;
          return why === undefined && alias === undefined ? rest : { ...rest, why: why ?? alias };
        })
      : [];
  } catch {
    return [];
  }
}

export function serializeMeta(meta: QuestionMeta[]): string {
  return JSON.stringify({ rows: meta }, null, 2) + "\n";
}

// ---- questions --------------------------------------------------------------

/** Is this benchmark the open-question shape the editors handle? */
export function isOpenQuestionExam(task: string | undefined, criteria: Criterion[] | null): boolean {
  return task === "answer" && !!criteria;
}

/** The metric the `answer` field is scored with (scoring.field_metrics.answer.metric), if declared. */
export function readMetric(doc: Document): string | null {
  const m = (doc.toJS() as Record<string, any>)?.scoring?.field_metrics?.answer?.metric;
  return typeof m === "string" ? m : null;
}

/** Is this benchmark the multiple-choice shape: the answer task scored by exact match —
 *  either the whole exam (casefold_strip on the answer) or the rows carrying an optional
 *  input field (route), when it mixes both question kinds. A mixed exam is also an open
 *  exam: isOpenQuestionExam stays true on its rubric. */
export function isMultipleChoiceExam(task: string | undefined, metric: string | null, route: string | null = null): boolean {
  return task === "answer" && (metric === "casefold_strip" || route !== null);
}

/** The input field a mixed exam routes to exact match: the key of
 *  scoring.field_metrics.answer.route (`options`). A row carrying that field scores by
 *  the route's metric; every other row goes the answer field's own metric (the rubric). */
export function readRoute(doc: Document): string | null {
  const r = (doc.toJS() as Record<string, any>)?.scoring?.field_metrics?.answer?.route;
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const keys = Object.keys(r);
  return keys.length > 0 ? keys[0] : null;
}

const text = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));

/** The options declared in an exam row (input.options), in order: the engine spells them
 *  a-d as a nested object; a plain list is read too, keyed a, b, c… for robustness. */
export function readOptions(row: ExamRow | { raw: string }): QuestionOption[] | null {
  if ("raw" in row) return null;
  const o = row.input?.options;
  if (Array.isArray(o)) return o.map((t, i) => ({ key: String.fromCharCode(97 + i), text: text(t) }));
  if (o && typeof o === "object") return Object.entries(o as Record<string, unknown>).map(([key, t]) => ({ key, text: text(t) }));
  return null;
}

/** Which option the correct answer (expected.answer) names: the one whose text matches it. */
export function correctOptionKey(options: QuestionOption[] | null, answer: string): string | null {
  if (!options) return null;
  const norm = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  return options.find((o) => norm(o.text) === norm(answer))?.key ?? null;
}

/** Was this review made with the rubric as it stands: the same criteria, worded the same? */
export function reviewMatchesRubric(review: Review, criteria: Criterion[] | null): boolean {
  if (!criteria || !Array.isArray(review.criteria)) return true;
  const keys = (list: string[]) => [...list].sort().join("\n");
  if (keys(review.criteria) !== keys(criteria.map((c) => c.key))) return false;
  if (!review.rubric) return true;
  return criteria.every((c) => review.rubric!.find((r) => r.name === c.key)?.description.trim() === c.description.trim());
}

export function questionsFrom(
  rows: (ExamRow | { raw: string })[],
  meta: QuestionMeta[],
  reviewed: Review | null,
  criteria: Criterion[] | null = null,
): Question[] {
  // A review made with another rubric counts for no question: the grader has to look again.
  const review = reviewed && reviewMatchesRubric(reviewed, criteria) ? reviewed : null;
  return rows.map((row, index) => {
    const m = meta[index] ?? {};
    const num = String(index + 1).padStart(2, "0");
    if ("raw" in row) {
      return { index, num, text: row.raw, answer: "", options: null, meta: m, status: "error" as const, review: null, stale: false, quality: null, qualityStale: false };
    }
    const q = text(row.input.question ?? Object.values(row.input)[0]);
    const a = text(row.expected.answer ?? Object.values(row.expected)[0]);
    // The review of this text and answer, wherever it sat (questions move up when one is deleted).
    const same = (x: ReviewRow) => text(x.input.question ?? Object.values(x.input)[0]) === q && text(x.answer) === a;
    const atIndex = review?.rows.find((x) => x.index === index) ?? null;
    const r = atIndex && same(atIndex) ? atIndex : (review?.rows.find(same) ?? atIndex);
    const current = !!r && same(r);
    let status: QStatus;
    if (!q.trim()) status = "empty";
    else if (!a.trim()) status = "error";
    else if (current && (r!.error || (r!.missed?.length ?? 0) > 0)) status = "attention";
    else if (m.status === "approved") status = "done";
    else if (byAgent(m)) status = "new";
    else status = "progress";
    return { index, num, text: q, answer: a, options: readOptions(row), meta: m, status, review: current ? r : null, stale: !!r && !current, quality: null, qualityStale: false };
  });
}


/** Attach each question's quality score to it by position — the way reviews
 *  move: a row keeps its score as long as the question text is the same, and
 *  an edited question shows its score as stale. Unlike the review, the score
 *  informs: it never changes a question's status or gates approval. */
export function questionsQuality(qs: Question[], scored: Quality | null): Question[] {
  if (!scored || !Array.isArray(scored.rows)) return qs;
  const same = (x: QualityRow, q: Question) => text(x.input?.question ?? Object.values(x.input ?? {})[0]) === q.text;
  return qs.map((q) => {
    const atIndex = scored!.rows.find((x) => x.index === q.index) ?? null;
    const r = atIndex && same(atIndex, q) ? atIndex : (scored!.rows.find((x) => same(x, q)) ?? atIndex);
    const current = !!r && same(r, q);
    return { ...q, quality: current ? r : null, qualityStale: !!r && !current };
  });
}

/** A short title for the list: the meta title if any, else the question's first words. */
export function titleOf(q: Question): string {
  const t = q.text.replace(/\s+/g, " ").trim();
  if (!t) return "Pregunta vacía";
  return t.length > 70 ? t.slice(0, 68).trimEnd() + "…" : t;
}

export function groupsOf(qs: Question[]): { title: string; items: Question[] }[] {
  const groups: { title: string; items: Question[] }[] = [];
  for (const q of qs) {
    const title = q.meta.group?.trim() || "Preguntas";
    let g = groups.find((x) => x.title === title);
    if (!g) groups.push((g = { title, items: [] }));
    g.items.push(q);
  }
  return groups;
}

export const isPending = (q: Question) => ["progress", "attention", "new", "empty"].includes(q.status);
export const hasIssue = (q: Question) => q.status === "error" || q.status === "attention";

// ---- the rubric, edited in place in benchmark.yaml ---------------------------

const CRITERIA_PATH = ["scoring", "field_metrics", "answer", "params", "criteria"];

export function readCriteria(doc: Document): Criterion[] | null {
  const js = (doc.toJS() as Record<string, any>)?.scoring?.field_metrics?.answer?.params?.criteria as Record<string, any> | undefined;
  if (!js || typeof js !== "object") return null;
  return Object.entries(js).map(([key, c]) => ({
    key,
    weight: Number(c?.weight ?? 0),
    description: typeof c?.description === "string" ? c.description : "",
    levels: Object.keys(c?.levels ?? {})
      .map(Number)
      .sort((a, b) => a - b),
  }));
}

export function parseBenchDoc(yamlText: string): Document {
  return parseDocument(yamlText);
}

/** The input fields the program declares (`program.input`), when the yaml says them. */
export function readInputFields(doc: Document): string[] | null {
  const input = (doc.toJS() as Record<string, any>)?.program?.input;
  return input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input) : null;
}

/** benchmark.yaml with one criterion's weight or description changed; comments and order kept. */
export function setCriterion(yamlText: string, key: string, patch: { weight?: number; description?: string }): string {
  const doc = parseDocument(yamlText);
  if (patch.weight !== undefined) doc.setIn([...CRITERIA_PATH, key, "weight"], patch.weight);
  if (patch.description !== undefined) doc.setIn([...CRITERIA_PATH, key, "description"], patch.description);
  return String(doc);
}

/** The most criteria a rubric may have in the app. */
export const MAX_CRITERIA = 10;

/** benchmark.yaml with one more criterion at the end, named after the highest c<n>. */
export function addCriterion(
  yamlText: string,
  description: string,
  weight: number,
  levels?: Record<string, string>,
): string {
  const doc = parseDocument(yamlText);
  const keys = readCriteria(doc)?.map((c) => c.key) ?? [];
  const top = Math.max(0, ...keys.map((k) => Number(/^c(\d+)$/.exec(k)?.[1] ?? 0)));
  let n = top + 1;
  while (keys.includes(`c${n}`)) n++;
  // Grade wordings, defaulting to the classic pair: a criterion picked from
  // the org's library brings its own.
  const wordings: [number, string][] = Object.entries(levels ?? { "0": "No lo cumple", "1": "Lo cumple" })
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([grade, text]) => [Number(grade), text]);
  const levelsNode = doc.createNode(new Map(wordings)) as YAMLMap;
  levelsNode.flow = true;
  const node = doc.createNode({ weight, description }) as YAMLMap;
  node.set("levels", levelsNode);
  doc.setIn([...CRITERIA_PATH, `c${n}`], node);
  return String(doc);
}

/** benchmark.yaml without one criterion. Down to none is allowed on purpose: an
 *  open exam with an empty rubric cannot be evaluated, and the app says so and
 *  blocks it until the researcher writes new criteria. */
export function removeCriterion(yamlText: string, key: string): string {
  const doc = parseDocument(yamlText);
  doc.deleteIn([...CRITERIA_PATH, key]);
  return String(doc);
}

/** The exam and its notes without one question (questions.json stays aligned with exam.jsonl). */
export function removeQuestion<R>(rows: R[], meta: QuestionMeta[], index: number): { rows: R[]; meta: QuestionMeta[] } {
  return { rows: rows.filter((_, i) => i !== index), meta: meta.filter((_, i) => i !== index) };
}

export function shareOf(c: Criterion, all: Criterion[]): string {
  const total = all.reduce((a, x) => a + x.weight, 0) || 1;
  return Math.round((c.weight / total) * 100) + "%";
}

/** Did the criterion pass for this review row? */
export function criterionMet(r: ReviewRow, c: Criterion): boolean | null {
  const g = r.criteria?.[c.key]?.grade;
  if (g === undefined) return null;
  return g >= (c.levels[c.levels.length - 1] ?? 1);
}
