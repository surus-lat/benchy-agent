// Data for the platform UI (state A). Everything comes from the Worker; the
// agent writes the workspace, this layer only reads it and derives views.

import { parse as parseYaml } from "yaml";
import { ApiError, api as chatApi, type WorkspaceFile } from "../app/api";

export { ApiError, errorText } from "../app/api";
export type { Message, WorkspaceFile } from "../app/api";

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin" });
  } catch {
    throw new ApiError("NETWORK", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `HTTP_${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export type EngineError = { phase?: string; code: string; message: string; path?: string[] | null };
export type Dimension = { path: string[]; weight: number };
export type Validation =
  | { ok: true; benchmark: { task: string; domain: string; language: string }; dimensions: Dimension[]; ai_system: AiSystem }
  | { ok: false; error: EngineError };
export type AiSystem = { type: string; provider?: string; model?: string; parameters?: Record<string, unknown> };
export type ExamRow = { line: number; input: unknown; expected: unknown; status: "valid" | "rejected"; error: EngineError | null };
export type ExamCheck =
  | { ok: true; total: number; valid: number; rejected: number; truncated: boolean; rows: ExamRow[]; dimensions: Dimension[] }
  | { ok: false; error: EngineError };
export type RunResult = {
  ai_system?: AiSystem;
  benchmark_score: number;
  summary: { examples: number; valid: number; invalid_outputs: number; execution_errors: number };
  results: { index: number; status: string; prediction: unknown; field_scores: { path: string[]; score: number; weight: number }[] | null; error: EngineError | null }[];
};
export type Me = { user: { id: string; name: string; email: string }; org: { id: string; name: string } | null };

export const api = {
  ...chatApi,
  me: () => get<Me>("/api/me"),
  models: () => get<{ provider: string; models: string[] }>("/api/models"),
  validate: (path: string) => get<Validation>(`/api/workspace/validate?path=${encodeURIComponent(path)}`),
  exam: (path: string) => get<ExamCheck>(`/api/workspace/exam?path=${encodeURIComponent(path)}`),
  text: async (path: string) => (await chatApi.file(path)).content,
};

// ---- Benchmarks from the workspace listing --------------------------------

export type Bench = {
  slug: string;
  yamlPath: string;
  examPath: string | null;
  runs: WorkspaceFile[]; // newest first
  modified: number;
};

/** A folder with a benchmark.yaml at its top is a benchmark. */
export function benchesFrom(files: WorkspaceFile[]): Bench[] {
  const bySlug = new Map<string, Bench>();
  for (const f of files) {
    const [slug, ...rest] = f.path.split("/");
    if (rest.length === 1 && rest[0] === "benchmark.yaml") {
      bySlug.set(slug, { slug, yamlPath: f.path, examPath: null, runs: [], modified: f.modified });
    }
  }
  for (const f of files) {
    const [slug, ...rest] = f.path.split("/");
    const b = bySlug.get(slug);
    if (!b) continue;
    b.modified = Math.max(b.modified, f.modified);
    if (rest[0] === "runs" && rest.length === 2 && f.path.endsWith(".json")) b.runs.push(f);
  }
  for (const b of bySlug.values()) b.runs.sort((x, y) => y.modified - x.modified);
  return [...bySlug.values()].sort((a, b) => b.modified - a.modified);
}

/** The title is the YAML's first-line comment (agent convention); else the slug. */
export function titleOf(yamlText: string | undefined, slug: string): string {
  const first = yamlText?.split("\n").find((l) => l.trim().length > 0) ?? "";
  const m = first.match(/^#\s*(.+?)\s*$/);
  if (m) return m[1];
  return slug.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export type BenchDoc = {
  title: string;
  task?: string;
  domain?: string;
  language?: string;
  examPath?: string;
  model?: string;
  parameters?: Record<string, unknown>;
};

export function readBenchYaml(text: string, slug: string): BenchDoc {
  const doc: BenchDoc = { title: titleOf(text, slug) };
  try {
    const y = parseYaml(text) as Record<string, any>;
    doc.task = y?.benchmark?.task;
    doc.domain = y?.benchmark?.domain;
    doc.language = y?.benchmark?.language;
    const dp = y?.data?.path;
    if (typeof dp === "string") doc.examPath = `${slug}/${dp.replace(/^\.\//, "")}`;
    doc.model = y?.["ai-system"]?.model;
    doc.parameters = y?.["ai-system"]?.parameters;
  } catch {
    // Unparseable YAML still shows, with its title; validate says what is wrong.
  }
  return doc;
}

// ---- Runs and comparisons ----------------------------------------------------

/** The model a run file was for: from the result, else the file name convention. */
export function runModel(file: WorkspaceFile, result?: RunResult, benchModel?: string): string {
  if (result?.ai_system?.model) return result.ai_system.model;
  const name = file.path.split("/").pop() ?? "";
  const parts = name.replace(/\.json$/, "").split("__");
  // Runs from before model recording ran the benchmark's own ai-system.
  return parts.length === 3 ? parts[1] : benchModel ?? "modelo del benchmark";
}

/** The newest run per model: that set is "the comparison". */
export function newestPerModel(runs: { file: WorkspaceFile; result: RunResult }[], benchModel?: string) {
  const seen = new Map<string, { file: WorkspaceFile; result: RunResult; model: string }>();
  for (const r of [...runs].sort((a, b) => b.file.modified - a.file.modified)) {
    const model = runModel(r.file, r.result, benchModel);
    if (!seen.has(model)) seen.set(model, { ...r, model });
  }
  return [...seen.values()].sort((a, b) => b.result.benchmark_score - a.result.benchmark_score);
}

/** Mean score per output field across a run's valid results. */
export function fieldMeans(result: RunResult): Map<string, number> {
  const sums = new Map<string, { s: number; n: number }>();
  for (const r of result.results) {
    if (!r.field_scores) continue;
    for (const f of r.field_scores) {
      const k = f.path.join(".");
      const cur = sums.get(k) ?? { s: 0, n: 0 };
      cur.s += f.score;
      cur.n += 1;
      sums.set(k, cur);
    }
  }
  // Failed examples count as 0 for every field, like they do for the score.
  const total = result.results.length || 1;
  return new Map([...sums].map(([k, v]) => [k, v.s / total]));
}

// ---- Agent "ask" blocks -----------------------------------------------------

export type Ask = { question: string; options: string[] };

/** Split a reply into its markdown and an optional ```ask {json}``` block. */
export function splitAsk(content: string): { text: string; ask: Ask | null } {
  const m = content.match(/```ask\s*\n([\s\S]*?)```\s*$/);
  if (!m) return { text: content, ask: null };
  try {
    const a = JSON.parse(m[1]) as Ask;
    if (typeof a.question === "string" && Array.isArray(a.options) && a.options.length > 0) {
      return { text: content.slice(0, m.index).trim(), ask: { question: a.question, options: a.options.slice(0, 4).map(String) } };
    }
  } catch {
    // Not valid JSON: show it as written.
  }
  return { text: content, ask: null };
}

// ---- Small formatting helpers -----------------------------------------------

export function since(unixSeconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (s < 90) return "recién";
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  if (s < 2 * 86400) return "ayer";
  return `hace ${Math.round(s / 86400)} días`;
}

export function leafSummary(value: unknown): string {
  if (value == null) return "(vacío)";
  if (typeof value !== "object") return String(value);
  return Object.values(value as Record<string, unknown>)
    .map((v) => (v && typeof v === "object" ? leafSummary(v) : String(v)))
    .join(" · ");
}

export function firstText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const t = firstText(v);
      if (t) return t;
    }
  }
  return value == null ? "" : String(value);
}
