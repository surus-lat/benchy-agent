import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorText, readBenchYaml, type BenchDoc, type Evaluation, type RunResult } from "./data";
import {
  parseBenchDoc,
  parseExam,
  parseMeta,
  questionsFrom,
  readCriteria,
  reviewMatchesRubric,
  serializeExam,
  serializeMeta,
  type Criterion,
  type ExamRow,
  type QuestionMeta,
  type Review,
} from "./exam-model";
import { usePlatform, type BenchSummary } from "./store";
import { parseSources, type Source } from "./library-data";

// One benchmark's files, loaded and kept in sync for the workspace window:
// edits apply locally at once and are saved shortly after, never over a
// version the agent wrote in between (the container refuses: CONFLICT).

type Versioned<T> = { value: T; modified?: number };

const SAVE_DELAY_MS = 700;

async function readOptional(path: string, known: Set<string> | null): Promise<{ content: string; modified: number } | null> {
  // Skip files the listing says are not there (no 404 in the console).
  if (known && !known.has(path)) return null;
  try {
    const f = await api.file(path);
    return { content: f.content, modified: f.modified };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export type SaveState = "idle" | "saving" | "saved" | "error";

export function useExam(bench: BenchSummary | undefined) {
  const slug = bench?.slug;
  const [yaml, setYaml] = useState<Versioned<string> | null>(null);
  const [rows, setRows] = useState<Versioned<(ExamRow | { raw: string })[]>>({ value: [] });
  const [meta, setMeta] = useState<Versioned<QuestionMeta[]>>({ value: [] });
  const [review, setReview] = useState<Review | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const { files } = usePlatform();
  // The review's and the papers' versions as last read: written by the container, never by A.
  const side = useRef<{ review?: number; sources?: number }>({});

  const doc: BenchDoc | null = yaml && slug ? readBenchYaml(yaml.value, slug) : null;
  let criteria: Criterion[] | null = null;
  try {
    criteria = yaml ? readCriteria(parseBenchDoc(yaml.value)) : null;
  } catch {
    criteria = null;
  }
  const examPath = doc?.examPath ?? (slug ? `${slug}/exam.jsonl` : null);
  const metaPath = slug ? `${slug}/questions.json` : null;

  const reload = useCallback(async () => {
    if (!bench) return;
    try {
      const y = await api.file(bench.yamlPath);
      const d = readBenchYaml(y.content, bench.slug);
      const ePath = d.examPath ?? `${bench.slug}/exam.jsonl`;
      // A fresh listing: the agent may have written files since the platform's last refresh.
      const known = await api
        .files()
        .then((r) => new Set(r.files.map((f) => f.path)))
        .catch(() => null);
      const [e, m, r, src] = await Promise.all([
        readOptional(ePath, known),
        readOptional(`${bench.slug}/questions.json`, known),
        readOptional(`${bench.slug}/review.json`, known),
        readOptional(`${bench.slug}/sources.json`, known),
      ]);
      setSources(parseSources(src?.content));
      side.current = { review: r?.modified, sources: src?.modified };
      setYaml({ value: y.content, modified: y.modified });
      setRows({ value: e ? parseExam(e.content) : [], modified: e?.modified });
      setMeta({ value: parseMeta(m?.content), modified: m?.modified });
      try {
        setReview(r ? (JSON.parse(r.content) as Review) : null);
      } catch {
        setReview(null);
      }
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [bench?.slug, bench?.yamlPath]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  /** Re-read what only the container writes (the papers, the grader's review), leaving edits alone. */
  const refreshSide = useCallback(async () => {
    if (!slug) return;
    const [r, src] = await Promise.all([readOptional(`${slug}/review.json`, null), readOptional(`${slug}/sources.json`, null)]).catch(() => [undefined, undefined]);
    if (r === undefined) return;
    side.current = { review: r?.modified, sources: src?.modified };
    setSources(parseSources(src?.content));
    try {
      setReview(r ? (JSON.parse(r.content) as Review) : null);
    } catch {
      setReview(null);
    }
  }, [slug]);

  // Saving: the latest rows/meta are written after a pause in typing.
  const pending = useRef<{ rows?: (ExamRow | { raw: string })[]; meta?: QuestionMeta[] } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const versions = useRef({ exam: rows.modified, meta: meta.modified, yaml: yaml?.modified });
  versions.current = { exam: rows.modified, meta: meta.modified, yaml: yaml?.modified };

  const flush = useCallback(async () => {
    const job = pending.current;
    pending.current = null;
    if (!job || !examPath || !metaPath) return;
    setSave("saving");
    try {
      if (job.rows) {
        const r = await api.write(examPath, serializeExam(job.rows), versions.current.exam);
        setRows((cur) => ({ ...cur, modified: r.modified }));
        versions.current.exam = r.modified;
      }
      if (job.meta) {
        const r = await api.write(metaPath, serializeMeta(job.meta), versions.current.meta);
        setMeta((cur) => ({ ...cur, modified: r.modified }));
        versions.current.meta = r.modified;
      }
      setSave("saved");
      setSavedAt(Date.now());
    } catch (err) {
      setSave("error");
      setError(errorText(err));
      if (err instanceof ApiError && err.code === "CONFLICT") await reload();
    }
  }, [examPath, metaPath, reload]);

  const schedule = useCallback(
    (job: { rows?: (ExamRow | { raw: string })[]; meta?: QuestionMeta[] }) => {
      pending.current = { ...pending.current, ...job };
      setSave("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  // Write anything still pending when leaving the benchmark.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      void flush();
    },
    [flush],
  );

  const update = useCallback(
    (nextRows: (ExamRow | { raw: string })[], nextMeta: QuestionMeta[]) => {
      setRows((cur) => ({ ...cur, value: nextRows }));
      setMeta((cur) => ({ ...cur, value: nextMeta }));
      schedule({ rows: nextRows, meta: nextMeta });
    },
    [schedule],
  );

  const updateMeta = useCallback(
    (nextMeta: QuestionMeta[]) => {
      setMeta((cur) => ({ ...cur, value: nextMeta }));
      schedule({ meta: nextMeta });
    },
    [schedule],
  );

  const saveYaml = useCallback(
    async (text: string) => {
      if (!bench) return;
      setYaml((cur) => (cur ? { ...cur, value: text } : cur));
      setSave("saving");
      try {
        const r = await api.write(bench.yamlPath, text, versions.current.yaml);
        setYaml({ value: text, modified: r.modified });
        setSave("saved");
        setSavedAt(Date.now());
      } catch (err) {
        setSave("error");
        setError(errorText(err));
        if (err instanceof ApiError && err.code === "CONFLICT") await reload();
      }
    },
    [bench, reload],
  );

  // The platform's listing says a file changed behind this window (the agent, a
  // colleague, a paper read in the background): load it, without losing typing.
  const stamp = (p: string | null | undefined) => (p ? files?.find((f) => f.path === p)?.modified : undefined);
  const remote = {
    exam: stamp(examPath),
    meta: stamp(metaPath),
    yaml: stamp(bench?.yamlPath),
    review: stamp(slug && `${slug}/review.json`),
    sources: stamp(slug && `${slug}/sources.json`),
  };
  useEffect(() => {
    if (loading || !files) return;
    const newer = (theirs?: number, mine?: number) => theirs !== undefined && (mine === undefined || theirs > mine);
    const v = versions.current;
    if ((newer(remote.exam, v.exam) || newer(remote.meta, v.meta) || newer(remote.yaml, v.yaml)) && !pending.current) {
      void reload();
    } else if (newer(remote.review, side.current.review) || newer(remote.sources, side.current.sources)) {
      void refreshSide();
    }
  }, [remote.exam, remote.meta, remote.yaml, remote.review, remote.sources, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const questions = questionsFrom(rows.value, meta.value, review, criteria);
  // The last review was made with a rubric that has changed since.
  const reviewOutdated = !!review && !reviewMatchesRubric(review, criteria);

  return {
    loading,
    error,
    setError,
    save,
    savedAt,
    doc,
    yamlText: yaml?.value ?? "",
    criteria,
    rows: rows.value,
    meta: meta.value,
    review,
    reviewOutdated,
    questions,
    /** The benchmark's papers (sources.json). */
    sources,
    examPath,
    reload,
    update,
    updateMeta,
    saveYaml,
    flush,
  };
}

export type ExamState = ReturnType<typeof useExam>;

/** The newest result of each run file of a benchmark (for Evaluation and the agent's cards). */
export function useRunResults(bench: BenchSummary | undefined) {
  const [results, setResults] = useState<{ file: BenchSummary["runs"][number]; result: RunResult }[]>([]);
  const key = bench ? bench.runs.map((r) => r.path + r.modified).join("|") : "";
  useEffect(() => {
    if (!bench) return;
    let cancelled = false;
    void Promise.all(
      bench.runs.slice(0, 16).map((file) =>
        api
          .text(file.path)
          .then((t) => ({ file, result: JSON.parse(t) as RunResult }))
          .catch(() => null),
      ),
    ).then((rs) => !cancelled && setResults(rs.filter((r): r is NonNullable<typeof r> => !!r)));
    return () => {
      cancelled = true;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return results;
}

/** The AI systems chosen to evaluate a benchmark, remembered in this browser. */
export function useSelectedModels(slug: string, models: string[], defaults?: string[]): [Set<string>, (s: Set<string>) => void] {
  const key = `benchy-sys:${slug}`;
  const [sel, setSel] = useState<Set<string> | null>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? new Set(JSON.parse(raw) as string[]) : null;
    } catch {
      return null;
    }
  });
  // Until the researcher picks: the catalog's defaults (one model per region), else all.
  const effective = sel ?? new Set(defaults?.length ? defaults.filter((m) => models.includes(m)) : models);
  const set = (s: Set<string>) => {
    setSel(s);
    try {
      localStorage.setItem(key, JSON.stringify([...s]));
    } catch {
      // ignore
    }
  };
  return [effective, set];
}

const POLL_MS = 4000;
const signature = (e: Evaluation | null) => (e ? `${e.state}|${e.models.map((m) => m.state).join(",")}|${e.report.state}` : "");

/**
 * The benchmark's evaluation as the container keeps it (evaluation.json):
 * read on opening, polled while it runs, so it shows the same after a reload
 * or on another device. `onChange` runs when a model or the report finishes,
 * to reload the files the results come from.
 */
export function useEvaluation(bench: BenchSummary | undefined, onChange: () => void) {
  const path = bench?.yamlPath;
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const last = useRef<string | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;

  const take = useCallback((e: Evaluation | null) => {
    setEvaluation(e);
    const sig = signature(e);
    if (last.current !== null && sig !== last.current) changed.current();
    last.current = sig;
  }, []);

  const load = useCallback(async () => {
    if (!path) return;
    try {
      const r = await api.evaluation(path);
      take(r.ok ? r.evaluation : null);
    } catch {
      // The next poll tries again.
    }
  }, [path, take]);

  useEffect(() => {
    last.current = null;
    setEvaluation(null);
    void load();
  }, [load]);

  const active = evaluation?.state === "running" || evaluation?.state === "reporting";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  const begin = useCallback(
    async (call: () => Promise<{ ok: true; evaluation: Evaluation } | { ok: false; error: { code: string; message: string } }>, what: string) => {
      setError(null);
      try {
        const r = await call();
        if (r.ok) take(r.evaluation);
        else setError(`${what} no pudo empezar: ${r.error.code} · ${r.error.message}`);
      } catch (err) {
        setError(errorText(err));
        void load();
      }
    },
    [take, load],
  );
  const start = useCallback((models: string[]) => (path ? begin(() => api.startEvaluation(path, models), "La evaluación") : Promise.resolve()), [path, begin]);
  const startReport = useCallback(() => (path ? begin(() => api.startReport(path), "El informe") : Promise.resolve()), [path, begin]);

  return { evaluation, active, error, setError, start, startReport, reload: load };
}

export type EvaluationState = ReturnType<typeof useEvaluation>;
