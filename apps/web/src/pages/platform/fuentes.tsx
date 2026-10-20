import { useState } from "react";
import { errorText, ApiError } from "./data";
import { usePlatform } from "./store";
import { SourceRow } from "./library";
import { libraryErrorText, sources as sourcesApi, type Source } from "./library-data";
import { BibliographyPicker } from "./bibliography-picker";
import { pickedFromSources, sourceOfPaper } from "./fuentes-model";
import type { PickedPaper } from "./new-bench-model";

// 01 · Fuentes — the benchmark's bibliography as a whole screen, not a drawer:
// the sources the questions are written from, with room to search the CONICET
// library and curate the list. The same picker as the wizard's paso 0; here a
// toggle adds the source to the benchmark (or takes it out), there it only
// marks the paper for when the benchmark exists. The Papers drawer in Autoría
// stays as the quick way in; this is the curaduría completa.

export function SourcesStage({ bench, list, onChanged }: { bench: string; list: Source[]; onChanged: (change: string) => void }) {
  const { pendingSources, failedSources, dismissFailedSource, addSource } = usePlatform();
  const reading = pendingSources.filter((p) => p.bench === bench);
  const failed = failedSources.filter((p) => p.bench === bench);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const picked = pickedFromSources(list);
  const busy = new Set(reading.map((p) => p.id));

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

  // The picker's toggle, wired to the benchmark: an elegido comes out of
  // sources.json, a new one goes in through the store (its pending row shows
  // in the list while the agent reads the PDF).
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
    <div className="ws-fuentes ws-scroll">
      <div className="ws-fuentes-col">
        <div className="ws-fuentes-head">
          <span className="ws-eyebrow">Fuentes del benchmark</span>
          <span className="mono muted">
            {list.length === 1 ? "1 fuente" : `${list.length} fuentes`}
            {reading.length ? ` · ${reading.length} leyéndose` : ""}
          </span>
        </div>
        <p className="ws-note">
          Las preguntas salen de estas fuentes: el agente las lee y en cada pregunta cita el paper y la página. Si un paper no tiene PDF abierto, el
          agente solo tiene su resumen.
        </p>

        {list.length === 0 && reading.length === 0 && failed.length === 0 ? (
          <p className="ws-note muted ws-fuentes-empty">
            Todavía no elegiste fuentes. Buscá abajo y elegí los papers de los que salen las preguntas — y si tenés un PDF propio, lo subís desde
            Papers, en Autoría.
          </p>
        ) : (
          <div className="lib ws-papers">
            {list.map((s) => (
              <SourceRow
                key={s.id}
                s={s}
                action={
                  <button className="lib-btn-line sm" disabled={removing !== null} onClick={() => void remove(s)}>
                    {removing === s.id ? "Sacando…" : "Sacar"}
                  </button>
                }
              />
            ))}
            {reading.map((p) => (
              <div key={p.id} className="lib-source reading">
                <span className="lib-tag conicet">…</span>
                <span className="b">
                  <span className="t">{p.title}</span>
                  <span className="m">{p.hasPdf ? "leyendo el PDF: puede tardar un minuto" : "agregando el resumen"}</span>
                </span>
              </div>
            ))}
            {failed.map((p) => (
              <div key={p.id} className="lib-source failed">
                <span className="lib-tag">×</span>
                <span className="b">
                  <span className="t">{p.title}</span>
                  <span className="m">No se pudo agregar: {p.message}</span>
                </span>
                <button className="lib-btn-line sm" onClick={() => dismissFailedSource(bench, p.id)}>
                  Cerrar
                </button>
              </div>
            ))}
          </div>
        )}
        {error && <p className="lib-error">{error}</p>}

        <p className="ws-eyebrow ws-fuentes-search">Buscar en la biblioteca</p>
        <BibliographyPicker picked={picked} busyIds={busy} onToggle={(p) => void toggle(p)} />
      </div>
    </div>
  );
}
