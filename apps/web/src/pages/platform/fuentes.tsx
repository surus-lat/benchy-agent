import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText, ApiError } from "./data";
import { usePlatform, usePokeWhile } from "./store";
import { authorsLine, library, libraryErrorText, libraryId, sources as sourcesApi, TYPE_LABEL, type LibraryHit, type SemanticHit, type Source } from "./library-data";
import { coverage, coverageNote, mergeBuckets, pickedFromSources, searchTerms, sourceOfPaper, suggestedQuery, type MatchedHit, type TermBucket } from "./fuentes-model";
import type { PickedPaper } from "./new-bench-model";
import type { Design } from "./exam-model";
import { useStageCta, type StageCta } from "./stage-next";
import { PUBLISHED_NOTE } from "./use-exam";
import "./library.css";

// 02 · Fuentes — curaduría como pantalla completa: la colección elegida a la
// izquierda, siempre a la vista, y la biblioteca a la derecha para el circuito
// buscar → evaluar → decidir sin perder el contexto de lo que ya tenés. Cada
// candidata muestra lo que un investigador necesita para juzgarla sin abrirla
// (autores, año, origen, tipo de publicación, una muestra del texto y si hay
// PDF legible); el cabezal de la colección resume con qué se queda el agente
// (textos completos vs solo resúmenes). El paso a 03 · Preguntas está en el
// cabezal de la ventana, con su explicación en el tooltip; el drawer de Papers
// en Preguntas sigue como la entrada rápida.

export function SourcesStage({
  bench,
  list,
  design,
  criteriaCount,
  noCriteria,
  questionCount,
  frozen,
  onNext,
  setStageCta,
  onCriteria,
  onChanged,
}: {
  bench: string;
  list: Source[];
  /** What the researcher set out to evaluate (design.json), shown as context. */
  design: Design;
  criteriaCount: number;
  /** Empty rubric on an open exam: the papers have nothing to test, so the
   *  stage ahead of them stays shut until the criteria are written. */
  noCriteria: boolean;
  questionCount: number;
  /** The benchmark is published: its papers are part of what was published. */
  frozen: boolean;
  onNext: () => void;
  /** Publishes this stage's next step into the toolbar. */
  setStageCta: (cta: StageCta | null) => void;
  onCriteria: () => void;
  onChanged: (change: string) => void;
}) {
  const { pendingSources, failedSources, dismissFailedSource, addSource } = usePlatform();
  // The container records the paper in sources.json the moment it is added
  // (status "reading"), so the local card only covers the seconds before that
  // row arrives: once it is on the list, the list itself shows the reading.
  const reading = pendingSources.filter((p) => p.bench === bench && !list.some((s) => libraryId(s) === p.id));
  const failed = failedSources.filter((p) => p.bench === bench);
  // A row the container is still reading: look at the listing often so it
  // flips to ready without waiting for the 30 s background look.
  usePokeWhile(list.some((s) => s.status === "reading"));

  // Where the curaduría leads: writing the questions from what was picked. With
  // no rubric the papers have nothing to test, so the next step is writing it.
  useStageCta(setStageCta,
    noCriteria
      ? {
          label: "Ir a Criterios",
          tip: "01 · Criterios. Sin criterios el juez no tiene con qué medir y estas fuentes no ponen a prueba nada: escribilos o pedile al agente que los baje de tu diseño para seguir.",
          onClick: onCriteria,
        }
      : {
          label: "Ir a Preguntas",
          tip:
            list.length > 0
              ? `03 · Preguntas. Con ${list.length === 1 ? "esta fuente" : `estas ${list.length} fuentes`} el agente puede escribir preguntas que pongan a prueba los criterios de 01 · Criterios; allá las revisás, verificás la clave y aprobás una por una.${questionCount > 0 ? ` El examen ya tiene ${questionCount} ${questionCount === 1 ? "pregunta" : "preguntas"}.` : ""}`
              : "03 · Preguntas. Todavía no elegiste fuentes: el agente no puede escribir preguntas sin material. Podés seguir y volver, o elegir una candidata de la biblioteca ahora.",
          onClick: onNext,
        },
  );
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // On narrow screens the two panes become tabs; wide screens keep both up.
  const [pane, setPane] = useState<"col" | "lib">(list.length || reading.length ? "col" : "lib");

  const picked = pickedFromSources(list);
  const chosen = useMemo(() => new Set(picked.map((p) => p.id)), [picked]);
  const busy = new Set(reading.map((p) => p.id));
  const cov = coverage(list);
  const readingAll = reading.length + list.filter((s) => s.status === "reading").length;

  const remove = async (s: Source) => {
    if (frozen) {
      setError(PUBLISHED_NOTE);
      return;
    }
    setRemoving(s.id);
    setError(null);
    try {
      await sourcesApi.remove(bench, s.id);
      onChanged(`− ${s.title}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRemoving(null);
    }
  };

  // The candidate's button, wired to the benchmark: an elegida comes out of
  // sources.json, a new one goes in through the store (its reading card shows
  // atop the collection while the agent reads the PDF).
  const toggle = async (p: PickedPaper) => {
    if (removing !== null) return;
    if (frozen) {
      setError(PUBLISHED_NOTE);
      return;
    }
    const inBench = sourceOfPaper(list, p);
    if (inBench) {
      await remove(inBench);
      return;
    }
    if (busy.has(p.id)) return;
    setError(null);
    try {
      const r = await addSource(bench, { id: p.id, title: p.title, hasPdf: p.hasPdf ?? true });
      if (r.ok) onChanged(`+ ${r.source.title}`);
      else setError(`«${p.title.slice(0, 60)}»: ${libraryErrorText(r.error.code)}`);
    } catch (err) {
      setError(err instanceof ApiError && !err.code.startsWith("AGENT") && err.code !== "NETWORK" ? libraryErrorText(err.code) : errorText(err));
    }
  };

  return (
    <div className="ws-fuentes-wrap">
      <div className={`ws-fuentes show-${pane}`}>
        <div className="ws-pills ws-fnt-pills">
          <button className={pane === "col" ? "on" : ""} onClick={() => setPane("col")}>
            Elegidas <span className="c">{list.length}</span>
          </button>
          <button className={pane === "lib" ? "on" : ""} onClick={() => setPane("lib")}>
            Biblioteca
          </button>
        </div>

        <aside className="ws-fnt-col" aria-label="Fuentes elegidas">
          <div className="ws-fnt-col-head">
            <div className="top">
              <span className="ws-eyebrow">Elegidas</span>
              <span className="ws-fnt-count">{list.length === 1 ? "1 fuente" : `${list.length} fuentes`}</span>
            </div>
            {cov.total > 0 || readingAll > 0 ? (
              <span className="ws-fnt-cov">
                {coverageNote(cov)}
                {readingAll ? `${cov.total > 0 ? " · " : ""}${readingAll} leyéndose` : ""}
              </span>
            ) : null}
            <div className="ws-fnt-design">
              <span className="ws-eyebrow">Qué vamos a evaluar</span>
              <p>{design.purpose.trim() || "Todavía no lo definiste: 01 · Criterios dice qué querés averiguar."}</p>
              <button className="ws-link" onClick={onCriteria}>
                {criteriaCount > 0 ? `${criteriaCount} ${criteriaCount === 1 ? "criterio" : "criterios"} · abrir 01 · Criterios ↗` : "Abrir 01 · Criterios ↗"}
              </button>
              {noCriteria && (
                <p className="ws-note fail">
                  Sin criterios el juez no tiene con qué medir: las fuentes se pueden elegir igual, pero el paso a 03 ·
                  Preguntas se abre con el primer criterio escrito.
                </p>
              )}
            </div>
            <p className="ws-fnt-note">
              Estás en 02 · Fuentes. Elegí el material con el que el agente escribirá las preguntas: las lee y en cada una cita el paper y la página.
              Sin PDF abierto, solo tiene el resumen.{" "}
              {noCriteria
                ? "Antes de seguir, escribí en 01 · Criterios con qué se mide cada respuesta."
                : "Cuando tengas al menos una, seguí a 03 · Preguntas."}
            </p>
            {frozen && (
              <p className="ws-locked" role="status">
                <span className="mono amber">[·]</span> Este benchmark está publicado: sus fuentes son parte de lo publicado. Revertí la publicación en 06 ·
                Publicación para agregar o quitar papers.
              </p>
            )}
          </div>
          <div className="ws-fnt-col-body">
          {reading.map((p) => (
            <div key={`r-${p.id}`} className="ws-fnt-src reading">
              <span className="t">{p.title}</span>
              <span className="m">{p.hasPdf ? "Leyendo el PDF: puede tardar un minuto" : "Agregando el resumen"}</span>
              <span className="ws-indet" aria-hidden="true">
                <span />
              </span>
            </div>
          ))}
          {failed.map((p) => (
            <div key={`f-${p.id}`} className="ws-fnt-src failed">
              <span className="t">{p.title}</span>
              <span className="m">No se pudo agregar: {p.message}</span>
              <div className="h">
                <button className="ws-link" onClick={() => dismissFailedSource(bench, p.id)}>
                  Cerrar
                </button>
              </div>
            </div>
          ))}
          {list.map((s) => {
            const href = s.pdf_url ?? s.url;
            // A row the container is still reading (or that failed): it is in
            // the collection, but without text yet.
            if (s.status === "reading")
              return (
                <div key={s.id} className="ws-fnt-src reading">
                  <span className="t">{s.title}</span>
                  <span className="m">Leyendo el PDF: puede tardar un minuto</span>
                  <span className="ws-indet" aria-hidden="true">
                    <span />
                  </span>
                </div>
              );
            if (s.status === "failed")
              return (
                <div key={s.id} className="ws-fnt-src failed">
                  <span className="t">{s.title}</span>
                  <span className="m">No se pudo agregar: {libraryErrorText(s.error?.code ?? "")}</span>
                  <div className="h">
                    <button className="ws-link" disabled={removing !== null || frozen} title="Sacalo y volvé a elegirlo para reintentar" onClick={() => void remove(s)}>
                      Sacar para reintentar
                    </button>
                  </div>
                </div>
              );
            return (
              <div key={s.id} className="ws-fnt-src">
                <div className="h">
                  <span className={`lib-tag ${s.origin}`}>{s.origin === "conicet" ? "CONICET" : s.origin === "bicyt" ? "BICyT" : "PDF"}</span>
                  <button className="ws-link ws-del" disabled={removing !== null || frozen} title={frozen ? "El benchmark está publicado: sus fuentes están congeladas" : "Sacar del benchmark"} onClick={() => void remove(s)}>
                    {removing === s.id ? "Sacando…" : "Sacar"}
                  </button>
                </div>
                {href ? (
                  <a className="t" href={href} target="_blank" rel="noreferrer">
                    {s.title}
                  </a>
                ) : (
                  <span className="t">{s.title}</span>
                )}
                <span className="m">
                  {[authorsLine(s.authors, 2), s.year].filter(Boolean).join(" · ")}
                  {s.text === "full" ? (
                    ` · ${s.pages} páginas`
                  ) : (
                    <>
                      {" · "}
                      <span className="warn">solo el resumen</span>
                    </>
                  )}
                </span>
              </div>
            );
          })}
          {list.length === 0 && reading.length === 0 && failed.length === 0 && (
            <div className="ws-fnt-empty">
              <span className="t">Tu colección está vacía</span>
              <ol>
                <li>Mirá 01 · Criterios: ahí está qué querés evaluar y con qué criterios.</li>
                <li>Buscá en la biblioteca los papers del tema del benchmark.</li>
                <li>Evaluá cada candidata: quién la publica, de qué año es y si tiene PDF legible.</li>
                <li>Elegila: el agente lee el PDF y cada pregunta cita el paper y la página.</li>
              </ol>
              <span className="d">¿Un PDF propio? Se sube desde el botón Papers, en 03 · Preguntas.</span>
            </div>
          )}
        </div>
      </aside>

      <LibrarySearch
        bench={bench}
        keywords={design.keywords}
        chosen={chosen}
        busyIds={busy}
        frozen={frozen}
        onToggle={(p) => void toggle(p)}
        toggleError={error}
        onDismissError={() => setError(null)}
      />
      </div>
    </div>
  );
}

// The CONICET library, as a workbench next to the collection: the search box
// and the count stay put while the candidates scroll; each one carries what
// the decision needs (procedencia, autores, año, tipo, muestra del texto,
// PDF sí/no) and one clear action — elegir, o sacar si ya está.
//
// The box holds more than one search: terms separated by comma are looked up one
// by one and their results put together, because a single query reads its words
// as AND and asks for papers about everything at once. And the box does not
// start empty when the design has keywords: 01 · Criterios wrote them for
// exactly this moment, so they arrive applied, ready to be edited away.
function LibrarySearch({
  bench,
  keywords,
  chosen,
  busyIds,
  frozen,
  onToggle,
  toggleError,
  onDismissError,
}: {
  /** Which benchmark is being curated: the dismissed suggestion is per benchmark. */
  bench: string;
  /** The design's searches (design.json), applied as a suggestion. */
  keywords: string[];
  chosen: ReadonlySet<number>;
  busyIds: ReadonlySet<number>;
  /** The benchmark is published: its papers are part of what was published. */
  frozen: boolean;
  onToggle: (p: PickedPaper) => void;
  toggleError: string | null;
  onDismissError: () => void;
}) {
  // The keyword set the researcher already edited away, so it does not come back
  // on the next visit. New keywords are a new suggestion.
  const suggested = keywords.join(", ");
  const [text, setText] = useState(() => suggestedQuery(keywords, readDismissed(bench)));
  const [pdfOnly, setPdfOnly] = useState(false);
  const [semantic, setSemantic] = useState(false);
  // One page per term searched; the list merges them.
  const [buckets, setBuckets] = useState<TermBucket[]>([]);
  const [semanticRows, setSemanticRows] = useState<SemanticHit[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  // The rows on the screen come from these searches, so the labels follow the
  // buckets and not the box: half-typed text never describes papers it did not
  // ask for. An empty box is still one search (the library's newest papers).
  const searched = semantic ? [] : buckets.map((b) => b.term);
  const multi = searched.length > 1;
  const merged = useMemo(() => mergeBuckets(buckets), [buckets]);
  const isSuggestion = !!suggested && text === suggested;

  /** Type in the box. Touching the suggestion takes it over for good. */
  const onQuery = (next: string) => {
    if (isSuggestion && suggested !== readDismissed(bench)) writeDismissed(bench, suggested);
    setText(next);
  };

  const load = useCallback(
    async (p: number) => {
      const n = ++seq.current;
      const words = searchTerms(text);
      const wanted = words.length ? words : [""];
      setLoading(true);
      setError(null);
      try {
        if (semantic && text.trim()) {
          // Semantic search: embed + cosine over the full library. One query.
          const r = await library.semantic(text, pdfOnly);
          if (n !== seq.current) return;
          setBuckets([]);
          setSemanticRows(r.papers);
          setTotal(r.papers.length);
          setFailed([]);
          setPage(0);
          return;
        }
        setSemanticRows([]);
        // Every term in its own request: one query would ask for all the words
        // at once and usually return nothing.
        const found = await Promise.all(
          wanted.map(async (term) => {
            try {
              const r = await library.search({ q: term, author: "", pdf: pdfOnly, page: p });
              return { term, total: r.total, papers: r.papers, error: null as string | null };
            } catch (err) {
              return {
                term,
                total: 0,
                papers: [] as LibraryHit[],
                // Not libraryErrorText: those codes are about adding a paper, and
                // here the researcher was only looking for one.
                error: errorText(err),
              };
            }
          }),
        );
        if (n !== seq.current) return;
        setBuckets((cur) =>
          p === 0
            ? found.map((f) => ({ term: f.term, total: f.total, papers: f.papers }))
            : cur.map((b) => {
                const fresh = found.find((f) => f.term === b.term);
                return { term: b.term, total: fresh?.total ?? b.total, papers: [...b.papers, ...(fresh?.papers ?? [])] };
              }),
        );
        setTotal(found.reduce((sum, f) => sum + f.total, 0));
        setFailed(found.filter((f) => f.error).map((f) => f.term));
        if (found.length && found.every((f) => f.error)) setError(found[0]?.error ?? null);
        setPage(p);
      } catch (err) {
        if (n === seq.current) setError(errorText(err));
      } finally {
        if (n === seq.current) setLoading(false);
      }
    },
    [text, pdfOnly, semantic],
  );
  // Typing filters the list after a short pause; an empty box lists the newest.
  // Semantic search waits longer (it embeds on the agent).
  useEffect(() => {
    const timer = setTimeout(() => void load(0), semantic ? 600 : text ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, text, semantic]);

  const rows: (MatchedHit | SemanticHit)[] = semantic && text.trim() ? semanticRows : merged.papers;
  const more = !(semantic && text.trim()) && merged.more;
  const count =
    total === null
      ? "Cargando la biblioteca…"
      : semantic && text.trim()
        ? `${total} ${total === 1 ? "paper por similitud" : "papers por similitud"}`
        : multi
          ? `${total.toLocaleString("es-AR")} papers entre los ${searched.length} términos`
          : searched[0]
            ? `${total.toLocaleString("es-AR")} ${total === 1 ? "paper coincide" : "papers coinciden"}`
            : `${total.toLocaleString("es-AR")} papers · los más recientes primero`;
  const banner = toggleError ?? error;

  return (
    <section className="ws-fnt-lib" aria-label="Buscar en la biblioteca">
      <div className="ws-fnt-lib-bar">
        <div className="top">
          <span className="ws-eyebrow">Biblioteca</span>
          <span className="count">
            {count}
            {loading && total !== null ? " · buscando…" : ""}
          </span>
        </div>
        <div className="ws-fnt-lib-row">
          <input
            type="search"
            className="ws-fnt-search"
            value={text}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={semantic ? "Describí lo que buscás…" : "Buscá por tema, autor o título… (varias búsquedas, separadas por coma)"}
            title="Separá varias búsquedas con coma: buscamos por cada una y sumamos los resultados"
            aria-label="Buscar en la biblioteca"
            spellCheck={false}
          />
          <button className={`ws-fnt-pdf${pdfOnly ? " on" : ""}`} aria-pressed={pdfOnly} onClick={() => setPdfOnly((v) => !v)}>
            Con PDF
          </button>
          <button className={`ws-fnt-pdf${semantic ? " on" : ""}`} aria-pressed={semantic} onClick={() => setSemantic((v) => !v)}>
            Semántica
          </button>
        </div>
        {isSuggestion && (
          <div className="ws-fnt-sug" role="note">
            <span className="ws-eyebrow">Sugerido desde 01 · Criterios</span>
            <span className="d">
              Tu diseño trajo {keywords.length} {keywords.length === 1 ? "palabra clave" : "palabras clave"}: buscamos cada una por separado y sumamos los
              resultados. Editá la caja para cambiar la búsqueda.
            </span>
            <button className="ws-link" onClick={() => onQuery("")}>
              Quitar sugerencia
            </button>
          </div>
        )}
        {multi && (
          <div className="ws-fnt-terms">
            {buckets.map((b) => (
              <span key={b.term} className="ws-fnt-term mono" title={`Papers que coinciden con «${b.term}»`}>
                {b.term} <strong>{b.total.toLocaleString("es-AR")}</strong>
              </span>
            ))}
          </div>
        )}
        {failed.length > 0 && !banner && (
          <p className="ws-fnt-soft">
            No pudimos buscar {failed.map((t) => `«${t}»`).join(", ")}; el resto de los resultados está igual.
            <button onClick={() => setFailed([])} aria-label="Cerrar">
              ✕
            </button>
          </p>
        )}
        {banner && (
          <p className="ws-fnt-err" role="alert">
            {banner}
            <button onClick={toggleError ? onDismissError : () => setError(null)} aria-label="Cerrar">
              ✕
            </button>
          </p>
        )}
      </div>
      <div className="ws-fnt-lib-body">
        <div className="ws-fnt-lib-in">
          <ul className="ws-fnt-hits">
            {rows.map((h) => {
              const isIn = chosen.has(h.id);
              const isBusy = busyIds.has(h.id);
              const paper: PickedPaper = { id: h.id, title: h.title, creators: h.creators, year: h.year, hasPdf: h.hasPdf };
              // With several searches in the box, each paper says which one brought it.
              const via = "via" in h ? h.via : [];
              return (
                <li key={`${h.origin}-${h.id}`} className={`ws-fnt-hit${isIn ? " in" : ""}`}>
                  <div className="b">
                    <span className="t">{h.title}</span>
                    <span className="m">
                      <span className={`lib-tag ${h.origin}`}>{h.origin === "bicyt" ? "BICyT" : "CONICET"}</span>
                      <span>{[authorsLine(h.creators, 3), h.year, TYPE_LABEL[h.type] ?? null].filter(Boolean).join(" · ")}</span>
                      {h.hasPdf ? <span className="pf">con PDF</span> : <span className="np">solo resumen</span>}
                    {"score" in h ? <span className="pf">{(h as SemanticHit).score.toFixed(3)}</span> : null}
                      {multi && via.length > 0 ? (
                        <span className="via" title={`Coincide con: ${via.join(" · ")}`}>
                          por «{via[0]}»{via.length > 1 ? ` +${via.length - 1} más` : ""}
                        </span>
                      ) : null}
                    </span>
                    {h.excerpt ? <span className="x">{h.excerpt}</span> : null}
                  </div>
                  <div className="side">
                    {isBusy ? (
                      <span className="ws-fnt-reading">{h.hasPdf ? "leyendo el PDF…" : "agregando…"}</span>
                    ) : (
                      <button
                        className="ws-fnt-pick"
                        aria-pressed={isIn}
                        disabled={frozen}
                        title={frozen ? "El benchmark está publicado: sus fuentes están congeladas" : isIn ? "Sacar de la colección" : "Elegir para el benchmark"}
                        onClick={() => onToggle(paper)}
                      >
                        {isIn ? "✓ Elegida" : "+ Elegir"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
            {total === null && (
              <>
                <li className="ws-skel" aria-hidden="true" />
                <li className="ws-skel" aria-hidden="true" />
                <li className="ws-skel" aria-hidden="true" />
              </>
            )}
          </ul>
          {!loading && rows.length === 0 && total !== null && (
            <p className="ws-fnt-none">
              {multi && merged.total === 0
                ? "Ninguna de estas búsquedas tiene papers en la biblioteca: los conteos de arriba dicen cuál podés sacar, o probá con términos más generales."
                : "Nada coincide. Probá con otras palabras."}
            </p>
          )}
          {more && (
            <button className="ws-fnt-more" disabled={loading} onClick={() => void load(page + 1)}>
              {loading ? "Cargando…" : "Ver más"}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/** The keyword set the researcher already edited away, per benchmark: the
 *  suggestion is applied once per set, so it never nags them twice. */
const SUGGESTED_KEY = "benchy-src-suggested:";

const readDismissed = (bench: string): string | null => {
  try {
    return localStorage.getItem(SUGGESTED_KEY + bench);
  } catch {
    return null;
  }
};

const writeDismissed = (bench: string, joined: string) => {
  try {
    localStorage.setItem(SUGGESTED_KEY + bench, joined);
  } catch {
    // Private mode: the suggestion simply comes back next time.
  }
};

