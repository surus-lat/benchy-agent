import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  api,
  errorText,
  fieldMeans,
  firstText,
  leafSummary,
  newestPerModel,
  splitAsk,
  type ExamCheck,
  type Message,
  type RunResult,
  type WorkspaceFile,
} from "./data";
import { conversationFor, rememberConversation, usePlatform, type BenchSummary } from "./store";
import { Pip } from "./home";
import { authorsLine, library, sources, type Paper } from "./library-data";

const TABS = [
  ["definicion", "Definición"],
  ["examen", "Examen"],
  ["sistemas", "Sistemas de IA"],
  ["corridas", "Corridas"],
  ["resultados", "Resultados"],
  ["historial", "Historial"],
] as const;
type Tab = (typeof TABS)[number][0];

// ---- The agent chat (Definición, and Nuevo benchmark) -----------------------

export function useAgentChat(convKey: string) {
  const [convId, setConvId] = useState<string | null>(() => conversationFor(convKey));
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Not remembered in this browser: the researcher's latest conversation about
  // this benchmark, kept in D1, so the work follows them across devices.
  useEffect(() => {
    if (convId || convKey === "new") return;
    let cancelled = false;
    api
      .conversations(convKey)
      .then(({ conversations }) => {
        const latest = conversations[0];
        if (!latest || cancelled) return;
        rememberConversation(convKey, latest.id);
        setConvId(latest.id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [convId, convKey]);

  useEffect(() => {
    if (!convId) return;
    let cancelled = false;
    api
      .messages(convId)
      .then((r) => {
        if (cancelled) return;
        setMessages(r.messages);
        // A conversation this browser remembered from before D1 kept the benchmark.
        if (convKey !== "new") void api.tagConversation(convId, convKey).catch(() => {});
      })
      .catch(() => {
        // Gone or not ours: start fresh.
        rememberConversation(convKey, null);
        if (!cancelled) setConvId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [convId, convKey]);

  const send = useCallback(
    async (text: string, opts: { quiet?: boolean } = {}): Promise<string | null> => {
      const message = text.trim();
      if (!message) return null;
      setPending(true);
      setError(null);
      if (!opts.quiet) {
        setMessages((m) => [...m, { id: `local-${Date.now()}`, role: "user", content: message, createdAt: new Date().toISOString() }]);
      }
      try {
        let id = convId;
        if (!id) {
          id = (await api.createConversation(convKey)).id;
          rememberConversation(convKey, id);
          setConvId(id);
        }
        const { reply } = await api.sendTurn(id, message);
        setMessages((m) => [
          ...m,
          ...(opts.quiet ? [{ id: `local-q-${Date.now()}`, role: "user" as const, content: message, createdAt: new Date().toISOString() }] : []),
          { id: `local-r-${Date.now()}`, role: "assistant", content: reply, createdAt: new Date().toISOString() },
        ]);
        return id;
      } catch (err) {
        setError(errorText(err));
        throw err;
      } finally {
        setPending(false);
      }
    },
    [convId, convKey],
  );

  return { convId, messages, pending, error, send, setError };
}

function Thread({ chat, onAnswered }: { chat: ReturnType<typeof useAgentChat>; onAnswered?: () => void }) {
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [chat.messages, chat.pending]);
  const lastAgent = [...chat.messages].reverse().find((m) => m.role === "assistant");
  return (
    <div className="bp-thread">
      {chat.messages.map((m) => {
        if (m.role === "user") return <div key={m.id} className="bp-msg user">{m.content}</div>;
        const { text, ask } = splitAsk(m.content);
        const live = ask && m === lastAgent && !chat.pending;
        return (
          <div key={m.id} className={`bp-msg ${ask ? "ask" : "agent"}`}>
            {ask && <span className="eyebrow" style={{ display: "block", marginBottom: 6 }}>El agente pregunta</span>}
            {text && <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>}
            {ask && <p style={{ fontWeight: 500 }}>{ask.question}</p>}
            {ask && (
              <span className="bp-ask-options">
                {ask.options.map((o, i) => (
                  <button
                    key={o}
                    className={i === 0 ? "btn" : "btn-ghost"}
                    disabled={!live}
                    onClick={() => void chat.send(o).then(onAnswered, () => {})}
                  >
                    {o}
                  </button>
                ))}
              </span>
            )}
          </div>
        );
      })}
      {chat.pending && (
        <div className="bp-working" role="status">
          <Pip />
          El agente está trabajando…
        </div>
      )}
      {chat.error && <p className="bp-error" role="alert">{chat.error}</p>}
      <div ref={bottom} />
    </div>
  );
}

function Composer({ disabled, onSend, placeholder = "Escribile al agente…" }: { disabled: boolean; onSend: (t: string) => void; placeholder?: string }) {
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [draft]);
  const submit = () => {
    if (disabled || !draft.trim()) return;
    onSend(draft);
    setDraft("");
  };
  return (
    <form
      className="bp-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        value={draft}
        placeholder={placeholder}
        aria-label="Mensaje para el agente"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button type="submit" className="btn" disabled={disabled || !draft.trim()}>
        Enviar
      </button>
    </form>
  );
}

// ---- New benchmark -------------------------------------------------------------

export function NewBench() {
  const { benches, refresh } = usePlatform();
  const [, navigate] = useLocation();
  const chat = useAgentChat("new");
  // The benchmarks that existed before this conversation started; whatever
  // appears beyond them was created by the agent here. Taken at the first
  // message, once the workspace list has loaded.
  const known = useRef<Set<string> | null>(null);
  // Started from a paper in the library (/app/nuevo?paper=<id>): the app adds
  // it to the benchmark as soon as the agent creates the folder.
  const paperId = useMemo(() => {
    const id = Number(new URLSearchParams(window.location.search).get("paper"));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }, []);
  const [paper, setPaper] = useState<Paper | null>(null);
  useEffect(() => {
    if (paperId) void library.paper(paperId).then(setPaper, () => {});
  }, [paperId]);

  const send = (text: string) => {
    const first = !known.current;
    if (!known.current) known.current = new Set(benches.map((b) => b.slug));
    const message =
      first && paper
        ? `${text}\n\n(Paper de partida, que la app agrega al benchmark apenas crees la carpeta: «${paper.title}», conicet-${paper.id}.)`
        : text;
    void chat.send(message).then(afterTurn, () => {});
  };
  const afterTurn = useCallback(async () => {
    await refresh();
  }, [refresh]);

  // When the agent creates a benchmark folder, move this conversation there.
  useEffect(() => {
    if (!known.current || !chat.convId || chat.pending) return;
    const created = benches.find((b) => !known.current!.has(b.slug));
    if (created) {
      rememberConversation(created.slug, chat.convId);
      rememberConversation("new", null);
      void api.tagConversation(chat.convId, created.slug).catch(() => {});
      const open = () => navigate(`/app/b/${encodeURIComponent(created.slug)}/autoria`);
      if (paperId) void sources.add(created.slug, paperId).then(open, open);
      else open();
    }
  }, [benches, chat.convId, chat.pending, navigate, paperId]);

  return (
    <div className="bp-bench">
      <div className="bp-bench-head" style={{ paddingBottom: 16 }}>
        <h1>Nuevo benchmark</h1>
        <div className="bp-bench-meta">El agente crea la carpeta y el benchmark.yaml con vos.</div>
      </div>
      <div className="bp-split">
        <div className="bp-chat">
          {chat.messages.length === 0 && !chat.pending ? (
            <div className="bp-welcome">
              <Pip variant="idle" />
              <h2 style={{ margin: "18px 0 0", fontSize: 22, fontWeight: 500 }}>¿Qué querés evaluar?</h2>
              <p className="body" style={{ marginTop: 8, lineHeight: 1.6 }}>
                Contale al agente qué sabe tu campo que los modelos deberían saber. Diseña el programa, los pesos y el examen
                con vos, y valida todo con el motor.
              </p>
              {paper && (
                <div className="bp-start-paper">
                  <span className="eyebrow">Paper de partida</span>
                  <span className="t">{paper.title}</span>
                  <span className="body">{authorsLine(paper.creators, 3)}{paper.year ? ` · ${paper.year}` : ""}</span>
                  <span className="muted">Se agrega al benchmark apenas el agente lo cree; las preguntas salen de él.</span>
                </div>
              )}
            </div>
          ) : (
            <Thread chat={chat} onAnswered={afterTurn} />
          )}
          <Composer disabled={chat.pending} onSend={send} />
        </div>
        <div className="bp-yaml">
          <div className="bp-yaml-head">
            <span className="eyebrow">benchmark.yaml</span>
            <span style={{ fontSize: 12 }} className="muted">todavía no existe</span>
          </div>
          <div className="bp-yaml-note">La persona, el agente y el motor trabajan sobre este mismo archivo. Nada se infiere a tus espaldas.</div>
        </div>
      </div>
    </div>
  );
}

// ---- One benchmark ---------------------------------------------------------------

export default function BenchPage({ slug, tab }: { slug: string; tab?: string }) {
  const { benches, files, runs, setRun, refresh } = usePlatform();
  const [, navigate] = useLocation();
  const bench = benches.find((b) => b.slug === slug);
  const current = (TABS.some(([k]) => k === tab) ? tab : "definicion") as Tab;
  const chat = useAgentChat(slug);
  const go = (t: Tab) => navigate(`/app/v1/b/${encodeURIComponent(slug)}/${t}`);

  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    void api.models().then((r) => setModels(r.models)).catch(() => {});
  }, []);
  const [selected, setSelected] = useSelectedModels(slug, models);
  const run = runs[slug];

  const startComparison = async () => {
    const chosen = models.filter((m) => selected.has(m));
    if (!bench || chosen.length === 0 || run?.state === "running") return;
    setRun(slug, { slug, models: chosen, startedAt: Date.now(), baseline: new Set(bench.runs.map((r) => r.path)), finished: new Set(), state: "running" });
    go("corridas");
    try {
      await chat.send(
        `Ejecutá la comparación de ${bench.yamlPath} con estos modelos: ${chosen.join(", ")}. Usá benchy_run una vez por modelo con su argumento model, sin cambiar el YAML, y resumí los puntajes con sus fallas.`,
        { quiet: true },
      );
      setRun(slug, { ...(runsRef.current[slug] ?? { slug, models: chosen, startedAt: Date.now(), baseline: new Set(), finished: new Set() }), finished: new Set(chosen), state: "done" });
    } catch (err) {
      setRun(slug, { ...(runsRef.current[slug] as NonNullable<typeof run>), state: "error", error: errorText(err) });
    }
    await refresh();
  };
  const runsRef = useRef(runs);
  runsRef.current = runs;

  if (!bench) {
    return (
      <section className="bp-page">
        <p className="body">{files === null ? "Cargando…" : `No encontramos el benchmark “${slug}” en el workspace de tu organización.`}</p>
      </section>
    );
  }

  const v = bench.validation;
  return (
    <div className="bp-bench">
      <div className="bp-bench-head">
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h1>{bench.doc?.title ?? slug}</h1>
            <div className="bp-bench-meta">
              <span>{bench.yamlPath}</span>
              {v?.ok && <span className="badge valid">✓ benchy_validate</span>}
              {v && !v.ok && <span className="badge error">✕ {v.error.code}</span>}
              <span>{[bench.doc?.domain, bench.doc?.task, bench.doc?.language].filter(Boolean).join(" · ")}</span>
            </div>
          </div>
          <button className="btn" onClick={() => void startComparison()} disabled={!v?.ok || run?.state === "running" || chat.pending}>
            Ejecutar comparación
          </button>
        </div>
        <nav className="bp-tabs" aria-label="Secciones del benchmark">
          {TABS.map(([k, label]) => (
            <button key={k} className={current === k ? "on" : ""} onClick={() => go(k)}>
              {label}
            </button>
          ))}
        </nav>
      </div>

      {current === "definicion" && <Definition bench={bench} chat={chat} />}
      {current === "examen" && <ExamTab bench={bench} />}
      {current === "sistemas" && (
        <SystemsTab bench={bench} models={models} selected={selected} setSelected={setSelected} onRun={() => void startComparison()} running={run?.state === "running"} />
      )}
      {current === "corridas" && <RunsTab bench={bench} onRun={() => void startComparison()} onResults={() => go("resultados")} />}
      {current === "resultados" && <ResultsTab bench={bench} />}
      {current === "historial" && <HistoryTab />}
    </div>
  );
}

export function useSelectedModels(slug: string, models: string[], defaults?: string[]): [Set<string>, (s: Set<string>) => void] {
  const key = `benchy-sys:${slug}`;
  const [sel, setSel] = useState<Set<string> | null>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? new Set(JSON.parse(raw) as string[]) : null;
    } catch {
      return null;
    }
  });
  // Until the researcher picks: the catalog's defaults (one model per region), else all.
  const effective = sel ?? new Set(defaults?.length ? defaults.filter((m) => models.includes(m)) : models);
  const set = (s: Set<string>) => {
    setSel(s);
    try {
      localStorage.setItem(key, JSON.stringify([...s]));
    } catch {
      // ignore
    }
  };
  return [effective, set];
}

// ---- Definición --------------------------------------------------------------

function Definition({ bench, chat }: { bench: BenchSummary; chat: ReturnType<typeof useAgentChat> }) {
  const { refresh } = usePlatform();
  const [yaml, setYaml] = useState<string | null>(null);
  const load = useCallback(() => api.text(bench.yamlPath).then(setYaml, () => setYaml("")), [bench.yamlPath]);
  useEffect(() => {
    void load();
  }, [load, bench.modified]);
  const after = async () => {
    await refresh();
    await load();
  };
  const v = bench.validation;
  return (
    <div className="bp-split">
      <div className="bp-chat">
        {chat.messages.length === 0 && !chat.pending ? (
          <div className="bp-welcome">
            <Pip variant="idle" />
            <p className="body" style={{ marginTop: 14, lineHeight: 1.6 }}>
              Pedile al agente que ajuste el programa, los pesos o el examen. Cada cambio queda en benchmark.yaml y se valida con el
              motor.
            </p>
          </div>
        ) : (
          <Thread chat={chat} onAnswered={after} />
        )}
        <Composer disabled={chat.pending} onSend={(t) => void chat.send(t).then(after, () => {})} />
      </div>
      <div className="bp-yaml">
        <div className="bp-yaml-head">
          <span className="eyebrow">benchmark.yaml</span>
          <span style={{ fontSize: 12 }} className="muted">
            {v?.ok ? `validado · ${v.dimensions.length} ${v.dimensions.length === 1 ? "dimensión" : "dimensiones"}` : v ? `error: ${v.error.code}` : ""}
          </span>
        </div>
        {v && !v.ok && (
          <p className="bp-note" style={{ margin: "12px 16px 0", background: "var(--fail-bg)" }}>
            {v.error.message}
            {v.error.path?.length ? ` (en ${v.error.path.join(".")})` : ""}
          </p>
        )}
        <pre>{yaml ?? "Cargando…"}</pre>
        <div className="bp-yaml-note">La persona, el agente y el motor trabajan sobre este mismo archivo. Nada se infiere a tus espaldas.</div>
      </div>
    </div>
  );
}

// ---- Examen ------------------------------------------------------------------

function ExamTab({ bench }: { bench: BenchSummary }) {
  const [check, setCheck] = useState<ExamCheck | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "valid" | "rejected">("all");
  useEffect(() => {
    void api.exam(bench.yamlPath).then(setCheck, (e) => setFailed(errorText(e)));
  }, [bench.yamlPath, bench.modified]);

  if (failed) return <section className="bp-page"><p className="bp-error">{failed}</p></section>;
  if (!check) return <section className="bp-page"><p className="body">Verificando el examen…</p></section>;
  if (!check.ok)
    return (
      <section className="bp-page">
        <p className="bp-error">El examen no se puede verificar: {check.error.message}</p>
      </section>
    );

  const rows = check.rows.filter((r) => filter === "all" || r.status === filter);
  return (
    <section className="bp-page" style={{ paddingTop: 24 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 14 }} className="body">
          <span style={{ color: "var(--ink)", fontWeight: 500 }}>{check.total} ítems</span> en {bench.doc?.examPath?.split("/").pop() ?? "exam.jsonl"} ·{" "}
          {check.valid} válidos · {check.rejected} rechazados
        </p>
        <div className="seg" role="group" aria-label="Filtrar">
          {(
            [
              ["all", "Todos"],
              ["valid", "Válidos"],
              ["rejected", "Rechazados"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="card" style={{ marginTop: 16, overflow: "hidden" }}>
        {rows.length === 0 && <p className="body" style={{ padding: 18, margin: 0 }}>No hay ítems en este filtro.</p>}
        {rows.map((r, i) => (
          <div key={r.line} className="bp-exam-row">
            <span className="idx">{String(check.rows.indexOf(r) + 1).padStart(3, "0")}</span>
            <div style={{ minWidth: 0 }}>
              <p>{firstText(r.input) || "(sin entrada)"}</p>
              <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px" }}>
                <span className="bp-chip">{leafSummary(r.expected)}</span>
                <span className={`badge ${r.status === "valid" ? "valid" : "error"}`}>{r.status === "valid" ? "válido" : "rechazado"}</span>
                {r.error && (
                  <span className="bp-code">
                    {r.error.code}
                    {r.error.path?.length ? ` · ${r.error.path.join(".")}` : ""}
                  </span>
                )}
              </div>
            </div>
            
          </div>
        ))}
      </div>
      {check.truncated && <p className="muted" style={{ fontSize: 13 }}>Mostrando los primeros 500 ítems.</p>}
      <p style={{ margin: "14px 0 0", fontSize: 13, lineHeight: 1.6 }} className="muted">
        Cada ítem se verifica contra el programa antes de entrar al examen: las fallas aparecen como rechazos, no como ruido en tus
        resultados.
      </p>
    </section>
  );
}

// ---- Sistemas de IA ------------------------------------------------------------

function SystemsTab(props: {
  bench: BenchSummary;
  models: string[];
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  onRun: () => void;
  running: boolean;
}) {
  const { bench, models, selected, setSelected, onRun, running } = props;
  const params = bench.doc?.parameters ?? {};
  const on = models.filter((m) => selected.has(m));
  return (
    <section className="bp-page" style={{ paddingTop: 24 }}>
      <p style={{ margin: 0, maxWidth: "44rem", fontSize: 14, lineHeight: 1.6 }} className="body">
        Para comparar, el benchmark queda igual y solo cambia el modelo del bloque <span className="mono" style={{ color: "var(--ink)" }}>ai-system</span>.
        Elegí qué sistemas entran en la próxima comparación.
      </p>
      <div className="bp-systems">
        {models.map((m) => {
          const isOn = selected.has(m);
          return (
            <div key={m} className={`bp-system${isOn ? "" : " off"}`}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <p className="mono" style={{ margin: 0, fontWeight: 500, fontSize: 14, overflowWrap: "anywhere" }}>{m}</p>
                  <p style={{ margin: "4px 0 0", fontSize: 12 }} className="muted">type: model · provider: bedrock</p>
                </div>
                <button
                  role="switch"
                  aria-checked={isOn}
                  aria-label="Incluir en la comparación"
                  className={`bp-switch${isOn ? " on" : ""}`}
                  onClick={() => {
                    const next = new Set(selected);
                    if (isOn) next.delete(m);
                    else next.add(m);
                    setSelected(next);
                  }}
                >
                  <span />
                </button>
              </div>
              <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 6 }}>
                {Object.entries(params).map(([k, val]) => (
                  <span key={k} className="bp-chip">
                    {k}: {String(val)}
                  </span>
                ))}
              </div>
              <p style={{ margin: "12px 0 0", fontSize: 13 }} className="body">
                {m === bench.doc?.model ? "Sistema actual del benchmark." : "Variante: solo cambia el modelo."}
              </p>
            </div>
          );
        })}
      </div>
      <div className="bp-bar-row">
        <span style={{ fontSize: 14, color: "var(--ink-soft)" }}>
          {on.length} de {models.length} sistemas en la próxima comparación
        </span>
        <button className="btn" onClick={onRun} disabled={running || on.length === 0 || !bench.validation?.ok}>
          Ejecutar comparación
        </button>
      </div>
    </section>
  );
}

// ---- Corridas ------------------------------------------------------------------

function RunsTab({ bench, onRun, onResults }: { bench: BenchSummary; onRun: () => void; onResults: () => void }) {
  const { runs } = usePlatform();
  const run = runs[bench.slug];
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (run?.state !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [run?.state]);

  if (!run)
    return (
      <section className="bp-page narrow">
        <div className="card-plain" style={{ padding: "32px 24px", textAlign: "center" }}>
          <p style={{ margin: 0, fontSize: 16 }}>No hay ninguna corrida en curso.</p>
          <p style={{ margin: "6px 0 0", fontSize: 14 }} className="body">
            Las corridas terminadas quedan en <span className="mono">runs/</span> y aparecen en Resultados.
          </p>
          <button className="btn" style={{ marginTop: 18 }} onClick={onRun} disabled={!bench.validation?.ok}>
            Ejecutar comparación
          </button>
        </div>
      </section>
    );

  const elapsed = Math.floor(((run.state === "running" ? now : Math.max(now, run.startedAt)) - run.startedAt) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  const done = run.models.filter((m) => run.finished.has(m)).length;
  return (
    <section className="bp-page narrow">
      <div className="card" style={{ overflow: "hidden" }}>
        <div style={{ padding: "22px 22px 18px", display: "flex", alignItems: "center", gap: 14, borderBottom: "1px solid var(--line-soft)" }}>
          <Pip variant={run.state === "done" ? "done" : "lg"} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>
              {run.state === "done" ? "Comparación terminada" : run.state === "error" ? "La comparación se interrumpió" : `Corriendo ${run.models.length} sistemas${bench.items ? ` sobre ${bench.items} ítems` : ""}`}
            </p>
            <p style={{ margin: "3px 0 0", fontSize: 13 }} className="body">
              {run.state === "error" ? run.error : run.state === "done" ? `${done} de ${run.models.length} sistemas terminados` : "Una llamada al modelo por ítem. Puede tardar unos minutos."}
            </p>
          </div>
          <span className="mono muted" style={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
            {mm}:{ss}
          </span>
        </div>
        {run.models.map((m) => {
          const finished = run.finished.has(m);
          const st = finished ? "done" : run.state === "running" ? "running" : "queued";
          return (
            <div key={m} className="bp-run-model">
              <div style={{ minWidth: 0 }}>
                <p className="mono" style={{ margin: 0, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m}</p>
                <div className="bp-track">{st !== "queued" && <span className={st} />}</div>
              </div>
              <span style={{ textAlign: "right", fontSize: 12, color: st === "done" ? "var(--ok-ink)" : st === "running" ? "var(--amber-ink)" : "var(--muted)" }}>
                {st === "done" ? "terminado" : st === "running" ? "en curso" : "sin terminar"}
              </span>
            </div>
          );
        })}
        <div style={{ padding: "14px 22px", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, background: "var(--paper)" }}>
          <span style={{ fontSize: 13 }} className="body">
            Podés cerrar esta pestaña: el resultado queda guardado en <span className="mono">runs/</span>.
          </span>
          {run.state !== "running" && (
            <button className="btn" onClick={onResults}>
              Ver resultados
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

// ---- Resultados ------------------------------------------------------------------

const FIX_HINTS: Record<string, string> = {
  invalid_output: "La respuesta no cumple el programa. Si el JSON está cortado, subí max_tokens en ai-system.parameters.",
  execution_error: "El modelo no respondió. Si es un límite de Bedrock, volvé a correr ese sistema en unos minutos.",
};

function ResultsTab({ bench }: { bench: BenchSummary }) {
  const [loaded, setLoaded] = useState<{ file: WorkspaceFile; result: RunResult }[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(bench.runs.slice(0, 24).map((f) => api.text(f.path).then((t) => ({ file: f, result: JSON.parse(t) as RunResult })).catch(() => null))).then(
      (rs) => !cancelled && setLoaded(rs.filter((r): r is { file: WorkspaceFile; result: RunResult } => !!r)),
    );
    return () => {
      cancelled = true;
    };
  }, [bench.runs]);

  const comparison = useMemo(() => (loaded ? newestPerModel(loaded, bench.doc?.model) : []), [loaded, bench.doc?.model]);
  const dims = bench.validation?.ok ? bench.validation.dimensions : [];

  if (!loaded) return <section className="bp-page"><p className="body">Cargando corridas…</p></section>;
  if (comparison.length === 0)
    return (
      <section className="bp-page">
        <div className="card-plain" style={{ padding: "32px 24px", textAlign: "center" }}>
          <p style={{ margin: 0, fontSize: 16 }}>Todavía no hay resultados.</p>
          <p style={{ margin: "6px 0 0", fontSize: 14 }} className="body">Ejecutá una comparación y los puntajes aparecen acá.</p>
        </div>
      </section>
    );

  const top = Math.max(...comparison.map((c) => c.result.benchmark_score));
  const examples = comparison[0].result.summary.examples;
  const means = comparison.map((c) => fieldMeans(c.result));
  const worst = comparison.find((c) => c.result.summary.invalid_outputs + c.result.summary.execution_errors > 0);
  const failures = comparison
    .flatMap((c) => c.result.results.filter((r) => r.status !== "valid").map((r) => ({ ...r, model: c.model })))
    .slice(0, 12);
  const cols = `minmax(0,1.4fr) 4rem repeat(${comparison.length}, minmax(0,1fr))`;

  return (
    <section className="bp-page" style={{ paddingTop: 24, display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 500, letterSpacing: "-.015em" }}>
          {comparison.length > 1 ? "Comparación" : "Resultado"} · {examples} ítems · {comparison.length} {comparison.length === 1 ? "sistema" : "sistemas"}
        </h2>
        <span className="mono muted" style={{ fontSize: 12 }}>{comparison[0].file.path}</span>
      </div>

      <div className="card" style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 16 }}>
        {comparison.map((c) => (
          <div key={c.model}>
            <div className="bp-res-row">
              <span className="mono" style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.model}</span>
              <span className="bp-res-bar">
                <span className={c.result.benchmark_score === top && comparison.length > 1 ? "top" : ""} style={{ width: `${c.result.benchmark_score * 100}%` }} />
              </span>
              <span style={{ textAlign: "right", fontSize: 15, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{c.result.benchmark_score.toFixed(2)}</span>
            </div>
            <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: 12 }} className="body">
              <span>{c.result.summary.valid} válidos</span>
              <span style={c.result.summary.invalid_outputs ? { color: "var(--fail)" } : undefined}>{c.result.summary.invalid_outputs} invalid_output</span>
              <span style={c.result.summary.execution_errors ? { color: "var(--fail)" } : undefined}>{c.result.summary.execution_errors} execution_error</span>
            </div>
          </div>
        ))}
        <p className="bp-note">
          Leé las fallas antes del puntaje
          {worst
            ? `: ${worst.model} tuvo ${worst.result.summary.invalid_outputs + worst.result.summary.execution_errors} fallas, que cuentan como 0.`
            : comparison.length > 1 ? "; en esta comparación no hubo fallas." : "; en este resultado no hubo fallas."}{" "}
          {examples < 100 ? `Con ${examples} ítems, diferencias chicas entre modelos pueden ser ruido.` : ""}
        </p>
      </div>

      {dims.length > 0 && (
        <div className="card-plain">
          <div className="card-head eyebrow">Puntaje por campo</div>
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 620 }}>
              <div className="bp-grid-row head" style={{ gridTemplateColumns: cols }}>
                <span>campo</span>
                <span style={{ textAlign: "right" }}>peso</span>
                {comparison.map((c) => (
                  <span key={c.model} style={{ textAlign: "right", overflow: "hidden", textOverflow: "ellipsis" }} title={c.model}>
                    {c.model.split(".").slice(-1)[0]}
                  </span>
                ))}
              </div>
              {dims.map((d) => {
                const k = d.path.join(".");
                return (
                  <div key={k} className="bp-grid-row" style={{ gridTemplateColumns: cols }}>
                    <span className="mono" style={{ fontSize: 13 }}>{k}</span>
                    <span style={{ textAlign: "right" }} className="muted">{d.weight}</span>
                    {means.map((mm, i) => (
                      <span key={i} style={{ textAlign: "right" }}>{mm.has(k) ? (mm.get(k) as number).toFixed(2) : "—"}</span>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {failures.length > 0 && (
        <div className="card-plain">
          <div className="card-head eyebrow">Fallas</div>
          {failures.map((f) => (
            <div key={`${f.model}-${f.index}`} className="bp-fail">
              <div className="mono" style={{ display: "flex", flexWrap: "wrap", gap: "6px 12px", fontSize: 12 }}>
                <span className="muted">ítem {String(f.index + 1).padStart(3, "0")}</span>
                <span>{f.model}</span>
                <span style={{ color: "var(--fail)" }}>{f.status}</span>
              </div>
              <code>{f.error?.message ?? (typeof f.prediction === "string" ? f.prediction : JSON.stringify(f.prediction))}</code>
              <span style={{ fontSize: 13 }} className="body">{FIX_HINTS[f.status] ?? ""}</span>
            </div>
          ))}
        </div>
      )}
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>
        Cada sistema muestra su corrida más reciente ({comparison.map((c) => c.model.split(".").slice(-1)[0]).join(", ")}).
      </p>
    </section>
  );
}

// ---- Historial ------------------------------------------------------------------

function HistoryTab() {
  return (
    <section className="bp-page narrow" style={{ paddingTop: 24 }}>
      <div className="card-plain" style={{ padding: "32px 24px", textAlign: "center" }}>
        <p style={{ margin: 0, fontSize: 16 }}>El historial de versiones llega pronto.</p>
        <p style={{ margin: "6px 0 0", fontSize: 14, lineHeight: 1.6 }} className="body">
          Cada cambio a <span className="mono">benchmark.yaml</span>, de quién vino y qué puntaje dio. Mientras tanto, las corridas
          anteriores quedan en <span className="mono">runs/</span>.
        </p>
      </div>
    </section>
  );
}
