import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api, spellcheckFor, type LibraryCriterion } from "./data";
import {
  addCriterion,
  MAX_CRITERIA,
  removeCriterion,
  setCriterion,
  shareOf,
  type Criterion,
  type Design,
} from "./exam-model";
import type { ExamState } from "./use-exam";
import { StageNext } from "./stage-next";

// 01 · Criterios — el paso que decide todo lo demás. Antes de buscar papers o
// escribir preguntas, el investigador dice con el agente qué quiere averiguar:
// qué debería poder hacer un modelo que domina el tema y qué errores tiene que
// exponer el examen. De ese diseño salen los criterios con los que el juez
// medirá cada respuesta; las fuentes y las preguntas se eligen para ponerlos a
// prueba. El diseño vive en design.json, legible y escribible por la app y el
// agente; los criterios, en benchmark.yaml (la rúbrica del motor).
//
// La pantalla va de lo general a lo particular: primero la pregunta, después la
// capacidad que se quiere medir, y recién entonces los criterios. Lo que afina
// el diseño (errores, límites) y las reglas del puntaje quedan plegados.

const Lang = createContext("es");

type DesignFieldSpec = {
  key: keyof Design;
  title: string;
  question: string;
  placeholder: string;
  help: string;
};

const PURPOSE: DesignFieldSpec = {
  key: "purpose",
  title: "Qué querés averiguar",
  question: "La pregunta que responde este benchmark.",
  placeholder: "Ej.: si los modelos distinguen la reciprocidad ritual de la doméstica en los Andes.",
  help: "Escribila como se la harías a un colega. Todo lo demás —criterios, fuentes, preguntas— sale de acá.",
};

const CONSTRUCT: DesignFieldSpec = {
  key: "construct",
  title: "Qué debería poder hacer un modelo que domina el tema",
  question: "¿Qué habilidad o comprensión querés medir?",
  placeholder: "Ej.: reconstruir el argumento de un paper, situarlo en su contexto y distinguir posiciones.",
  help: "No lo que sabe de memoria, sino lo que puede hacer con el material de tu campo.",
};

const FAILURE_MODES: DesignFieldSpec = {
  key: "failureModes",
  title: "Qué errores querés exponer",
  question: "¿Qué respuestas flojas o engañosas querés detectar?",
  placeholder: "Ej.: confundir la tesis del autor con la del comentarista, citar sin la página, mezclar tradiciones.",
  help: "Cada pregunta se diseña para que un modelo que solo improvisa caiga en alguno de estos errores.",
};

const NOTES: DesignFieldSpec = {
  key: "notes",
  title: "Qué deja afuera el puntaje",
  question: "¿Qué no mide este examen?",
  placeholder: "Ej.: no mide estilo, originalidad ni la calidad de la escritura; solo la comprensión del material.",
  help: "Decirlo ahora evita leer el resultado como si midiera más de lo que mide.",
};

export function CriteriaStage({
  bench,
  exam,
  openExam,
  mcExam,
  questionCount,
  onNext,
  ask,
  showAgent,
}: {
  /** The benchmark folder: the agent needs it to find design.json and the rubric. */
  bench: string;
  exam: ExamState;
  openExam: boolean;
  mcExam: boolean;
  questionCount: number;
  onNext: () => void;
  ask: (t: string) => Promise<void>;
  showAgent: () => void;
}) {
  const criteria = exam.criteria ?? [];
  const [library, setLibrary] = useState<LibraryCriterion[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(true);

  useEffect(() => {
    void api
      .criteria()
      .then((r) => setLibrary(r.criteria))
      .catch(() => {
        // The library is optional: the stage works without it.
      });
  }, []);

  const saved = useRef<Design>(exam.design);
  const [design, setDesign] = useState<Design>(exam.design);
  const pending = useRef<Design | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The agent may write design.json while the researcher is reading it.
  useEffect(() => {
    if (JSON.stringify(exam.design) === JSON.stringify(saved.current)) return;
    saved.current = exam.design;
    setDesign(exam.design);
  }, [exam.design]);

  const write = (next: Design) => {
    setDesign(next);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const value = pending.current;
      pending.current = null;
      saved.current = value ?? next;
      if (value) void exam.saveDesign(value);
    }, 700);
  };

  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    const value = pending.current;
    pending.current = null;
    if (value) {
      saved.current = value;
      void exam.saveDesign(value);
    }
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) void exam.saveDesign(pending.current);
    },
    [exam.saveDesign],
  );

  const next = () => {
    flush();
    onNext();
  };

  // What still needs deciding: only the question, then the capability. Once
  // both are there, asking the agent for criteria makes sense; before that it
  // would have nothing to work from. The label is what the researcher reads;
  // the message carries the benchmark and the files so the agent knows exactly
  // where to work, even without sources or questions yet.
  const purpose = design.purpose.trim();
  const construct = design.construct.trim();
  const designPrompt = !purpose
    ? {
        label: "Ayudame a formular la pregunta",
        message: `En el benchmark ${bench}, ayudame a formular qué queremos averiguar sobre los modelos en mi campo. Hacéme preguntas hasta que la pregunta quede clara y escribila en design.json.`,
      }
    : !construct
      ? {
          label: "¿Qué debería poder hacer un modelo que domina el tema?",
          message: `En el benchmark ${bench}, a partir de lo que ya escribí en design.json, proponeme dos o tres cosas que debería poder hacer un modelo que domina el tema y completá construct en design.json.`,
        }
      : null;
  const criteriaPrompt =
    openExam && purpose
      ? {
          label: "Revisemos los criterios",
          message: `En el benchmark ${bench}, leé design.json y los criterios de benchmark.yaml. Revisá que cada criterio se pueda comprobar leyendo la respuesta experta y proponeme los que falten para cubrir el diseño.`,
        }
      : null;

  // The optional fields stay folded until there is something in them. The agent
  // may fill them later, so opening on content keeps its work visible.
  const extrasFilled = !!(design.failureModes.trim() || design.notes.trim());
  const [extrasOpen, setExtrasOpen] = useState(extrasFilled);
  useEffect(() => {
    if (extrasFilled) setExtrasOpen(true);
  }, [extrasFilled]);

  return (
    <Lang.Provider value={exam.doc?.language ?? "es"}>
      <div className="ws-scroll ws-pad-lg">
        <div className="ws-criteria">
          <header className="ws-crit-hero">
            <p className="ws-eyebrow">01 · Criterios de evaluación</p>
            <h2>¿Qué queremos averiguar?</h2>
            <p className="ws-note">
              Primero decidí qué querés descubrir sobre los modelos en tu campo. Con eso escribimos los criterios con los que se mide cada
              respuesta; las fuentes y las preguntas vienen después.
            </p>
          </header>

          <section className="ws-crit-block" aria-labelledby="crit-design">
            <header className="ws-crit-step">
              <span className="ws-crit-num" aria-hidden="true">1</span>
              <div>
                <p className="ws-eyebrow" id="crit-design">El diseño</p>
                <h3>La pregunta y lo que querés medir</h3>
                <p className="ws-note">Una pregunta y una capacidad: qué te interesa saber y qué debería poder hacer un modelo que domina el tema.</p>
              </div>
            </header>

            <div className="ws-crit-design">
              <DesignField spec={PURPOSE} value={design.purpose} onChange={(v) => write({ ...design, purpose: v })} big />
              <DesignField spec={CONSTRUCT} value={design.construct} onChange={(v) => write({ ...design, construct: v })} />
            </div>

            {designPrompt && <AgentAsk prompt={designPrompt} ask={ask} showAgent={showAgent} />}

            <button className="ws-crit-more" aria-expanded={extrasOpen} onClick={() => setExtrasOpen((o) => !o)}>
              <span className="chev">{extrasOpen ? "▾" : "▸"}</span>
              <span>{extrasOpen ? "Ocultar" : "Afinar el diseño"}</span>
              <span className="hint">Qué errores buscar y qué no mide · opcional</span>
            </button>
            {extrasOpen && (
              <div className="ws-crit-design extras">
                <DesignField spec={FAILURE_MODES} value={design.failureModes} onChange={(v) => write({ ...design, failureModes: v })} />
                <DesignField spec={NOTES} value={design.notes} onChange={(v) => write({ ...design, notes: v })} />
              </div>
            )}

            <p className="ws-design-save">Se guarda solo. El agente puede leerlo y completarlo.</p>
          </section>

          <section className="ws-crit-block" aria-labelledby="crit-rubric">
            <header className="ws-crit-step">
              <span className="ws-crit-num" aria-hidden="true">2</span>
              <div>
                <p className="ws-eyebrow" id="crit-rubric">Los criterios</p>
                <h3>Cómo se mide cada respuesta</h3>
                <p className="ws-note">
                  {openExam
                    ? `El juez los aplica a ${questionCount === 0 ? "cada pregunta" : questionCount === 1 ? "la pregunta del examen" : `las ${questionCount} preguntas del examen`}. Escribí cada criterio como algo que se pueda comprobar leyendo la respuesta experta.`
                    : "Este examen no usa rúbrica: cada respuesta se corrige por coincidencia exacta."}
                </p>
              </div>
              {openExam && (
                <span className="ws-crit-count mono" title={`Máximo ${MAX_CRITERIA} criterios`}>
                  {criteria.length} de {MAX_CRITERIA}
                </span>
              )}
            </header>

            {openExam ? (
              <>
                <CriteriaEditor
                  exam={exam}
                  criteria={criteria}
                  library={library}
                  libraryOpen={libraryOpen}
                  onLibraryOpen={setLibraryOpen}
                  onSaved={(item) => setLibrary((list) => [...list, item])}
                />
                {criteriaPrompt && <AgentAsk prompt={criteriaPrompt} ask={ask} showAgent={showAgent} />}
                <p className="ws-note">
                  Cuando el juez verifica una clave, comprueba que la respuesta experta cumpla estos criterios. Aprobar la pregunta es tu decisión y
                  pasa en 03 · Preguntas.
                </p>
                <details className="ws-crit-details">
                  <summary>Cómo se calcula el puntaje</summary>
                  <p>
                    El juez lee la respuesta del modelo, la compara con la respuesta experta y decide, criterio por criterio, si la cumple. La
                    importancia (de 1 a 5) dice cuánto mueve el puntaje final: un criterio con 5 pesa cinco veces más que uno con 1.
                  </p>
                  <p>
                    Si una clave no cumple un criterio, el problema suele estar en la redacción del criterio o en la respuesta experta, no en los
                    modelos.
                  </p>
                </details>
              </>
            ) : (
              <div className="ws-card ws-pad ws-crit-closed">
                <p className="ws-note">
                  {mcExam
                    ? "Las preguntas son de opción múltiple: la respuesta del modelo tiene que ser el texto exacto de la opción correcta. No hay rúbrica ni juez, así que no hay criterios que definir."
                    : "Cada campo se corrige por coincidencia exacta, sin criterios de evaluación."}
                </p>
                <p className="ws-note">
                  El diseño de arriba sigue siendo el norte: las preguntas y sus opciones se escriben para ponerlo a prueba.
                </p>
              </div>
            )}
          </section>

          <StageNext
            eyebrow="02 · Fuentes"
            title="Ahora elegí el material con el que vas a examinar"
            text={
              <>
                Los criterios dicen <em>qué</em> mirar; las fuentes dan <em>con qué</em>. Elegí los papers de tu campo y el agente escribirá las
                preguntas a partir de ellos, citando paper y página.
              </>
            }
            action="Ir a Fuentes"
            onClick={next}
          />
        </div>
      </div>
    </Lang.Provider>
  );
}

/** A prompt for the agent, next to the decision it helps with. */
function AgentAsk({ prompt, ask, showAgent }: { prompt: { label: string; message: string }; ask: (t: string) => Promise<void>; showAgent: () => void }) {
  return (
    <div className="ws-crit-ask">
      <span className="ws-eyebrow">Pensalo con el agente</span>
      <div className="ws-chips">
        <button
          title={prompt.message}
          onClick={() => {
            showAgent();
            void ask(prompt.message);
          }}
        >
          {prompt.label}
        </button>
      </div>
    </div>
  );
}

function DesignField({
  spec,
  value,
  onChange,
  big = false,
}: {
  spec: DesignFieldSpec;
  value: string;
  onChange: (v: string) => void;
  big?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const lang = useContext(Lang);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [value]);
  return (
    <label className={`ws-design${big ? " main" : ""}`}>
      <span className="t">{spec.title}</span>
      <span className="q">{spec.question}</span>
      <textarea
        ref={ref}
        className="ws-edit design"
        lang={lang}
        spellCheck={spellcheckFor(lang)}
        rows={2}
        value={value}
        placeholder={spec.placeholder}
        aria-label={spec.title}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="h">{spec.help}</span>
    </label>
  );
}

/** The rubric, edited in place: every change saves benchmark.yaml at once. */
function CriteriaEditor({
  exam,
  criteria,
  library,
  libraryOpen,
  onLibraryOpen,
  onSaved,
}: {
  exam: ExamState;
  criteria: Criterion[];
  library: LibraryCriterion[];
  libraryOpen: boolean;
  onLibraryOpen: (open: boolean) => void;
  onSaved: (item: LibraryCriterion) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState("");
  const [newWeight, setNewWeight] = useState(3);
  // The criteria this stage added but the org has not saved to the library yet.
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const full = criteria.length >= MAX_CRITERIA;
  const locked = false;

  const change = (c: Criterion, patch: { weight?: number; description?: string }, label: string) => {
    void exam.saveYaml(setCriterion(exam.yamlText, c.key, patch));
    setError(null);
    if (label === "texto") setDrafts((d) => ({ ...d, [c.key]: c.description }));
  };

  const add = (description: string, weight: number, levels?: Record<string, string>) => {
    void exam.saveYaml(addCriterion(exam.yamlText, description, weight, levels));
    setError(null);
  };

  const remove = (c: Criterion) => {
    void exam.saveYaml(removeCriterion(exam.yamlText, c.key));
    setError(null);
  };

  const saveToLibrary = async (c: Criterion) => {
    try {
      const r = await api.saveCriterion({
        name: c.description.length > 48 ? c.description.slice(0, 46).trimEnd() + "…" : c.description,
        description: c.description,
        weight: c.weight,
        levels: Object.fromEntries(c.levels.map((g) => [String(g), g === 0 ? "No lo cumple" : "Lo cumple"])),
      });
      onSaved(r.criterion);
      setSavedKeys((k) => new Set(k).add(c.key));
    } catch {
      setError("No se pudo guardar el criterio en la biblioteca.");
    }
  };

  return (
    <div className="ws-crit-rubric">
      <div className="ws-crit-list">
        {criteria.map((c, i) => (
          <div key={c.key} className="ws-crit-card">
            <div className="row">
              <span className="mono muted">{String(i + 1).padStart(2, "0")}</span>
              <span className="lbl">Importancia</span>
              <WeightScale value={c.weight} label={`Importancia del criterio ${i + 1}`} disabled={locked} onPick={(n) => change(c, { weight: n }, "importancia")} />
              <span className="share">{shareOf(c, criteria)} del puntaje</span>
            </div>
            <AutoText
              className="crit"
              value={drafts[c.key] ?? c.description}
              label={`Criterio ${i + 1}`}
              disabled={locked}
              onChange={(v) => setDrafts((d) => ({ ...d, [c.key]: v }))}
            />
            {drafts[c.key] !== undefined && drafts[c.key] !== c.description ? (
              <div className="ws-crit-save">
                <button
                  className="ws-btn-dark sm"
                  disabled={locked || !drafts[c.key].trim()}
                  onClick={() => {
                    change(c, { description: drafts[c.key].trim() }, "guardar");
                    setDrafts((d) => {
                      const next = { ...d };
                      delete next[c.key];
                      return next;
                    });
                  }}
                >
                  Guardar criterio
                </button>
                <button
                  className="ws-btn-line sm"
                  onClick={() =>
                    setDrafts((d) => {
                      const next = { ...d };
                      delete next[c.key];
                      return next;
                    })
                  }
                >
                  Deshacer
                </button>
              </div>
            ) : removing === c.key ? (
              <div className="ws-crit-save">
                <span className="ws-note">¿Quitar este criterio? El juez dejará de medirlo.</span>
                <button
                  className="ws-btn-danger sm"
                  disabled={locked}
                  onClick={() => {
                    setRemoving(null);
                    remove(c);
                  }}
                >
                  Quitar
                </button>
                <button className="ws-btn-line sm" onClick={() => setRemoving(null)}>
                  Cancelar
                </button>
              </div>
            ) : (
              <div className="ws-crit-actions">
                {criteria.length > 1 && (
                  <button className="ws-link ws-crit-remove" disabled={locked} onClick={() => setRemoving(c.key)} aria-label={`Quitar el criterio ${i + 1}`}>
                    Quitar
                  </button>
                )}
                {addedKeys.has(c.key) && !savedKeys.has(c.key) && (
                  <button className="ws-link" disabled={locked} onClick={() => void saveToLibrary(c)}>
                    Guardar en la biblioteca
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {library.length > 0 && (
        <div className="ws-crit-library">
          <button className="ws-crit-library-head" onClick={() => onLibraryOpen(!libraryOpen)} aria-expanded={libraryOpen}>
            <span className="t">Biblioteca de criterios</span>
            <span className="mono muted">{library.length} guardados</span>
            <span className="chev">{libraryOpen ? "▾" : "▸"}</span>
          </button>
          {libraryOpen &&
            library.map((item) => (
              <div key={item.id} className="ws-crit-lib-row">
                <span className="d">{item.description}</span>
                <span className="w mono muted">imp. {item.weight}</span>
                <button
                  className="ws-btn-line sm"
                  disabled={locked || full}
                  onClick={() => {
                    const key = nextCriterionKey(criteria);
                    add(item.description, item.weight, item.levels);
                    setAddedKeys((k) => new Set(k).add(key));
                  }}
                >
                  Agregar a este examen
                </button>
              </div>
            ))}
        </div>
      )}

      {adding ? (
        <div className="ws-crit-card new">
          <div className="row">
            <span className="mono muted">{String(criteria.length + 1).padStart(2, "0")}</span>
            <span className="lbl">Importancia</span>
            <WeightScale value={newWeight} label="Importancia del nuevo criterio" disabled={locked} onPick={setNewWeight} />
          </div>
          <AutoText
            className="crit"
            value={newText}
            label="Nuevo criterio"
            disabled={locked}
            onChange={setNewText}
            placeholder="Una oración que el juez pueda verificar: «Menciona…», «Distingue…»"
          />
          <div className="ws-crit-save">
            <button
              className="ws-btn-dark sm"
              disabled={locked || !newText.trim()}
              onClick={() => {
                const key = nextCriterionKey(criteria);
                add(newText.trim(), newWeight);
                setAddedKeys((k) => new Set(k).add(key));
                setAdding(false);
                setNewText("");
                setNewWeight(3);
              }}
            >
              Agregar criterio
            </button>
            <button
              className="ws-btn-line sm"
              onClick={() => {
                setAdding(false);
                setNewText("");
              }}
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <button className="ws-crit-add" disabled={locked || full} onClick={() => setAdding(true)}>
          {full ? `Máximo ${MAX_CRITERIA} criterios` : "+ Agregar criterio"}
        </button>
      )}

      {error && <p className="ws-note fail">{error}</p>}
    </div>
  );
}

function AutoText({
  value,
  onChange,
  label,
  className,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  className: string;
  disabled: boolean;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const lang = useContext(Lang);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [value]);
  return (
    <textarea
      ref={ref}
      lang={lang}
      spellCheck={spellcheckFor(lang)}
      className={`ws-edit ${className}`}
      value={value}
      aria-label={label}
      rows={2}
      readOnly={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Importance from 1 to 5. */
function WeightScale({ value, label, disabled, onPick }: { value: number; label: string; disabled: boolean; onPick: (n: number) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="ws-scale">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          role="radio"
          aria-checked={n === value}
          aria-label={`Importancia ${n}`}
          className={n === value ? "on" : n < value ? "under" : ""}
          disabled={disabled}
          onClick={() => n !== value && onPick(n)}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

/** The key exam-model's addCriterion gives to the next criterion added to this list. */
function nextCriterionKey(criteria: Criterion[]): string {
  const top = Math.max(0, ...criteria.map((c) => Number(/^c(\d+)$/.exec(c.key)?.[1] ?? 0)));
  let n = top + 1;
  while (criteria.some((c) => c.key === `c${n}`)) n++;
  return `c${n}`;
}
