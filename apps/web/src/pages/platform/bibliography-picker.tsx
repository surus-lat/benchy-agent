import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, errorText } from "./data";
import { authorsLine, library, libraryErrorText, type LibraryHit } from "./library-data";
import type { PickedPaper } from "./new-bench-model";
import "./library.css";

// The CONICET library picker, shared by the wizard's paso 0 and the
// benchmark's Fuentes screen: one search (debounce + pagination + toggle),
// two contexts. The parent owns the picked list; each context decides what a
// toggle means (a local list before the benchmark exists, sources.add /
// sources.remove once it does).

export function BibliographyPicker({
  picked,
  onToggle,
  busyIds,
}: {
  picked: PickedPaper[];
  onToggle: (p: PickedPaper) => void;
  /** Papers being added to the benchmark right now: their rows wait instead of toggling. */
  busyIds?: ReadonlySet<number>;
}) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<LibraryHit[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const chosen = useMemo(() => new Set(picked.map((p) => p.id)), [picked]);

  const load = useCallback(
    async (p: number) => {
      const n = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const r = await library.search({ q: text, author: "", pdf: false, page: p });
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
    [text],
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

  return (
    <div className="lib lb">
      <input
        type="search"
        className="lb-search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Buscá por tema, autor o título…"
        aria-label="Buscar en la biblioteca"
        spellCheck={false}
      />
      <p className="lb-count">
        {count}
        {loading && total !== null ? " · buscando…" : ""}
      </p>
      {error && <p className="lib-error">{error}</p>}
      <ul className="lb-list">
        {rows.map((h) => {
          const isIn = chosen.has(h.id);
          const busy = busyIds?.has(h.id) ?? false;
          const paper: PickedPaper = { id: h.id, title: h.title, creators: h.creators, year: h.year, hasPdf: h.hasPdf };
          return (
            <li key={`${h.origin}-${h.id}`} className={`lb-row${isIn ? " in" : ""}`}>
              <button className="lb-main" aria-pressed={isIn} onClick={() => onToggle(paper)}>
                <span className="t">{h.title}</span>
                <span className="m">
                  {[authorsLine(h.creators, 2), h.year, h.origin === "bicyt" ? "BICyT" : null].filter(Boolean).join(" · ")}
                  {!h.hasPdf && <span className="np"> · solo resumen</span>}
                </span>
              </button>
              {busy ? (
                <span className="lb-reading">{h.hasPdf ? "leyendo el PDF…" : "agregando…"}</span>
              ) : (
                <button className="lb-add" aria-pressed={isIn} onClick={() => onToggle(paper)}>
                  {isIn ? "✓ elegido" : "+ elegir"}
                </button>
              )}
            </li>
          );
        })}
        {!loading && rows.length === 0 && total !== null && <li className="lb-empty">Nada coincide. Probá con otras palabras.</li>}
      </ul>
      {more && (
        <button className="lb-more" disabled={loading} onClick={() => void load(page + 1)}>
          {loading ? "Cargando…" : "Ver más"}
        </button>
      )}
    </div>
  );
}
