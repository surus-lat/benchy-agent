import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorText, readBenchYaml, type BenchDoc, type RunResult } from "./data";
import {
  parseBenchDoc,
  parseExam,
  parseMeta,
  questionsFrom,
  readCriteria,
  serializeExam,
  serializeMeta,
  type Criterion,
  type ExamRow,
  type QuestionMeta,
  type Review,
} from "./exam-model";
import type { BenchSummary } from "./store";

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<number | null>(null);

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
      const [e, m, r] = await Promise.all([
        readOptional(ePath, known),
        readOptional(`${bench.slug}/questions.json`, known),
        readOptional(`${bench.slug}/review.json`, known),
      ]);
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

  const questions = questionsFrom(rows.value, meta.value, review);

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
    questions,
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
