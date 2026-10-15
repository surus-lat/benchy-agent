import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, errorText, newestPerModel, REGIONS, splitAsk, type CatalogModel, type Message } from "./data";
import { useAgentChat, useSelectedModels } from "./bench";
import { usePlatform, type BenchSummary } from "./store";
import { useExam, useRunResults, type ExamState } from "./use-exam";
import {
  byAgent,
  criterionMet,
  groupsOf,
  hasIssue,
  isOpenQuestionExam,
  isPending,
  setCriterion,
  shareOf,
  titleOf,
  type Criterion,
  type Question,
  type QStatus,
} from "./exam-model";
import { LibraryPicker, SourceRow } from "./library";
import { PublicationStage } from "./publication";
import { citation, sources as sourcesApi, libraryErrorText, type Source } from "./library-data";
import { ApiError } from "./data";
import "./workspace.css";

// One benchmark as two windows over the same exam (design: Plataforma AB v3).
// A · Interfaz is the researcher's: questions, expert answers, the rubric, the
// review, the evaluation. B · Agente is the org's Hermes, working on the same
// files. Whatever either side changes shows in the other: A reloads after every
// agent turn, and A's saves appear in B's thread as events.

const STAGES = [
  ["autoria", "01", "Autoría"],
  ["revision", "02", "Revisión"],
  ["evaluacion", "03", "Evaluación"],
  ["publicacion", "04", "Publicación"],
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

/** First message of a conversation tells the agent which benchmark is open. Hidden in the thread. */
const CONTEXT = /^\(Benchmark abierto en la app: [^)]*\)\n\n/;

/** What the agent is asked for a batch: from the benchmark's papers when it has them. */
function batchPrompt(n: number, slug: string, fromPapers: boolean): string {
  const tail = `Agregalas al final de exam.jsonl y de questions.json (status draft, by agente, con su group). No toques las preguntas existentes.`;
  return fromPapers
    ? `Generá ${n} preguntas nuevas para este examen a partir de los papers del benchmark (${slug}/sources.json): leé los papers primero y escribí cada pregunta desde lo que el paper sostiene, con su respuesta experta y por qué la pregunta importa. En questions.json, sources lleva el id del paper y la página (por ejemplo "conicet-179477 p. 4"). ${tail}`
    : `Generá ${n} preguntas nuevas para este examen, cada una con su respuesta experta, por qué la pregunta importa y sus fuentes. ${tail}`;
}

export default function Workspace({ slug, stage: stageParam }: { slug: string; stage?: string }) {
  const { me, benches, files, runs, setRun, refresh } = usePlatform();
  const [, navigate] = useLocation();
  const bench = benches.find((b) => b.slug === slug);
  const stage = (STAGES.some(([k]) => k === stageParam) ? stageParam : "autoria") as Stage;
  const go = useCallback((s: Stage) => navigate(`/app/b/${encodeURIComponent(slug)}/${s}`), [navigate, slug]);

  const exam = useExam(bench);
  const chat = useAgentChat(slug);
  const [front, setFront] = useState<"A" | "B">("A");
  const [instant, setInstant] = useState(false);
  const [unread, setUnread] = useState(0);
  const [events, setEvents] = useState<Event[]>([]);
  const [qIndex, setQIndex] = useState(0);
  const [rubricOpen, setRubricOpen] = useState(false);
  const [papersOpen, setPapersOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [generating, setGenerating] = useState<number | null>(null);
  // "Ejecutar evaluación" from the toolbar or B: Evaluation starts it once mounted.
  const [runRequest, setRunRequest] = useState(0);
  const requestRun = useCallback(() => {
    go("evaluacion");
    setRunRequest((n) => n + 1);
  }, [go]);

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
  const q = qs[Math.min(qIndex, Math.max(qs.length - 1, 0))];
  const approved = qs.filter((x) => x.status === "done").length;
  const papers = exam.sources;
  // The exam is "concretado" when the grader has reviewed every question as it
  // stands, the researcher approved each one, and it compiles.
  const ready = openExam && qs.length > 0 && qs.every((x) => x.status === "done" && x.review) && !!bench.validation?.ok;
  const run = runs[slug];
  const running = run?.state === "running";
  const busy = chat.pending || reviewing;
  const statusText = reviewing
    ? `El juez está revisando ${qs.length} respuestas expertas contra la rúbrica…`
    : running
      ? `Corriendo ${run.models.length} sistemas sobre ${qs.length} preguntas… ${run.finished.size}/${run.models.length} terminados`
      : chat.pending
        ? "El agente está trabajando…"
        : openExam
          ? `${approved} de ${qs.length} preguntas aprobadas`
          : `${qs.length} filas en el examen`;

  return (
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
                <button className="ws-btn-line" onClick={() => setPapersOpen(true)}>
                  <span className="mono amber">{papers.length}</span>Papers
                </button>
              )}
              {openExam && (
                <button className="ws-btn-line" onClick={() => setRubricOpen(true)}>
                  <span className="mono amber">{exam.criteria!.length}</span>Rúbrica
                </button>
              )}
              <button
                className="ws-btn-dark"
                disabled={!bench.validation?.ok || running || busy || (openExam && qs.length === 0)}
                onClick={requestRun}
              >
                {running ? "Evaluando…" : "Ejecutar evaluación"}
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
            ) : stage === "autoria" ? (
              <Authoring
                exam={exam}
                author={me?.user.name?.trim() || me?.user.email || "vos"}
                openExam={openExam}
                q={q}
                qIndex={qIndex}
                setQIndex={setQIndex}
                locked={chat.pending}
                generating={generating}
                pushEvent={pushEvent}
                onRubric={() => setRubricOpen(true)}
                papers={papers}
                onPapers={() => setPapersOpen(true)}
                onBatch={async (n, fromPapers) => {
                  setGenerating(n);
                  const before = qs.length;
                  await ask(batchPrompt(n, slug, fromPapers));
                  setGenerating(null);
                  setQIndex(before);
                }}
                onDraft={(question) =>
                  void ask(
                    `Escribí un borrador para la pregunta ${question.num} del examen (fila ${question.index + 1} de exam.jsonl)${question.text ? `: «${question.text}»` : ""}. Completá la pregunta y la respuesta experta, y en questions.json el porqué y las fuentes, con status draft.`,
                  ).then(() => bringFront("B"))
                }
              />
            ) : stage === "revision" ? (
              <ReviewStage
                exam={exam}
                openExam={openExam}
                busy={busy}
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
              />
            ) : stage === "evaluacion" ? (
              <EvaluationStage
                bench={bench}
                ask={ask}
                setRun={setRun}
                running={running}
                busy={busy}
                runRequest={runRequest}
                unapproved={openExam ? qs.length - approved : 0}
                onReview={() => go("revision")}
              />
            ) : (
              <PublicationStage bench={bench} exam={exam} openExam={openExam} go={go} ask={ask} showAgent={() => bringFront("B")} busy={busy} />
            )}

            {openExam && (
              <PapersDrawer
                open={papersOpen}
                onClose={() => setPapersOpen(false)}
                bench={slug}
                list={papers}
                locked={chat.pending}
                onChange={(change) => {
                  pushEvent({ who: "Vos", path: "papers", change, open: () => setPapersOpen(true) });
                  void exam.reload();
                }}
              />
            )}

            {openExam && (
              <RubricDrawer
                open={rubricOpen}
                onClose={() => setRubricOpen(false)}
                criteria={exam.criteria!}
                total={qs.length}
                locked={chat.pending}
                onChange={(c, patch, label) => {
                  void exam.saveYaml(setCriterion(exam.yamlText, c.key, patch));
                  pushEvent({ who: "Vos", path: `rúbrica.${c.key}.${label}`, change: "editado → guardado", open: () => setRubricOpen(true) });
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
          generatePrompt={batchPrompt(5, slug, papers.length > 0)}
        />
      </main>
    </div>
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

// ---- 01 · Autoría ---------------------------------------------------------------

function Authoring({
  exam,
  author,
  openExam,
  q,
  qIndex,
  setQIndex,
  locked,
  generating,
  pushEvent,
  onRubric,
  papers,
  onPapers,
  onBatch,
  onDraft,
}: {
  exam: ExamState;
  /** The researcher's name, recorded as who wrote a question. */
  author: string;
  openExam: boolean;
  q: Question | undefined;
  qIndex: number;
  setQIndex: (i: number) => void;
  locked: boolean;
  generating: number | null;
  pushEvent: (e: Omit<Event, "id" | "at">) => void;
  onRubric: () => void;
  papers: Source[];
  onPapers: () => void;
  onBatch: (n: number, fromPapers: boolean) => void;
  onDraft: (q: Question) => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "pend" | "issues">("all");
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchN, setBatchN] = useState(5);
  const [batchFrom, setBatchFrom] = useState<"papers" | "none">("papers");
  const fromPapers = batchFrom === "papers" && papers.length > 0;
  const [writing, setWriting] = useState<number | null>(null);
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

  return (
    <div className="ws-aut">
      <aside className="ws-qlist" aria-label="Preguntas">
        <div className="ws-qlist-head">
          <div className="ws-eyebrow-row">
            <span>Preguntas</span>
            <span>{qs.length}</span>
          </div>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar pregunta…" aria-label="Buscar pregunta" />
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
          {groups.map((g) => (
            <div key={g.title}>
              <p className="ws-group">
                <span>{g.title}</span>
                <span>{g.items.length}</span>
              </p>
              {g.items.map((x) => (
                <button
                  key={x.index}
                  className={`ws-qrow${x.index === q?.index ? " on" : ""}${x.status === "attention" || x.status === "new" ? " warm" : ""}`}
                  onClick={() => setQIndex(x.index)}
                >
                  {/* Closed-answer exams have no approval flow: no status to show. */}
                  <span className={`br ${openExam ? BRACKET[x.status][1] : "none"}`}>{openExam ? BRACKET[x.status][0] : "[·]"}</span>
                  <span className="t">{titleOf(x)}</span>
                  <span className="n">{x.num}</span>
                </button>
              ))}
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
              <label>
                Fuente
                <select value={fromPapers ? "papers" : "none"} onChange={(e) => setBatchFrom(e.target.value as "papers" | "none")}>
                  {papers.length > 0 && (
                    <option value="papers">
                      {papers.length === 1 ? "El paper del benchmark" : `Los ${papers.length} papers del benchmark`}
                    </option>
                  )}
                  <option value="none">Sin papers: lo que sabe el agente</option>
                </select>
              </label>
            </div>
            {papers.length === 0 && (
              <p className="ws-batch-note">
                Sin papers, el agente escribe de lo que sabe y no puede citar.{" "}
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
                disabled={locked || !openExam}
                onClick={() => {
                  setBatchOpen(false);
                  onBatch(batchN, fromPapers);
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
        </div>
      </aside>

      <div className="ws-editor">
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
          ) : (
            <EmptyCard
              title="Todavía no hay preguntas"
              text={`El agente puede escribir un primer lote a partir de ${papers.length === 1 ? "tu paper" : `tus ${papers.length} papers`}, cada pregunta con su respuesta experta y la página que la respalda. O escribí la primera vos.`}
              onAgent={() => onBatch(5, true)}
              agentLabel="Pedile 5 preguntas al agente"
              onSelf={addQuestion}
              locked={locked}
            />
          )
        ) : q.status === "empty" && writing !== q.index ? (
          <EmptyCard
            title="Pregunta vacía"
            text="Escribila vos o pedile un borrador al agente: te lo deja acá para revisar."
            onAgent={() => onDraft(q)}
            agentLabel="Pedile un borrador al agente"
            onSelf={() => setWriting(q.index)}
            locked={locked}
          />
        ) : (
          <QuestionEditor q={q} criteria={exam.criteria!} total={qs.length} locked={locked} edit={edit} onRubric={onRubric} papers={papers} />
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
  locked,
}: {
  title: string;
  text: string;
  onAgent: () => void;
  agentLabel: string;
  onSelf: () => void;
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
      </div>
    </div>
  );
}

function ClosedExamNote({ exam, q }: { exam: ExamState; q: Question | undefined }) {
  return (
    <div className="ws-closed">
      <p className="ws-note">
        Este benchmark es de respuesta cerrada ({exam.doc?.task ?? "sin tarea"}): cada campo se corrige por coincidencia exacta, sin
        rúbrica. Lo podés leer acá; para cambiarlo, pedíselo al agente.
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
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [value]);
  return (
    <textarea
      ref={ref}
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
  onRubric,
  papers,
}: {
  q: Question;
  criteria: Criterion[];
  total: number;
  locked: boolean;
  edit: (field: "text" | "answer" | "why", value: string) => void;
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
          {(q.meta.tags ?? []).map((t) => (
            <span key={t} className="ws-chip">{t}</span>
          ))}
          {q.status === "new" && <span className="ws-flag amber">propuesta del agente · revisala</span>}
          {q.stale && <span className="ws-flag">editada · vuelve a revisión</span>}
          {q.status === "done" && (
            <span className="ws-flag ok" title={q.meta.approved_at ? new Date(q.meta.approved_at).toLocaleString("es-AR") : undefined}>
              ● aprobada{q.meta.approved_by ? ` por ${q.meta.approved_by}` : ""}
            </span>
          )}
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

      {/* Why it is asked, where it comes from, and what the grader checks. */}
      <div className="ws-col">
        <div className="ws-col-head">
          <span className="ws-eyebrow">Por qué esta pregunta</span>
        </div>
        <div className="ws-card ws-pad ws-why">
          <AutoText className="soft" value={q.meta.why ?? ""} onChange={(v) => edit("why", v)} label="Por qué esta pregunta" disabled={locked} placeholder="Qué error de los modelos busca exponer…" />
          <div className="ws-sep">
            <p className="ws-eyebrow">Fuentes</p>
            {(q.meta.sources ?? []).length ? (
              <div className="ws-sources">
                {q.meta.sources!.map((s) => {
                  const cited = citation(s, papers);
                  if (cited) {
                    const href = cited.source.pdf_url ?? cited.source.url;
                    return (
                      <div key={s} className="ws-source">
                        <span className="tag doi">PAPER</span>
                        {href ? (
                          <a className="t" href={href} target="_blank" rel="noreferrer" title={cited.source.title}>
                            {cited.source.title}
                          </a>
                        ) : (
                          <span className="t">{cited.source.title}</span>
                        )}
                        {cited.page && <span className="pg">p. {cited.page}</span>}
                      </div>
                    );
                  }
                  const doi = /^10\.\d+\//.test(s) || /doi/i.test(s);
                  return (
                    <div key={s} className="ws-source">
                      <span className={`tag ${doi ? "doi" : ""}`}>{doi ? "DOI" : "REF"}</span>
                      <span className="t">{s}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="ws-note">{papers.length ? "Sin fuentes. Pedile al agente que cite el paper y la página." : "Sin fuentes. Agregá papers al benchmark para que el agente cite de dónde sale cada pregunta."}</p>
            )}
          </div>
        </div>
        <div className="ws-card ws-pad ws-rubric-mini">
            <div className="ws-eyebrow-row">
              <span>Rúbrica · {criteria.length} criterios</span>
              <button className="ws-link" onClick={onRubric}>configurar ↗</button>
            </div>
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
      </div>
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
}: {
  open: boolean;
  onClose: () => void;
  criteria: Criterion[];
  total: number;
  locked: boolean;
  onChange: (c: Criterion, patch: { weight?: number; description?: string }, label: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) setDrafts({});
  }, [open]);
  return (
    <>
      <div className={`ws-drawer-overlay${open ? " open" : ""}`} onClick={onClose} />
      <aside className={`ws-drawer${open ? " open" : ""}`} role="dialog" aria-label="Rúbrica del examen" aria-hidden={!open}>
        <div className="ws-drawer-head">
          <span className="t">Rúbrica del examen</span>
          <span className="mono muted">{criteria.length} criterios · obligatorios</span>
          <button onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        <div className="ws-drawer-body">
          <p className="ws-note">
            Los {criteria.length} criterios se aplican a las {total} preguntas: el juez compara cada respuesta con la respuesta experta y
            decide si cumple cada uno. Lo que configurás es la importancia de cada criterio, de 1 a 5.
          </p>
          {criteria.map((c, i) => (
            <div key={c.key} className="ws-crit-card">
              <div className="row">
                <span className="mono muted">{String(i + 1).padStart(2, "0")}</span>
                <span className="lbl">Importancia</span>
                <div role="radiogroup" aria-label={`Importancia del criterio ${i + 1}`} className="ws-scale">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      role="radio"
                      aria-checked={n === c.weight}
                      aria-label={`Importancia ${n}`}
                      className={n === c.weight ? "on" : n < c.weight ? "under" : ""}
                      disabled={locked}
                      onClick={() => n !== c.weight && onChange(c, { weight: n }, "importancia")}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <span className="share">{shareOf(c, criteria)} del puntaje</span>
              </div>
              <AutoText
                className="crit"
                value={drafts[c.key] ?? c.description}
                label={`Criterio ${i + 1}`}
                disabled={locked}
                onChange={(v) => setDrafts((d) => ({ ...d, [c.key]: v }))}
              />
              {drafts[c.key] !== undefined && drafts[c.key] !== c.description && (
                <div className="ws-crit-save">
                  <button className="ws-btn-dark sm" disabled={locked || !drafts[c.key].trim()} onClick={() => onChange(c, { description: drafts[c.key].trim() }, "texto")}>
                    Guardar criterio
                  </button>
                  <button className="ws-btn-line sm" onClick={() => setDrafts((d) => ({ ...d, [c.key]: c.description }))}>
                    Deshacer
                  </button>
                </div>
              )}
            </div>
          ))}
          <p className="ws-note">Para agregar o quitar criterios, pedíselo al agente: ajusta la rúbrica y vuelve a validar.</p>
        </div>
        <p className="ws-drawer-foot">→ en el motor: scoring.field_metrics.answer · rubric · pesos {criteria.map((c) => c.weight).join(" / ")}</p>
      </aside>
    </>
  );
}

const MAX_UPLOAD = 24 * 1024 * 1024;

type Upload = { name: string; state: "waiting" | "reading" | "ok" | "error"; note?: string };

/** The benchmark's papers: what the agent writes the questions from. */
function PapersDrawer({
  open,
  onClose,
  bench,
  list,
  locked,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  bench: string;
  list: Source[];
  locked: boolean;
  onChange: (change: string) => void;
}) {
  const [tab, setTab] = useState<"library" | "upload">("library");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const added = useMemo(() => new Set(list.filter((s) => s.origin === "conicet").map((s) => Number(s.id.replace("conicet-", "")))), [list]);
  const uploading = uploads.some((u) => u.state === "waiting" || u.state === "reading");

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
          <span className="mono muted">{list.length === 1 ? "1 paper" : `${list.length} papers`}</span>
          <button onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        <div className="ws-drawer-body">
          <p className="ws-note">
            Las preguntas salen de estos papers: el agente los lee y en cada pregunta cita el paper y la página. Si un paper no tiene PDF abierto,
            el agente solo tiene su resumen.
          </p>
          <div className="lib ws-papers">
            {list.map((s) => (
              <SourceRow
                key={s.id}
                s={s}
                action={
                  <button className="lib-btn-line sm" disabled={locked || removing !== null} onClick={() => void remove(s)}>
                    {removing === s.id ? "Quitando…" : "Quitar"}
                  </button>
                }
              />
            ))}
            {list.length === 0 && <p className="ws-note muted">Todavía no hay papers en este benchmark.</p>}
            {error && <p className="lib-error">{error}</p>}
          </div>

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
            <LibraryPicker bench={bench} added={added} disabled={locked} onAdded={(src) => onChange(`+ ${src.title}`)} />
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

// ---- 02 · Revisión -------------------------------------------------------------

function ReviewStage({
  exam,
  openExam,
  busy,
  ready,
  onNext,
  onReview,
  onApprove,
  onOpen,
}: {
  exam: ExamState;
  openExam: boolean;
  busy: boolean;
  ready: boolean;
  onNext: () => void;
  onReview: () => void;
  onApprove: (q: Question) => void;
  onOpen: (q: Question) => void;
}) {
  const [openRow, setOpenRow] = useState<number | null>(null);
  if (!openExam) {
    return <p className="ws-note ws-pad">La revisión con rúbrica es para exámenes de preguntas abiertas. Este benchmark se corrige por coincidencia exacta.</p>;
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
            Antes de evaluar, el juez verifica que cada respuesta experta cumpla los {criteria.length} criterios de la rúbrica. Vos aprobás
            cada pregunta o la abrís en Autoría para corregirla.
          </p>
          <div className="r">
            <span className="mono muted">{summary}</span>
            <button className="ws-btn-dark sm" onClick={onReview} disabled={busy || qs.length === 0}>
              {reviewed ? "Volver a revisar" : "Revisar respuestas expertas"}
            </button>
          </div>
        </div>
        {qs.length > 0 && qs.every((q) => q.status === "done") && qs.some((q) => !q.review) && (
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
                          {q.status === "empty" ? "Pregunta vacía: escribila en Autoría o pedile un borrador al agente." : "Sin respuesta experta el juez no tiene contra qué comparar."}
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

// ---- 03 · Evaluación -------------------------------------------------------------

function EvaluationStage({
  bench,
  ask,
  setRun,
  running,
  busy,
  runRequest,
  unapproved,
  onReview,
}: {
  bench: BenchSummary;
  ask: (t: string) => Promise<void>;
  setRun: ReturnType<typeof usePlatform>["setRun"];
  running: boolean;
  busy: boolean;
  runRequest: number;
  /** Questions not yet approved: the exam is not "concretado" until they are. */
  unapproved: number;
  onReview: () => void;
}) {
  const { runs } = usePlatform();
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
  const results = useRunResults(bench);
  const board = newestPerModel(results, bench.doc?.model);
  const run = runs[bench.slug];
  const runsRef = useRef(runs);
  runsRef.current = runs;

  const start = useCallback(async () => {
    const chosen = models.filter((m) => selected.has(m));
    if (chosen.length === 0 || running || busy) return;
    const base = { slug: bench.slug, models: chosen, startedAt: Date.now(), baseline: new Set(bench.runs.map((r) => r.path)), finished: new Set<string>() };
    setRun(bench.slug, { ...base, state: "running" });
    void api.logActivity(bench.slug, "evaluate", `evaluó ${chosen.join(", ")}`);
    await ask(
      `Corré la evaluación de ${bench.yamlPath} con ${chosen.length === 1 ? "este modelo" : "estos modelos"}: ${chosen.join(", ")}. Usá benchy_run una vez por modelo con su argumento model, sin cambiar el YAML, y resumí los puntajes con sus fallas.`,
    );
    // The agent's reply (or its error) is in B; the files say which models finished.
    const cur = runsRef.current[bench.slug] ?? { ...base, state: "running" as const };
    setRun(bench.slug, { ...cur, state: "done" });
  }, [models, selected, running, busy, bench, setRun, ask]);

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
            Modelos de distintas regiones, para ver cómo responde cada una sobre tu campo: América Latina suele quedar contestada desde la
            mirada de otra región. Por defecto, uno de cada región.
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
          <button className="ws-btn-dark sm" disabled={!bench.validation?.ok || running || busy || !models.some((m) => selected.has(m))} onClick={() => void start()}>
            {running ? "Evaluando…" : "Ejecutar evaluación"}
          </button>
        </div>
      </div>

      <div className="ws-card ws-pad ws-results">
        <p className="ws-eyebrow">Resultados · {board.length ? `la corrida más reciente de cada modelo` : "todavía sin corridas"}</p>
        {run?.state === "running" && (
          <div className="ws-running">
            {run.models.map((m) => (
              <div key={m} className="ws-run-row">
                <span className="m">{m}</span>
                {run.finished.has(m) ? <span className="ok mono">[✓] terminado</span> : <span className="ws-indet"><span /></span>}
              </div>
            ))}
            <p className="ws-note">Cada modelo se marca terminado cuando aparece su resultado en runs/.</p>
          </div>
        )}
        {run?.state === "error" && <p className="ws-note fail">{run.error}</p>}
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
  generatePrompt: string;
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
              Pedile al agente lo que quieras sobre este examen: preguntas nuevas, ajustes a la rúbrica, una evaluación. Lo que cambie lo vas a
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
              <button disabled={chat.pending} onClick={() => void ask(generatePrompt)}>
                Generá 5 preguntas nuevas
              </button>
            )}
            {openExam && (
              <button disabled={chat.pending} onClick={() => void ask("Revisá las respuestas expertas con benchy_review y contame cuáles no cumplen la rúbrica y por qué.")}>
                Revisá las respuestas expertas
              </button>
            )}
            <button disabled={chat.pending} onClick={onRun}>
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
