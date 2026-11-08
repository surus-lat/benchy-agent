import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorText, publicationErrorText, readBenchYaml, type BenchDoc, type CatalogModel, type Evaluation, type Publication, type RunResult } from "./data";
import {
  EMPTY_DESIGN,
  parseBenchDoc,
  parseDesign,
  parseExam,
  parseMeta,
  questionsFrom,
  questionsQuality,
  readCriteria,
  readInputFields,
  readMetric,
  readRoute,
  reviewMatchesRubric,
  serializeDesign,
  serializeExam,
  serializeMeta,
  type Criterion,
  type Design,
  type ExamRow,
  type QuestionMeta,
  type Quality,
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

/** What the app says when a write is refused because the benchmark is published. */
export const PUBLISHED_NOTE =
  "El benchmark está publicado: su definición está congelada. Revertí la publicación para seguir iterando sobre ella.";

export function useExam(bench: BenchSummary | undefined) {
  const slug = bench?.slug;
  const [yaml, setYaml] = useState<Versioned<string> | null>(null);
  const [rows, setRows] = useState<Versioned<(ExamRow | { raw: string })[]>>({ value: [] });
  const [meta, setMeta] = useState<Versioned<QuestionMeta[]>>({ value: [] });
  const [review, setReview] = useState<Review | null>(null);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [design, setDesign] = useState<Versioned<Design>>({ value: { ...EMPTY_DESIGN } });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Where the benchmark stands as a publication: the Worker's record, which is
  // what freezes the editors while it says the benchmark is published.
  const [publication, setPublication] = useState<Publication | null>(null);
  const [publicationBusy, setPublicationBusy] = useState(false);
  const [publicationError, setPublicationError] = useState<string | null>(null);
  const { files, refresh } = usePlatform();
  // The review's, the quality's, the papers' and the design's versions as last
  // read: written by the container, never by A.
  const side = useRef<{ review?: number; quality?: number; sources?: number; design?: number }>({});

  const doc: BenchDoc | null = yaml && slug ? readBenchYaml(yaml.value, slug) : null;
  let criteria: Criterion[] | null = null;
  let metric: string | null = null;
  let route: string | null = null;
  try {
    const parsed = yaml ? parseBenchDoc(yaml.value) : null;
    criteria = parsed ? readCriteria(parsed) : null;
    metric = parsed ? readMetric(parsed) : null;
    route = parsed ? readRoute(parsed) : null;
  } catch {
    criteria = null;
    metric = null;
    route = null;
  }
  const examPath = doc?.examPath ?? (slug ? `${slug}/exam.jsonl` : null);
  const metaPath = slug ? `${slug}/questions.json` : null;
  const designPath = slug ? `${slug}/design.json` : null;

  const reload = useCallback(async () => {
    if (!bench) return;
    try {
      const y = await api.file(bench.yamlPath);
      const benchDoc = readBenchYaml(y.content, bench.slug);
      const ePath = benchDoc.examPath ?? `${bench.slug}/exam.jsonl`;
      // What the program declares is what a row may carry: the agent writes its
      // own keys beside the question, and those are not part of a row.
      let inputFields: string[] | null = null;
      try {
        inputFields = readInputFields(parseBenchDoc(y.content));
      } catch {
        inputFields = null;
      }
      // A fresh listing: the agent may have written files since the platform's last
      // refresh. It is only an optimization to skip 404s — a truncated listing (a
      // big workspace) says nothing about the files it never got to, so then every
      // file is asked for and a missing one simply 404s.
      const known = await api
        .files()
        .then((r) => (r.truncated ? null : new Set(r.files.map((f) => f.path))))
        .catch(() => null);
      const [e, m, r, q, src, designFile] = await Promise.all([
        readOptional(ePath, known),
        readOptional(`${bench.slug}/questions.json`, known),
        readOptional(`${bench.slug}/review.json`, known),
        readOptional(`${bench.slug}/quality.json`, known),
        readOptional(`${bench.slug}/sources.json`, known),
        readOptional(`${bench.slug}/design.json`, known),
      ]);
      setSources(parseSources(src?.content));
      side.current = { review: r?.modified, quality: q?.modified, sources: src?.modified, design: designFile?.modified };
      setYaml({ value: y.content, modified: y.modified });
      // The agent writes exam rows flat as often as it writes them in the
      // program's shape, and only the latter is a row the engine accepts: both
      // read as the same row, and the file is put back in that shape before
      // anything runs against it.
      let exam = e;
      const parsed = e ? parseExam(e.content, inputFields) : [];
      if (e) {
        const canonical = serializeExam(parsed);
        if (canonical.trimEnd() !== e.content.trimEnd()) {
          try {
            const w = await api.write(ePath, canonical, e.modified);
            exam = { content: canonical, modified: w.modified };
          } catch {
            // Published (its definition is frozen) or the agent wrote while we
            // read: the file stays as it is and the next reload reads it again.
          }
        }
      }
      setRows({ value: parsed, modified: exam?.modified });
      setMeta({ value: parseMeta(m?.content), modified: m?.modified });
      setDesign({ value: parseDesign(designFile?.content), modified: designFile?.modified });
      try {
        setReview(r ? (JSON.parse(r.content) as Review) : null);
      } catch {
        setReview(null);
      }
      try {
        setQuality(q ? (JSON.parse(q.content) as Quality) : null);
      } catch {
        setQuality(null);
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

  // Where the benchmark stands as a publication. The Worker's rows are the
  // record; the container keeps the frozen copy of the files themselves.
  const reloadPublication = useCallback(async () => {
    if (!slug) return;
    try {
      setPublication(await api.publication(slug));
    } catch {
      // The org's listing carries the same rows: the next look catches up.
    }
  }, [slug]);
  useEffect(() => {
    setPublication(null);
    setPublicationError(null);
    void reloadPublication();
  }, [reloadPublication]);

  // A published benchmark's definition is frozen: the Worker and the container
  // refuse those writes, and the editors here do not even try.
  const frozen = publication?.state === "published";

  /** Re-read what only the container writes (the papers, the grader's review and quality), leaving edits alone. */
  const refreshSide = useCallback(async () => {
    if (!slug) return;
    const [r, q, src, d] = await Promise.all([
      readOptional(`${slug}/review.json`, null),
      readOptional(`${slug}/quality.json`, null),
      readOptional(`${slug}/sources.json`, null),
      readOptional(`${slug}/design.json`, null),
    ]).catch(() => [undefined, undefined, undefined, undefined]);
    if (r === undefined) return;
    side.current = { review: r?.modified, quality: q?.modified, sources: src?.modified, design: d?.modified };
    setSources(parseSources(src?.content));
    setDesign({ value: parseDesign(d?.content), modified: d?.modified });
    try {
      setReview(r ? (JSON.parse(r.content) as Review) : null);
    } catch {
      setReview(null);
    }
    try {
      setQuality(q ? (JSON.parse(q.content) as Quality) : null);
    } catch {
      setQuality(null);
    }
  }, [slug]);

  // Saving: the latest rows/meta are written after a pause in typing.
  const pending = useRef<{ rows?: (ExamRow | { raw: string })[]; meta?: QuestionMeta[] } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const versions = useRef({ exam: rows.modified, meta: meta.modified, yaml: yaml?.modified, design: design.modified });
  versions.current = { exam: rows.modified, meta: meta.modified, yaml: yaml?.modified, design: design.modified };

  const flush = useCallback(async () => {
    const job = pending.current;
    pending.current = null;
    if (!job || !examPath || !metaPath) return;
    if (frozen) {
      setSave("error");
      setError(PUBLISHED_NOTE);
      return;
    }
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
  }, [examPath, metaPath, reload, frozen]);

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
      if (frozen) {
        setSave("error");
        setError(PUBLISHED_NOTE);
        return;
      }
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
    [bench, reload, frozen],
  );

  const saveDesign = useCallback(
    async (next: Design) => {
      if (!designPath) return;
      if (frozen) {
        setSave("error");
        setError(PUBLISHED_NOTE);
        return;
      }
      setDesign((cur) => ({ ...cur, value: next }));
      setSave("saving");
      try {
        const r = await api.write(designPath, serializeDesign(next), versions.current.design);
        setDesign({ value: next, modified: r.modified });
        versions.current.design = r.modified;
        side.current.design = r.modified;
        setSave("saved");
        setSavedAt(Date.now());
      } catch (err) {
        setSave("error");
        setError(errorText(err));
        if (err instanceof ApiError && err.code === "CONFLICT") await reload();
      }
    },
    [designPath, reload, frozen],
  );

  // Publishing freezes this benchmark as its next version; reverting leaves that
  // version exactly where it is and turns the working copy back into an
  // editable draft tied to it, which is where the iterating continues.
  const publish = useCallback(
    async (note?: string): Promise<boolean> => {
      if (!slug || publicationBusy) return false;
      setPublicationError(null);
      setPublicationBusy(true);
      // Whatever is still being typed goes into the version being published.
      await flush();
      try {
        const r = await api.publish(slug, note?.trim() || undefined);
        if (r.ok) {
          await Promise.all([reloadPublication(), refresh()]);
          return true;
        }
        setPublicationError(publicationErrorText(r.error.code));
        await reloadPublication();
        return false;
      } catch (err) {
        setPublicationError(errorText(err));
        await reloadPublication();
        return false;
      } finally {
        setPublicationBusy(false);
      }
    },
    [slug, publicationBusy, flush, reloadPublication, refresh],
  );

  const revertPublication = useCallback(async (): Promise<boolean> => {
    if (!slug || publicationBusy) return false;
    setPublicationError(null);
    setPublicationBusy(true);
    try {
      const r = await api.revertPublication(slug);
      if (r.ok) {
        // The files did not change, but the gate did: reload them as editable.
        await Promise.all([reloadPublication(), reload(), refresh()]);
        return true;
      }
      setPublicationError(publicationErrorText(r.error.code));
      await reloadPublication();
      return false;
    } catch (err) {
      setPublicationError(errorText(err));
      await reloadPublication();
      return false;
    } finally {
      setPublicationBusy(false);
    }
  }, [slug, publicationBusy, reloadPublication, reload, refresh]);

  // The platform's listing says a file changed behind this window (the agent, a
  // colleague, a paper read in the background): load it, without losing typing.
  const stamp = (p: string | null | undefined) => (p ? files?.find((f) => f.path === p)?.modified : undefined);
  const remote = {
    exam: stamp(examPath),
    meta: stamp(metaPath),
    yaml: stamp(bench?.yamlPath),
    review: stamp(slug && `${slug}/review.json`),
    quality: stamp(slug && `${slug}/quality.json`),
    sources: stamp(slug && `${slug}/sources.json`),
    design: stamp(designPath),
  };
  useEffect(() => {
    if (loading || !files) return;
    const newer = (theirs?: number, mine?: number) => theirs !== undefined && (mine === undefined || theirs > mine);
    const v = versions.current;
    if ((newer(remote.exam, v.exam) || newer(remote.meta, v.meta) || newer(remote.yaml, v.yaml)) && !pending.current) {
      void reload();
    } else if (
      newer(remote.review, side.current.review) ||
      newer(remote.quality, side.current.quality) ||
      newer(remote.sources, side.current.sources) ||
      newer(remote.design, side.current.design)
    ) {
      void refreshSide();
    }
  }, [remote.exam, remote.meta, remote.yaml, remote.review, remote.quality, remote.sources, remote.design, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const questions = questionsQuality(questionsFrom(rows.value, meta.value, review, criteria), quality);
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
    /** The answer field's scoring metric (casefold_strip marks multiple choice). */
    metric,
    /** The optional input field a mixed exam routes to exact match; null on a single-kind exam. */
    route,
    rows: rows.value,
    meta: meta.value,
    review,
    reviewOutdated,
    quality,
    questions,
    /** The benchmark's papers (sources.json). */
    sources,
    /** What the benchmark sets out to evaluate (design.json). */
    design: design.value,
    designPath,
    examPath,
    reload,
    update,
    updateMeta,
    saveYaml,
    saveDesign,
    flush,
    /** Where the benchmark stands as a publication (null while it is being read). */
    publication,
    /** Its definition is frozen because its publication is published. */
    frozen,
    publicationBusy,
    publicationError,
    setPublicationError,
    publish,
    revertPublication,
    reloadPublication,
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

/**
 * The AI systems this platform can run, with the catalog info the app shows
 * for them (name, maker, region): the same list 04 · Evaluación picks from and
 * 05 · Resultados uses to name a run in progress.
 */
export function useModelCatalog() {
  const [state, setState] = useState<{ models: string[]; catalog: CatalogModel[] }>({ models: [], catalog: [] });
  useEffect(() => {
    void api
      .models()
      .then((r) =>
        setState({
          models: r.models,
          catalog: r.catalog ?? r.models.map((id) => ({ id, name: id, maker: "", region: "Otras", default: false })),
        }),
      )
      .catch(() => {});
  }, []);
  return state;
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
