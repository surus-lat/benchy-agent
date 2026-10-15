// The exam as the workspace window edits it. Pure functions over the three
// files a rubric benchmark keeps (the agent skill writes the same shapes):
//
//   benchmark.yaml   program, rubric (scoring.field_metrics.answer.params.criteria)
//   exam.jsonl       one {"input": {"question"}, "expected": {"answer"}} per line
//   questions.json   {"rows": [{why, sources, tags, group, status, by}]}, aligned
//                    with the exam's rows (the engine rejects extra keys in a row)
//
// and review.json, written by the grader review (apps/agent/mcp/benchy_review.py).

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

export type Criterion = { key: string; weight: number; description: string; levels: number[] };

/** Status in the question list. */
export type QStatus = "done" | "progress" | "attention" | "new" | "error" | "empty";

export type Question = {
  index: number;
  num: string;
  text: string;
  answer: string;
  meta: QuestionMeta;
  status: QStatus;
  /** The grader review of this exact text and answer, if there is one. */
  review: ReviewRow | null;
  /** Reviewed before, but the text or answer changed since. */
  stale: boolean;
};

// ---- exam.jsonl -----------------------------------------------------------------

/** Parse the exam. Unparseable lines are kept as raw text so a save never drops them. */
export function parseExam(text: string): (ExamRow | { raw: string })[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      try {
        const row = JSON.parse(line) as ExamRow;
        if (row && typeof row === "object" && row.input && row.expected) return row;
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
    return Array.isArray(rows) ? rows.map((r) => (r && typeof r === "object" ? (r as QuestionMeta) : {})) : [];
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

const text = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));

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
      return { index, num, text: row.raw, answer: "", meta: m, status: "error" as const, review: null, stale: false };
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
    return { index, num, text: q, answer: a, meta: m, status, review: current ? r : null, stale: !!r && !current };
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
export function addCriterion(yamlText: string, description: string, weight: number): string {
  const doc = parseDocument(yamlText);
  const keys = readCriteria(doc)?.map((c) => c.key) ?? [];
  const top = Math.max(0, ...keys.map((k) => Number(/^c(\d+)$/.exec(k)?.[1] ?? 0)));
  let n = top + 1;
  while (keys.includes(`c${n}`)) n++;
  const levels = doc.createNode(new Map([[0, "No lo cumple"], [1, "Lo cumple"]])) as YAMLMap;
  levels.flow = true;
  const node = doc.createNode({ weight, description }) as YAMLMap;
  node.set("levels", levels);
  doc.setIn([...CRITERIA_PATH, `c${n}`], node);
  return String(doc);
}

/** benchmark.yaml without one criterion; a rubric keeps at least one. */
export function removeCriterion(yamlText: string, key: string): string {
  const doc = parseDocument(yamlText);
  if ((readCriteria(doc)?.length ?? 0) <= 1) return yamlText;
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
