import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { api, ApiError, errorText, spellcheckFor } from "./data";
import { serializeMeta } from "./exam-model";
import { usePlatform } from "./store";
import { authorsLine, library, sources } from "./library-data";
import { BibliographyPicker } from "./bibliography-picker";
import { benchmarkYaml, DOMAINS, LANGUAGES, slugify, togglePaper, uniqueSlug, type PickedPaper } from "./new-bench-model";

// /app/nuevo — a new benchmark in two steps. Paso 0 picks the bibliography:
// the papers and publications the questions are written from. Paso 1 is the
// benchmark itself (its name, field and language); creating it opens
// A · Interfaz in Autoría, where the agent writes the questions over the
// bibliography already chosen here. The agent waits in B; nothing here talks
// to it.

export function NewBench() {
  const { files, benches, refresh } = usePlatform();
  const [, navigate] = useLocation();
  const [step, setStep] = useState<0 | 1>(0);
  const [picked, setPicked] = useState<PickedPaper[]>([]);
  const [emptyWarned, setEmptyWarned] = useState(false);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("general");
  const [language, setLanguage] = useState("es");
  const [state, setState] = useState<"idle" | "creating" | "papers">("idle");
  const [error, setError] = useState<string | null>(null);

  // Started from a paper in the library (/app/nuevo?paper=<id>): it arrives
  // already picked in paso 0, and can be taken out like any other.
  const paperId = useMemo(() => {
    const id = Number(new URLSearchParams(window.location.search).get("paper"));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }, []);
  useEffect(() => {
    if (!paperId) return;
    void library.paper(paperId).then(
      (p) => setPicked((cur) => (cur.some((x) => x.id === p.id) ? cur : [...cur, { id: p.id, title: p.title, creators: p.creators, year: p.year, hasPdf: p.pdfUrl !== null }])),
      () => {},
    );
  }, [paperId]);

  // Every folder in the workspace, with or without a benchmark.yaml.
  const taken = useMemo(
    () => new Set([...(files ?? []).map((f) => f.path.split("/")[0]), ...benches.map((b) => b.slug)]),
    [files, benches],
  );
  const slug = uniqueSlug(slugify(name), taken);

  // Paso 0 → paso 1. Without papers it is allowed, but not silently: the
  // first "Continuar" shows the warning and asks for a second click.
  const toBenchmark = () => {
    if (picked.length === 0 && !emptyWarned) {
      setEmptyWarned(true);
      return;
    }
    setStep(1);
  };

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
      if (picked.length) {
        setState("papers");
        // A paper that cannot be added now can be added from Papers in A.
        await Promise.all(picked.map((p) => sources.add(folder, p.id).catch(() => null)));
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
        {step === 0
          ? "Primero la bibliografía: elegí los papers y publicaciones de los que salen las preguntas. Después, en Autoría, el agente escribe las preguntas sobre lo que elegís acá."
          : "Le ponés un nombre y se abre el examen en Autoría, para escribir o generar las preguntas sobre la bibliografía que ya elegiste. La rúbrica arranca con tres criterios que podés cambiar."}
      </p>

      {step === 0 ? (
        <div className="card-plain bp-newbench-form">
          <span className="eyebrow">Paso 0 · Bibliografía</span>

          {picked.length > 0 && (
            <div className="bp-start-paper">
              <span className="eyebrow">{picked.length === 1 ? "1 paper elegido" : `${picked.length} papers elegidos`}</span>
              {picked.map((p) => (
                <span key={p.id} className="body">
                  {p.title} — {authorsLine(p.creators, 2)}
                  {p.year ? ` · ${p.year}` : ""}{" "}
                  <button type="button" className="lb-add" onClick={() => setPicked((cur) => togglePaper(cur, p))}>
                    Sacar
                  </button>
                </span>
              ))}
            </div>
          )}

          <BibliographyPicker picked={picked} onToggle={(p) => setPicked((cur) => togglePaper(cur, p))} />

          {emptyWarned && picked.length === 0 && (
            <div className="bp-start-paper" role="alert">
              <span className="eyebrow">Seguís sin papers</span>
              <span className="body">
                Podés avanzar igual: el benchmark se crea sin fuentes y los papers los agregás después desde Papers, en Autoría. Sin fuentes, eso
                sí, el agente escribe de lo que sabe y no puede citar el paper y la página en cada pregunta.
              </span>
            </div>
          )}

          <div className="bp-newbench-foot">
            <button type="button" className="btn" onClick={toBenchmark}>
              {picked.length === 0 && emptyWarned ? "Seguir sin papers →" : "Continuar →"}
            </button>
            <button type="button" className="btn-ghost" onClick={() => navigate("/app")}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <form className="card-plain bp-newbench-form" onSubmit={(e) => void create(e)}>
          <span className="eyebrow">Paso 1 · El benchmark</span>
          <p className="body" style={{ margin: 0 }}>
            Bibliografía: {picked.length === 0 ? "sin papers — los agregás después desde Autoría." : picked.length === 1 ? "1 paper elegido." : `${picked.length} papers elegidos.`}
          </p>

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

          {error && (
            <p className="bp-newbench-error" role="alert">
              {error}
            </p>
          )}

          <div className="bp-newbench-foot">
            <button type="submit" className="btn" disabled={!name.trim() || state !== "idle"}>
              {state === "creating" ? "Creando…" : state === "papers" ? "Agregando los papers…" : "Crear y abrir"}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setStep(0)} disabled={state !== "idle"}>
              ← Bibliografía
            </button>
            <button type="button" className="btn-ghost" onClick={() => navigate("/app")} disabled={state !== "idle"}>
              Cancelar
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
