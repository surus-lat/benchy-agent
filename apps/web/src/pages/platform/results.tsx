import { useEffect, useState } from "react";
import { api, errorText, type Analysis, type CatalogModel, type Evaluation } from "./data";
import { usePlatform, type BenchSummary } from "./store";
import { useModelCatalog, type EvaluationState } from "./use-exam";
import { useStageCta, type StageCta } from "./stage-next";

// 05 · Resultados: what the evaluations produced, in two readings of the same
// runs. One block per evaluated model with its metrics; opening a block takes
// over the whole stage with that model's detail — its metrics up close, and
// every question with the answer it gave and the criteria it missed. Below the
// blocks, the cross-model analysis (region, criterion, topic, paper and the
// hardest questions), which moved here from Publicación: the findings report
// and the public card consume these numbers, they no longer repeat them.

export type ResultsStageRoute = "evaluacion" | "publicacion";

type ModelRow = Analysis["models"][number];
type QuestionRow = Analysis["questions"][number];

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const num = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(2));
/** A unix time in seconds (how every timestamp in a run file is written). */
const when = (t: number) => new Date(t * 1000).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });

/** The analysis for a benchmark, reloaded when its runs or questions change. */
export function useAnalysis(bench: BenchSummary) {
  const { files } = usePlatform();
  const key = (files ?? [])
    .filter((f) => f.path.startsWith(`${bench.slug}/runs/`) || f.path === `${bench.slug}/questions.json` || f.path === `${bench.slug}/exam.jsonl`)
    .map((f) => `${f.path}@${f.modified}`)
    .join("|");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .analysis(bench.yamlPath)
      .then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setAnalysis(r);
          setError(null);
        } else setError(`${r.error.code} · ${r.error.message}`);
      })
      .catch((err) => !cancelled && setError(errorText(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [bench.yamlPath, key]);
  return { analysis, error, loading };
}

export function ResultsStage({
  bench,
  evaluation,
  setStageCta,
  ask,
  showAgent,
  busy,
  go,
  focus,
  clearFocus,
}: {
  bench: BenchSummary;
  evaluation: EvaluationState;
  /** Publishes this stage's next step into the toolbar. */
  setStageCta: (cta: StageCta | null) => void;
  ask: (t: string) => Promise<void>;
  showAgent: () => void;
  /** The agent is answering: the chips that ask it stay disabled. */
  busy: boolean;
  go: (s: ResultsStageRoute) => void;
  /** A model opened from 04 · Evaluación's board: its detail opens on arrival. */
  focus: string | null;
  clearFocus: () => void;
}) {
  const { analysis, error, loading } = useAnalysis(bench);
  const { catalog } = useModelCatalog();
  const [openModel, setOpenModel] = useState<string | null>(null);
  const [openQ, setOpenQ] = useState<number | null>(null);

  // The board in 04 · Evaluación hands a model over: open its detail once the
  // numbers land (and forget it if these results have no such model).
  useEffect(() => {
    if (!focus || !analysis) return;
    if (analysis.models.some((m) => m.model === focus)) setOpenModel(focus);
    clearFocus();
  }, [focus, analysis, clearFocus]);

  const talk = (text: string) => {
    showAgent();
    void ask(text);
  };

  useStageCta(setStageCta, {
    label: "Ir a Publicación",
    tip: analysis?.models.length
      ? "06 · Publicación. Contá qué encontraste: en Publicación van el informe de hallazgos y la ficha pública del benchmark, armados con estos resultados."
      : "06 · Publicación. Todavía sin corridas: la versión se puede publicar igual, pero queda sin resultados y el informe no se puede redactar.",
    onClick: () => go("publicacion"),
  });

  const models = analysis?.models ?? [];
  const detail = openModel ? models.find((m) => m.model === openModel) ?? null : null;
  // A run in progress: the blocks below still show the previous one until it ends.
  const ev = evaluation.evaluation;
  const running = !!ev && (ev.state === "running" || ev.state === "reporting");

  return (
    <>
      <div className="ws-scroll ws-pad-lg">
        <div className="ws-ana">
          {running && ev && (
            <div className="ws-res-live">
              <EvaluationProgress bench={bench} ev={ev} catalog={catalog} onReport={() => void evaluation.startReport()} />
              <p className="ws-note">Hay una corrida en curso: los bloques de abajo siguen mostrando la corrida anterior hasta que termine, y se actualizan solos.</p>
            </div>
          )}
          {!analysis ? (
            <p className="ws-note">{error ? `No pudimos analizar los resultados: ${error}` : loading ? "Analizando los resultados…" : ""}</p>
          ) : models.length === 0 ? (
            <div className="ws-empty">
              <p className="t">Todavía no hay resultados</p>
              <p className="d">
                Los resultados salen de las corridas: elegí los modelos en 04 · Evaluación y ejecutala. Acá va a haber un bloque por modelo con sus
                métricas, el detalle de cada respuesta que dio, y la comparación entre modelos criterio por criterio.
              </p>
              <div className="b">
                <button className="ws-btn-dark sm" onClick={() => go("evaluacion")}>
                  Ir a Evaluación →
                </button>
              </div>
            </div>
          ) : (
            <>
              <section>
                <p className="ws-eyebrow">
                  Por modelo · {models.length} {models.length === 1 ? "sistema evaluado" : "sistemas evaluados"} · abrí un bloque para ver sus respuestas
                </p>
                <div className="ws-res-grid">
                  {models.map((m, i) => (
                    <ModelBlock key={m.model} m={m} top={i === 0} criteria={analysis.criteria} onOpen={() => setOpenModel(m.model)} />
                  ))}
                </div>
              </section>

              <div className="ws-ana-ask">
                <span className="ws-eyebrow">Pensalo con el agente</span>
                <div className="ws-chips">
                  {QUESTIONS_TO_ASK.map((q) => (
                    <button key={q} disabled={busy} onClick={() => talk(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>

              {Object.keys(analysis.regions ?? {}).length > 1 && (
                <section className="ws-card ws-pad">
                  <p className="ws-eyebrow">Por región · puntaje medio de sus modelos</p>
                  <div className="ws-regions">
                    {Object.entries(analysis.regions).map(([r, v]) => (
                      <div key={r}>
                        <span className="r">{r}</span>
                        <span className="v">{num(v)}</span>
                        <span className="n">{models.filter((m) => m.region === r).map((m) => m.name).join(", ")}</span>
                      </div>
                    ))}
                  </div>
                  <p className="ws-note">Con uno o dos modelos por región es una primera mirada, no una medición de la región.</p>
                </section>
              )}

              {analysis.criteria.length > 0 && (
                <section className="ws-card ws-clip">
                  <div className="ws-pad ws-bb">
                    <p className="ws-eyebrow">Por criterio de evaluación · % de preguntas en que se cumplió</p>
                  </div>
                  <div className="ws-table-wrap">
                    <table className="ws-table">
                      <thead>
                        <tr>
                          <th>Criterio</th>
                          {models.map((m) => (
                            <th key={m.model} title={`${m.model} · ${m.region}`}>{m.name}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {analysis.criteria.map((c) => (
                          <tr key={c.key}>
                            <td className="ws-crit-cell">
                              {c.description || c.key}
                              <span className="w">importancia {c.weight}</span>
                            </td>
                            {models.map((m) => (
                              <Heat key={m.model} v={m.criteria[c.key]} />
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {analysis.groups.length > 1 && (
                <section className="ws-card ws-clip">
                  <div className="ws-pad ws-bb">
                    <p className="ws-eyebrow">Por tema · puntaje medio, en % del máximo</p>
                  </div>
                  <div className="ws-table-wrap">
                    <table className="ws-table">
                      <thead>
                        <tr>
                          <th>Tema</th>
                          {models.map((m) => (
                            <th key={m.model} title={`${m.model} · ${m.region}`}>{m.name}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {analysis.groups.map((g) => (
                          <tr key={g}>
                            <td>{g}</td>
                            {models.map((m) => (
                              <Heat key={m.model} v={m.groups[g]} />
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {analysis.papers.length > 0 && (
                <section className="ws-card ws-clip">
                  <div className="ws-pad ws-bb">
                    <p className="ws-eyebrow">Por paper · puntaje medio de las preguntas que lo citan, en % del máximo</p>
                  </div>
                  <div className="ws-table-wrap">
                    <table className="ws-table">
                      <thead>
                        <tr>
                          <th>Paper</th>
                          {models.map((m) => (
                            <th key={m.model} title={`${m.model} · ${m.region}`}>{m.name}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {analysis.papers.map((p) => (
                          <tr key={p.id}>
                            <td>
                              {p.title}
                              {p.year ? <span className="wi"> · {p.year}</span> : null}
                            </td>
                            {models.map((m) => (
                              <Heat key={m.model} v={m.papers[p.id]} />
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              <section className="ws-card ws-clip">
                <div className="ws-pad ws-bb">
                  <p className="ws-eyebrow">Dónde fallan · las preguntas con menor puntaje medio</p>
                </div>
                {analysis.hardest.map((i) => {
                  const q = analysis.questions[i];
                  const isOpen = openQ === i;
                  return (
                    <div key={i} className="ws-rev-row">
                      <button className={`ws-rev-toggle${isOpen ? " open" : ""}`} aria-expanded={isOpen} onClick={() => setOpenQ(isOpen ? null : i)}>
                        <span className="n">{q.num}</span>
                        <span className="t">{q.question}</span>
                        <span className="mono muted">{num(q.mean)}</span>
                        <span className="mini">
                          {models.map((m) => {
                            const r = q.models[m.model];
                            const cls = !r ? "" : r.error || r.score < 1 ? "no" : "ok";
                            return <span key={m.model} className={cls} title={`${m.name} · ${r ? num(r.score) : "sin datos"}`} />;
                          })}
                        </span>
                        <span className="chev" aria-hidden="true">›</span>
                      </button>
                      {isOpen && <QuestionDetail q={q} models={models} analysis={analysis} talk={talk} busy={busy} />}
                    </div>
                  );
                })}
              </section>

              <p className="ws-note">
                Juez: <span className="mono">{analysis.grader ?? "—"}</span> · mejor puntaje {num(models[0].score)} ({models[0].name}). Las diferencias
                de pocas centésimas con una corrida por modelo no son un hallazgo.
              </p>

              <div className="ws-next">
                <span className="t">
                  Leíste los resultados: contá qué encontraste. En 06 · Publicación van el informe de hallazgos y la ficha pública del benchmark.
                </span>
                <button className="ws-btn-dark sm" onClick={() => go("publicacion")}>
                  Ir a Publicación <span className="amber">→</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {analysis && detail && (
        <ModelDetail m={detail} analysis={analysis} talk={talk} busy={busy} onClose={() => setOpenModel(null)} />
      )}
    </>
  );
}

const QUESTIONS_TO_ASK = [
  "¿Qué patrón de errores ves en los resultados? Mostrame la evidencia.",
  "¿En qué se diferencian los modelos, criterio por criterio?",
  "¿Qué hallazgo de estos resultados podría ser una nota de divulgación?",
];

// ---- un bloque por modelo --------------------------------------------------------

function ModelBlock({ m, top, criteria, onOpen }: { m: ModelRow; top: boolean; criteria: Analysis["criteria"]; onOpen: () => void }) {
  const s = m.summary;
  const bad = (s.invalid_outputs ?? 0) + (s.execution_errors ?? 0);
  return (
    <button className="ws-res-block" onClick={onOpen} title={`Abrir el detalle de ${m.name}: sus métricas y cada respuesta que dio`}>
      <span className="head">
        <span className="nm">{m.name}</span>
        <span className="v">{num(m.score)}</span>
      </span>
      <span className="track">
        <span className={top ? "top" : ""} style={{ width: `${(m.score ?? 0) * 100}%` }} />
      </span>
      <span className="meta">
        {bad === 0 ? `todas válidas · ${s.examples ?? "?"} preguntas` : `${bad} sin respuesta válida de ${s.examples ?? "?"}`}
        {m.stale && <span className="stale"> · corrida de una versión anterior del examen</span>}
      </span>
      {criteria.length > 0 && (
        <span className="crit">
          {criteria.map((c) => {
            const v = m.criteria[c.key];
            return (
              <span
                key={c.key}
                className="sq"
                style={v == null ? undefined : { background: `rgba(245, 166, 35, ${((1 - v) * 0.42).toFixed(2)})` }}
                title={`${c.description || c.key} · ${pct(v)}`}
              />
            );
          })}
          <span className="cl">{criteria.length} criterios</span>
        </span>
      )}
      <span className="foot">
        <span className="rg">
          {m.region}
          {m.maker ? ` · ${m.maker}` : ""} · {when(m.run_at)}
        </span>
        <span className="go">respuestas →</span>
      </span>
    </button>
  );
}

// ---- el detalle de un modelo: cubre todo el stage --------------------------------

function ModelDetail({ m, analysis, talk, busy, onClose }: { m: ModelRow; analysis: Analysis; talk: (t: string) => void; busy: boolean; onClose: () => void }) {
  const [term, setTerm] = useState("");
  const [failsOnly, setFailsOnly] = useState(false);
  // Escape leaves the detail: the toolbar and the tabs stay reachable behind it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const byTitle = new Map(analysis.papers.map((p) => [p.id, p.title]));
  const fails = (q: QuestionRow) => {
    const r = q.models[m.model];
    return !!r && (!!r.error || r.score < 1);
  };
  const failCount = analysis.questions.filter(fails).length;
  const query = term.trim().toLowerCase();
  const rows = analysis.questions.filter((q) => (failsOnly ? fails(q) : true) && (!query || q.question.toLowerCase().includes(query) || q.num.includes(query)));

  const s = m.summary;
  const bad = (s.invalid_outputs ?? 0) + (s.execution_errors ?? 0);
  const groups = Object.entries(m.groups).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  const papers = Object.entries(m.papers).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));

  return (
    <div className="ws-res-detail" role="dialog" aria-label={`Detalle de ${m.name}`}>
      <div className="ws-res-detail-head">
        <button className="ws-btn-line sm" onClick={onClose}>
          ← Resultados
        </button>
        <span className="nm">{m.name}</span>
        <span className="rg">
          {m.region}
          {m.maker ? ` · ${m.maker}` : ""}
        </span>
        <span className="sp" />
        <span className="sc">{num(m.score)}</span>
        <span className="mono muted">{when(m.run_at)}</span>
        {m.stale && <span className="ws-flag amber">corrida de una versión anterior del examen</span>}
      </div>

      <div className="ws-res-detail-body">
        <aside className="ws-res-metrics" aria-label="Métricas del modelo">
          <div className="ws-card ws-pad ws-stack">
            <p className="ws-eyebrow">Puntaje</p>
            <p className="ws-res-score">{num(m.score)}</p>
            <span className="track">
              <span style={{ width: `${(m.score ?? 0) * 100}%` }} />
            </span>
            <p className="ws-note">
              {bad === 0
                ? `Todas las ${s.examples ?? "?"} respuestas fueron válidas.`
                : `${bad} de ${s.examples ?? "?"} respuestas sin valorar: ${[
                    s.invalid_outputs ? `${s.invalid_outputs} invalid_output` : "",
                    s.execution_errors ? `${s.execution_errors} execution_error` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}`}
            </p>
          </div>

          {analysis.criteria.length > 0 && (
            <MetricList
              title="Por criterio"
              items={analysis.criteria.map((c) => ({ id: c.key, label: c.description || c.key, sub: `importancia ${c.weight}`, v: m.criteria[c.key] }))}
            />
          )}
          {groups.length > 0 && <MetricList title="Por tema" items={groups.map(([g, v]) => ({ id: g, label: g, v }))} />}
          {papers.length > 0 && (
            <MetricList title="Por paper" items={papers.map(([id, v]) => ({ id, label: byTitle.get(id) ?? id, v }))} />
          )}

          <div className="ws-chips">
            <button disabled={busy} onClick={() => talk(`¿Qué nos dice el desempeño de ${m.name} en este benchmark? ¿Dónde es fuerte y dónde falla?`)}>
              Preguntarle al agente
            </button>
          </div>
        </aside>

        <div className="ws-res-answers">
          <div className="ws-res-answers-head">
            <p className="ws-eyebrow" style={{ margin: 0 }}>
              Respuestas · {rows.length} de {analysis.questions.length}
            </p>
            <input type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Buscar pregunta…" aria-label="Buscar pregunta" />
            <div className="ws-pills" role="group" aria-label="Filtrar respuestas">
              <button className={failsOnly ? "" : "on"} onClick={() => setFailsOnly(false)}>
                Todas <span className="c">{analysis.questions.length}</span>
              </button>
              <button className={failsOnly ? "on" : ""} onClick={() => setFailsOnly(true)}>
                Con fallas <span className="c">{failCount}</span>
              </button>
            </div>
          </div>

          <div className="ws-card ws-clip">
            {rows.map((q) => (
              <AnswerRow key={q.index} q={q} m={m} criteria={analysis.criteria} byTitle={byTitle} talk={talk} busy={busy} />
            ))}
            {rows.length === 0 && (
              <p className="ws-note" style={{ padding: "14px 16px" }}>
                Ninguna pregunta coincide.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricList({ title, items }: { title: string; items: { id: string; label: string; sub?: string; v: number | null }[] }) {
  return (
    <div className="ws-card ws-pad ws-stack">
      <p className="ws-eyebrow">{title}</p>
      {items.map((it) => (
        <div key={it.id} className="ws-res-metric">
          <span className="k">
            {it.label}
            {it.sub && <span className="sub">{it.sub}</span>}
          </span>
          <span className="v">{pct(it.v)}</span>
          <span className="track">
            <span style={{ width: `${(it.v ?? 0) * 100}%`, opacity: it.v == null ? 0 : 1 }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** One question as this model answered it: the row, and what's behind the click. */
function AnswerRow({ q, m, criteria, byTitle, talk, busy }: { q: QuestionRow; m: ModelRow; criteria: Analysis["criteria"]; byTitle: Map<string, string>; talk: (t: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const r = q.models[m.model];
  const missed = r?.missed ?? [];
  const stat = !r
    ? "sin datos"
    : r.error
      ? "sin respuesta"
      : missed.length
        ? `${missed.length} criterio${missed.length === 1 ? "" : "s"} sin cumplir`
        : r.score < 1
          ? "incorrecta"
          : "completa";
  return (
    <div className="ws-rev-row">
      <button className={`ws-rev-toggle${open ? " open" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="n">{q.num}</span>
        <span className="t">{q.question}</span>
        <span className="mono muted">{r ? num(r.score) : "—"}</span>
        <span className="ws-res-stat">{stat}</span>
        <span className="chev" aria-hidden="true">›</span>
      </button>
      {open && (
        <div className="ws-hard">
          <p className="ws-eyebrow">
            Respuesta experta · {q.group}
            {q.papers.length ? ` · ${q.papers.map((p) => byTitle.get(p) ?? p).join(", ")}` : ""}
          </p>
          <p className="soft">{q.expert_answer}</p>
          <div className="ws-hard-model">
            <p className="ws-eyebrow">
              {m.name} · {m.region} · {r ? num(r.score) : "sin datos"}
            </p>
            {!r ? (
              <p>Esta pregunta no estaba en la corrida de {m.name}.</p>
            ) : (
              <>
                <p>{r.error ? `Sin respuesta válida: ${r.error}` : r.answer || "(vacía)"}</p>
                {missed.map((x) => (
                  <p key={x.criterion} className="ws-hard-miss">
                    <span className="mono">no cumple {criteria.find((c) => c.key === x.criterion)?.description ?? x.criterion}</span>
                    {x.justification}
                  </p>
                ))}
              </>
            )}
          </div>
          <button className="ws-btn-line sm" disabled={busy} onClick={() => talk(`Analicemos la pregunta ${q.num}: ¿por qué ${m.name} respondió eso y qué dice eso del modelo?`)}>
            Preguntarle al agente por esta pregunta
          </button>
        </div>
      )}
    </div>
  );
}

// ---- el análisis entre modelos ---------------------------------------------------

function Heat({ v }: { v: number | null | undefined }) {
  // Amber for what fails, so the eye lands on it; neutral for what passes.
  const miss = v == null ? 0 : 1 - v;
  return (
    <td className="ws-heat" style={{ background: v == null ? undefined : `rgba(245, 166, 35, ${(miss * 0.42).toFixed(2)})` }}>
      {pct(v)}
    </td>
  );
}

function QuestionDetail({ q, models, analysis, talk, busy }: { q: QuestionRow; models: ModelRow[]; analysis: Analysis; talk: (t: string) => void; busy: boolean }) {
  const byTitle = new Map(analysis.papers.map((p) => [p.id, p.title]));
  return (
    <div className="ws-hard">
      <p className="ws-eyebrow">
        Respuesta experta · {q.group}
        {q.papers.length ? ` · ${q.papers.map((p) => byTitle.get(p) ?? p).join(", ")}` : ""}
      </p>
      <p className="soft">{q.expert_answer}</p>
      {models.map((m) => {
        const r = q.models[m.model];
        if (!r) return null;
        return (
          <div key={m.model} className="ws-hard-model">
            <p className="ws-eyebrow">
              {m.name} · {m.region} · {num(r.score)}
            </p>
            <p>{r.error ? `Sin respuesta válida: ${r.error}` : r.answer || "(vacía)"}</p>
            {r.missed.map((x) => (
              <p key={x.criterion} className="ws-hard-miss">
                <span className="mono">no cumple {analysis.criteria.find((c) => c.key === x.criterion)?.description ?? x.criterion}</span>
                {x.justification}
              </p>
            ))}
          </div>
        );
      })}
      <button className="ws-btn-line sm" disabled={busy} onClick={() => talk(`Analicemos la pregunta ${q.num}: ¿por qué fallan los modelos ahí y qué dice eso?`)}>
        Preguntarle al agente por esta pregunta
      </button>
    </div>
  );
}

// ---- 04 · Evaluación's corrida ---------------------------------------------------

/** The last evaluation, model by model and then the report: running, done, or what failed. */
export function EvaluationProgress({ bench, ev, catalog, onReport }: { bench: BenchSummary; ev: Evaluation; catalog: CatalogModel[]; onReport: () => void }) {
  const name = (id: string) => catalog.find((c) => c.id === id)?.name ?? id;
  const finished = ev.models.filter((m) => m.state === "done" || m.state === "error").length;
  const head =
    ev.state === "running"
      ? `Evaluación en curso · ${finished} de ${ev.models.length} modelos · empezó ${when(ev.started)}`
      : ev.state === "reporting"
        ? "Modelos terminados · el agente está redactando el informe"
        : ev.state === "interrupted"
          ? "La evaluación se cortó: el agente se reinició mientras corría. Volvé a ejecutarla."
          : ev.state === "error"
            ? "La evaluación falló: ningún modelo pudo terminar."
            : `Evaluación terminada · ${when(ev.finished ?? ev.started)}`;
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
