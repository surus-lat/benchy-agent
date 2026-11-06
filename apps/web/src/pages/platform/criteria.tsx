import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api, spellcheckFor, type LibraryCriterion } from "./data";
import {
  addCriterion,
  criteriaEntryStep,
  designKeywords,
  hasDesign,
  MAX_CRITERIA,
  removeCriterion,
  setCriterion,
  type Criterion,
  type CriteriaStep,
  type Design,
} from "./exam-model";
import { STARTER_CRITERIA } from "./new-bench-model";
import { useStageCta, type StageCta } from "./stage-next";
import type { ExamState } from "./use-exam";

// 01 · Criterios — el paso que decide todo lo demás. Antes de buscar papers o
// escribir preguntas, el investigador dice con el agente qué conocimiento,
// capacidad o sesgo quiere poner a prueba. De ese diseño salen los criterios
// con los que el juez medirá cada respuesta; las fuentes y las preguntas se
// eligen para ponerlos a prueba. El diseño vive en design.json, legible y
// escribible por la app y el agente; los criterios, en benchmark.yaml (la
// rúbrica del motor).
//
// Dos pantallas, una decisión cada una: primero la pregunta y la capacidad,
// después los criterios. Al pasar a la segunda, el agente escribe un primer
// juego de criterios a partir del diseño; el investigador los edita o suma los
// suyos. Volver a esta etapa abre la pantalla que falta: la rúbrica es lo que
// dice que la decisión ya está tomada, así que un benchmark con criterios
// propios vuelve a ellos aunque su diseño nunca se haya escrito. Nada se
// muestra de golpe y ninguna pantalla necesita scroll de página.

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
  title: "Qué errores o sesgos querés exponer",
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

/** Whether the rubric is still the generic one every new benchmark starts with. */
function isStarterRubric(criteria: Criterion[]): boolean {
  return (
    criteria.length === STARTER_CRITERIA.length &&
    criteria.every((c, i) => c.weight === STARTER_CRITERIA[i][0] && c.description === STARTER_CRITERIA[i][1])
  );
}

/** Criteria the agent wrote need the researcher's expert eye: the model does not
 *  know their field. Both facts are remembered per benchmark in this browser, so
 *  the caution survives a reload and disappears once it has been acknowledged. */
const GENERATED_KEY = "benchy-criteria-generated:";
const READ_KEY = "benchy-criteria-read:";

const localSeen = (key: string) => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};

const localMark = (key: string) => {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Private mode: the caution simply comes back next time.
  }
};

const localForget = (key: string) => {
  try {
    localStorage.removeItem(key);
  } catch {
    // Same: nothing to undo.
  }
};

export function CriteriaStage({
  bench,
  exam,
  openExam,
  mcExam,
  questionCount,
  onNext,
  setStageCta,
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
  /** Publishes this stage's next step into the toolbar. */
  setStageCta: (cta: StageCta | null) => void;
  ask: (t: string) => Promise<void>;
  showAgent: () => void;
}) {
  const criteria = exam.criteria ?? [];
  // A published benchmark's definition — the design and its rubric — is frozen;
  // the stage still shows everything, read-only.
  const frozen = exam.frozen;
  const [library, setLibrary] = useState<LibraryCriterion[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);

  useEffect(() => {
    void api
      .criteria()
      .then((r) => setLibrary(r.criteria))
      .catch(() => {
        // The library is optional: the stage works without it.
      });
  }, []);

  /** Design first; a benchmark that already has one, or a rubric of its own,
   *  opens straight in the rubric. */
  const [startedWithDesign] = useState(() => hasDesign(exam.design));
  const [step, setStep] = useState<CriteriaStep>(() =>
    criteriaEntryStep(exam.design, criteria, criteria.length === 0 || isStarterRubric(criteria)),
  );
  const [generating, setGenerating] = useState(false);
  const generatingRef = useRef(false);
  /** The agent was already asked for this benchmark's first rubric. */
  const [autoTried, setAutoTried] = useState(false);
  /** Whether the agent wrote this rubric, and whether the researcher read the caution. */
  const [agentWritten, setAgentWritten] = useState(() => localSeen(GENERATED_KEY + bench));
  const [cautionRead, setCautionRead] = useState(() => localSeen(READ_KEY + bench));

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

  /** Write any pending design now; the agent reads design.json when asked. */
  const flush = (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    const value = pending.current;
    pending.current = null;
    if (!value) return Promise.resolve();
    saved.current = value;
    return exam.saveDesign(value);
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) void exam.saveDesign(pending.current);
    },
    [exam.saveDesign],
  );

  const next = () => {
    void flush();
    onNext();
  };

  const purpose = design.purpose.trim();
  const construct = design.construct.trim();
  const canLeaveDesign = !!purpose && !!construct;

  const failureModes = design.failureModes.trim();
  const limits = design.notes.trim();
  const keywords = design.keywords;
  /** Whether the design already names the searches for 02 · Fuentes. */
  const hasKeywords = keywords.length > 0;
  /** The rubric spelled out in the message, so the agent works on what is there
   *  instead of inventing a parallel one. It also reads benchmark.yaml itself. */
  const criteriaList = criteria.map((c) => `${c.key}: «${c.description}» (peso ${c.weight})`).join("; ");
  /** Whether the rubric is still the generic set every new benchmark starts with. */
  const starter = criteria.length === 0 || isStarterRubric(criteria);

  /** Ask the agent for criteria with the design and the current rubric in hand. */
  const rubricPrompt = (replace: boolean) =>
    [
      `En el benchmark ${bench}, trabajá sobre su rúbrica (los criteria de benchmark.yaml).`,
      `Diseño (design.json): qué queremos averiguar → ${purpose || "sin definir"} · qué debería poder hacer un modelo que domina el tema → ${construct || "sin definir"} · errores o sesgos que queremos exponer → ${failureModes || "sin declarar"} · qué no mide el puntaje → ${limits || "sin declarar"}.`,
      `Criterios actuales: ${criteriaList || "ninguno"}.`,
      replace
        ? "Son un punto de partida genérico: escribí de cero entre 3 y 5 criterios verificables que se desprendan del diseño y reemplazalos."
        : criteria.length === 0
          ? "No hay criterios: escribí de cero entre 3 y 5 criterios verificables que se desprendan del diseño."
          : "Sumá los que faltan para cubrir el diseño —cada error o sesgo declarado necesita al menos un criterio que lo capture— y reescribí los que no se puedan comprobar leyendo la respuesta experta de una pregunta. No repitas una idea que otro criterio ya cubre.",
      "Cada criterio: una oración que el juez pueda verificar, weight de 1 a 5 repartido según lo que importa más (lo que pesa es la proporción: nunca todos en 5) y levels 0/1. Explicame en una frase qué agrega cada uno.",
      // The same thinking, one file over: the searches the researcher will type
      // in the library, so the papers come from the design and not from a guess.
      'Y escribí en design.json el campo "keywords" con entre 5 y 8 cadenas cortas de búsqueda (1 a 4 palabras, en el idioma en que se publican los papers del campo): son las búsquedas con las que se van a elegir las fuentes en 02 · Fuentes. No son criterios ni palabras del título.',
    ].join("\n");

  /** Keywords only, for a design whose rubric is already settled. */
  const keywordsPrompt = () =>
    [
      `En el benchmark ${bench}, escribí en design.json el campo "keywords" con entre 5 y 8 cadenas cortas de búsqueda (1 a 4 palabras, en el idioma en que se publican los papers del campo).`,
      `Salen de design.json y de los criterios de benchmark.yaml (${criteriaList || "sin criterios todavía"}): son las búsquedas con las que se van a elegir las fuentes en 02 · Fuentes.`,
      "No copies palabras del título ni escribas criterios.",
    ].join("\n");

  const generate = async (replace: boolean) => {
    if (generatingRef.current) return;
    generatingRef.current = true;
    setGenerating(true);
    // Whatever arrives is the agent's work, not the researcher's: say so, again.
    localMark(GENERATED_KEY + bench);
    localForget(READ_KEY + bench);
    setAgentWritten(true);
    setCautionRead(false);
    try {
      await ask(rubricPrompt(replace));
    } finally {
      generatingRef.current = false;
      setGenerating(false);
    }
  };

  const goCriteria = async () => {
    if (!canLeaveDesign) return;
    await flush();
    setStep("criteria");
    // Only the first design of a benchmark with no questions asks the agent for
    // the rubric: a researcher's own criteria are never replaced.
    if (openExam && questionCount === 0 && !startedWithDesign && !autoTried && starter) {
      setAutoTried(true);
      void generate(true);
    }
  };

  // The two steps of this stage, published into the toolbar's corner: the stage
  // keeps the room it needs instead of spending it on a bar at the bottom.
  useStageCta(setStageCta,
    step === "design"
      ? {
          label: "Siguiente: criterios",
          tip: canLeaveDesign
            ? "Paso 1 de 2. Al seguir, el agente escribe los criterios a partir de lo que definiste."
            : "Paso 1 de 2. Completá la pregunta y la capacidad para seguir.",
          disabled: !canLeaveDesign,
          onClick: () => void goCriteria(),
        }
      : {
          label: "Ir a Fuentes",
          // Empty rubric is a dead end on purpose: without criteria the judge has
          // nothing to measure with, so the way forward stays shut.
          tip:
            openExam && criteria.length === 0
              ? "Paso 2 de 2. Sin criterios el juez no tiene con qué medir: el examen no se puede evaluar ni publicar. Escribí o generá al menos uno para seguir."
              : `Paso 2 de 2. El juez verifica las claves con estos criterios; aprobar cada pregunta pasa en 03 · Preguntas.${
                  hasKeywords ? " En 02 · Fuentes la búsqueda arranca con las palabras clave de tu diseño." : ""
                }`,
          disabled: openExam && criteria.length === 0,
          onClick: next,
        },
  );

  // What still needs deciding: only the question, then the capability. Once
  // both are there, asking the agent for criteria makes sense; before that it
  // would have nothing to work from. The label is what the researcher reads;
  // the message carries the benchmark and the files so the agent knows exactly
  // where to work, even without sources or questions yet.
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

  // The optional fields stay folded, even when the agent filled them: this step
  // is one decision at a time. What they say is one click away, and the toggle
  // says whether something is already written there.
  const extrasFilled = !!(design.failureModes.trim() || design.notes.trim());
  const [extrasOpen, setExtrasOpen] = useState(false);

  const generationFailed = autoTried && !generating && (criteria.length === 0 || isStarterRubric(criteria));
  // A rubric the agent wrote is the agent's until the researcher owns it: the
  // caution about its expertise stays up until they acknowledge it.
  const needsReview = openExam && agentWritten && !cautionRead;

  return (
    <Lang.Provider value={exam.doc?.language ?? "es"}>
      <div className="ws-crit-page ws-pad-lg">
        <div className="ws-criteria">
          <header className="ws-crit-hero">
            <p className="ws-eyebrow">01 · Criterios de evaluación · Paso {step === "design" ? "1" : "2"} de 2</p>
            <div className="ws-crit-title">
              <h2>{step === "design" ? "¿Qué queremos averiguar?" : "¿Cómo se mide cada respuesta?"}</h2>
              {step === "criteria" && (
                <span className="ws-crit-tools">
                  <button className="ws-link" onClick={() => setStep("design")}>
                    Volver al diseño
                  </button>
                  {openExam && (
                    <span className="ws-crit-count mono" title={`Máximo ${MAX_CRITERIA} criterios`}>
                      {criteria.length} de {MAX_CRITERIA}
                    </span>
                  )}
                </span>
              )}
            </div>
            <p className="ws-note">
              {step === "design"
                ? "Definí qué conocimiento, capacidad o sesgo querés poner a prueba. De esa decisión salen los criterios con los que el juez mide cada respuesta."
                : openExam
                  ? "Con estos criterios el juez mide cada respuesta. Reescribilos, cambiá cuánto pesan o sumá los tuyos."
                  : "Este examen no usa rúbrica: cada respuesta se corrige por coincidencia exacta."}
            </p>
            {frozen && (
              <p className="ws-note amber">
                El benchmark está publicado: el diseño y los criterios se leen, no se editan. Revertí la publicación en 06 · Publicación para crear una
                copia editable a partir de esa versión.
              </p>
            )}
          </header>

          <div className="ws-crit-body">
            {step === "design" ? (
              <>
                <div className="ws-crit-design">
                  <DesignField spec={PURPOSE} value={design.purpose} onChange={(v) => write({ ...design, purpose: v })} disabled={frozen} big />
                  <DesignField spec={CONSTRUCT} value={design.construct} onChange={(v) => write({ ...design, construct: v })} disabled={frozen} />
                </div>

                {designPrompt && <AgentAsk prompt={designPrompt} ask={ask} showAgent={showAgent} />}

                <button className="ws-crit-more" aria-expanded={extrasOpen} onClick={() => setExtrasOpen((o) => !o)}>
                  <span className="chev">{extrasOpen ? "▾" : "▸"}</span>
                  <span>{extrasOpen ? "Ocultar" : "Afinar el diseño"}</span>
                  <span className="hint">
                    {extrasFilled
                      ? "los errores o sesgos a exponer y lo que no mide · ya hay algo escrito"
                      : "los errores o sesgos a exponer y lo que no mide · opcional"}
                  </span>
                </button>
                {extrasOpen && (
                  <div className="ws-crit-design extras">
                    <DesignField spec={FAILURE_MODES} value={design.failureModes} onChange={(v) => write({ ...design, failureModes: v })} disabled={frozen} />
                    <DesignField spec={NOTES} value={design.notes} onChange={(v) => write({ ...design, notes: v })} disabled={frozen} />
                  </div>
                )}

                <p className="ws-design-save">Se guarda solo. El agente puede leerlo y completarlo.</p>
              </>
            ) : (
              <>
                {openExam && !hasDesign(design) && (
                  <p className="ws-note amber" role="note">
                    Todavía no escribiste qué querés averiguar: estos criterios no bajan de un diseño tuyo. Definilo y
                    pedile al agente que los reescriba a partir de lo que definiste.{" "}
                    <button className="ws-link" onClick={() => setStep("design")}>
                      Volver al paso 1
                    </button>
                  </p>
                )}

                {openExam && needsReview && (
                  <div className="ws-crit-warn" role="note">
                    <p>
                      <strong>Revisalos contra tu diseño:</strong> los escribió un modelo que no conoce tu tema y pueden
                      ser obvios o difíciles de verificar con la respuesta experta.
                    </p>
                    <button
                      className="ws-link"
                      onClick={() => {
                        localMark(READ_KEY + bench);
                        setCautionRead(true);
                      }}
                    >
                      Entendido
                    </button>
                  </div>
                )}

                {generating ? (
                  <div className="ws-crit-gen" role="status" aria-live="polite">
                    <span className="ws-crit-gen-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                    <p className="t">Generando criterios a partir de tu diseño…</p>
                    <p className="d">El agente está leyendo qué querés evaluar. Cuando termine, vas a poder editarlos o sumar los tuyos.</p>
                  </div>
                ) : openExam ? (
                  <>
                    <CriteriaEditor
                      exam={exam}
                      criteria={criteria}
                      library={library}
                      libraryOpen={libraryOpen}
                      onLibraryOpen={setLibraryOpen}
                      onSaved={(item) => setLibrary((list) => [...list, item])}
                      onGenerate={() => void generate(starter)}
                      generating={generating}
                      frozen={frozen}
                      generateHint={rubricPrompt(starter)}
                    />
                    {generationFailed && (
                      <p className="ws-note fail">
                        No llegaron criterios nuevos. Probá de nuevo con el agente o escribí uno a mano.{" "}
                        <button className="ws-link" onClick={() => void generate(starter)} disabled={generating}>
                          Reintentar
                        </button>
                      </p>
                    )}
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

                {!generating && (
                  <KeywordEditor
                    keywords={keywords}
                    frozen={frozen}
                    onChange={(next) => write({ ...design, keywords: next })}
                    onAsk={() => {
                      showAgent();
                      void ask(keywordsPrompt());
                    }}
                  />
                )}
              </>
            )}
          </div>
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
  disabled = false,
}: {
  spec: DesignFieldSpec;
  value: string;
  onChange: (v: string) => void;
  big?: boolean;
  /** Read-only: the benchmark is published. */
  disabled?: boolean;
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
        readOnly={disabled}
        placeholder={spec.placeholder}
        aria-label={spec.title}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="h">{spec.help}</span>
    </label>
  );
}

/** The searches the design hands to 02 · Fuentes. They come out of the same
 *  thinking as the criteria — what would put this design to the test — so they
 *  are written and edited here, and the library starts with them there. */
function KeywordEditor({
  keywords,
  frozen,
  onChange,
  onAsk,
}: {
  keywords: string[];
  /** The benchmark is published: its design is part of what was published. */
  frozen: boolean;
  onChange: (keywords: string[]) => void;
  /** Ask the agent for them, with the design and the rubric in hand. */
  onAsk: () => void;
}) {
  const [draft, setDraft] = useState("");
  const lang = useContext(Lang);
  // Typing "a, b" adds two searches: the box is the same one as the library's.
  const pending = designKeywords(draft);

  const add = () => {
    if (!pending.length) return;
    onChange(designKeywords([...keywords, ...pending]));
    setDraft("");
  };

  return (
    <section className="ws-kw" aria-label="Palabras clave para buscar las fuentes">
      <div className="head">
        <span className="t">Palabras clave para buscar las fuentes</span>
        <span className="d">
          Es lo que alguien escribiría en el buscador de la biblioteca para encontrar los papers de este diseño. Cuando pases a 02 · Fuentes, la búsqueda
          arranca con ellas.
        </span>
      </div>
      <div className="ws-kw-chips">
        {keywords.map((k) => (
          <span key={k} className="ws-kw-chip">
            <span className="mono">{k}</span>
            <button disabled={frozen} onClick={() => onChange(keywords.filter((x) => x !== k))} aria-label={`Quitar la palabra clave ${k}`}>
              ✕
            </button>
          </span>
        ))}
        {keywords.length === 0 && <span className="ws-kw-none">Ninguna todavía.</span>}
      </div>
      <div className="ws-kw-row">
        <input
          className="ws-kw-input"
          value={draft}
          lang={lang}
          spellCheck={spellcheckFor(lang)}
          disabled={frozen}
          placeholder="Ej.: reciprocidad ritual andina (separá varias con coma)"
          aria-label="Agregá una palabra clave"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button className="ws-btn-line sm" disabled={frozen || !pending.length} onClick={add}>
          {pending.length > 1 ? `Agregar ${pending.length}` : "Agregar"}
        </button>
        <button className="ws-link" disabled={frozen} title={keywordsPromptTitle} onClick={onAsk}>
          {keywords.length === 0 ? "Pedídselas al agente" : "Que el agente las complete"}
        </button>
      </div>
    </section>
  );
}

/** The message the button sends, as a tooltip. */
const keywordsPromptTitle = "El agente lee el diseño y la rúbrica y escribe las keywords en design.json";

/** The rubric, edited in place: every change saves benchmark.yaml at once. */
function CriteriaEditor({

  exam,
  criteria,
  library,
  libraryOpen,
  onLibraryOpen,
  onSaved,
  onGenerate,
  generating,
  frozen,
  generateHint,
}: {
  exam: ExamState;
  criteria: Criterion[];
  library: LibraryCriterion[];
  libraryOpen: boolean;
  onLibraryOpen: (open: boolean) => void;
  onSaved: (item: LibraryCriterion) => void;
  /** Ask the agent for criteria, with the design and this rubric in hand. */
  onGenerate: () => void;
  generating: boolean;
  /** The benchmark is published: its rubric is part of what was published. */
  frozen: boolean;
  /** The message the button sends, shown as a tooltip. */
  generateHint: string;
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
  // The rubric belongs to the benchmark's definition: a published one is read here.
  const locked = frozen;

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

  /** Weights only matter as a proportion: 5/5 is the same exam as 1/1. So the
   *  editor shows how the score is split, and lets them split it evenly. */
  const weights = criteria.map((c) => c.weight);
  const maxW = Math.max(...weights);
  const minW = Math.min(...weights);
  const even = criteria.length > 1 && maxW === minW;
  const pct = (weight: number, list: { weight: number }[]) => Math.round((weight / (list.reduce((a, x) => a + x.weight, 0) || 1)) * 100);

  const equalize = () => {
    let text = exam.yamlText;
    for (const c of criteria) text = setCriterion(text, c.key, { weight: 3 });
    void exam.saveYaml(text);
    setError(null);
  };

  return (
    <div className="ws-crit-rubric">
      {criteria.length > 0 && (
        <div className="ws-crit-alloc">
          <div className="alloc-bar">
            {criteria.map((c, i) => (
              <span
                key={c.key}
                className={`seg${maxW !== minW && c.weight === maxW ? " top" : ""}`}
                style={{ flexGrow: c.weight }}
                title={`Criterio ${i + 1}: ${pct(c.weight, criteria)}% del puntaje`}
              >
                <span className="n mono">{String(i + 1).padStart(2, "0")}</span>
                <span className="p mono">{pct(c.weight, criteria)}%</span>
              </span>
            ))}
          </div>
          <div className="alloc-foot">
            <details className="ws-crit-details">
              <summary>
                Se reparten 100% del puntaje: lo que le sumás a un criterio se lo sacás a los demás.
                {even ? " Ahora pesan todos igual." : ""}
              </summary>
              <p>
                El juez lee la respuesta del modelo, la compara con la respuesta experta y decide, criterio por
                criterio, si la cumple. Lo que importa es la proporción: un criterio que vale 50% del puntaje mueve el
                doble que uno que vale 25%.
              </p>
              <p>
                Si una clave no cumple un criterio, el problema suele estar en la redacción del criterio o en la
                respuesta experta, no en los modelos.
              </p>
            </details>
            {criteria.length > 1 && !even && (
              <button className="ws-link" disabled={locked} onClick={equalize}>
                Repartir en partes iguales
              </button>
            )}
          </div>
        </div>
      )}

      {criteria.length === 0 && !adding && (
        <div className="ws-crit-none">
          <p className="t">Sin criterios no hay con qué corregir</p>
          <p className="d">
            El juez mide cada respuesta con estos criterios: sin ninguno el examen no compila, y no se puede evaluar ni
            publicar. Bajalos de tu diseño con el agente, o escribí el primero.
          </p>
        </div>
      )}

      <div className="ws-crit-list">
        {criteria.map((c, i) => (
          <div key={c.key} className="ws-crit-card">
            <div className="crit-line">
              <span className="mono idx">{String(i + 1).padStart(2, "0")}</span>
              <AutoText
                className="crit"
                value={drafts[c.key] ?? c.description}
                label={`Criterio ${i + 1}`}
                disabled={locked}
                onChange={(v) => setDrafts((d) => ({ ...d, [c.key]: v }))}
              />
            </div>
            <div className="row">
              <WeightSlider
                value={c.weight}
                share={pct(c.weight, criteria)}
                label={`Peso del criterio ${i + 1} en el puntaje`}
                disabled={locked}
                onPick={(n) => change(c, { weight: n }, "importancia")}
              />
              <span className="spacer" />
              {addedKeys.has(c.key) && !savedKeys.has(c.key) && (
                <button className="ws-link" disabled={locked} onClick={() => void saveToLibrary(c)}>
                  Guardar en la biblioteca
                </button>
              )}
              <button className="ws-link ws-crit-remove" disabled={locked} onClick={() => setRemoving(c.key)} aria-label={`Quitar el criterio ${i + 1}`}>
                Quitar
              </button>
            </div>
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
                <span className="ws-note">
                  {criteria.length === 1
                    ? "¿Quitar el último criterio? Sin criterios el examen no se puede evaluar."
                    : "¿Quitar este criterio? El juez dejará de medirlo."}
                </span>
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
            ) : null}
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
          <div className="crit-line">
            <span className="mono idx">{String(criteria.length + 1).padStart(2, "0")}</span>
            <AutoText
              className="crit"
              value={newText}
              label="Nuevo criterio"
              disabled={locked}
              onChange={setNewText}
              placeholder="Una oración que el juez pueda verificar: «Menciona…», «Distingue…»"
            />
          </div>
          <div className="row">
            <WeightSlider
              value={newWeight}
              share={pct(newWeight, [...criteria, { weight: newWeight }])}
              label="Peso del nuevo criterio en el puntaje"
              disabled={locked}
              onPick={setNewWeight}
            />
          </div>
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
        <div className="ws-crit-addrow">
          <button className="ws-crit-add" disabled={locked || full} onClick={() => setAdding(true)}>
            {full ? `Máximo ${MAX_CRITERIA} criterios` : "+ Agregar criterio"}
          </button>
          <button className="ws-btn-line ws-crit-gen-btn" disabled={locked || generating} title={generateHint} onClick={onGenerate}>
            {generating ? "Generando…" : criteria.length === 0 ? "Generar criterios con el agente" : "Generar o mejorar con el agente"}
          </button>
        </div>
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

/** How much a criterion counts, told as what it actually changes: the slice of
 *  the final score it takes. The absolute weight in benchmark.yaml is an
 *  implementation detail — every criterion at 5 measures the same exam as every
 *  criterion at 1 — so the control never shows that number. Moving the slider
 *  grows this slice and shrinks the others, which is the whole point. */
function WeightSlider({
  value,
  share,
  label,
  disabled,
  onPick,
}: {
  value: number;
  share: number;
  label: string;
  disabled: boolean;
  onPick: (n: number) => void;
}) {
  const level = Math.min(5, Math.max(1, Math.round(value) || 1));
  const fill = ((level - 1) / 4) * 100;
  return (
    <span className="ws-weight">
      <input
        type="range"
        min={1}
        max={5}
        step={1}
        value={level}
        aria-label={label}
        aria-valuetext={`${share}% del puntaje`}
        title="Más peso le saca porcentaje al resto de los criterios"
        disabled={disabled}
        style={{ backgroundImage: `linear-gradient(to right, var(--ink) ${fill}%, var(--line-soft) ${fill}%)` }}
        onChange={(e) => onPick(Number(e.target.value))}
      />
      <span className="share mono">
        Vale <strong>{share}%</strong> del puntaje
      </span>
    </span>
  );
}

/** The key exam-model's addCriterion gives to the next criterion added to this list. */
function nextCriterionKey(criteria: Criterion[]): string {
  const top = Math.max(0, ...criteria.map((c) => Number(/^c(\d+)$/.exec(c.key)?.[1] ?? 0)));
  let n = top + 1;
  while (criteria.some((c) => c.key === `c${n}`)) n++;
  return `c${n}`;
}
