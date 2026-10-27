// Data for the platform UI (state A). Everything comes from the Worker; the
// agent writes the workspace, this layer only reads it and derives views.

import { parse as parseYaml } from "yaml";
import { ApiError, api as chatApi, type WorkspaceFile } from "../app/api";

export { ApiError, errorText } from "../app/api";
import { impersonateHeaders } from "./impersonate";
export type { Message, WorkspaceFile } from "../app/api";

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", headers: impersonateHeaders() });
  } catch {
    throw new ApiError("NETWORK", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `HTTP_${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

async function del<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: "DELETE", credentials: "same-origin", headers: impersonateHeaders() });
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
  results: { index: number; status: string; prediction: unknown; field_scores: { path: string[]; score: number; weight: number; criteria?: Record<string, { grade: number; justification: string }> }[] | null; error: EngineError | null }[];
};
export type Me = {
  user: { id: string; name: string; email: string };
  org: { id: string; name: string; slug?: string; brandColor?: string | null; brandColorSecondary?: string | null; brandTagline?: string | null; brandLogoUrl?: string | null } | null;
};

/**
 * Whether the browser's spell checker can help with text in `lang`. The browser
 * picks the dictionary from its own settings, not from the page (Chrome checks
 * against the languages enabled there, by default its interface language), so a
 * Spanish exam in an English browser would be all red. Spell check stays on only
 * when the browser's first language is the text's.
 */
export function spellcheckFor(lang: string, languages: readonly string[] | undefined = globalThis.navigator?.languages): boolean {
  const first = (languages?.[0] ?? globalThis.navigator?.language ?? "").toLowerCase();
  return !!lang && first.split("-")[0] === lang.toLowerCase().split("-")[0];
}

/** Where a benchmark is published: getbenchy.lat/b/<org>/<benchmark>. */
export function publicPath(org: { slug?: string; name: string } | null | undefined, slug: string): string {
  const o = org?.slug || (org?.name ?? "org").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `getbenchy.lat/b/${o}/${slug}`;
}

/** A model a benchmark may run, with its maker and region (apps/agent/mcp/benchy_shared.py). */
export type CatalogModel = { id: string; name: string; maker: string; region: string; default: boolean };

/** Regions in the order the app lists them. */
export const REGIONS = ["Norteamérica", "Europa", "China", "Otras"];

/** The results beyond the score (apps/agent/mcp/benchy_analysis.py). */
export type Analysis = {
  ok: true;
  grader: string | null;
  criteria: { key: string; weight: number; description: string; top: number }[];
  groups: string[];
  papers: { id: string; title: string; year: number | null }[];
  models: {
    model: string;
    name: string;
    maker: string;
    region: string;
    file: string;
    run_at: number;
    score: number | null;
    summary: { examples?: number; valid?: number; invalid_outputs?: number; execution_errors?: number };
    stale: boolean;
    criteria: Record<string, number | null>;
    groups: Record<string, number | null>;
    papers: Record<string, number | null>;
  }[];
  questions: {
    index: number;
    num: string;
    question: string;
    expert_answer: string;
    group: string;
    papers: string[];
    mean: number | null;
    models: Record<string, { score: number; status: string; answer: string; missed: { criterion: string; justification: string }[]; error: string | null }>;
  }[];
  hardest: number[];
  regions: Record<string, number | null>;
};

async function send<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("NETWORK", 0);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error ?? `HTTP_${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...impersonateHeaders() },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("NETWORK", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `HTTP_${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...impersonateHeaders() },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("NETWORK", 0);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error ?? `HTTP_${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

/** An evaluation in the container (<bench>/evaluation.json): each model's run, then the report. */
export type Evaluation = {
  state: "running" | "reporting" | "done" | "error" | "interrupted";
  started: number;
  finished: number | null;
  models: {
    model: string;
    state: "pending" | "running" | "done" | "error";
    score?: number | null;
    summary?: { examples?: number; valid?: number; invalid_outputs?: number; execution_errors?: number };
    seconds?: number;
    error?: EngineError;
  }[];
  report: { state: "pending" | "running" | "done" | "error" | "skipped"; started?: number; finished?: number; error?: string };
};

/** One saved criterion of the org's library: the wording the judge applies,
 *  its importance, and the grade wordings (the levels map in benchmark.yaml). */
export type LibraryCriterion = {
  id: string;
  name: string;
  description: string;
  weight: number;
  levels: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

/** One question of the org's peer review (issue #1): the text every member
 *  sees, the members' tally over the current text, and whether it is Validada. */
export type PeerQuestion = {
  bench: string;
  q: number;
  question: string;
  expectedAnswer: string | null;
  votes: { up: number; down: number };
  myVote: number | null;
  hash: string;
  validated: boolean;
};

/** The judge for a benchmark's next evaluation: its override, the org's default, and which one applies. */
export type JudgeConfig = {
  override: string | null;
  orgDefault: string | null;
  effective: string | null;
  source: "override" | "org" | "system";
};

export const api = {
  ...chatApi,
  me: () => get<Me>("/api/me"),
  models: () => get<{ provider: string; models: string[]; catalog?: CatalogModel[] }>("/api/models"),
  /** The org's default judge model (null: each benchmark's own grader judges). */
  orgJudge: () => get<{ judgeModel: string | null }>("/api/org/judge"),
  setOrgJudge: (judgeModel: string | null) => put<{ judgeModel: string | null }>("/api/org/judge", { judgeModel }),
  /** The org's visual identity for reports and publications (issue #5). */
  setOrgBranding: (branding: { color: string | null; colorSecondary?: string | null; tagline: string | null; logoUrl?: string | null }) =>
    patch<{ color: string | null; colorSecondary: string | null; tagline: string | null; logoUrl: string | null }>("/api/org/branding", branding),
  /** One benchmark's judge: its override, the org's default, and which applies. */
  benchJudge: (bench: string) => get<JudgeConfig>(`/api/workspace/judge?bench=${encodeURIComponent(bench)}`),
  setBenchJudge: (bench: string, judgeModel: string | null) => put<JudgeConfig>("/api/workspace/judge", { bench, judgeModel }),
  /** The org's library of reusable evaluation criteria (issue #12): saved in
   *  D1, offered by the "Criterios de evaluación" drawer of every benchmark. */
  criteria: () => get<{ criteria: LibraryCriterion[] }>("/api/criteria"),
  saveCriterion: (c: Omit<LibraryCriterion, "id" | "createdAt" | "updatedAt">) =>
    send<{ criterion: LibraryCriterion }>("/api/criteria", c),
  forgetCriterion: (id: string) => del<{ ok: boolean }>(`/api/criteria/${encodeURIComponent(id)}`),
  /** Every question of the org's benchmarks with its peer tally (issue #1). */
  orgQuestions: () => get<{ questions: PeerQuestion[]; truncated: boolean }>("/api/org/questions"),
  /** +1 valida, -1 rechaza, 0 quita el voto del miembro. */
  voteQuestion: (v: { bench: string; q: number; hash: string; vote: 1 | -1 | 0 }) =>
    send<{ ok: boolean; bench: string; q: number; vote: number | null }>("/api/org/questions/vote", v),
  /** Delete a benchmark and everything it produced; the app confirms first. */
  removeBenchmark: (bench: string) => del<{ ok: boolean }>(`/api/workspace/benchmark?bench=${encodeURIComponent(bench)}`),
  removeQuestion: (bench: string, q: number) =>
    del<{ ok: boolean }>(`/api/workspace/benchmark/question?bench=${encodeURIComponent(bench)}&q=${q}`),
  validate: (path: string) => get<Validation>(`/api/workspace/validate?path=${encodeURIComponent(path)}`),
  exam: (path: string) => get<ExamCheck>(`/api/workspace/exam?path=${encodeURIComponent(path)}`),
  analysis: (path: string) => get<Analysis | { ok: false; error: EngineError }>(`/api/workspace/analysis?path=${encodeURIComponent(path)}`),
  text: async (path: string) => (await chatApi.file(path)).content,
  /** The benchmark's last evaluation (each model, then the report), kept by the container. */
  evaluation: (path: string) => get<{ ok: true; evaluation: Evaluation | null } | { ok: false; error: EngineError }>(`/api/workspace/evaluation?path=${encodeURIComponent(path)}`),
  /** Run the benchmark with these models in the container; the report follows on its own. */
  startEvaluation: (path: string, models: string[]) =>
    send<{ ok: true; evaluation: Evaluation } | { ok: false; error: EngineError }>("/api/workspace/evaluation", { path, models }),
  /** (Re)write the findings report from the results there are. */
  startReport: (path: string) => send<{ ok: true; evaluation: Evaluation } | { ok: false; error: EngineError }>(`/api/workspace/report?path=${encodeURIComponent(path)}`),
  /** The grader grades every expert answer against the rubric; writes review.json. */
  review: async (path: string) => {
    let res: Response;
    try {
      res = await fetch(`/api/workspace/review?path=${encodeURIComponent(path)}`, { method: "POST", credentials: "same-origin" });
    } catch {
      throw new ApiError("NETWORK", 0);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(body.error ?? `HTTP_${res.status}`, res.status);
    }
    return (await res.json()) as { ok: true } | { ok: false; error: EngineError };
  },
  /** The grader scores every question on the four fixed quality criteria; writes quality.json. */
  quality: async (path: string) => {
    let res: Response;
    try {
      res = await fetch(`/api/workspace/quality?path=${encodeURIComponent(path)}`, { method: "POST", credentials: "same-origin" });
    } catch {
      throw new ApiError("NETWORK", 0);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(body.error ?? `HTTP_${res.status}`, res.status);
    }
    return (await res.json()) as { ok: true } | { ok: false; error: EngineError };
  },
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
  /** The rubric grader's model, for rubric benchmarks. */
  grader?: string;
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
    doc.grader = y?.scoring?.grader?.model;
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
