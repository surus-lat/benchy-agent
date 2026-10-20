import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText, ApiError } from "./data";
import { usePlatform } from "./store";
import { authorsLine, library, libraryErrorText, sources as sourcesApi, TYPE_LABEL, type LibraryHit, type Source } from "./library-data";
import { coverage, coverageNote, pickedFromSources, sourceOfPaper } from "./fuentes-model";
import type { PickedPaper } from "./new-bench-model";
import "./library.css";

// 01 · Fuentes — curaduría como pantalla completa: la colección elegida a la
// izquierda, siempre a la vista, y la biblioteca a la derecha para el circuito
// buscar → evaluar → decidir sin perder el contexto de lo que ya tenés. Cada
// candidata muestra lo que un investigador necesita para juzgarla sin abrirla
// (autores, año, origen, tipo de publicación, una muestra del texto y si hay
// PDF legible); el cabezal de la colección resume con qué se queda el agente
// (textos completos vs solo resúmenes). El drawer de Papers en Autoría sigue
// como la entrada rápida; acá va la curaduría completa.

export function SourcesStage({ bench, list, onChanged }: { bench: string; list: Source[]; onChanged: (change: string) => void }) {
  const { pendingSources, failedSources, dismissFailedSource, addSource } = usePlatform();
  const reading = pendingSources.filter((p) => p.bench === bench);
  const failed = failedSources.filter((p) => p.bench === bench);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // On narrow screens the two panes become tabs; wide screens keep both up.
  const [pane, setPane] = useState<"col" | "lib">(list.length || reading.length ? "col" : "lib");

  const picked = pickedFromSources(list);
  const chosen = useMemo(() => new Set(picked.map((p) => p.id)), [picked]);
  const busy = new Set(reading.map((p) => p.id));
  const cov = coverage(list);

  const remove = async (s: Source) => {
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
          {cov.total > 0 || reading.length > 0 ? (
            <span className="ws-fnt-cov">
              {coverageNote(cov)}
              {reading.length ? `${cov.total > 0 ? " · " : ""}${reading.length} leyéndose` : ""}
            </span>
          ) : null}
          <p className="ws-fnt-note">
            Las preguntas salen de estas fuentes: el agente las lee y en cada una cita el paper y la página. Sin PDF abierto, solo tiene el resumen.
          </p>
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
            return (
              <div key={s.id} className="ws-fnt-src">
                <div className="h">
                  <span className={`lib-tag ${s.origin}`}>{s.origin === "conicet" ? "CONICET" : s.origin === "bicyt" ? "BICyT" : "PDF"}</span>
                  <button className="ws-link ws-del" disabled={removing !== null} onClick={() => void remove(s)}>
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
                <li>Buscá en la biblioteca los papers del tema del benchmark.</li>
                <li>Evaluá cada candidata: quién la publica, de qué año es y si tiene PDF legible.</li>
                <li>Elegila: el agente lee el PDF y cada pregunta cita el paper y la página.</li>
              </ol>
              <span className="d">¿Un PDF propio? Se sube desde Papers, en Autoría.</span>
            </div>
          )}
        </div>
      </aside>

      <LibrarySearch chosen={chosen} busyIds={busy} onToggle={(p) => void toggle(p)} toggleError={error} onDismissError={() => setError(null)} />
    </div>
  );
}

// The CONICET library, as a workbench next to the collection: the search box
// and the count stay put while the candidates scroll; each one carries what
// the decision needs (procedencia, autores, año, tipo, muestra del texto,
// PDF sí/no) and one clear action — elegir, o sacar si ya está.
function LibrarySearch({
  chosen,
  busyIds,
  onToggle,
  toggleError,
  onDismissError,
}: {
  chosen: ReadonlySet<number>;
  busyIds: ReadonlySet<number>;
  onToggle: (p: PickedPaper) => void;
  toggleError: string | null;
  onDismissError: () => void;
}) {
  const [text, setText] = useState("");
  const [pdfOnly, setPdfOnly] = useState(false);
  const [rows, setRows] = useState<LibraryHit[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(
    async (p: number) => {
      const n = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const r = await library.search({ q: text, author: "", pdf: pdfOnly, page: p });
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
    [text, pdfOnly],
  );
  // Typing filters the list after a short pause; an empty box lists the newest.
  useEffect(() => {
    const timer = setTimeout(() => void load(0), text ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, text]);

  const more = total !== null && rows.length < Math.min(total, 1000);
  const count =
    total === null
      ? "Cargando la biblioteca…"
      : text.trim()
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
            onChange={(e) => setText(e.target.value)}
            placeholder="Buscá por tema, autor o título…"
            aria-label="Buscar en la biblioteca"
            spellCheck={false}
          />
          <button className={`ws-fnt-pdf${pdfOnly ? " on" : ""}`} aria-pressed={pdfOnly} onClick={() => setPdfOnly((v) => !v)}>
            Con PDF
          </button>
        </div>
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
              return (
                <li key={`${h.origin}-${h.id}`} className={`ws-fnt-hit${isIn ? " in" : ""}`}>
                  <div className="b">
                    <span className="t">{h.title}</span>
                    <span className="m">
                      <span className={`lib-tag ${h.origin}`}>{h.origin === "bicyt" ? "BICyT" : "CONICET"}</span>
                      <span>{[authorsLine(h.creators, 3), h.year, TYPE_LABEL[h.type] ?? null].filter(Boolean).join(" · ")}</span>
                      {h.hasPdf ? <span className="pf">con PDF</span> : <span className="np">solo resumen</span>}
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
                        title={isIn ? "Sacar de la colección" : "Elegir para el benchmark"}
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
                <span className="ws-skel" aria-hidden="true" />
                <span className="ws-skel" aria-hidden="true" />
                <span className="ws-skel" aria-hidden="true" />
              </>
            )}
          </ul>
          {!loading && rows.length === 0 && total !== null && <p className="ws-fnt-none">Nada coincide. Probá con otras palabras.</p>}
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
