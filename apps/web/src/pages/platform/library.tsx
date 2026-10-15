import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useLocation } from "wouter";
import { ApiError, errorText } from "./data";
import { usePlatform } from "./store";
import {
  authorsLine,
  library,
  libraryErrorText,
  LANGUAGE_LABEL,
  TYPE_LABEL,
  type LibraryHit,
  type LibraryStats,
  type Paper,
  type SearchResult,
  type Source,
} from "./library-data";
import "./library.css";

// The paper library: CONICET Digital's publications, searched by topic or
// author. On its own page (/app/biblioteca) each paper opens beside the list
// and can be added to any of the org's benchmarks; inside a benchmark (the
// papers drawer) results are added to that benchmark directly.

type Query = { q: string; author: string; pdf: boolean };

const EXAMPLES = ["glaciares patagonia", "ecofeminismo", "cambio climático", "arqueología de mesetas"];

function useLibrarySearch() {
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const run = useCallback(async (query: Query, page = 0) => {
    if (!query.q.trim() && !query.author.trim()) {
      setResult(null);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await library.search({ ...query, page });
      if (mine === seq.current) setResult(r);
    } catch (err) {
      if (mine === seq.current) setError(err instanceof ApiError && err.code === "EMPTY_QUERY" ? "Escribí al menos una palabra." : errorText(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);
  return { result, loading, error, run };
}

function fmt(n: number): string {
  return n.toLocaleString("es-AR");
}

function SearchForm({
  query,
  setQuery,
  onSubmit,
  myName,
  compact,
}: {
  query: Query;
  setQuery: (q: Query) => void;
  onSubmit: (q: Query) => void;
  myName?: string;
  compact?: boolean;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(query);
  };
  return (
    <form className={`lib-form${compact ? " compact" : ""}`} onSubmit={submit} role="search">
      <input
        type="search"
        className="lib-q"
        value={query.q}
        onChange={(e) => setQuery({ ...query, q: e.target.value })}
        placeholder="Tema, título o palabra clave"
        aria-label="Buscar papers por tema, título o palabra clave"
        spellCheck={false}
        autoFocus={!compact}
      />
      <input
        type="search"
        className="lib-author"
        value={query.author}
        onChange={(e) => setQuery({ ...query, author: e.target.value })}
        placeholder="Autor o autora"
        aria-label="Autor o autora"
        spellCheck={false}
      />
      <button type="submit" className="lib-go">
        Buscar
      </button>
      <div className="lib-form-row">
        <label className="lib-check">
          <input type="checkbox" checked={query.pdf} onChange={(e) => onSubmit({ ...query, pdf: e.target.checked })} />
          Solo con PDF abierto
        </label>
        {myName && (
          <button type="button" className="lib-link" onClick={() => onSubmit({ q: "", author: myName, pdf: query.pdf })}>
            Mis papers
          </button>
        )}
      </div>
    </form>
  );
}

function HitMeta({ year, type, language, hasPdf }: { year: number | null; type: string; language: string; hasPdf: boolean }) {
  return (
    <span className="lib-meta">
      {year && <span>{year}</span>}
      <span>{TYPE_LABEL[type] ?? "Publicación"}</span>
      {LANGUAGE_LABEL[language] && <span>{LANGUAGE_LABEL[language]}</span>}
      <span className={`lib-pdf${hasPdf ? "" : " no"}`}>{hasPdf ? "PDF" : "sin PDF"}</span>
    </span>
  );
}

function ResultsHead({ result, query, loading }: { result: SearchResult; query: Query; loading: boolean }) {
  const what = [query.q.trim() && `“${query.q.trim()}”`, query.author.trim() && `autor: ${query.author.trim()}`].filter(Boolean).join(" · ");
  const n = result.total === 0 ? "Sin resultados" : `${result.more ? "Más de " : ""}${fmt(result.total)} ${result.total === 1 ? "resultado" : "resultados"}`;
  return (
    <p className="lib-count" aria-live="polite">
      {loading ? "Buscando…" : `${n} para ${what}${query.pdf ? " · con PDF" : ""}`}
    </p>
  );
}

function Pager({ result, onPage }: { result: SearchResult; onPage: (p: number) => void }) {
  const last = Math.ceil(Math.min(result.total, 4000) / result.pageSize) - 1;
  if (last <= 0) return null;
  return (
    <div className="lib-pager">
      <button className="lib-btn-line" disabled={result.page === 0} onClick={() => onPage(result.page - 1)}>
        ← Anteriores
      </button>
      <span className="mono">
        {result.page + 1} / {last + 1}
      </span>
      <button className="lib-btn-line" disabled={result.page >= last} onClick={() => onPage(result.page + 1)}>
        Siguientes →
      </button>
    </div>
  );
}

// ---- The library page ----------------------------------------------------------

function readUrl(): Query & { p: number | null } {
  const s = new URLSearchParams(window.location.search);
  const p = Number(s.get("p"));
  return { q: s.get("q") ?? "", author: s.get("autor") ?? "", pdf: s.get("pdf") === "1", p: Number.isSafeInteger(p) && p > 0 ? p : null };
}

function writeUrl(query: Query, p: number | null) {
  const s = new URLSearchParams();
  if (query.q.trim()) s.set("q", query.q.trim());
  if (query.author.trim()) s.set("autor", query.author.trim());
  if (query.pdf) s.set("pdf", "1");
  if (p) s.set("p", String(p));
  const qs = s.toString();
  window.history.replaceState(window.history.state, "", `/app/biblioteca${qs ? `?${qs}` : ""}`);
}

export default function LibraryPage() {
  const { me } = usePlatform();
  const initial = useRef(readUrl());
  const [query, setQuery] = useState<Query>(initial.current);
  const [selected, setSelected] = useState<number | null>(initial.current.p);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const search = useLibrarySearch();

  useEffect(() => {
    void library.stats().then(setStats).catch(() => {});
    if (initial.current.q || initial.current.author) void search.run(initial.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (q: Query) => {
    setQuery(q);
    setSelected(null);
    writeUrl(q, null);
    void search.run(q);
  };
  const open = (id: number | null) => {
    setSelected(id);
    writeUrl(query, id);
  };

  const result = search.result;
  return (
    <section className="lib lib-page">
      <div className="lib-head">
        <h1 className="bp-h1">Biblioteca</h1>
        <p className="lib-sub">
          {stats
            ? `${fmt(stats.papers)} publicaciones de CONICET Digital y BICyT · ${fmt(stats.withPdf)} con PDF de acceso abierto`
            : "Las publicaciones de CONICET Digital y BICyT"}
        </p>
      </div>
      <SearchForm query={query} setQuery={setQuery} onSubmit={submit} myName={me?.user.name || undefined} />
      {search.error && <p className="lib-error">{search.error}</p>}

      {!result && !search.loading ? (
        <div className="lib-intro">
          <p>
            Buscá tus papers o los de tu campo. Los que agregues a un benchmark los lee el agente: escribe las preguntas y las respuestas expertas a
            partir de ellos, y cada pregunta queda citada con su paper y su página.
          </p>
          <div className="lib-examples">
            {EXAMPLES.map((e) => (
              <button key={e} className="lib-chip" onClick={() => submit({ q: e, author: "", pdf: query.pdf })}>
                {e}
              </button>
            ))}
          </div>
          {stats?.snapshot && <p className="lib-fine">Fuente: dataset UNRN/ri-conicet (SURUS + CITA-UNRN), actualizado al {stats.snapshot}.</p>}
        </div>
      ) : (
        <div className={`lib-split${selected ? " has-detail" : ""}`}>
          <div className="lib-results">
            {result && <ResultsHead result={result} query={query} loading={search.loading} />}
            <ol className="lib-list">
              {result?.papers.map((h) => (
                <li key={h.id}>
                  <button className={`lib-hit${selected === h.id ? " on" : ""}`} aria-current={selected === h.id} onClick={() => open(h.id)}>
                    <span className="t">{h.title}</span>
                    <span className="a">{authorsLine(h.creators)}</span>
                    <HitMeta year={h.year} type={h.type} language={h.language} hasPdf={h.hasPdf} />
                  </button>
                </li>
              ))}
            </ol>
            {result && <Pager result={result} onPage={(p) => void search.run(query, p)} />}
          </div>
          {selected && <PaperDetail id={selected} onClose={() => open(null)} />}
        </div>
      )}
    </section>
  );
}

function PaperDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const { benches, addSource, pendingSources, lastBench } = usePlatform();
  const [, navigate] = useLocation();
  const [paper, setPaper] = useState<Paper | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bench, setBench] = useState("");
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<{ bench: string; source: Source } | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPaper(null);
    setError(null);
    setAdded(null);
    setAddError(null);
    void library
      .paper(id)
      .then((p) => !cancelled && setPaper(p))
      .catch((err) => !cancelled && setError(err instanceof ApiError && err.status === 404 ? "Ese paper ya no está en la biblioteca." : errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [id]);

  // The benchmark the researcher came from, else the latest one.
  useEffect(() => {
    if (!bench && benches.length) setBench(benches.some((b) => b.slug === lastBench) ? lastBench! : benches[0].slug);
  }, [benches, bench, lastBench]);
  // Still being read (from here or elsewhere), even after leaving and coming back.
  const reading = adding || pendingSources.some((p) => p.id === id && p.bench === bench);

  const add = async () => {
    if (!paper || !bench) return;
    setAdding(true);
    setAddError(null);
    try {
      const r = await addSource(bench, { id: paper.id, title: paper.title, hasPdf: !!paper.pdfUrl });
      if (r.ok) setAdded({ bench, source: r.source });
      else setAddError(libraryErrorText(r.error.code));
    } catch (err) {
      setAddError(err instanceof ApiError ? (err.code.startsWith("AGENT") || err.code === "NETWORK" ? errorText(err) : libraryErrorText(err.code)) : errorText(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <article className="lib-detail" aria-label="Paper">
      <button className="lib-back" onClick={onClose}>
        ← Resultados
      </button>
      {error && <p className="lib-error">{error}</p>}
      {!paper && !error && <p className="lib-fine">Cargando…</p>}
      {paper && (
        <>
          <HitMeta year={paper.year} type={paper.type} language={paper.language} hasPdf={!!paper.pdfUrl} />
          <h2>{paper.title}</h2>
          <p className="lib-authors">{authorsLine(paper.creators, 12)}</p>
          {paper.publisher && <p className="lib-fine">{paper.publisher}</p>}
          <div className="lib-links">
            {paper.pdfUrl && (
              <a className="lib-btn-dark" href={paper.pdfUrl} target="_blank" rel="noreferrer">
                Abrir PDF ↗
              </a>
            )}
            <a className="lib-btn-line" href={paper.url} target="_blank" rel="noreferrer">
              {paper.origin === "bicyt" ? "Ver en BICyT ↗" : "Ver en CONICET Digital ↗"}
            </a>
          </div>

          <div className="lib-add">
            <p className="lib-eyebrow">Usarlo en un benchmark</p>
            {benches.length === 0 ? (
              <p className="lib-fine">Todavía no hay benchmarks en tu organización: empezá uno con este paper.</p>
            ) : added ? (
              <p className="lib-ok">
                Agregado a {benches.find((b) => b.slug === added.bench)?.doc?.title ?? added.bench}
                {added.source.text === "full" ? ` · ${added.source.pages} páginas de texto` : " · solo el resumen (sin PDF abierto)"}.{" "}
                <button className="lib-link" onClick={() => navigate(`/app/b/${encodeURIComponent(added.bench)}/autoria`)}>
                  Abrir el benchmark →
                </button>
              </p>
            ) : (
              <div className="lib-add-row">
                <select value={bench} onChange={(e) => setBench(e.target.value)} aria-label="Benchmark">
                  {benches.map((b) => (
                    <option key={b.slug} value={b.slug}>
                      {b.doc?.title ?? b.slug}
                    </option>
                  ))}
                </select>
                <button className="lib-btn-dark" onClick={() => void add()} disabled={reading || !bench}>
                  {reading ? (paper.pdfUrl ? "Leyendo el PDF…" : "Agregando…") : "Agregar"}
                </button>
              </div>
            )}
            {!added && (
              <button className={benches.length === 0 ? "lib-btn-dark lib-new" : "lib-link lib-new"} onClick={() => navigate(`/app/nuevo?paper=${paper.id}`)}>
                Nuevo benchmark con este paper
              </button>
            )}
            {reading && <p className="lib-fine">Podés seguir navegando: el benchmark lo muestra apenas termina de leerse.</p>}
            {!added && !paper.pdfUrl && <p className="lib-fine">Sin PDF abierto: el agente va a tener solo el resumen. Si tenés el PDF, subilo desde el benchmark.</p>}
            {addError && <p className="lib-error">{addError}</p>}
          </div>

          <p className="lib-eyebrow">Resumen</p>
          <p className="lib-abstract">{paper.description || "Sin resumen registrado."}</p>
          {paper.subjects.length > 0 && (
            <>
              <p className="lib-eyebrow">Palabras clave</p>
              <div className="lib-subjects">
                {[...new Set(paper.subjects)].map((s) => (
                  <span key={s} className="lib-chip static">
                    {s}
                  </span>
                ))}
              </div>
            </>
          )}
          <p className="lib-fine">
            {paper.date && `Publicado: ${paper.date} · `}
            {paper.creators.length > 12 && `${paper.creators.length} autores · `}
            id {paper.id}
          </p>
        </>
      )}
    </article>
  );
}

// ---- Inside a benchmark: the library as a list, filtered as you type -------------

type Row = { id: number; origin: string; title: string; creators: string[]; year: number | null; hasPdf: boolean; excerpt: string };

/** The library number of a benchmark source that came from it (conicet-123, bicyt-123); null for an upload. */
export function libraryId(s: Source): number | null {
  const m = /^(?:conicet|bicyt)-(\d+)$/.exec(s.id);
  return m ? Number(m[1]) : null;
}

export function LibraryBrowser({
  bench,
  inBench,
  onAdded,
  disabled,
}: {
  bench: string;
  /** The benchmark's papers (sources.json). */
  inBench: Source[];
  onAdded: (s: Source) => void;
  disabled: boolean;
}) {
  const { me, addSource, pendingSources } = usePlatform();
  const myName = me?.user.name?.trim() || "";
  const [text, setText] = useState("");
  const [mine, setMine] = useState(false);
  const [view, setView] = useState<"all" | "in" | "out">("all");
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  // Several can be read at once; each row says its own state.
  const reading = new Set(pendingSources.filter((p) => p.bench === bench).map((p) => p.id));

  const added = new Set(inBench.map(libraryId).filter((x): x is number => x !== null));
  const fromLibrary: Row[] = inBench
    .filter((s) => libraryId(s) !== null)
    .map((s) => ({ id: libraryId(s)!, origin: s.origin, title: s.title, creators: s.authors, year: s.year, hasPdf: s.text === "full", excerpt: "" }));

  const load = useCallback(
    async (p: number) => {
      const n = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const r = await library.search({ q: text, author: mine ? myName : "", pdf: false, page: p });
        if (n !== seq.current) return;
        setRows((cur) => (p === 0 ? r.papers : [...cur, ...r.papers]));
        setTotal(r.total);
        setPage(p);
      } catch (err) {
        if (n === seq.current) setError(err instanceof ApiError && err.code !== "NETWORK" ? libraryErrorText(err.code) : errorText(err));
      } finally {
        if (n === seq.current) setLoading(false);
      }
    },
    [text, mine, myName],
  );
  // Typing filters the list after a short pause; an empty box lists the newest.
  useEffect(() => {
    const timer = setTimeout(() => void load(0), text ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, text]);

  const add = async (h: Row) => {
    setError(null);
    try {
      const r = await addSource(bench, { id: h.id, title: h.title, hasPdf: h.hasPdf });
      if (r.ok) onAdded(r.source);
      else setError(`«${h.title.slice(0, 60)}»: ${libraryErrorText(r.error.code)}`);
    } catch (err) {
      setError(err instanceof ApiError && !err.code.startsWith("AGENT") && err.code !== "NETWORK" ? libraryErrorText(err.code) : errorText(err));
    }
  };

  const term = text.trim().toLowerCase();
  const shown =
    view === "in"
      ? fromLibrary.filter((r) => !term || `${r.title} ${r.creators.join(" ")}`.toLowerCase().includes(term))
      : view === "out"
        ? rows.filter((r) => !added.has(r.id))
        : rows;
  const more = view !== "in" && total !== null && rows.length < Math.min(total, 1000);
  const count =
    view === "in"
      ? `${shown.length} de ${fromLibrary.length} en este benchmark`
      : total === null
        ? "Cargando la biblioteca…"
        : text.trim() || mine
          ? `${total.toLocaleString("es-AR")} ${total === 1 ? "paper coincide" : "papers coinciden"}`
          : `${total.toLocaleString("es-AR")} papers · los más recientes primero`;

  return (
    <div className="lib lb">
      <input
        type="search"
        className="lb-search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Filtrá por tema, autor o título…"
        aria-label="Filtrar la biblioteca"
        spellCheck={false}
      />
      <div className="lb-bar">
        <div role="group" aria-label="Qué papers" className="lb-seg">
          {(
            [
              ["all", "Todos"],
              ["in", `En el benchmark · ${fromLibrary.length}`],
              ["out", "Sin agregar"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={view === k ? "on" : ""} aria-pressed={view === k} onClick={() => setView(k)}>
              {label}
            </button>
          ))}
        </div>
        {myName && view !== "in" && (
          <button className={`lb-chip${mine ? " on" : ""}`} aria-pressed={mine} onClick={() => setMine((m) => !m)} title={`Papers de ${myName}`}>
            Mis papers
          </button>
        )}
      </div>
      <p className="lb-count">
        {count}
        {loading && view !== "in" && total !== null ? " · buscando…" : ""}
      </p>
      {error && <p className="lib-error">{error}</p>}
      <ul className="lb-list">
        {shown.map((h) => {
          const isIn = added.has(h.id);
          return (
            <li key={`${h.origin}-${h.id}`} className={`lb-row${isIn ? " in" : ""}`}>
              <button className="lb-main" aria-expanded={open === h.id} onClick={() => setOpen(open === h.id ? null : h.id)}>
                <span className="t">{h.title}</span>
                <span className="m">
                  {[authorsLine(h.creators, 2), h.year, h.origin === "bicyt" ? "BICyT" : null].filter(Boolean).join(" · ")}
                  {!h.hasPdf && <span className="np"> · solo resumen</span>}
                </span>
                {open === h.id && h.excerpt && <span className="x">{h.excerpt}{h.excerpt.length >= 320 ? "…" : ""}</span>}
              </button>
              {isIn ? (
                <span className="lb-in">en el benchmark</span>
              ) : reading.has(h.id) ? (
                <span className="lb-reading">{h.hasPdf ? "leyendo el PDF…" : "agregando…"}</span>
              ) : (
                <button className="lb-add" disabled={disabled} onClick={() => void add(h)}>
                  + agregar
                </button>
              )}
            </li>
          );
        })}
        {!loading && shown.length === 0 && (
          <li className="lb-empty">{view === "in" ? "Ningún paper de la biblioteca en este benchmark todavía." : "Nada coincide. Probá con otras palabras."}</li>
        )}
      </ul>
      {more && (
        <button className="lb-more" disabled={loading} onClick={() => void load(page + 1)}>
          {loading ? "Cargando…" : "Ver más"}
        </button>
      )}
    </div>
  );
}

export function SourceRow({ s, action }: { s: Source; action?: ReactNode }) {
  const href = s.pdf_url ?? s.url;
  return (
    <div className="lib-source">
      <span className={`lib-tag ${s.origin}`}>{s.origin === "conicet" ? "CONICET" : s.origin === "bicyt" ? "BICyT" : "PDF"}</span>
      <span className="b">
        {href ? (
          <a className="t" href={href} target="_blank" rel="noreferrer">
            {s.title}
          </a>
        ) : (
          <span className="t">{s.title}</span>
        )}
        <span className="m">
          {[authorsLine(s.authors, 2), s.year].filter(Boolean).join(" · ")} ·{" "}
          {s.text === "full" ? `${s.pages} páginas` : <span className="warn">solo el resumen</span>}
        </span>
      </span>
      {action}
    </div>
  );
}
