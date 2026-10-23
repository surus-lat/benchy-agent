import { useMemo, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { api, ApiError, errorText, spellcheckFor } from "./data";
import { serializeMeta } from "./exam-model";
import { usePlatform } from "./store";
import { sources } from "./library-data";
import { benchmarkYaml, DOMAINS, LANGUAGES, slugify, uniqueSlug, type ExamKind } from "./new-bench-model";
import { tourAnchorRef } from "./tour";

// /app/nuevo — a new benchmark, name-first: the form is the whole wizard.
// Creating it lands in 01 · Fuentes, where the bibliography is chosen (the
// papers and publications the questions are written from); Autoría comes
// after, with the agent writing the questions over those sources. Started
// from a paper in the library (/app/nuevo?paper=<id>), that paper goes in as
// the first source when the benchmark is created. The agent waits in B;
// nothing here talks to it.

export function NewBench() {
  const { files, benches, refresh } = usePlatform();
  const [, navigate] = useLocation();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("general");
  const [language, setLanguage] = useState("es");
  const [kind, setKind] = useState<ExamKind>("open");
  const [state, setState] = useState<"idle" | "creating">("idle");
  const [error, setError] = useState<string | null>(null);

  // Started from a paper in the library (/app/nuevo?paper=<id>): the wizard
  // still asks only for the benchmark — the paper is added as its first
  // source on creation and shows up in Fuentes.
  const paperId = useMemo(() => {
    const id = Number(new URLSearchParams(window.location.search).get("paper"));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }, []);

  // Every folder in the workspace, with or without a benchmark.yaml.
  const taken = useMemo(
    () => new Set([...(files ?? []).map((f) => f.path.split("/")[0]), ...benches.map((b) => b.slug)]),
    [files, benches],
  );
  const slug = uniqueSlug(slugify(name), taken);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || state !== "idle") return;
    setState("creating");
    setError(null);
    try {
      const yaml = benchmarkYaml(name, domain, language, kind);
      const used = new Set(taken);
      let folder = slug;
      // baseModified 0: written only if no such file exists, so another
      // member's benchmark created a moment ago is never overwritten.
      for (let attempt = 0; ; attempt++) {
        try {
          await api.write(`${folder}/benchmark.yaml`, yaml, 0);
          break;
        } catch (err) {
          if (!(err instanceof ApiError && err.code === "CONFLICT") || attempt >= 4) throw err;
          used.add(folder);
          folder = uniqueSlug(slugify(name), used);
        }
      }
      await Promise.all([api.write(`${folder}/exam.jsonl`, "", 0), api.write(`${folder}/questions.json`, serializeMeta([]), 0)]);
      void api.logActivity(folder, "create", "creó el benchmark");
      // The paper this was started from becomes the first source; if it
      // cannot be added now, it can be added from 01 · Fuentes.
      if (paperId) await sources.add(folder, paperId).catch(() => null);
      await refresh();
      navigate(`/app/b/${encodeURIComponent(folder)}/fuentes`);
    } catch (err) {
      setError(errorText(err));
      setState("idle");
    }
  };

  return (
    <section className="bp-page bp-newbench">
      <h1 className="bp-h1">Nuevo benchmark</h1>
      <p className="body">
        Le ponés un nombre y se crea: las fuentes las elegís en la pestaña Fuentes, apenas se crea. Después, en Autoría, el agente escribe
        las preguntas sobre esas fuentes.
        {kind === "open"
          ? " El examen arranca con tres criterios de evaluación que podés cambiar."
          : " Cada pregunta de opción múltiple tiene cuatro opciones y una respuesta correcta: se corrige por coincidencia exacta, sin criterios de evaluación."}
      </p>

      <form className="card-plain bp-newbench-form" onSubmit={(e) => void create(e)}>
        <span className="eyebrow">El benchmark</span>

        <label className="bp-field">
          Nombre
          <input
            autoFocus
            lang="es"
            spellCheck={spellcheckFor("es")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ej.: Morfología verbal del mapudungun"
            maxLength={120}
            disabled={state !== "idle"}
          />
          <span className="hint">
            Carpeta en el workspace: <code>{name.trim() ? slug : "—"}</code>
          </span>
        </label>
        <label className="bp-field">
          Tipo de examen
          <div className="bp-newbench-kinds" role="radiogroup" aria-label="Tipo de examen">
            <button type="button" role="radio" aria-checked={kind === "open"} className={kind === "open" ? "on" : ""} onClick={() => setKind("open")} disabled={state !== "idle"}>
              Preguntas abiertas
            </button>
            <button type="button" role="radio" aria-checked={kind === "multiple_choice"} className={kind === "multiple_choice" ? "on" : ""} onClick={() => setKind("multiple_choice")} disabled={state !== "idle"}>
              Opción múltiple
            </button>
          </div>
          <span className="hint">
            {kind === "open" ? "Cada respuesta la juzga un juez contra los criterios de evaluación." : "Cuatro opciones, una respuesta correcta: se corrige por coincidencia exacta."}
          </span>
        </label>
        <div className="bp-newbench-row">
          <label className="bp-field">
            Disciplina
            <select value={domain} onChange={(e) => setDomain(e.target.value)} disabled={state !== "idle"}>
              {DOMAINS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="bp-field">
            Idioma del examen
            <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={state !== "idle"}>
              {LANGUAGES.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && (
          <p className="bp-newbench-error" role="alert">
            {error}
          </p>
        )}

        <div className="bp-newbench-foot">
          <button type="submit" className="btn" ref={tourAnchorRef("tour-nuevo-create")} disabled={!name.trim() || state !== "idle"}>
            {state === "creating" ? "Creando…" : "Crear y abrir"}
          </button>
          <button type="button" className="btn-ghost" onClick={() => navigate("/app")} disabled={state !== "idle"}>
            Cancelar
          </button>
        </div>
      </form>
    </section>
  );
}
