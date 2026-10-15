import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  api,
  ApiError,
  benchesFrom,
  errorText,
  readBenchYaml,
  type Bench,
  type BenchDoc,
  type Me,
  type RunResult,
  type Validation,
  type WorkspaceFile,
} from "./data";
import { libraryErrorText, sources, type SourceResult } from "./library-data";

// Shared state for the platform: who is signed in, the org workspace, a summary
// per benchmark, and comparison runs in flight (which must survive switching
// tabs). Conversations are per user and per benchmark, remembered locally.

export type BenchSummary = Bench & {
  doc?: BenchDoc;
  items?: number;
  best?: number | null;
  validation?: Validation;
};

export type ComparisonRun = {
  slug: string;
  models: string[];
  startedAt: number;
  baseline: Set<string>; // run files that existed when it started
  finished: Set<string>; // models whose new run file has appeared
  state: "running" | "done" | "error";
  error?: string;
};

/** A library paper being added to a benchmark: the container is fetching and reading it. */
export type PendingSource = { bench: string; id: number; title: string; hasPdf: boolean };
/** A paper that could not be added, kept until dismissed so the benchmark can say so. */
export type FailedSource = PendingSource & { message: string };

type Store = {
  me: Me | null;
  files: WorkspaceFile[] | null;
  benches: BenchSummary[];
  notProvisioned: boolean;
  loadError: string | null;
  refresh: () => Promise<void>;
  runs: Record<string, ComparisonRun>;
  setRun: (slug: string, run: ComparisonRun | null) => void;
  /** Papers being added, wherever they were added from: every view shows them. */
  pendingSources: PendingSource[];
  failedSources: FailedSource[];
  dismissFailedSource: (bench: string, id: number) => void;
  /** Add a library paper to a benchmark; the workspace listing reloads when it is in. */
  addSource: (bench: string, paper: { id: number; title: string; hasPdf: boolean }) => Promise<SourceResult>;
  /** The benchmark last opened, so the library offers it first. */
  lastBench: string | null;
  setLastBench: (slug: string) => void;
};

const Ctx = createContext<Store | null>(null);

export function usePlatform(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("usePlatform outside PlatformProvider");
  return s;
}

const CONV_KEY = "benchy-conv:";

/** The researcher's conversation for a benchmark ("new" for a benchmark not yet created). */
export function conversationFor(slug: string): string | null {
  try {
    return localStorage.getItem(CONV_KEY + slug);
  } catch {
    return null;
  }
}

export function rememberConversation(slug: string, id: string | null) {
  try {
    if (id) localStorage.setItem(CONV_KEY + slug, id);
    else localStorage.removeItem(CONV_KEY + slug);
  } catch {
    // Private mode: conversations still work, just not remembered across reloads.
  }
}

async function summarize(b: Bench, cache: Map<string, BenchSummary>): Promise<BenchSummary> {
  const key = `${b.slug}@${b.modified}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const yamlText = await api.text(b.yamlPath).catch(() => "");
  const doc = readBenchYaml(yamlText, b.slug);
  const [validation, items, best] = await Promise.all([
    api.validate(b.yamlPath).catch(() => undefined),
    doc.examPath
      ? api
          .text(doc.examPath)
          .then((t) => t.split("\n").filter((l) => l.trim()).length)
          .catch(() => undefined)
      : Promise.resolve(undefined),
    Promise.all(b.runs.slice(0, 8).map((r) => api.text(r.path).then((t) => JSON.parse(t) as RunResult).catch(() => null))).then(
      (rs) => {
        const scores = rs.filter((r): r is RunResult => !!r).map((r) => r.benchmark_score);
        return scores.length ? Math.max(...scores) : null;
      },
    ),
  ]);
  const s: BenchSummary = { ...b, doc, validation, items, best };
  cache.set(key, s);
  return s;
}

export function PlatformProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
  const [benches, setBenches] = useState<BenchSummary[]>([]);
  const [notProvisioned, setNotProvisioned] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, ComparisonRun>>({});
  const [pendingSources, setPendingSources] = useState<PendingSource[]>([]);
  const [failedSources, setFailedSources] = useState<FailedSource[]>([]);
  const dismissFailedSource = useCallback((bench: string, id: number) => setFailedSources((f) => f.filter((x) => !(x.bench === bench && x.id === id))), []);
  const [lastBench, setLastBench] = useState<string | null>(null);
  const cache = useRef(new Map<string, BenchSummary>());

  const refresh = useCallback(async () => {
    try {
      const { files } = await api.files();
      setFiles(files);
      setNotProvisioned(false);
      setLoadError(null);
      const list = benchesFrom(files);
      setBenches((prev) => list.map((b) => prev.find((p) => p.slug === b.slug && p.modified === b.modified) ?? b));
      const full = await Promise.all(list.map((b) => summarize(b, cache.current)));
      setBenches(full);
    } catch (err) {
      if (err instanceof ApiError && err.code === "AGENT_NOT_PROVISIONED") {
        setNotProvisioned(true);
        setFiles([]);
      } else {
        setLoadError(err instanceof ApiError ? err.code : "UNKNOWN");
        setFiles((f) => f ?? []);
      }
    }
  }, []);

  useEffect(() => {
    void api.me().then(setMe).catch(() => {});
    void refresh();
  }, [refresh]);

  // The workspace changes behind the page (the agent, a colleague, a paper read in
  // the background): look again every 30 s while the tab is visible, and on return.
  useEffect(() => {
    const look = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = setInterval(look, 30_000);
    document.addEventListener("visibilitychange", look);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", look);
    };
  }, [refresh]);

  const addSource = useCallback(
    async (bench: string, paper: { id: number; title: string; hasPdf: boolean }) => {
      const same = (x: PendingSource) => x.bench === bench && x.id === paper.id;
      setPendingSources((p) => [...p.filter((x) => !same(x)), { bench, ...paper }]);
      setFailedSources((f) => f.filter((x) => !same(x)));
      const fail = (message: string) => setFailedSources((f) => [...f.filter((x) => !same(x)), { bench, ...paper, message }]);
      try {
        const r = await sources.add(bench, paper.id);
        if (!r.ok) fail(libraryErrorText(r.error.code));
        return r;
      } catch (err) {
        fail(err instanceof ApiError && !err.code.startsWith("AGENT") && err.code !== "NETWORK" ? libraryErrorText(err.code) : errorText(err));
        throw err;
      } finally {
        setPendingSources((p) => p.filter((x) => !(x.bench === bench && x.id === paper.id)));
        await refresh();
      }
    },
    [refresh],
  );

  const setRun = useCallback((slug: string, run: ComparisonRun | null) => {
    setRuns((r) => {
      const next = { ...r };
      if (run) next[slug] = run;
      else delete next[slug];
      return next;
    });
  }, []);

  // While a comparison runs, watch runs/ for each model's new result file.
  const running = Object.values(runs).some((r) => r.state === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const { files } = await api.files().catch(() => ({ files: null as WorkspaceFile[] | null }));
      if (!files) return;
      setRuns((all) => {
        const next = { ...all };
        for (const run of Object.values(all)) {
          if (run.state !== "running") continue;
          const fresh = files.filter((f) => f.path.startsWith(`${run.slug}/runs/`) && !run.baseline.has(f.path));
          const finished = new Set(run.finished);
          for (const m of run.models) {
            const safe = m.replace(/[^A-Za-z0-9._-]/g, "-");
            if (fresh.some((f) => f.path.includes(`__${safe}__`))) finished.add(m);
          }
          next[run.slug] = { ...run, finished };
        }
        return next;
      });
    }, 5000);
    return () => clearInterval(t);
  }, [running]);

  const value = useMemo(
    () => ({ me, files, benches, notProvisioned, loadError, refresh, runs, setRun, pendingSources, failedSources, dismissFailedSource, addSource, lastBench, setLastBench }),
    [me, files, benches, notProvisioned, loadError, refresh, runs, setRun, pendingSources, failedSources, dismissFailedSource, addSource, lastBench],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
