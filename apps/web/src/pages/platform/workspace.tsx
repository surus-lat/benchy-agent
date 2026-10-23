import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, errorText, newestPerModel, REGIONS, spellcheckFor, splitAsk, type CatalogModel, type Evaluation, type JudgeConfig, type LibraryCriterion, type Message, type SearchHit } from "./data";
import { useAgentChat } from "./agent-chat";
import { usePlatform, type BenchSummary, type PendingSource } from "./store";
import { useEvaluation, useExam, useRunResults, useSelectedModels, type EvaluationState, type ExamState } from "./use-exam";
import {
  addCriterion,
  byAgent,
  criterionMet,
  groupsOf,
  hasIssue,
  isOpenQuestionExam,
  isPending,
  QUALITY_CRITERIA,
  MAX_CRITERIA,
  removeCriterion,
  setCriterion,
  shareOf,
  titleOf,
  type Criterion,
  type Question,
  type QStatus,
} from "./exam-model";
import { LibraryBrowser, SourceRow } from "./library";
import { SourcesStage } from "./fuentes";
import { PublicationStage } from "./publication";
import {
  citation,
  sources as sourcesApi,
  libraryErrorText,
  sourceState,
  validation as validationApi,
  type ChecklistItem,
  type Source,
  type SourceValidation,
} from "./library-data";
import { ApiError } from "./data";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import "./workspace.css";

// One benchmark as two windows over the same exam (design: Plataforma AB v3).
// A · Interfaz is the researcher's: questions, expert answers, the rubric, the
// review, the evaluation. B · Agente is the org's Hermes, working on the same
// files. Whatever either side changes shows in the other: A reloads after every
// agent turn, and A's saves appear in B's thread as events.

const STAGES = [
  ["fuentes", "01", "Fuentes"],
  ["autoria", "02", "Autoría"],
  ["revision", "03", "Revisión"],
  ["evaluacion", "04", "Evaluación"],
  ["publicacion", "05", "Publicación"],
] as const;
type Stage = (typeof STAGES)[number][0];

const BRACKET: Record<QStatus, [string, string]> = {
  done: ["[✓]", "ok"],
  progress: ["[·]", "amber"],
  attention: ["[!]", "amber"],
  new: ["[+]", "amber"],
  error: ["[×]", "fail"],
  empty: ["[ ]", "muted"],
};

type Event = { id: string; at: number; who: "Vos" | "Juez"; path: string; change: string; open: () => void };

/** 0.75, not 0.7500000000000001: the quality badge reads like a grade. */
const trimScore = (s: number) => String(Math.round(s * 100) / 100);

/** The exam's language (benchmark.language): its text fields declare it, for spell check. */
const ExamLang = createContext("es");

/** First message of a conversation tells the agent which benchmark is open. Hidden in the thread. */
const CONTEXT = /^\(Benchmark abierto en la app: [^)]*\)\n\n/;

/** What the agent is asked for a batch: from the benchmark's papers when it has
 *  them. Only the validated papers are named (ids): a pending one stays out of
 *  generation until the org ticks it off in the Papers drawer. */
function batchPrompt(n: number, slug: string, ids: string[] = []): string {
  const tail = `Agregalas al final de exam.jsonl y de questions.json (status draft, by agente, con su group). No toques las preguntas existentes.`;
  const which =
    ids.length > 0
      ? `estos papers del benchmark: ${ids.join(", ")} (la lista en ${slug}/sources.json, el texto de cada uno en ${slug}/sources/)`
      : `los papers del benchmark (${slug}/sources.json)`;
  return `Generá ${n} preguntas nuevas para este examen a partir de ${which}: leé los papers primero y escribí cada pregunta desde lo que el paper sostiene, con su respuesta experta y por qué la pregunta importa. En questions.json, sources lleva el id del paper y la página (por ejemplo "conicet-179477 p. 4"). ${tail}`;
}

export default function Workspace({ slug, stage: stageParam }: { slug: string; stage?: string }) {
  const { me, benches, files, refresh, setLastBench, pendingSources } = usePlatform();
  const [, navigate] = useLocation();
  const bench = benches.find((b) => b.slug === slug);
  const stage = (STAGES.some(([k]) => k === stageParam) ? stageParam : "autoria") as Stage;
  const go = useCallback((s: Stage) => navigate(`/app/b/${encodeURIComponent(slug)}/${s}`), [navigate, slug]);

  const exam = useExam(bench);
  useEffect(() => setLastBench(slug), [slug, setLastBench]);
  // Runs in the container, not in the chat: a model or the report finishing reloads the files.
  const evaluation = useEvaluation(bench, () => void refresh());
  const chat = useAgentChat(slug);
  const [front, setFront] = useState<"A" | "B">("A");
  const [instant, setInstant] = useState(false);
  const [unread, setUnread] = useState(0);
  const [events, setEvents] = useState<Event[]>([]);
  const [qIndex, setQIndex] = useState(0);
  const [rubricOpen, setRubricOpen] = useState(false);
  const [papersOpen, setPapersOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [generating, setGenerating] = useState<number | null>(null);
  // The exam is read-only only while the agent writes questions the app asked for
  // (a batch, a draft): never just because the researcher is chatting with it.
  const [drafting, setDrafting] = useState(false);
  // "Ejecutar evaluación" from the toolbar or B: Evaluation starts it once mounted.
  const [runRequest, setRunRequest] = useState(0);
  const requestRun = useCallback(() => {
    go("evaluacion");
    setRunRequest((n) => n + 1);
  }, [go]);

  // The org's checklist for validating new material, and this bench's
  // per-source state against it. A source without a row predates the feature:
  // it counts as validated (grandfathered).
  const [checklist, setChecklist] = useState<ChecklistItem[] | null>(null);
  const [validations, setValidations] = useState<Record<string, SourceValidation>>({});
  // The org's saved criteria (issue #12): offered in the drawer, fed by what
  // the drawer saves back. A library the fetch cannot reach reads as empty.
  const [savedCriteria, setSavedCriteria] = useState<LibraryCriterion[]>([]);
  const reloadCriteria = useCallback(async () => {
    try {
      setSavedCriteria((await api.criteria()).criteria);
    } catch {
      // The drawer offers no imports until the next open retries the fetch.
    }
  }, []);
  useEffect(() => {
    void reloadCriteria();
  }, [reloadCriteria]);
  const reloadValidation = useCallback(async () => {
    try {
      const [c, v] = await Promise.all([validationApi.checklist(), validationApi.forBench(slug)]);
      setChecklist(c.items);
      setValidations(Object.fromEntries(v.validations.map((x) => [x.sourceId, x])));
    } catch {
      // Same semantics as a missing row: without the state, sources read as
      // validated; the next render of the drawer retries the fetch.
    }
  }, [slug]);
  useEffect(() => {
    setChecklist(null);
    setValidations({});
    void reloadValidation();
  }, [reloadValidation]);

  const bringFront = useCallback((f: "A" | "B", fast = false) => {
    setFront(f);
    if (f === "B") setUnread(0);
    if (fast) {
      setInstant(true);
      setTimeout(() => setInstant(false), 60);
    }
  }, []);

  // ⌘J / Ctrl+J swaps the windows; Escape closes the rubric.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setFront((f) => {
          const next = f === "A" ? "B" : "A";
          if (next === "B") setUnread(0);
          return next;
        });
      }
      if (e.key === "Escape") {
        setRubricOpen(false);
        setPapersOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A new agent reply while A is in front counts as unread.
  const replies = chat.messages.filter((m) => m.role === "assistant").length;
  const seen = useRef(replies);
  useEffect(() => {
    if (replies > seen.current && front === "A") setUnread((u) => u + replies - seen.current);
    seen.current = replies;
  }, [replies, front]);

  const pushEvent = useCallback((e: Omit<Event, "id" | "at">) => {
    setEvents((all) => {
      const last = all[all.length - 1];
      // Typing in one field is one event, not one per save.
      if (last && last.who === e.who && last.path === e.path) return [...all.slice(0, -1), { ...last, change: e.change, at: Date.now() }];
      return [...all, { ...e, id: `ev-${Date.now()}-${all.length}`, at: Date.now() }];
    });
  }, []);

  /** A turn the app sends for the researcher (buttons and chips); A reloads after it. */
  const ask = useCallback(
    async (text: string) => {
      const first = !chat.convId && chat.messages.length === 0;
      const message = first && bench ? `(Benchmark abierto en la app: ${bench.yamlPath})\n\n${text}` : text;
      try {
        await chat.send(message);
      } catch {
        // chat.error shows it in B
      }
      await Promise.all([exam.reload(), refresh()]);
    },
    [chat, bench, exam, refresh],
  );

  if (!bench) {
    return (
      <div className="ws">
        <WsHeader org={me?.org?.name} front={front} unread={unread} onFront={bringFront} />
        <main className="ws-canvas ws-center">
          <p className="ws-note">
            {files === null ? "Cargando…" : `No encontramos el benchmark “${slug}” en el workspace de tu organización.`}{" "}
            <Link href="/app">Volver a los benchmarks</Link>
          </p>
        </main>
      </div>
    );
  }

  const openExam = isOpenQuestionExam(exam.doc?.task, exam.criteria);
  const qs = exam.questions;
  /**
   * Take a question out of the exam for good. The container deletes it and
   * reindexes the runs and the review that reference it (the runs then read as
   * "de una versión anterior del examen" until a new one runs), so the delete
   * happens server-side and we re-read the files instead of editing them here.
   */
  const deleteQuestion = async (question: Question) => {
    try {
      await api.removeQuestion(slug, question.index + 1);
    } catch (err) {
      exam.setError(errorText(err));
      return;
    }
    pushEvent({ who: "Vos", path: question.num, change: "pregunta borrada", open: () => go("autoria") });
    setQIndex((i) => Math.max(0, Math.min(i > question.index ? i - 1 : i, qs.length - 2)));
    await Promise.all([exam.reload(), refresh()]);
  };
  const q = qs[Math.min(qIndex, Math.max(qs.length - 1, 0))];
  const approved = qs.filter((x) => x.status === "done").length;
  const papers = exam.sources;
  // The papers the agent may write questions from: the validated ones. A
  // pending paper waits for the org's checklist in the Papers drawer and stays
  // out of generation (the batch prompt names only the validated ids).
  const validPapers = papers.filter((s) => sourceState(validations[s.id]) === "validated");
  const pendingPapers = papers.length - validPapers.length;
  // The exam is "concretado" when the grader has reviewed every question as it
  // stands, the researcher approved each one, and it compiles.
  const ready = openExam && qs.length > 0 && qs.every((x) => x.status === "done" && x.review) && !!bench.validation?.ok;
  const ev = evaluation.evaluation;
  const running = evaluation.active;
  const busy = chat.pending || reviewing || scoring;
  const statusText = reviewing
    ? `El juez está revisando ${qs.length} respuestas expertas contra los criterios de evaluación…`
    : scoring
      ? `El juez está midiendo la calidad de ${qs.length} preguntas…`
    : ev?.state === "running"
      ? `Evaluando ${ev.models.length} ${ev.models.length === 1 ? "modelo" : "modelos"} sobre ${qs.length} preguntas… ${ev.models.filter((m) => m.state === "done" || m.state === "error").length}/${ev.models.length} terminados`
      : ev?.state === "reporting"
        ? "Evaluación terminada · el agente está redactando el informe…"
      : chat.pending
        ? "El agente está trabajando…"
        : openExam
          ? `${approved} de ${qs.length} preguntas aprobadas`
          : `${qs.length} filas en el examen`;

  return (
    <ExamLang.Provider value={exam.doc?.language ?? "es"}>
    <div className="ws">
      <WsHeader org={me?.org?.name} front={front} unread={unread} onFront={bringFront} />
      <main className="ws-canvas">
        <div className="ws-mswitch">
          <button className={front === "A" ? "on" : ""} onClick={() => bringFront("A")}>A · Interfaz</button>
          <button className={front === "B" ? "on" : ""} onClick={() => bringFront("B")}>
            B · Agente {unread ? `· ${unread}` : ""}
          </button>
        </div>

        <section className={`ws-win ws-a${front === "A" ? " front" : ""}${instant ? " instant" : ""}`} aria-label="A · Interfaz">
          {front === "B" && <button className="ws-win-back" onClick={() => bringFront("A")} aria-label="Traer la interfaz al frente" />}
          <div className="ws-toolbar">
            <span className="ws-tag">A</span>
            <span className="ws-crumb">
              <Link href="/app">{me?.org?.name ?? "benchmarks"}</Link> / <span title={exam.doc?.title}>{slug}</span>
            </span>
            {ready ? (
              <span className="ws-ver ok" title="Compila, y el juez revisó todas las preguntas y las aprobaste">
                ✓ EXAMEN LISTO
              </span>
            ) : (
              <ValidationBadge bench={bench} />
            )}
            <nav aria-label="Etapas" className="ws-stages">
              {STAGES.map(([k, num, label]) => (
                <button key={k} className={stage === k ? "on" : ""} onClick={() => go(k)}>
                  <span className="n">{num}</span>
                  {label}
                </button>
              ))}
            </nav>
            <div className="ws-toolbar-right">
              <span className="ws-saved">{savedLabel(exam.save, exam.savedAt)}</span>
              {openExam && (
                <button className="ws-btn-line" onClick={() => setPapersOpen(true)} title={pendingPapers ? `${pendingPapers} pendiente(s) de validación` : undefined}>
                  <span className="mono amber">{papers.length}</span>Papers
                  {pendingPapers > 0 && <span className="ws-pend">{pendingPapers} pend.</span>}
                </button>
              )}
              {openExam && (
                <button className="ws-btn-line" onClick={() => setRubricOpen(true)}>
                  <span className="mono amber">{exam.criteria!.length}</span>Criterios
                </button>
              )}
              <button
                className="ws-btn-dark"
                disabled={!bench.validation?.ok || running || reviewing || (openExam && qs.length === 0)}
                onClick={requestRun}
              >
                {ev?.state === "reporting" ? "Redactando informe…" : running ? "Evaluando…" : "Ejecutar evaluación"}
                <span className="amber">→</span>
              </button>
            </div>
          </div>

          {exam.error && (
            <p className="ws-alert" role="alert">
              {exam.error}
              <button onClick={() => exam.setError(null)} aria-label="Cerrar">✕</button>
            </p>
          )}

          <div className="ws-stage">
            {exam.loading ? (
              <p className="ws-note ws-pad">Cargando el examen…</p>
            ) : stage === "fuentes" ? (
              <SourcesStage
                bench={slug}
                list={papers}
                onChanged={(change) => {
                  pushEvent({ who: "Vos", path: "papers", change, open: () => go("fuentes") });
                  void exam.reload();
                }}
              />
            ) : stage === "autoria" ? (
              <Authoring
                exam={exam}
                author={me?.user.name?.trim() || me?.user.email || "vos"}
                slug={slug}
                openExam={openExam}
                q={q}
                qIndex={qIndex}
                setQIndex={setQIndex}
                locked={generating !== null || drafting}
                reading={pendingSources.filter((p) => p.bench === slug).length}
                generating={generating}
                scoring={scoring}
                pushEvent={pushEvent}
                onQuality={async () => {
                  setScoring(true);
                  try {
                    const r = await api.quality(bench.yamlPath);
                    if (!r.ok) exam.setError(`La calidad no pudo medirse: ${r.error.code} · ${r.error.message}`);
                    else pushEvent({ who: "Juez", path: "quality.json", change: `${qs.length} preguntas medidas`, open: () => go("autoria") });
                  } catch (err) {
                    exam.setError(errorText(err));
                  } finally {
                    setScoring(false);
                    await exam.reload();
                  }
                }}
                onRubric={() => setRubricOpen(true)}
                papers={papers}
                validPapers={validPapers}
                onPapers={() => setPapersOpen(true)}
                onDelete={deleteQuestion}
                onBatch={async (n) => {
                  setGenerating(n);
                  const before = qs.length;
                  await ask(batchPrompt(n, slug, validPapers.map((s) => s.id)));
                  setGenerating(null);
                  setQIndex(before);
                }}
                onDraft={(question) => {
                  setDrafting(true);
                  void ask(
                    `Escribí un borrador para la pregunta ${question.num} del examen (fila ${question.index + 1} de exam.jsonl)${question.text ? `: «${question.text}»` : ""}. Completá la pregunta y la respuesta experta, y en questions.json el porqué y las fuentes, con status draft.`,
                  ).finally(() => setDrafting(false));
                }}
              />
            ) : stage === "revision" ? (
              <ReviewStage
                exam={exam}
                openExam={openExam}
                busy={reviewing}
                ready={ready}
                onNext={() => go("evaluacion")}
                onReview={async () => {
                  setReviewing(true);
                  try {
                    const r = await api.review(bench.yamlPath);
                    if (!r.ok) exam.setError(`La revisión no pudo correr: ${r.error.code} · ${r.error.message}`);
                    else pushEvent({ who: "Juez", path: "review.json", change: `${qs.length} respuestas revisadas`, open: () => go("revision") });
                  } catch (err) {
                    exam.setError(errorText(err));
                  } finally {
                    setReviewing(false);
                    await exam.reload();
                  }
                }}
                onApprove={(question) => {
                  const meta = [...exam.meta];
                  const who = me?.user.name?.trim() || me?.user.email || "vos";
                  meta[question.index] = { ...meta[question.index], status: "approved", approved_by: who, approved_at: new Date().toISOString() };
                  exam.updateMeta(meta);
                  void api.logActivity(slug, "approve", `aprobó la pregunta ${question.num}`);
                  pushEvent({ who: "Vos", path: `${question.num}.revisión`, change: "por aprobar → aprobada", open: () => go("revision") });
                }}
                onOpen={(question) => {
                  setQIndex(question.index);
                  go("autoria");
                }}
                onDelete={deleteQuestion}
              />
            ) : stage === "evaluacion" ? (
              <EvaluationStage
                bench={bench}
                evaluation={evaluation}
                runRequest={runRequest}
                unapproved={openExam ? qs.length - approved : 0}
                onReview={() => go("revision")}
              />
            ) : (
              <PublicationStage bench={bench} exam={exam} openExam={openExam} go={go} ask={ask} showAgent={() => bringFront("B")} busy={busy} evaluation={evaluation} />
            )}

            {openExam && (
              <PapersDrawer
                open={papersOpen}
                onClose={() => setPapersOpen(false)}
                bench={slug}
                list={papers}
                reading={pendingSources.filter((p) => p.bench === slug)}
                locked={false}
                checklist={checklist}
                validations={validations}
                onValidation={(v) => setValidations((all) => ({ ...all, [v.sourceId]: v }))}
                onChecklist={setChecklist}
                onChange={(change) => {
                  pushEvent({ who: "Vos", path: "papers", change, open: () => setPapersOpen(true) });
                  void exam.reload();
                  void reloadValidation();
                }}
              />
            )}

            {openExam && (
              <RubricDrawer
                open={rubricOpen}
                onClose={() => setRubricOpen(false)}
                criteria={exam.criteria!}
                total={qs.length}
                locked={false}
                onChange={(c, patch, label) => {
                  void exam.saveYaml(setCriterion(exam.yamlText, c.key, patch));
                  pushEvent({ who: "Vos", path: `criterios.${c.key}.${label}`, change: "editado → guardado", open: () => setRubricOpen(true) });
                }}
                onAdd={(description, weight) => {
                  void exam.saveYaml(addCriterion(exam.yamlText, description, weight));
                  pushEvent({ who: "Vos", path: "criterios", change: "criterio agregado", open: () => setRubricOpen(true) });
                }}
                onRemove={(c) => {
                  void exam.saveYaml(removeCriterion(exam.yamlText, c.key));
                  pushEvent({ who: "Vos", path: `criterios.${c.key}`, change: "criterio quitado", open: () => setRubricOpen(true) });
                }}
                library={savedCriteria}
                onAddFromLibrary={(item) => {
                  void exam.saveYaml(addCriterion(exam.yamlText, item.description, item.weight, item.levels));
                  pushEvent({ who: "Vos", path: "criterios", change: `criterio «${item.name}» de la biblioteca`, open: () => setRubricOpen(true) });
                }}
                onSaveToLibrary={(c) => {
                  void api
                    .saveCriterion({
                      name: c.description.length > 48 ? c.description.slice(0, 46).trimEnd() + "…" : c.description,
                      description: c.description,
                      weight: c.weight,
                      levels: Object.fromEntries(c.levels.map((g) => [String(g), g === 0 ? "No lo cumple" : "Lo cumple"])),
                    })
                    .then((r) => setSavedCriteria((list) => [...list, r.criterion]))
                    .catch(() => {});
                }}
              />
            )}
          </div>

          <footer className="ws-status">
            <span className="mono amber">{busy || running ? "[···]" : "[·]"}</span>
            <span className="txt">{statusText}</span>
            {openExam && (
              <>
                <span className="ws-prog"><span style={{ transform: `scaleX(${approved / Math.max(qs.length, 1)})` }} /></span>
                <span className="mono muted">{approved} / {qs.length} listas</span>
              </>
            )}
            <span className="ws-engine">
              {exam.doc?.grader ? `juez · ${exam.doc.grader} · ` : ""}
              {bench.validation ? <span className="ok">● motor conectado</span> : <span className="muted">● motor sin respuesta</span>}
            </span>
          </footer>
        </section>

        <AgentWindow
          front={front}
          instant={instant}
          unread={unread}
          onFront={bringFront}
          chat={chat}
          events={events}
          ask={ask}
          openExam={openExam}
          onRun={requestRun}
          generatePrompt={validPapers.length > 0 ? batchPrompt(5, slug, validPapers.map((s) => s.id)) : null}
        />
      </main>
    </div>
    </ExamLang.Provider>
  );
}

function savedLabel(state: string, at: number | null): string {
  if (state === "saving") return "guardando…";
  if (state === "error") return "sin guardar";
  if (!at) return "";
  const s = (Date.now() - at) / 1000;
  return s < 60 ? "guardado recién" : `guardado hace ${Math.round(s / 60)} min`;
}

function WsHeader({ org, front, unread, onFront }: { org?: string; front: "A" | "B"; unread: number; onFront: (f: "A" | "B") => void }) {
  return (
    <header className="ws-head">
      <Link href="/app" className="ws-lockup" aria-label="benchy agent">
        <img src="/brand/pip-mark.svg" alt="" />
        <span className="name">benchy</span>
        <span className="suffix">agent</span>
      </Link>
      {org && <span className="ws-org">{org}</span>}
      <div className="ws-head-right">
        <div role="group" aria-label="Ventana al frente" className="ws-seg">
          <button aria-pressed={front === "A"} className={front === "A" ? "on" : ""} onClick={() => onFront("A")}>
            <span className="k">A</span>Interfaz
          </button>
          <button aria-pressed={front === "B"} className={front === "B" ? "on" : ""} onClick={() => onFront("B")}>
            <span className="k b">B</span>Agente
            {unread > 0 && <span className="ws-unread">{unread}</span>}
          </button>
        </div>
        <span className="ws-kbd">⌘J</span>
      </div>
    </header>
  );
}

function ValidationBadge({ bench }: { bench: BenchSummary }) {
  const v = bench.validation;
  if (!v) return <span className="ws-ver">SIN VALIDAR</span>;
  if (v.ok) return <span className="ws-ver ok">✓ VÁLIDO</span>;
  return (
    <span className="ws-ver err" title={v.error.message}>
      ✕ {v.error.code}
    </span>
  );
}

// ---- 02 · Autoría ---------------------------------------------------------------

function Authoring({
  exam,
  author,
  slug,
  openExam,
  q,
  qIndex,
  setQIndex,
  locked,
  reading,
  generating,
  scoring,
  pushEvent,
  onQuality,
  onRubric,
  papers,
  validPapers,
  onPapers,
  onBatch,
  onDraft,
  onDelete,
}: {
  exam: ExamState;
  /** The researcher's name, recorded as who wrote a question. */
  author: string;
  /** The benchmark's folder: semantic search runs over its papers and exam. */
  slug: string;
  openExam: boolean;
  q: Question | undefined;
  qIndex: number;
  setQIndex: (i: number) => void;
  locked: boolean;
  /** Papers of this benchmark still being read. */
  reading: number;
  generating: number | null;
  /** The judge is scoring the questions' quality right now. */
  scoring: boolean;
  pushEvent: (e: Omit<Event, "id" | "at">) => void;
  onQuality: () => void;
  onRubric: () => void;
  papers: Source[];
  /** The papers whose validation passed: the only ones the agent may write from. */
  validPapers: Source[];
  onPapers: () => void;
  onBatch: (n: number) => void;
  onDraft: (q: Question) => void;
  onDelete: (q: Question) => void;
}) {
  const [search, setSearch] = useState("");
  // Semantic search over the benchmark's papers and exam questions: its own
  // input, its own results (the text filter above only narrows the list).
  const [semQuery, setSemQuery] = useState("");
  const [semBusy, setSemBusy] = useState(false);
  const [semResults, setSemResults] = useState<SearchHit[] | null>(null);
  const [filter, setFilter] = useState<"all" | "pend" | "issues">("all");
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchN, setBatchN] = useState(5);
  // Papers waiting for the org's checklist: they stay out of generation.
  const pendingCount = papers.length - validPapers.length;
  const [writing, setWriting] = useState<number | null>(null);
  // Right-click on a question offers to delete it: the row becomes the confirmation.
  const [askDelete, setAskDelete] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const qs = exam.questions;

  const term = search.trim().toLowerCase();
  const visible = qs.filter(
    (x) => (filter === "all" || (filter === "pend" ? isPending(x) : hasIssue(x))) && (!term || x.text.toLowerCase().includes(term)),
  );
  const groups = groupsOf(visible);

  useEffect(() => {
    if (generating === null) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [generating]);

  const edit = (field: "text" | "answer" | "why", value: string) => {
    if (!q) return;
    const rows = [...exam.rows];
    const meta = [...exam.meta];
    while (meta.length < rows.length) meta.push({});
    const row = rows[q.index];
    if ("raw" in row) return;
    if (field === "text") rows[q.index] = { ...row, input: { ...row.input, question: value } };
    if (field === "answer") rows[q.index] = { ...row, expected: { ...row.expected, answer: value } };
    const m = { ...meta[q.index] };
    if (field === "why") m.why = value;
    // An edited question goes back to review.
    else if (m.status === "approved") m.status = "draft";
    meta[q.index] = m;
    // The "why" lives only in questions.json: leave the exam file untouched.
    if (field === "why") exam.updateMeta(meta);
    else exam.update(rows, meta);
    const label = { text: "pregunta", answer: "respuesta_experta", why: "por_qué" }[field];
    pushEvent({ who: "Vos", path: `${q.num}.${label}`, change: "editado → guardado", open: () => setQIndex(q.index) });
  };

  const setSources = (list: string[]) => {
    if (!q) return;
    const meta = [...exam.meta];
    while (meta.length < exam.rows.length) meta.push({});
    meta[q.index] = { ...meta[q.index], sources: list };
    // Notes only: the exam file and the approval stay as they are.
    exam.updateMeta(meta);
    pushEvent({ who: "Vos", path: `${q.num}.fuentes`, change: "editado → guardado", open: () => setQIndex(q.index) });
  };

  const addQuestion = () => {
    const rows = [...exam.rows, { input: { question: "" }, expected: { answer: "" } }];
    const meta = [...exam.meta];
    while (meta.length < rows.length - 1) meta.push({});
    meta.push({ status: "draft", by: author, group: q?.meta.group });
    exam.update(rows, meta);
    setQIndex(rows.length - 1);
    setWriting(rows.length - 1);
    setFilter("all");
    setSearch("");
  };

  // Ask the agent to embed the benchmark's papers and questions and rank them
  // against the query; an exam hit opens that question.
  const runSemantic = async () => {
    const term = semQuery.trim();
    if (!term || semBusy) return;
    setSemBusy(true);
    try {
      const r = await api.search(slug, term);
      if (!r.ok) setSemResults([]);
      else setSemResults(r.results);
    } catch (err) {
      setSemResults([]);
      exam.setError(errorText(err));
    } finally {
      setSemBusy(false);
    }
  };

  const openHit = (hit: SearchHit) => {
    const m = /^exam:(\d+)$/.exec(hit.id);
    if (m) setQIndex(Number(m[1]));
  };

  return (
    <div className="ws-aut">
      <aside className="ws-qlist" aria-label="Preguntas">
        <div className="ws-qlist-head">
          <div className="ws-eyebrow-row">
            <span>Preguntas</span>
            <span>{qs.length}</span>
          </div>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar pregunta…" aria-label="Buscar pregunta" spellCheck={false} />
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              void runSemantic();
            }}
          >
            <input
              type="search"
              value={semQuery}
              onChange={(e) => setSemQuery(e.target.value)}
              placeholder="Buscar en el examen y sus fuentes…"
              aria-label="Buscar en el examen y sus fuentes"
              spellCheck={false}
            />
          </form>
          {openExam && (
          <div role="group" aria-label="Filtrar" className="ws-pills">
            {(
              [
                ["all", "Todas", qs.length],
                ["pend", "Por revisar", qs.filter(isPending).length],
                ["issues", "Con problemas", qs.filter(hasIssue).length],
              ] as const
            ).map(([k, label, n]) => (
              <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
                {label}
                <span className="c">{n}</span>
              </button>
            ))}
          </div>
          )}
        </div>
        <div className="ws-qlist-body" ref={listRef}>
          {semResults !== null && (
            <div className="ws-sem">
              <p className="ws-group">{semBusy ? "buscando…" : `semántico · ${semResults.length}`}</p>
              {semResults.map((hit) => (
                <button key={hit.id} className="ws-semrow" onClick={() => openHit(hit)} disabled={!hit.id.startsWith("exam:")}>
                  <span className="s">{hit.score.toFixed(2)}</span>
                  <span className="t">{hit.title ?? (hit.id.startsWith("exam:") ? `pregunta ${Number(hit.id.slice(5)) + 1}` : hit.id)}</span>
                </button>
              ))}
            </div>
          )}
          {groups.map((g) => (
            <div key={g.title}>
              <p className="ws-group">
                <span>{g.title}</span>
                <span>{g.items.length}</span>
              </p>
              {g.items.map((x) =>
                askDelete === x.index ? (
                  <div key={x.index} className="ws-qrow-ask">
                    <DeleteConfirm
                      num={x.num}
                      locked={locked}
                      onDelete={() => {
                        setAskDelete(null);
                        onDelete(x);
                      }}
                      onCancel={() => setAskDelete(null)}
                    />
                  </div>
                ) : (
                  <ContextMenu key={x.index}>
                    <ContextMenuTrigger asChild>
                      <button
                        className={`ws-qrow${x.index === q?.index ? " on" : ""}${x.status === "attention" || x.status === "new" ? " warm" : ""}`}
                        onClick={() => setQIndex(x.index)}
                        onContextMenu={() => setQIndex(x.index)}
                      >
                        {/* Closed-answer exams have no approval flow: no status to show. */}
                        <span className={`br ${openExam ? BRACKET[x.status][1] : "none"}`}>{openExam ? BRACKET[x.status][0] : "[·]"}</span>
                        <span className="t">{titleOf(x)}</span>
                        {x.quality?.score !== undefined && <span className="q" title={`Calidad de la pregunta: ${x.quality.score}`}>Q{trimScore(x.quality.score)}</span>}
                        {x.qualityStale && <span className="q stale" title="La pregunta cambió desde la última medición">Q?</span>}
                        <span className="n">{x.num}</span>
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem className="text-destructive" disabled={locked} onSelect={() => setAskDelete(x.index)}>
                        Borrar pregunta…
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ),
              )}
            </div>
          ))}
          {generating !== null && (
            <div className="ws-gen">
              <p className="ws-group amber">generando {generating}</p>
              {Array.from({ length: generating }, (_, i) => (
                <div key={i} className="ws-skel" style={{ animationDelay: `${i * 80}ms` }} />
              ))}
            </div>
          )}
          {groups.length === 0 && generating === null && (
            <p className="ws-note" style={{ margin: "16px 8px" }}>
              {qs.length ? "Ninguna pregunta coincide." : "Todavía no hay preguntas."}
            </p>
          )}
        </div>

        {batchOpen && (
          <div className="ws-batch" role="dialog" aria-label="Nuevo lote de preguntas">
            <p className="h">
              Nuevo lote <span>· el agente las redacta con su respuesta experta</span>
            </p>
            <div className="ws-batch-grid">
              <label>
                Cantidad
                <div className="ws-pills">
                  {[5, 10, 20].map((n) => (
                    <button key={n} className={batchN === n ? "on" : ""} onClick={() => setBatchN(n)}>
                      {n}
                    </button>
                  ))}
                </div>
              </label>
              {validPapers.length > 0 && (
                <label>
                  Fuente
                  <span className="ws-batch-src">
                    {validPapers.length === 1 ? "El paper validado del benchmark" : `Los ${validPapers.length} papers validados del benchmark`}
                  </span>
                </label>
              )}
            </div>
            {reading > 0 && (
              <p className="ws-batch-note">
                Todavía se está leyendo {reading === 1 ? "1 paper" : `${reading} papers`}: el lote usa los que ya están listos. Esperá unos segundos si
                querés incluirlo.
              </p>
            )}
            {pendingCount > 0 && (
              <p className="ws-batch-note">
                {pendingCount === 1 ? "1 paper está pendiente de validación" : `${pendingCount} papers están pendientes de validación`}: el lote usa
                solo los validados.{" "}
                <button
                  className="ws-link"
                  onClick={() => {
                    setBatchOpen(false);
                    onPapers();
                  }}
                >
                  Validarlos ↗
                </button>
              </p>
            )}
            {papers.length === 0 && (
              <p className="ws-batch-note">
                Sin papers no se genera el lote: el agente escribe solo desde los papers validados, con cita.{" "}
                <button
                  className="ws-link"
                  onClick={() => {
                    setBatchOpen(false);
                    onPapers();
                  }}
                >
                  Agregar papers ↗
                </button>
              </p>
            )}
            <div className="ws-batch-foot">
              <button
                className="ws-btn-dark sm"
                disabled={locked || !openExam || validPapers.length === 0}
                onClick={() => {
                  setBatchOpen(false);
                  onBatch(batchN);
                }}
              >
                Generar {batchN}
              </button>
              <button className="ws-btn-line sm" onClick={() => setBatchOpen(false)}>
                Cancelar
              </button>
            </div>
          </div>
        )}
        <div className="ws-qlist-foot">
          <button onClick={addQuestion} disabled={locked || !openExam}>
            <span className="ico dashed">+</span>Pregunta
          </button>
          <button className="warm" onClick={() => setBatchOpen((o) => !o)} disabled={!openExam}>
            <span className="ico amberbox">[·]</span>Nuevo lote
          </button>
          <button className="warm" onClick={() => void onQuality()} disabled={!openExam || scoring}>
            <span className="ico amberbox">{scoring ? "[···]" : "[Q]"}</span>{scoring ? "Midiendo calidad…" : "Verificar calidad"}
          </button>
        </div>
      </aside>

      <div className="ws-editor">
        {locked && (
          <p className="ws-locked" role="status">
            <span className="mono amber">[···]</span> El agente está escribiendo preguntas en este examen: los campos se habilitan apenas termina.
          </p>
        )}
        <select className="ws-qselect" value={q?.index ?? 0} onChange={(e) => setQIndex(Number(e.target.value))} aria-label="Pregunta">
          {qs.map((x) => (
            <option key={x.index} value={x.index}>
              {x.num} · {titleOf(x)}
            </option>
          ))}
        </select>
        {!openExam ? (
          <ClosedExamNote exam={exam} q={q} />
        ) : !q ? (
          papers.length === 0 ? (
            <EmptyCard
              title="Empezá por los papers"
              text="Agregá los papers de los que salen las preguntas, de la biblioteca de CONICET o subiendo el PDF. El agente los lee y escribe cada pregunta con su respuesta experta y la página que la respalda."
              onAgent={onPapers}
              agentLabel="Agregar papers"
              onSelf={addQuestion}
              locked={false}
            />
          ) : validPapers.length === 0 ? (
            <EmptyCard
              title="Papers pendientes de validación"
              text="Antes de que el agente escriba preguntas desde un paper, alguien de la organización tiene que validarlo con el checklist de Papers. Mientras tanto, podés escribir la primera pregunta vos."
              onAgent={onPapers}
              agentLabel="Validar papers"
              onSelf={addQuestion}
              locked={false}
            />
          ) : (
            <EmptyCard
              title="Todavía no hay preguntas"
              text={`El agente puede escribir un primer lote a partir de ${validPapers.length === 1 ? "tu paper validado" : `tus ${validPapers.length} papers validados`}, cada pregunta con su respuesta experta y la página que la respalda. O escribí la primera vos.`}
              onAgent={() => onBatch(5)}
              agentLabel="Pedile 5 preguntas al agente"
              onSelf={addQuestion}
              locked={locked}
            />
          )
        ) : q.status === "empty" && writing !== q.index ? (
          <EmptyCard
            title="Pregunta vacía"
            text="Escribila vos, pedile un borrador al agente o borrala si no la vas a usar."
            onAgent={() => onDraft(q)}
            agentLabel="Pedile un borrador al agente"
            onSelf={() => setWriting(q.index)}
            onDelete={() => onDelete(q)}
            locked={locked}
          />
        ) : (
          <QuestionEditor
            q={q}
            criteria={exam.criteria!}
            total={qs.length}
            locked={locked}
            edit={edit}
            setSources={setSources}
            onDelete={() => onDelete(q)}
            onRubric={onRubric}
            papers={papers}
          />
        )}
      </div>
    </div>
  );
}

function EmptyCard({
  title,
  text,
  onAgent,
  agentLabel,
  onSelf,
  onDelete,
  locked,
}: {
  title: string;
  text: string;
  onAgent: () => void;
  agentLabel: string;
  onSelf: () => void;
  /** An empty question can go: nothing in it is lost. */
  onDelete?: () => void;
  locked: boolean;
}) {
  return (
    <div className="ws-empty">
      <p className="t">{title}</p>
      <p className="d">{text}</p>
      <div className="b">
        <button className="ws-btn-dark sm" onClick={onAgent} disabled={locked}>
          {agentLabel}
        </button>
        <button className="ws-btn-line sm" onClick={onSelf} disabled={locked}>
          Escribirla yo
        </button>
        {onDelete && (
          <button className="ws-btn-line sm" onClick={onDelete} disabled={locked}>
            Borrarla
          </button>
        )}
      </div>
    </div>
  );
}

function ClosedExamNote({ exam, q }: { exam: ExamState; q: Question | undefined }) {
  return (
    <div className="ws-closed">
      <p className="ws-note">
        Este benchmark es de respuesta cerrada ({exam.doc?.task ?? "sin tarea"}): cada campo se corrige por coincidencia exacta, sin
        criterios de evaluación. Lo podés leer acá; para cambiarlo, pedíselo al agente.
      </p>
      {q && (
        <div className="ws-twocol">
          <div className="ws-card ws-pad">
            <p className="ws-eyebrow">Entrada · fila {q.index + 1}</p>
            <pre className="ws-pre">{JSON.stringify((exam.rows[q.index] as { input?: unknown }).input ?? q.text, null, 2)}</pre>
          </div>
          <div className="ws-card ws-pad">
            <p className="ws-eyebrow">Respuesta esperada</p>
            <pre className="ws-pre">{JSON.stringify((exam.rows[q.index] as { expected?: unknown }).expected ?? "", null, 2)}</pre>
          </div>
        </div>
      )}
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
  const lang = useContext(ExamLang);
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

function Pips({ w }: { w: number }) {
  return (
    <span className="ws-pips" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= w ? "on" : ""} />
      ))}
    </span>
  );
}

function QuestionEditor({
  q,
  criteria,
  total,
  locked,
  edit,
  setSources,
  onDelete,
  onRubric,
  papers,
}: {
  q: Question;
  criteria: Criterion[];
  total: number;
  locked: boolean;
  edit: (field: "text" | "answer" | "why", value: string) => void;
  setSources: (list: string[]) => void;
  onDelete: () => void;
  onRubric: () => void;
  papers: Source[];
}) {
  const agent = byAgent(q.meta);
  const writer = !agent && q.meta.by && q.meta.by !== "vos" ? q.meta.by : null;
  return (
    <div className="ws-twocol">
      {/* The question and, right below it, its answer: read one, write the other. */}
      <div className="ws-col">
        <div className="ws-col-head">
          <span className="ws-eyebrow">Pregunta {q.num}</span>
          {[...new Set(q.meta.tags ?? [])].map((t) => (
            <span key={t} className="ws-chip">{t}</span>
          ))}
          {q.status === "new" && <span className="ws-flag amber">propuesta del agente · revisala</span>}
          {q.stale && <span className="ws-flag">editada · vuelve a revisión</span>}
          {q.status === "done" && (
            <span className="ws-flag ok" title={q.meta.approved_at ? new Date(q.meta.approved_at).toLocaleString("es-AR") : undefined}>
              ● aprobada{q.meta.approved_by ? ` por ${q.meta.approved_by}` : ""}
            </span>
          )}
          <DeleteQuestion num={q.num} locked={locked} onDelete={onDelete} />
        </div>
        <div className="ws-card ws-qcard">
          <AutoText className="big" value={q.text} onChange={(v) => edit("text", v)} label="Texto de la pregunta" disabled={locked} placeholder="Escribí la pregunta…" />
          <div className="ws-sep ws-answer">
            <p className="ws-eyebrow">Respuesta experta</p>
            <AutoText className="answer" value={q.answer} onChange={(v) => edit("answer", v)} label="Respuesta experta" disabled={locked} placeholder="La respuesta contra la que el juez compara…" />
          </div>
          <div className="ws-byline">
            <span className="av">{agent ? "[·]" : (writer ?? "Vos").slice(0, 1).toUpperCase()}</span>
            <span>{agent ? "Propuesta del agente" : writer ? `Escrita por ${writer}` : "Escrita en la interfaz"}</span>
          </div>
        </div>
      </div>

      {/* What the grader checks, why the question is asked, and where it comes from. */}
      <div className="ws-col">
        <div className="ws-col-head">
          <span className="ws-eyebrow">Criterios</span>
          <button className="ws-link push" onClick={onRubric}>
            {criteria.length} {criteria.length === 1 ? "criterio" : "criterios"} · configurar ↗
          </button>
        </div>
        <div className="ws-card ws-pad ws-rubric-mini">
          {criteria.map((c) => {
            const met = q.review ? criterionMet(q.review, c) : null;
            return (
              <div key={c.key} className="ws-crit">
                <span className="t">{c.description || c.key}</span>
                {met !== null && <span className={`ws-met ${met ? "ok" : "no"}`}>{met ? "sí" : "no"}</span>}
                <span className="w" title={`Importancia ${c.weight} de 5`}>
                  <Pips w={c.weight} />
                  <span className="s">{shareOf(c, criteria)}</span>
                </span>
              </div>
            );
          })}
          <p className="ws-engine-line">
            → en el motor: un campo answer juzgado con {criteria.length} criterios · pesos {criteria.map((c) => c.weight).join(" / ")} · {total} filas en exam.jsonl
          </p>
        </div>

        <div className="ws-col-head sub">
          <span className="ws-eyebrow">Calidad de la pregunta</span>
          {q.quality?.score !== undefined && (
            <span className={`ws-qscore${(q.quality.missed?.length ?? 0) > 0 ? " amber" : " ok"}`}>Q{trimScore(q.quality.score)}</span>
          )}
        </div>
        <div className="ws-card ws-pad ws-quality">
          {q.qualityStale ? (
            <p className="ws-note">La pregunta cambió desde la última medición: volvé a verificarla con «Verificar calidad».</p>
          ) : q.quality?.error ? (
            <p className="ws-note">El juez no pudo medir esta pregunta: {q.quality.error.message}</p>
          ) : q.quality ? (
            <>
              {QUALITY_CRITERIA.map((name) => {
                const c = q.quality!.criteria?.[name];
                return (
                  <div key={name} className="ws-qcrit">
                    <span className="t">{name}</span>
                    {c && <span className={`ws-met ${c.grade > 0 ? "ok" : "no"}`}>{c.grade > 0 ? "sí" : "no"}</span>}
                    {c && <p className="ws-qjust">{c.justification}</p>}
                  </div>
                );
              })}
              <p className="ws-engine-line">→ el juez puntúa la pregunta en 4 criterios fijos · la nota informa: aprobarla sigue siendo tu decisión</p>
            </>
          ) : (
            <p className="ws-note">Todavía no la midió el juez. «Verificar calidad» la puntúa en {QUALITY_CRITERIA.join(", ")}.</p>
          )}
        </div>

        <div className="ws-col-head sub">
          <span className="ws-eyebrow">Por qué esta pregunta</span>
        </div>
        <div className="ws-card ws-pad">
          <AutoText className="soft" value={q.meta.why ?? ""} onChange={(v) => edit("why", v)} label="Por qué esta pregunta" disabled={locked} placeholder="Qué error de los modelos busca exponer…" />
        </div>

        <div className="ws-col-head sub">
          <span className="ws-eyebrow">Fuentes</span>
        </div>
        <div className="ws-card ws-pad">
          <SourcesEditor sources={q.meta.sources ?? []} papers={papers} locked={locked} onChange={setSources} />
        </div>
      </div>
    </div>
  );
}

/** Inline "are you sure" for a question delete: Borrar / Cancelar. */
function DeleteConfirm({ num, locked, onDelete, onCancel, className = "" }: { num: string; locked?: boolean; onDelete: () => void; onCancel: () => void; className?: string }) {
  return (
    <span className={`ws-del-ask${className ? ` ${className}` : ""}`} role="group" aria-label={`Borrar la pregunta ${num}`}>
      <span>¿Borrar la pregunta {num}? No se puede deshacer.</span>
      <button className="ws-btn-danger sm" disabled={locked} onClick={onDelete}>
        Borrar
      </button>
      <button className="ws-btn-line sm" onClick={onCancel}>
        Cancelar
      </button>
    </span>
  );
}

/** Delete a question, after a second click that says what goes. */
function DeleteQuestion({ num, locked, onDelete, button = false }: { num: string; locked: boolean; onDelete: () => void; button?: boolean }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => setAsking(false), [num]);
  if (asking) {
    return <DeleteConfirm num={num} locked={locked} onDelete={onDelete} onCancel={() => setAsking(false)} className={button ? "btn" : ""} />;
  }
  return (
    <button className={button ? "ws-btn-line sm ws-del" : "ws-link ws-del push"} disabled={locked} onClick={() => setAsking(true)}>
      Borrar pregunta
    </button>
  );
}

/** One citation: a paper of the benchmark (with its page) or any other reference. */
function SourceLine({ text, papers, onRemove }: { text: string; papers: Source[]; onRemove?: () => void }) {
  const cited = citation(text, papers);
  const remove = onRemove && (
    <button className="x" onClick={onRemove} aria-label={`Quitar la fuente ${cited?.source.title ?? text}`} title="Quitar">
      ×
    </button>
  );
  if (cited) {
    const href = cited.source.pdf_url ?? cited.source.url;
    return (
      <div className="ws-source">
        <span className="tag doi">PAPER</span>
        {href ? (
          <a className="t" href={href} target="_blank" rel="noreferrer" title={cited.source.title}>
            {cited.source.title}
          </a>
        ) : (
          <span className="t">{cited.source.title}</span>
        )}
        {cited.page && <span className="pg">p. {cited.page}</span>}
        {remove}
      </div>
    );
  }
  const doi = /^10\.\d+\//.test(text) || /doi/i.test(text);
  return (
    <div className="ws-source">
      <span className={`tag ${doi ? "doi" : ""}`}>{doi ? "DOI" : "REF"}</span>
      <span className="t" title={text}>
        {text}
      </span>
      {remove}
    </div>
  );
}

/** A question's citations, added and removed by hand: a paper and page, or any reference. */
function SourcesEditor({ sources, papers, locked, onChange }: { sources: string[]; papers: Source[]; locked: boolean; onChange: (list: string[]) => void }) {
  const [pick, setPick] = useState<string>(papers[0]?.id ?? "otra");
  const [page, setPage] = useState("");
  const [ref, setRef] = useState("");
  useEffect(() => {
    if (pick !== "otra" && !papers.some((p) => p.id === pick)) setPick(papers[0]?.id ?? "otra");
  }, [papers, pick]);
  const next = pick === "otra" ? ref.trim() : `${pick}${page ? ` p. ${page}` : ""}`;
  const add = () => {
    if (!next || sources.includes(next)) return;
    onChange([...sources, next]);
    setPage("");
    setRef("");
  };
  return (
    <div className="ws-srcs">
      {sources.length ? (
        <div className="ws-sources">
          {sources.map((s, i) => (
            <SourceLine key={`${i}-${s}`} text={s} papers={papers} onRemove={locked ? undefined : () => onChange(sources.filter((_, j) => j !== i))} />
          ))}
        </div>
      ) : (
        <p className="ws-note">{papers.length ? "Sin fuentes todavía: elegí el paper y la página." : "Sin fuentes todavía. Agregá papers al benchmark o anotá otra referencia."}</p>
      )}
      <form
        className="ws-src-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Fuente" disabled={locked}>
          {papers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title.length > 60 ? p.title.slice(0, 58).trimEnd() + "…" : p.title}
            </option>
          ))}
          <option value="otra">Otra referencia (DOI, libro, URL)</option>
        </select>
        {pick === "otra" ? (
          <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="10.1234/… o autor, título, año" aria-label="Referencia" disabled={locked} spellCheck={false} />
        ) : (
          <input
            className="pg"
            value={page}
            onChange={(e) => setPage(e.target.value.replace(/[^\d–-]/g, ""))}
            inputMode="numeric"
            placeholder="pág."
            aria-label="Página"
            disabled={locked}
          />
        )}
        <button type="submit" className="ws-btn-line sm" disabled={locked || !next || sources.includes(next)}>
          Agregar
        </button>
      </form>
    </div>
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

function RubricDrawer({
  open,
  onClose,
  criteria,
  total,
  locked,
  onChange,
  onAdd,
  onRemove,
  library,
  onAddFromLibrary,
  onSaveToLibrary,
}: {
  open: boolean;
  onClose: () => void;
  criteria: Criterion[];
  total: number;
  locked: boolean;
  onChange: (c: Criterion, patch: { weight?: number; description?: string }, label: string) => void;
  onAdd: (description: string, weight: number) => void;
  onRemove: (c: Criterion) => void;
  library: LibraryCriterion[];
  onAddFromLibrary: (item: LibraryCriterion) => void;
  onSaveToLibrary: (c: Criterion) => void;
}) {
  // The criteria this drawer added but the org has not saved to the library yet.
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState("");
  const [newWeight, setNewWeight] = useState(3);
  useEffect(() => {
    if (!open) return;
    setDrafts({});
    setRemoving(null);
    setAdding(false);
    setNewText("");
    setNewWeight(3);
    setAddedKeys(new Set());
    setSavedKeys(new Set());
  }, [open]);
  const full = criteria.length >= MAX_CRITERIA;
  return (
    <>
      <div className={`ws-drawer-overlay${open ? " open" : ""}`} onClick={onClose} />
      <aside className={`ws-drawer${open ? " open" : ""}`} role="dialog" aria-label="Criterios de evaluación" aria-hidden={!open}>
        <div className="ws-drawer-head">
          <span className="t">Criterios de evaluación</span>
          <span className="mono muted">
            {criteria.length} de {MAX_CRITERIA} criterios
          </span>
          <button onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        <div className="ws-drawer-body">
          <p className="ws-note">
            Cada criterio se aplica a las {total} preguntas: el juez compara cada respuesta con la respuesta experta y decide si lo cumple. Podés
            tener hasta {MAX_CRITERIA} criterios, cada uno con una importancia de 1 a 5.
          </p>
          {criteria.map((c, i) => (
            <div key={c.key} className="ws-crit-card">
              <div className="row">
                <span className="mono muted">{String(i + 1).padStart(2, "0")}</span>
                <span className="lbl">Importancia</span>
                <WeightScale value={c.weight} label={`Importancia del criterio ${i + 1}`} disabled={locked} onPick={(n) => onChange(c, { weight: n }, "importancia")} />
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
                  <button className="ws-btn-dark sm" disabled={locked || !drafts[c.key].trim()} onClick={() => onChange(c, { description: drafts[c.key].trim() }, "texto")}>
                    Guardar criterio
                  </button>
                  <button className="ws-btn-line sm" onClick={() => setDrafts((d) => ({ ...d, [c.key]: c.description }))}>
                    Deshacer
                  </button>
                </div>
              ) : removing === c.key ? (
                <div className="ws-crit-save">
                  <span className="ws-note">¿Quitar este criterio?</span>
                  <button
                    className="ws-btn-danger sm"
                    disabled={locked}
                    onClick={() => {
                      setRemoving(null);
                      onRemove(c);
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
                    <button
                      className="ws-link"
                      disabled={locked}
                      onClick={() => {
                        onSaveToLibrary(c);
                        setSavedKeys((k) => new Set(k).add(c.key));
                      }}
                    >
                      Guardar en la biblioteca
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {library.length > 0 && (
            <div className="ws-crit-library">
              <button className="ws-crit-library-head" onClick={() => setLibraryOpen((o) => !o)} aria-expanded={libraryOpen}>
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
                      onClick={() => onAddFromLibrary(item)}
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
                    onAdd(newText.trim(), newWeight);
                    // The drawer adds the new criterion as the next c<n>; the
                    // card that appears carries the same key, read off the
                    // same rule exam-model's addCriterion uses.
                    setAddedKeys((k) => new Set(k).add(nextCriterionKey(criteria)));
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
          <p className="ws-note">Si agregás, quitás o reescribís un criterio, el juez tiene que volver a revisar las respuestas expertas en Revisión.</p>
        </div>
        <p className="ws-drawer-foot">→ en el motor: scoring.field_metrics.answer · rubric · pesos {criteria.map((c) => c.weight).join(" / ")}</p>
      </aside>
    </>
  );
}

/** The key exam-model's addCriterion gives to the next criterion added to this list. */
function nextCriterionKey(criteria: Criterion[]): string {
  const top = Math.max(0, ...criteria.map((c) => Number(/^c(\d+)$/.exec(c.key)?.[1] ?? 0)));
  let n = top + 1;
  while (criteria.some((c) => c.key === `c${n}`)) n++;
  return `c${n}`;
}

const MAX_UPLOAD = 24 * 1024 * 1024;

/** One source's validation under the org's checklist: "Validada ✓" (with who
 *  and when, when there's a row), or "Pendiente de validación" with the items
 *  to tick. A source without a row predates the feature and shows as validated. */
function ValidationRow({
  source,
  checklist,
  v,
  ticking,
  onTick,
}: {
  source: Source;
  checklist: ChecklistItem[] | null;
  v: SourceValidation | undefined;
  ticking: string | null;
  onTick: (s: Source, itemId: string, on: boolean) => void;
}) {
  if (sourceState(v) === "validated") {
    const when = v?.validatedAt ? new Date(v.validatedAt) : null;
    return (
      <p className="ws-val-line ok" title={v ? undefined : "Material anterior a la validación de fuentes: se toma como validado"}>
        ✓ Validada
        {v?.validatedByName ? ` por ${v.validatedByName}` : ""}
        {when ? ` · ${when.toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric" })}` : ""}
      </p>
    );
  }
  if (!checklist) return <p className="ws-val-line amber">Pendiente de validación</p>;
  return (
    <div className="ws-val-box">
      <p className="ws-val-line amber">
        Pendiente de validación · {v?.checked.length ?? 0}/{checklist.length} — hasta que pase el checklist el agente no la usa para generar
      </p>
      {checklist.map((item) => (
        <label key={item.id} className="ws-val-item">
          <input
            type="checkbox"
            checked={v?.checked.includes(item.id) ?? false}
            disabled={ticking === `${source.id}:${item.id}`}
            onChange={(e) => onTick(source, item.id, e.target.checked)}
          />
          <span>{item.label}</span>
        </label>
      ))}
    </div>
  );
}

/** The org's checklist of verifiables for new material: read view plus an edit
 *  mode (add/remove/rename items). Editing it never re-validates material that
 *  already passed. */
function ChecklistSection({ checklist, onChecklist }: { checklist: ChecklistItem[] | null; onChecklist: (items: ChecklistItem[]) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ChecklistItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (checklist === null) return null;

  const start = () => {
    setDraft(checklist.map((i) => ({ ...i })));
    setError(null);
    setEditing(true);
  };
  const save = async () => {
    if (draft.some((i) => !i.label.trim())) {
      setError("Completá todos los ítems o quitalos.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await validationApi.saveChecklist(draft.map((i) => ({ id: i.id, label: i.label })));
      onChecklist(r.items);
      setEditing(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ws-checklist">
      <p className="ws-eyebrow" style={{ marginTop: 10 }}>Checklist de validación</p>
      <p className="ws-note">Lo que tiene que cumplir un paper nuevo antes de que el agente escriba preguntas desde él. Cambiarlo no afecta lo ya validado.</p>
      {editing ? (
        <div className="ws-val-edit">
          {draft.map((item, i) => (
            <div key={i} className="ws-val-edit-row">
              <input
                value={item.label}
                aria-label={`Ítem ${i + 1}`}
                onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              />
              <button className="lib-btn-line sm" disabled={draft.length <= 1 || saving} onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}>
                Quitar
              </button>
            </div>
          ))}
          <div className="ws-val-edit-foot">
            <button
              className="lib-btn-line sm"
              disabled={draft.length >= 20 || saving}
              onClick={() => setDraft((d) => [...d, { id: `nuevo-${d.length}`, label: "" }])}
            >
              + Ítem
            </button>
            <button className="ws-btn-dark sm" disabled={saving} onClick={() => void save()}>
              {saving ? "Guardando…" : "Guardar checklist"}
            </button>
            <button className="ws-btn-line sm" disabled={saving} onClick={() => setEditing(false)}>
              Cancelar
            </button>
          </div>
          {error && <p className="lib-error">{error}</p>}
        </div>
      ) : (
        <>
          {checklist.map((item) => (
            <p key={item.id} className="ws-val-item-view">
              · {item.label}
            </p>
          ))}
          <button className="lib-btn-line sm" onClick={start}>
            Editar checklist
          </button>
        </>
      )}
    </div>
  );
}

type Upload = { name: string; state: "waiting" | "reading" | "ok" | "error"; note?: string };

/** The benchmark's papers: what the agent writes the questions from. */
function PapersDrawer({
  open,
  onClose,
  bench,
  list,
  reading,
  locked,
  checklist,
  validations,
  onValidation,
  onChecklist,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  bench: string;
  list: Source[];
  /** Papers being added right now, from here or from the library page. */
  reading: PendingSource[];
  locked: boolean;
  /** The org's checklist for validating new material (null while it loads). */
  checklist: ChecklistItem[] | null;
  /** This bench's per-source state; a source without a row counts as validated. */
  validations: Record<string, SourceValidation>;
  onValidation: (v: SourceValidation) => void;
  onChecklist: (items: ChecklistItem[]) => void;
  onChange: (change: string) => void;
}) {
  const { failedSources, dismissFailedSource } = usePlatform();
  const failed = failedSources.filter((p) => p.bench === bench);
  const [tab, setTab] = useState<"library" | "upload">("library");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [ticking, setTicking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const uploading = uploads.some((u) => u.state === "waiting" || u.state === "reading");

  // Ticking one checklist item of a pending source; the server answers the
  // source's state (validated once every item is ticked).
  const tick = async (s: Source, itemId: string, on: boolean) => {
    const v = validations[s.id];
    const checked = on ? [...(v?.checked ?? []), itemId] : (v?.checked ?? []).filter((id) => id !== itemId);
    setTicking(`${s.id}:${itemId}`);
    setError(null);
    // Optimistic: the row shows the tick right away; the server's answer wins.
    onValidation({ sourceId: s.id, checked, validatedAt: v?.validatedAt ?? null, validatedByName: v?.validatedByName ?? null });
    try {
      const r = await validationApi.setChecked(bench, s.id, checked);
      onValidation(r.validation);
    } catch (err) {
      setError(errorText(err));
      onValidation({ sourceId: s.id, checked: v?.checked ?? [], validatedAt: v?.validatedAt ?? null, validatedByName: v?.validatedByName ?? null });
    } finally {
      setTicking(null);
    }
  };

  const upload = async (files: File[]) => {
    const queue: Upload[] = files.map((f) => ({ name: f.name, state: "waiting" }));
    setUploads(queue);
    const set = (i: number, u: Partial<Upload>) => setUploads((all) => all.map((x, j) => (j === i ? { ...x, ...u } : x)));
    for (const [i, file] of files.entries()) {
      if (file.size > MAX_UPLOAD) {
        set(i, { state: "error", note: libraryErrorText("TOO_LARGE") });
        continue;
      }
      set(i, { state: "reading" });
      try {
        const r = await sourcesApi.upload(bench, file);
        if (r.ok) {
          set(i, { state: "ok", note: `${r.source.pages} páginas` });
          onChange(`+ ${r.source.title}`);
        } else set(i, { state: "error", note: libraryErrorText(r.error.code) });
      } catch (err) {
        set(i, { state: "error", note: err instanceof ApiError && !err.code.startsWith("AGENT") && err.code !== "NETWORK" ? libraryErrorText(err.code) : errorText(err) });
      }
    }
  };

  const remove = async (s: Source) => {
    setRemoving(s.id);
    setError(null);
    try {
      await sourcesApi.remove(bench, s.id);
      onChange(`− ${s.title}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <>
      <div className={`ws-drawer-overlay${open ? " open" : ""}`} onClick={onClose} />
      <aside className={`ws-drawer wide${open ? " open" : ""}`} role="dialog" aria-label="Papers del benchmark" aria-hidden={!open}>
        <div className="ws-drawer-head">
          <span className="t">Papers del benchmark</span>
          <span className="mono muted">
            {list.length === 1 ? "1 paper" : `${list.length} papers`}
            {reading.length ? ` · ${reading.length} leyéndose` : ""}
          </span>
          <button onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        <div className="ws-drawer-body">
          <p className="ws-note">
            Las preguntas salen de estos papers: el agente los lee y en cada pregunta cita el paper y la página. Si un paper no tiene PDF abierto,
            el agente solo tiene su resumen. Un paper nuevo entra pendiente de validación y el agente no lo usa hasta que pase el checklist.
          </p>
          <Link href={`/app/b/${encodeURIComponent(bench)}/fuentes`} className="ws-fuentes-link" onClick={onClose}>
            Abrir Fuentes → la bibliografía en pantalla completa
          </Link>
          <div className="lib ws-papers">
            {list.map((s) => (
              <div key={s.id} className="ws-val">
                <SourceRow
                  s={s}
                  action={
                    <button className="lib-btn-line sm" disabled={locked || removing !== null} onClick={() => void remove(s)}>
                      {removing === s.id ? "Quitando…" : "Quitar"}
                    </button>
                  }
                />
                <ValidationRow source={s} checklist={checklist} v={validations[s.id]} ticking={ticking} onTick={tick} />
              </div>
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
            {list.length === 0 && reading.length === 0 && <p className="ws-note muted">Todavía no hay papers en este benchmark.</p>}
            {error && <p className="lib-error">{error}</p>}
          </div>

          <ChecklistSection checklist={checklist} onChecklist={onChecklist} />

          <p className="ws-eyebrow" style={{ marginTop: 10 }}>Agregar papers</p>
          <div role="tablist" aria-label="De dónde" className="ws-pills">
            <button role="tab" aria-selected={tab === "library"} className={tab === "library" ? "on" : ""} onClick={() => setTab("library")}>
              Biblioteca CONICET
            </button>
            <button role="tab" aria-selected={tab === "upload"} className={tab === "upload" ? "on" : ""} onClick={() => setTab("upload")}>
              Subir PDF
            </button>
          </div>
          {tab === "library" ? (
            <LibraryBrowser bench={bench} inBench={list} disabled={locked} onAdded={(src) => onChange(`+ ${src.title}`)} />
          ) : (
            <div className="ws-upload">
              <label className={`ws-drop${locked || uploading ? " off" : ""}`}>
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  multiple
                  disabled={locked || uploading}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    if (files.length) void upload(files);
                  }}
                />
                <span className="t">Elegí uno o más PDFs</span>
                <span className="d">Hasta 24 MB cada uno. Se guarda el texto para el agente; un PDF escaneado sin texto no sirve.</span>
              </label>
              {uploads.map((u, i) => (
                <div key={i} className="ws-up-row">
                  <span className="n">{u.name}</span>
                  <span className={`s ${u.state}`}>
                    {u.state === "waiting" ? "en cola" : u.state === "reading" ? "leyendo…" : u.state === "ok" ? `✓ ${u.note}` : u.note}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <p className="ws-drawer-foot">→ en el workspace: {bench}/sources.json · el texto de cada paper en sources/</p>
      </aside>
    </>
  );
}

// ---- 03 · Revisión -------------------------------------------------------------

function ReviewStage({
  exam,
  openExam,
  busy,
  ready,
  onNext,
  onReview,
  onApprove,
  onOpen,
  onDelete,
}: {
  exam: ExamState;
  openExam: boolean;
  busy: boolean;
  ready: boolean;
  onNext: () => void;
  onReview: () => void;
  onApprove: (q: Question) => void;
  onOpen: (q: Question) => void;
  onDelete: (q: Question) => void;
}) {
  const [openRow, setOpenRow] = useState<number | null>(null);
  // Right-click on a question offers to delete it: the row shows the confirmation.
  const [askDelete, setAskDelete] = useState<number | null>(null);
  if (!openExam) {
    return <p className="ws-note ws-pad">La revisión por criterios de evaluación es para exámenes de preguntas abiertas. Este benchmark se corrige por coincidencia exacta.</p>;
  }
  const qs = exam.questions;
  const criteria = exam.criteria!;
  const reviewed = qs.filter((q) => q.review).length;
  const summary = `${qs.filter((q) => q.status === "done").length} aprobadas · ${qs.filter((q) => q.status === "progress" || q.status === "new").length} por aprobar · ${qs.filter((q) => q.status === "attention").length} con criterios sin cumplir`;
  return (
    <div className="ws-scroll ws-pad-lg">
      <div className="ws-narrow">
        <div className="ws-rev-head">
          <p className="ws-note">
            Antes de evaluar, el juez verifica que cada respuesta experta cumpla los {criteria.length} criterios de evaluación. Vos aprobás
            cada pregunta o la abrís en Autoría para corregirla.
          </p>
          <div className="r">
            <span className="mono muted">{summary}</span>
            <button className="ws-btn-dark sm" onClick={onReview} disabled={busy || qs.length === 0}>
              {reviewed ? "Volver a revisar" : "Revisar respuestas expertas"}
            </button>
          </div>
        </div>
        {exam.reviewOutdated && qs.length > 0 && (
          <p className="ws-note ws-outdated" role="status">
            Los criterios de evaluación cambiaron después de la última revisión del juez. Volvé a revisar para que cada respuesta experta quede verificada con los
            criterios de ahora.
          </p>
        )}
        {qs.length > 0 && qs.every((q) => q.status === "done") && qs.some((q) => !q.review) && !exam.reviewOutdated && (
          <p className="ws-note" style={{ margin: "0 0 10px" }}>
            Todas están aprobadas, pero {qs.filter((q) => !q.review).length === 1 ? "una no tiene" : "algunas no tienen"} la revisión del juez de su
            versión actual. Volvé a revisar para concretar el examen.
          </p>
        )}
        {ready && (
          <div className="ws-ready" role="status">
            <span className="mono ok">[✓]</span>
            <span>
              <strong>Examen listo.</strong> El juez revisó las {qs.length} preguntas y las aprobaste todas. El siguiente paso es elegir los modelos y evaluarlos.
            </span>
            <button className="ws-btn-dark sm" onClick={onNext}>
              Ir a Evaluación →
            </button>
          </div>
        )}
        {exam.review && (
          <p className="ws-note" style={{ margin: "0 0 10px" }}>
            Última revisión: {new Date(exam.review.created * 1000).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })} · juez{" "}
            <span className="mono">{exam.review.grader?.model ?? "—"}</span>
          </p>
        )}
        <div className="ws-card ws-clip">
          {qs.map((q) => {
            const open = openRow === q.index;
            const r = q.review;
            const missed = r ? criteria.filter((c) => criterionMet(r, c) === false).length : 0;
            const [label, tone] =
              q.status === "done"
                ? ["aprobada", "ok"]
                : q.status === "attention"
                  ? [r?.error ? "el juez falló" : `${missed} criterio${missed === 1 ? "" : "s"} sin cumplir`, "a"]
                  : q.status === "error"
                    ? ["sin respuesta experta", "err"]
                    : q.status === "empty"
                      ? ["vacía", "n"]
                      : [q.stale ? "editada · revisar" : r ? "por aprobar" : "sin revisar", "a"];
            // Approval comes after the grader's review of the question as it stands.
            const canApprove = (q.status === "progress" || q.status === "new") && !!q.review;
            return (
              <div key={q.index} className="ws-rev-row">
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <button className={`ws-rev-toggle${open ? " open" : ""}`} aria-expanded={open} onClick={() => setOpenRow(open ? null : q.index)}>
                  <span className="n">{q.num}</span>
                  <span className="t">{titleOf(q)}</span>
                  <span className="mini" title={r ? `${criteria.length - missed} de ${criteria.length} criterios cumplidos` : "sin verificar"}>
                    {criteria.map((c) => {
                      const met = r ? criterionMet(r, c) : null;
                      return <span key={c.key} className={met === null ? "" : met ? "ok" : "no"} />;
                    })}
                  </span>
                  <span className={`ws-state ${tone}`}>{label}</span>
                  <span className="chev" aria-hidden="true">›</span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem className="text-destructive" disabled={busy} onSelect={() => setAskDelete(q.index)}>
                      Borrar pregunta…
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
                {askDelete === q.index && (
                  <div className="ws-rev-ask">
                    <DeleteConfirm
                      num={q.num}
                      locked={busy}
                      onDelete={() => {
                        setAskDelete(null);
                        onDelete(q);
                      }}
                      onCancel={() => setAskDelete(null)}
                    />
                  </div>
                )}
                <div className={`ws-rev-panel${open ? " open" : ""}`}>
                  <div>
                    <div className="ws-rev-body">
                      {q.text && q.answer ? (
                        <>
                          <div className="ws-twocol tight">
                            <div>
                              <p className="ws-eyebrow">Pregunta</p>
                              <p className="clamp">{q.text}</p>
                            </div>
                            <div>
                              <p className="ws-eyebrow">Respuesta experta</p>
                              <p className="clamp soft">{q.answer}</p>
                            </div>
                          </div>
                          {r?.error ? (
                            <p className="ws-note">El juez no pudo calificar esta respuesta: {r.error.message}</p>
                          ) : (
                            <div className="ws-card ws-clip">
                              <div className="ws-rev-grid head">
                                <span>Criterio</span>
                                <span>Importancia</span>
                                <span className="right">¿La cumple?</span>
                              </div>
                              {criteria.map((c) => {
                                const met = r ? criterionMet(r, c) : null;
                                const why = r?.criteria?.[c.key]?.justification;
                                return (
                                  <div key={c.key} className={`ws-rev-grid${met === false ? " warm" : ""}`}>
                                    <span>
                                      <span className="ct">{c.description || c.key}</span>
                                      {met === false && why && <span className="note">{why}</span>}
                                    </span>
                                    <Pips w={c.weight} />
                                    <span className={`right mono ${met === null ? "muted" : met ? "ok" : "fail"}`}>{met === null ? "—" : met ? "sí" : "no"}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="ws-note">
                          {q.status === "empty" ? "Pregunta vacía: escribila en Autoría o borrala si no la vas a usar." : "Sin respuesta experta el juez no tiene contra qué comparar."}
                        </p>
                      )}
                      {!r && (q.status === "progress" || q.status === "new") && (
                        <p className="ws-note">Para aprobarla, primero la revisa el juez: «{reviewed ? "Volver a revisar" : "Revisar respuestas expertas"}».</p>
                      )}
                      <div className="ws-row-btns">
                        {canApprove && (
                          <button className="ws-btn-dark sm" onClick={() => onApprove(q)}>
                            Aprobar
                          </button>
                        )}
                        <button className="ws-btn-line sm" onClick={() => onOpen(q)}>
                          {q.status === "attention" ? "Corregir en Autoría" : "Abrir en Autoría"}
                        </button>
                        <DeleteQuestion num={q.num} locked={busy} onDelete={() => onDelete(q)} button />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {qs.length === 0 && <p className="ws-note ws-pad">Todavía no hay preguntas para revisar.</p>}
        </div>
      </div>
    </div>
  );
}

// ---- 04 · Evaluación -------------------------------------------------------------

function EvaluationStage({
  bench,
  evaluation,
  runRequest,
  unapproved,
  onReview,
}: {
  bench: BenchSummary;
  evaluation: EvaluationState;
  runRequest: number;
  /** Questions not yet approved: the exam is not "concretado" until they are. */
  unapproved: number;
  onReview: () => void;
}) {
  const running = evaluation.active;
  const [models, setModels] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  useEffect(() => {
    void api
      .models()
      .then((r) => {
        setModels(r.models);
        setCatalog(r.catalog ?? r.models.map((id) => ({ id, name: id, maker: "", region: "Otras", default: false })));
      })
      .catch(() => {});
  }, []);
  const [selected, setSelected] = useSelectedModels(
    bench.slug,
    models,
    catalog.filter((c) => c.default).map((c) => c.id),
  );
  const byRegion = REGIONS.map((region) => ({ region, items: catalog.filter((c) => c.region === region) })).filter((g) => g.items.length);
  // The judge of the next evaluation: this benchmark's override ("" when none),
  // else the org's default, else the benchmark's own grader. Saved on change.
  const [judge, setJudge] = useState<JudgeConfig | null>(null);
  const [judgePick, setJudgePick] = useState("");
  const [judgeSaving, setJudgeSaving] = useState<"idle" | "saving" | "error">("idle");
  useEffect(() => {
    setJudge(null);
    setJudgePick("");
    void api
      .benchJudge(bench.slug)
      .then((j) => {
        setJudge(j);
        setJudgePick(j.override ?? "");
      })
      .catch(() => {});
  }, [bench.slug]);
  async function pickJudge(id: string) {
    setJudgePick(id);
    setJudgeSaving("saving");
    try {
      const j = await api.setBenchJudge(bench.slug, id || null);
      setJudge(j);
      setJudgePick(j.override ?? "");
      setJudgeSaving("idle");
    } catch {
      setJudgeSaving("error");
    }
  }
  const judgeName = (id: string) => catalog.find((c) => c.id === id)?.name ?? id;
  const results = useRunResults(bench);
  const board = newestPerModel(results, bench.doc?.model);
  const start = useCallback(async () => {
    const chosen = models.filter((m) => selected.has(m));
    if (chosen.length === 0 || running) return;
    await evaluation.start(chosen);
  }, [models, selected, running, evaluation]);

  // The toolbar's "Ejecutar evaluación" and B's chip land here, once the models are known.
  const handled = useRef(runRequest);
  useEffect(() => {
    if (runRequest === handled.current || models.length === 0) return;
    handled.current = runRequest;
    void start();
  }, [runRequest, models.length, start]);

  const top = board[0]?.result.benchmark_score ?? 0;
  return (
    <div className="ws-scroll ws-pad-lg ws-grid2">
      <div className="ws-card ws-clip">
        <div className="ws-pad">
          <p className="ws-eyebrow">Sistemas de IA</p>
          <p className="ws-note">
            Modelos de distintas regiones, para ver cómo responde cada una sobre tu campo. Por defecto, uno de cada región.
          </p>
        </div>
        <div role="tablist" aria-label="Tipos de sistema" className="ws-systypes">
          {(
            [
              ["Modelos", false, "Un modelo, sin prompt ni herramientas"],
              ["Modelo + prompt", true, "Un modelo con un prompt de sistema propio"],
              ["Agentes", true, "Modelo + harness abierto, ej. Hermes"],
              ["Endpoints", true, "Evaluá cualquier sistema por su URL"],
            ] as const
          ).map(([label, soon, hint]) => (
            <button key={label} role="tab" aria-selected={!soon} disabled={soon} title={hint} className={soon ? "" : "on"}>
              {label}
              {soon && <span className="soon">pronto</span>}
            </button>
          ))}
        </div>
        <div className="ws-systems">
          {byRegion.map((g) => (
            <div key={g.region}>
              <p className="ws-region">{g.region}</p>
              {g.items.map((c) => {
                const on = selected.has(c.id);
                return (
                  <div key={c.id} className="ws-system">
                    <div>
                      <p className="m">
                        {c.name}
                        {c.maker && <span className="mk"> · {c.maker}</span>}
                      </p>
                      <p className="d">{c.id} · bedrock</p>
                    </div>
                    <button
                      role="switch"
                      aria-checked={on}
                      aria-label={`Incluir ${c.name}`}
                      className={`ws-switch${on ? " on" : ""}`}
                      onClick={() => {
                        const next = new Set(selected);
                        if (on) next.delete(c.id);
                        else next.add(c.id);
                        setSelected(next);
                      }}
                    >
                      <span />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
          {models.length === 0 && <p className="ws-note" style={{ padding: "11px 0" }}>Cargando modelos…</p>}
        </div>
        {judge && (
          <div className="ws-pad" style={{ display: "grid", gap: 6 }}>
            <p className="ws-eyebrow" style={{ margin: 0 }}>Modelo juez</p>
            <p className="ws-note" style={{ margin: 0 }}>Califica cada respuesta contra los criterios de evaluación.</p>
            <select value={judgePick} onChange={(e) => void pickJudge(e.target.value)} disabled={judgeSaving === "saving"}>
              <option value="">
                {judge.orgDefault ? `Sin override — ${judgeName(judge.orgDefault)} (default de la organización)` : "Sin override — el del benchmark (default del sistema)"}
              </option>
              {catalog.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.maker ? ` · ${c.maker}` : ""}
                </option>
              ))}
              {judgePick && !catalog.some((c) => c.id === judgePick) && <option value={judgePick}>{judgePick}</option>}
            </select>
            <p className="ws-note" style={{ margin: 0 }}>
              Juez de la próxima evaluación: {judge.effective ? judgeName(judge.effective) : "el del benchmark"} ·{" "}
              {judge.source === "override" ? "override de esta evaluación" : judge.source === "org" ? "default de la organización" : "default del sistema"}
              {judgeSaving === "saving" ? " · guardando…" : judgeSaving === "error" ? " · no se pudo guardar" : ""}
            </p>
          </div>
        )}
        {unapproved > 0 && (
          <p className="ws-eval-warn">
            {unapproved === 1 ? "Falta aprobar 1 pregunta" : `Faltan aprobar ${unapproved} preguntas`}: el examen todavía no está listo. Podés evaluar igual
            para probar, pero el resultado para publicar sale del examen aprobado.{" "}
            <button className="ws-link" onClick={onReview}>
              Revisión ↗
            </button>
          </p>
        )}
        <div className="ws-sysfoot">
          <span>
            {models.filter((m) => selected.has(m)).length} de {models.length} modelos en la próxima evaluación
          </span>
          <button className="ws-btn-dark sm" disabled={!bench.validation?.ok || running || !models.some((m) => selected.has(m))} onClick={() => void start()}>
            {running ? "Evaluando…" : "Ejecutar evaluación"}
          </button>
        </div>
      </div>

      <div className="ws-card ws-pad ws-results">
        <p className="ws-eyebrow">Resultados · {board.length ? `la corrida más reciente de cada modelo` : "todavía sin corridas"}</p>
        {evaluation.error && <p className="ws-note fail">{evaluation.error}</p>}
        {evaluation.evaluation && <EvaluationProgress bench={bench} ev={evaluation.evaluation} catalog={catalog} onReport={() => void evaluation.startReport()} />}
        {board.map((r, i) => {
          const s = r.result.summary;
          const bad = s.invalid_outputs + s.execution_errors;
          return (
            <div key={r.model}>
              <div className="ws-bar-row">
                <span className="m" title={r.model}>{r.model}</span>
                <span className="track">
                  <span className={i === 0 ? "top" : ""} style={{ width: `${r.result.benchmark_score * 100}%` }} />
                </span>
                <span className="v">{r.result.benchmark_score.toFixed(2)}</span>
              </div>
              <p className="ws-bar-line">
                {bad === 0 ? `todas válidas · ${s.examples} preguntas` : [s.invalid_outputs && `${s.invalid_outputs} invalid_output`, s.execution_errors && `${s.execution_errors} execution_error`].filter(Boolean).join(" · ")}
                {" · "}
                {new Date(r.file.modified * 1000).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}
              </p>
            </div>
          );
        })}
        {board.length > 0 && top === 0 && <p className="ws-note">Todos en 0: revisá las fallas antes de leer el puntaje.</p>}
      </div>
    </div>
  );
}

const clock = (t: number) => new Date(t * 1000).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });

/** The last evaluation, model by model and then the report: running, done, or what failed. */
function EvaluationProgress({ bench, ev, catalog, onReport }: { bench: BenchSummary; ev: Evaluation; catalog: CatalogModel[]; onReport: () => void }) {
  const name = (id: string) => catalog.find((c) => c.id === id)?.name ?? id;
  const finished = ev.models.filter((m) => m.state === "done" || m.state === "error").length;
  const head =
    ev.state === "running"
      ? `Evaluación en curso · ${finished} de ${ev.models.length} modelos · empezó ${clock(ev.started)}`
      : ev.state === "reporting"
        ? "Modelos terminados · el agente está redactando el informe"
        : ev.state === "interrupted"
          ? "La evaluación se cortó: el agente se reinició mientras corría. Volvé a ejecutarla."
          : ev.state === "error"
            ? "La evaluación falló: ningún modelo pudo terminar."
            : `Evaluación terminada · ${clock(ev.finished ?? ev.started)}`;
  const r = ev.report;
  return (
    <div className={`ws-evprog ${ev.state}`} role="status" aria-live="polite">
      <p className="h">
        <span className={`mono ${ev.state === "done" ? "ok" : ev.state === "error" || ev.state === "interrupted" ? "fail" : "amber"}`}>
          {ev.state === "done" ? "[✓]" : ev.state === "error" || ev.state === "interrupted" ? "[×]" : "[···]"}
        </span>
        {head}
      </p>
      {ev.models.map((m) => (
        <div key={m.model} className="ws-run-row">
          <span className="m" title={m.model}>{name(m.model)}</span>
          {m.state === "pending" ? (
            <span className="mono muted">en cola</span>
          ) : m.state === "running" ? (
            <span className="ws-indet" aria-label="corriendo"><span /></span>
          ) : m.state === "done" ? (
            <span className="ok mono">
              [✓] {m.score?.toFixed(2) ?? "—"}
              {m.summary?.examples ? ` · ${m.summary.valid ?? 0}/${m.summary.examples} válidas` : ""}
              {m.seconds ? ` · ${Math.round(m.seconds)} s` : ""}
            </span>
          ) : (
            <span className="fail mono ws-run-err" title={m.error ? `${m.error.code}: ${m.error.message}` : undefined}>
              [×] {m.error?.message || m.error?.code || "error"}
            </span>
          )}
        </div>
      ))}
      {r.state !== "skipped" && (
        <div className="ws-run-row report">
          <span className="m">Informe de hallazgos</span>
          {r.state === "pending" ? (
            <span className="mono muted">cuando terminen los modelos</span>
          ) : r.state === "running" ? (
            <span className="ws-indet" aria-label="redactando"><span /></span>
          ) : r.state === "done" ? (
            <a className="ok mono" href={`/app/b/${encodeURIComponent(bench.slug)}/informe`} target="_blank" rel="noreferrer">
              [✓] listo · abrir ↗
            </a>
          ) : (
            <span className="fail mono">
              [×] no se pudo{" "}
              <button className="ws-link" onClick={onReport}>
                reintentar
              </button>
            </span>
          )}
        </div>
      )}
      {r.state === "error" && r.error && <p className="ws-note">{r.error}</p>}
      {(ev.state === "running" || ev.state === "reporting") && (
        <p className="ws-note">Corre en el agente de tu organización: podés cerrar la página o seguir con otra cosa; el estado queda acá.</p>
      )}
    </div>
  );
}

// ---- B · Agente ------------------------------------------------------------------

type ThreadItem = { kind: "msg"; at: number; m: Message } | { kind: "event"; at: number; e: Event };

function AgentWindow({
  front,
  instant,
  unread,
  onFront,
  chat,
  events,
  ask,
  openExam,
  onRun,
  generatePrompt,
}: {
  front: "A" | "B";
  instant: boolean;
  unread: number;
  onFront: (f: "A" | "B") => void;
  chat: ReturnType<typeof useAgentChat>;
  events: Event[];
  ask: (t: string) => Promise<void>;
  openExam: boolean;
  onRun: () => void;
  /** Null when the benchmark has no validated papers: generation stays off. */
  generatePrompt: string | null;
}) {
  const [draft, setDraft] = useState("");
  const thread = useRef<HTMLDivElement>(null);
  const items: ThreadItem[] = useMemo(() => {
    const all: ThreadItem[] = [
      ...chat.messages.map((m) => ({ kind: "msg" as const, at: Date.parse(m.createdAt) || 0, m })),
      ...events.map((e) => ({ kind: "event" as const, at: e.at, e })),
    ];
    return all.sort((a, b) => a.at - b.at);
  }, [chat.messages, events]);
  useEffect(() => {
    const el = thread.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, chat.pending]);

  const lastAgent = [...chat.messages].reverse().find((m) => m.role === "assistant");
  const send = () => {
    const t = draft.trim();
    if (!t || chat.pending) return;
    setDraft("");
    void ask(t);
  };

  return (
    <section className={`ws-win ws-b${front === "B" ? " front" : ""}${instant ? " instant" : ""}`} aria-label="B · Agente">
      {front === "A" && <button className="ws-win-back" onClick={() => onFront("B")} aria-label="Traer el agente al frente" />}
      <div className="ws-b-main">
        <div className="ws-b-head">
          <span className="ws-tag b">B</span>
          <span className={`ws-pipmark${chat.pending ? " busy" : ""}`} aria-hidden="true">
            <span className="br l" />
            <span className="dots">
              <span />
              <span />
              <span />
            </span>
            <span className="br r" />
          </span>
          <span className="t">Agente</span>
          <span className="s">trabaja sobre el mismo examen</span>
        </div>
        <div className="ws-thread" ref={thread}>
          {items.length === 0 && (
            <p className="ws-note">
              Pedile al agente lo que quieras sobre este examen: preguntas nuevas, ajustes a los criterios de evaluación, una evaluación. Lo que cambie lo vas a
              ver en la interfaz.
            </p>
          )}
          {items.map((it) => {
            if (it.kind === "event") {
              const e = it.e;
              return (
                <button
                  key={e.id}
                  className="ws-event"
                  onClick={() => {
                    e.open();
                    onFront("A");
                  }}
                >
                  <span className={`who ${e.who === "Vos" ? "" : "agent"}`}>{e.who}</span>
                  <span>{e.path}</span>
                  <span className="muted">{e.change}</span>
                  <span className="go">ver en A ↗</span>
                </button>
              );
            }
            const m = it.m;
            if (m.role === "user") {
              return (
                <div key={m.id} className="ws-msg user">
                  {m.content.replace(CONTEXT, "")}
                </div>
              );
            }
            const { text, ask: question } = splitAsk(m.content);
            const live = question && m === lastAgent && !chat.pending;
            return (
              <div key={m.id} className={`ws-msg agent${question ? " ask" : ""}`}>
                {question && <span className="ws-eyebrow amber">El agente pregunta</span>}
                {text && <Markdown>{text}</Markdown>}
                {question && <p className="q">{question.question}</p>}
                {question && (
                  <span className="opts">
                    {question.options.map((o, i) => (
                      <button key={o} className={i === 0 ? "ws-btn-dark pill" : "ws-btn-line pill"} disabled={!live} onClick={() => void ask(o)}>
                        {o}
                      </button>
                    ))}
                  </span>
                )}
              </div>
            );
          })}
          {chat.pending && (
            <div className="ws-pending" role="status">
              El agente está trabajando…
            </div>
          )}
          {chat.error && (
            <p className="ws-note fail" role="alert">
              {chat.error}
            </p>
          )}
        </div>
        <div className="ws-b-foot">
          <div className="ws-chips">
            {openExam && (
              <button
                disabled={chat.pending || !generatePrompt}
                title={generatePrompt ? undefined : "Validá un paper primero: el agente escribe solo desde los papers validados"}
                onClick={() => {
                  if (generatePrompt) void ask(generatePrompt);
                }}
              >
                Generá 5 preguntas nuevas
              </button>
            )}
            {openExam && (
              <button disabled={chat.pending} onClick={() => void ask("Revisá las respuestas expertas con benchy_review y contame cuáles no cumplen los criterios de evaluación y por qué.")}>
                Revisá las respuestas expertas
              </button>
            )}
            <button onClick={onRun}>
              Corré la evaluación
            </button>
          </div>
          <form
            className="ws-composer"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <textarea
              rows={1}
              lang="es"
              spellCheck={spellcheckFor("es")}
              value={draft}
              placeholder="Escribile al agente…"
              aria-label="Mensaje para el agente"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button type="submit" className="ws-btn-dark pill" disabled={chat.pending || !draft.trim()}>
              Enviar
            </button>
          </form>
        </div>
      </div>
      <button className="ws-strip" onClick={() => onFront("B")} aria-label="Agente">
        <span className="d" />
        <span className="v">B · Agente</span>
        {unread > 0 && <span className="ws-unread">{unread}</span>}
      </button>
    </section>
  );
}

function Markdown({ children }: { children: string }): ReactNode {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>;
}
