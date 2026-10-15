import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { api, ApiError, errorText, spellcheckFor } from "./data";
import { serializeMeta } from "./exam-model";
import { usePlatform } from "./store";
import { authorsLine, library, sources, type Paper } from "./library-data";
import { benchmarkYaml, DOMAINS, LANGUAGES, slugify, uniqueSlug } from "./new-bench-model";

// /app/nuevo — a new benchmark: its name, field and language, and the app
// creates it and opens it in A · Interfaz, where the researcher writes the
// questions or adds papers. The agent waits in B; nothing here talks to it.

export function NewBench() {
  const { files, benches, refresh } = usePlatform();
  const [, navigate] = useLocation();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("general");
  const [language, setLanguage] = useState("es");
  const [state, setState] = useState<"idle" | "creating" | "paper">("idle");
  const [error, setError] = useState<string | null>(null);

  // Started from a paper in the library (/app/nuevo?paper=<id>): it is added
  // to the benchmark right after it is created.
  const paperId = useMemo(() => {
    const id = Number(new URLSearchParams(window.location.search).get("paper"));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }, []);
  const [paper, setPaper] = useState<Paper | null>(null);
  useEffect(() => {
    if (paperId) void library.paper(paperId).then(setPaper, () => {});
  }, [paperId]);

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
      const yaml = benchmarkYaml(name, domain, language);
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
      if (paperId) {
        setState("paper");
        // A paper that cannot be added now can be added from Papers in A.
        await sources.add(folder, paperId).catch(() => null);
      }
      await refresh();
      navigate(`/app/b/${encodeURIComponent(folder)}/autoria`);
    } catch (err) {
      setError(errorText(err));
      setState("idle");
    }
  };

  return (
    <section className="bp-page bp-newbench">
      <h1 className="bp-h1">Nuevo benchmark</h1>
      <p className="body">
        Le ponés un nombre y se abre el examen para que escribas las preguntas o agregues los papers de los que salen. La rúbrica arranca con
        tres criterios que podés cambiar.
      </p>

      <form className="card-plain bp-newbench-form" onSubmit={(e) => void create(e)}>
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

        {paper && (
          <div className="bp-start-paper">
            <span className="eyebrow">Paper de partida</span>
            <span className="t">{paper.title}</span>
            <span className="body">
              {authorsLine(paper.creators, 3)}
              {paper.year ? ` · ${paper.year}` : ""}
            </span>
            <span className="muted">Se agrega al benchmark apenas se crea.</span>
          </div>
        )}

        {error && (
          <p className="bp-newbench-error" role="alert">
            {error}
          </p>
        )}

        <div className="bp-newbench-foot">
          <button type="submit" className="btn" disabled={!name.trim() || state !== "idle"}>
            {state === "creating" ? "Creando…" : state === "paper" ? "Agregando el paper…" : "Crear y abrir"}
          </button>
          <button type="button" className="btn-ghost" onClick={() => navigate("/app")} disabled={state !== "idle"}>
            Cancelar
          </button>
        </div>
      </form>
    </section>
  );
}
