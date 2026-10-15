import { useEffect, useMemo, useState } from "react";
import { api, errorText, newestPerModel, type Analysis } from "./data";
import { usePlatform, type BenchSummary } from "./store";
import { useRunResults, type ExamState } from "./use-exam";

// 04 · Publicación: what the results say (the analysis: by criterion, topic,
// paper and question), the findings report the agent writes with the
// researcher (report.md, rendered on the SURUS letterhead at
// /app/b/:slug/informe), and the public card, still a preview.

export type PubStage = "autoria" | "revision" | "evaluacion" | "publicacion";

type Tab = "analisis" | "informe" | "publicar";

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const num = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(2));

/** "SURUS × CONICET"; just "SURUS" for SURUS itself. */
export function letterheadName(org?: string | null): string {
  const name = org?.trim();
  return !name || /^surus$/i.test(name) ? "SURUS" : `SURUS × ${name.toUpperCase()}`;
}

/** The analysis for a benchmark, reloaded when its runs or questions change. */
export function useAnalysis(bench: BenchSummary) {
  const { files } = usePlatform();
  const key = useMemo(
    () =>
      (files ?? [])
        .filter((f) => f.path.startsWith(`${bench.slug}/runs/`) || f.path === `${bench.slug}/questions.json` || f.path === `${bench.slug}/exam.jsonl`)
        .map((f) => `${f.path}@${f.modified}`)
        .join("|"),
    [files, bench.slug],
  );
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

export function PublicationStage({
  bench,
  exam,
  openExam,
  go,
  ask,
  showAgent,
  busy,
}: {
  bench: BenchSummary;
  exam: ExamState;
  openExam: boolean;
  go: (s: PubStage) => void;
  ask: (t: string) => Promise<void>;
  showAgent: () => void;
  busy: boolean;
}) {
  const [tab, setTab] = useState<Tab>("analisis");
  const { analysis, error, loading } = useAnalysis(bench);
  const talk = (text: string) => {
    showAgent();
    void ask(text);
  };
  return (
    <div className="ws-scroll ws-pad-lg">
      <div className="ws-pub-tabs" role="tablist" aria-label="Publicación">
        {(
          [
            ["analisis", "Análisis"],
            ["informe", "Informe"],
            ["publicar", "Publicar"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "analisis" ? (
        <AnalysisView analysis={analysis} error={error} loading={loading} go={go} talk={talk} busy={busy} />
      ) : tab === "informe" ? (
        <ReportView bench={bench} analysis={analysis} talk={talk} showAgent={showAgent} busy={busy} />
      ) : (
        <PublishView bench={bench} exam={exam} openExam={openExam} go={go} />
      )}
    </div>
  );
}

// ---- Análisis -------------------------------------------------------------------

function Heat({ v }: { v: number | null | undefined }) {
  // Amber for what fails, so the eye lands on it; neutral for what passes.
  const miss = v == null ? 0 : 1 - v;
  return (
    <td className="ws-heat" style={{ background: v == null ? undefined : `rgba(245, 166, 35, ${(miss * 0.42).toFixed(2)})` }}>
      {pct(v)}
    </td>
  );
}

const QUESTIONS_TO_ASK = [
  "¿Qué patrón de errores ves en los resultados? Mostrame la evidencia.",
  "¿En qué se diferencian los modelos, criterio por criterio?",
  "¿Qué hallazgo de estos resultados podría ser una nota de divulgación?",
];

function AnalysisView({
  analysis,
  error,
  loading,
  go,
  talk,
  busy,
}: {
  analysis: Analysis | null;
  error: string | null;
  loading: boolean;
  go: (s: PubStage) => void;
  talk: (t: string) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (!analysis) return <p className="ws-note">{error ? `No pudimos analizar los resultados: ${error}` : loading ? "Analizando los resultados…" : ""}</p>;
  const models = analysis.models;
  if (models.length === 0) {
    return (
      <div className="ws-empty">
        <p className="t">Todavía no hay resultados</p>
        <p className="d">El análisis sale de las corridas: elegí los modelos en Evaluación y ejecutala.</p>
        <div className="b">
          <button className="ws-btn-dark sm" onClick={() => go("evaluacion")}>
            Ir a Evaluación →
          </button>
        </div>
      </div>
    );
  }
  const top = models[0];
  const byTitle = new Map(analysis.papers.map((p) => [p.id, p.title]));
  return (
    <div className="ws-ana">
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

      <section className="ws-card ws-pad">
        <p className="ws-eyebrow">Puntaje por modelo · la corrida más reciente de cada uno</p>
        {models.map((m, i) => {
          const s = m.summary;
          const bad = (s.invalid_outputs ?? 0) + (s.execution_errors ?? 0);
          return (
            <div key={m.model}>
              <div className="ws-bar-row">
                <span className="m" title={m.model}>{m.model}</span>
                <span className="track">
                  <span className={i === 0 ? "top" : ""} style={{ width: `${(m.score ?? 0) * 100}%` }} />
                </span>
                <span className="v">{num(m.score)}</span>
              </div>
              <p className="ws-bar-line">
                {bad === 0 ? `todas válidas · ${s.examples ?? "?"} preguntas` : `${bad} sin respuesta válida de ${s.examples ?? "?"}`}
                {m.stale && <span className="amber"> · corrida de una versión anterior del examen</span>}
              </p>
            </div>
          );
        })}
      </section>

      {analysis.criteria.length > 0 && (
        <section className="ws-card ws-clip">
          <div className="ws-pad ws-bb">
            <p className="ws-eyebrow">Por criterio de la rúbrica · % de preguntas en que se cumplió</p>
          </div>
          <div className="ws-table-wrap">
            <table className="ws-table">
              <thead>
                <tr>
                  <th>Criterio</th>
                  {models.map((m) => (
                    <th key={m.model} title={m.model}>{m.model}</th>
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
                    <th key={m.model} title={m.model}>{m.model}</th>
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
                    <th key={m.model} title={m.model}>{m.model}</th>
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
          const isOpen = open === i;
          return (
            <div key={i} className="ws-rev-row">
              <button className={`ws-rev-toggle${isOpen ? " open" : ""}`} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : i)}>
                <span className="n">{q.num}</span>
                <span className="t">{q.question}</span>
                <span className="mono muted">{num(q.mean)}</span>
                <span className="chev" aria-hidden="true">›</span>
              </button>
              {isOpen && (
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
                          {m.model} · {num(r.score)}
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
              )}
            </div>
          );
        })}
      </section>
      <p className="ws-note">
        Juez: <span className="mono">{analysis.grader ?? "—"}</span> · mejor puntaje {num(top.score)} ({top.model}). Las diferencias de pocas
        centésimas con una corrida por modelo no son un hallazgo.
      </p>
    </div>
  );
}

// ---- Informe ---------------------------------------------------------------------

const REPORT_PROMPT = (slug: string) =>
  `Redactá el informe de hallazgos de este benchmark en ${slug}/report.md, siguiendo la skill benchy-report-findings: los números de benchy_analysis, los hallazgos con su evidencia (pregunta, respuesta experta, respuesta del modelo, criterio que falla), las limitaciones y el ángulo para publicar. Cuando termines, contame en dos líneas cuáles son los hallazgos principales.`;

function ReportView({
  bench,
  analysis,
  talk,
  showAgent,
  busy,
}: {
  bench: BenchSummary;
  analysis: Analysis | null;
  talk: (t: string) => void;
  showAgent: () => void;
  busy: boolean;
}) {
  const { files } = usePlatform();
  const path = `${bench.slug}/report.md`;
  const file = files?.find((f) => f.path === path);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setText(null);
      return;
    }
    void api.text(path).then(setText, () => setText(null));
  }, [path, file?.modified]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasRuns = (analysis?.models.length ?? 0) > 0;
  const title = text?.match(/^#\s+(.+)$/m)?.[1];
  const summary = text?.split(/^##\s+/m)[1]?.replace(/^[^\n]*\n/, "").trim().slice(0, 600);
  return (
    <div className="ws-narrow">
      {!text ? (
        <div className="ws-empty">
          <p className="t">El informe de hallazgos</p>
          <p className="d">
            El agente lo redacta a partir del análisis: qué fallan los modelos y por qué, con la evidencia de cada pregunta, las limitaciones y el
            ángulo para un paper o una nota. Sale en el membrete de SURUS con el nombre de tu organización, listo para descargar en PDF. Después lo
            ajustás conversando con el agente.
          </p>
          <div className="b">
            <button
              className="ws-btn-dark sm"
              disabled={busy || !hasRuns}
              onClick={() => {
                void api.logActivity(bench.slug, "report", "pidió el informe de hallazgos");
                talk(REPORT_PROMPT(bench.slug));
              }}
            >
              Redactar el informe con el agente
            </button>
          </div>
          {!hasRuns && <p className="ws-note">Primero hace falta una evaluación: el informe sale de sus resultados.</p>}
        </div>
      ) : (
        <div className="ws-card ws-pad ws-report-card">
          <p className="ws-eyebrow">Informe de hallazgos · report.md</p>
          <h3>{title ?? "Informe"}</h3>
          {summary && <p className="ws-note">{summary}{summary.length >= 600 ? "…" : ""}</p>}
          <div className="ws-row-btns">
            <a className="ws-btn-dark sm" href={`/app/b/${encodeURIComponent(bench.slug)}/informe`} target="_blank" rel="noreferrer">
              Abrir el informe ↗
            </a>
            <button className="ws-btn-line sm" onClick={showAgent}>
              Pedirle cambios al agente
            </button>
            <button className="ws-btn-line sm" disabled={busy} onClick={() => talk(`Actualizá ${bench.slug}/report.md con los resultados actuales de benchy_analysis, manteniendo lo que no cambió.`)}>
              Actualizar con los últimos resultados
            </button>
          </div>
          <p className="ws-note">
            Pedile al agente lo que quieras cambiar («sumá un hallazgo sobre la pregunta 03», «escribí un párrafo para prensa»): edita el informe y
            acá se actualiza solo.
          </p>
        </div>
      )}
    </div>
  );
}

// ---- Publicar ---------------------------------------------------------------------

function PublishView({ bench, exam, openExam, go }: { bench: BenchSummary; exam: ExamState; openExam: boolean; go: (s: PubStage) => void }) {
  const { me } = usePlatform();
  const results = useRunResults(bench);
  const board = newestPerModel(results, bench.doc?.model);
  const [scope, setScope] = useState<"approved" | "all">("approved");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const qs = exam.questions;
  const approved = openExam ? qs.filter((q) => q.status === "done").length : qs.length;
  const n = scope === "approved" ? approved : qs.length;
  const title = exam.doc?.title ?? bench.slug;
  const org = me?.org?.name ?? "";
  const checks = [
    { ok: approved > 0, label: `${approved} de ${qs.length} preguntas aprobadas`, go: "revision" as PubStage, goLabel: "Revisión" },
    { ok: board.length > 0, label: board.length ? "Hay una evaluación para adjuntar" : "Falta ejecutar la evaluación", go: "evaluacion" as PubStage, goLabel: "Evaluación" },
    { ok: !!bench.validation?.ok, label: bench.validation?.ok ? "El benchmark compila (benchy_validate)" : "El benchmark no compila todavía", go: "autoria" as PubStage, goLabel: "Autoría" },
  ];
  const radio = (on: boolean) => `ws-radio${on ? " on" : ""}`;
  return (
    <>
      <div className="ws-soon-banner">
        <span className="mono amber">[·]</span>
        La publicación llega pronto: tablero público, paquete descargable y DOI. Así se va a ver.
      </div>
      <div className="ws-pub">
        <div className="ws-col">
          <p className="ws-eyebrow">Así se va a ver publicado · tablero de Benchy</p>
          <div className="ws-card ws-preview">
            <div className="ws-browser">
              <span className="dots"><span /><span /><span /></span>
              <span>getbenchy.lat/b/{bench.slug}</span>
            </div>
            <div className="ws-pad ws-preview-body">
              <div>
                <div className="tags">
                  <span className="ws-chip">BORRADOR</span>
                  <span className="ws-chip">{[exam.doc?.domain, exam.doc?.language].filter(Boolean).join(" · ").toUpperCase()}</span>
                </div>
                <h2>{title}</h2>
                <p className="ws-note">{org}</p>
              </div>
              <p className="about">
                {n} preguntas{openExam ? ` de respuesta abierta, cada una juzgada contra una respuesta experta con una rúbrica de ${exam.criteria!.length} criterios.` : "."}
              </p>
              <div className="board">
                <p className="ws-eyebrow">Resultados</p>
                {board.length ? (
                  board.map((r, i) => (
                    <div key={r.model} className="ws-bar-row sm">
                      <span className="m">{r.model}</span>
                      <span className="track">
                        <span className={i === 0 ? "top" : ""} style={{ width: `${r.result.benchmark_score * 100}%` }} />
                      </span>
                      <span className="v">{r.result.benchmark_score.toFixed(2)}</span>
                    </div>
                  ))
                ) : (
                  <p className="ws-note">Sin corridas todavía.</p>
                )}
              </div>
              <p className="sample">
                {visibility === "private"
                  ? "Las preguntas no se publican: se muestran 3 ejemplos y la rúbrica. Así el examen no se filtra en el entrenamiento de los modelos."
                  : `Las ${n} preguntas, sus respuestas expertas y la rúbrica son públicas.`}
              </p>
              <div>
                <p className="ws-eyebrow">Cómo citar</p>
                <p className="cite">
                  {org} ({new Date().getFullYear()}). {title} [Benchmark]. Benchy. https://getbenchy.lat/b/{bench.slug}
                </p>
              </div>
            </div>
          </div>
        </div>
        <div className="ws-col">
          <div className="ws-card ws-pad ws-stack">
            <p className="ws-eyebrow">Antes de publicar</p>
            {checks.map((c) => (
              <div key={c.label} className="ws-check">
                <span className={`mono ${c.ok ? "ok" : "amber"}`}>{c.ok ? "[✓]" : "[·]"}</span>
                <span className="t">{c.label}</span>
                {!c.ok && (
                  <button className="ws-link" onClick={() => go(c.go)}>
                    {c.goLabel} ↗
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="ws-card ws-pad ws-stack">
            <p className="ws-eyebrow">Qué preguntas entran</p>
            <button className={radio(scope === "approved")} onClick={() => setScope("approved")}>
              <span className="dot" />
              <span>
                <span className="l">Solo las aprobadas ({approved})</span>
                <span className="h">Recomendado: las demás quedan para la próxima versión.</span>
              </span>
            </button>
            <button className={radio(scope === "all")} onClick={() => setScope("all")}>
              <span className="dot" />
              <span>
                <span className="l">Todas ({qs.length})</span>
                <span className="h">{approved === qs.length ? "Todas están aprobadas." : `Requiere aprobar las ${qs.length - approved} que faltan.`}</span>
              </span>
            </button>
          </div>
          <div className="ws-card ws-pad ws-stack">
            <p className="ws-eyebrow">Las preguntas, ¿se ven?</p>
            <button className={radio(visibility === "private")} onClick={() => setVisibility("private")}>
              <span className="dot" />
              <span>
                <span className="l">Privadas · se publican resultados y 3 ejemplos</span>
                <span className="h">Protege el examen: si las preguntas circulan, los modelos pueden aprenderlas.</span>
              </span>
            </button>
            <button className={radio(visibility === "public")} onClick={() => setVisibility("public")}>
              <span className="dot" />
              <span>
                <span className="l">Públicas · examen completo</span>
                <span className="h">Útil para docencia y replicación, pero el benchmark pierde valor con el tiempo.</span>
              </span>
            </button>
          </div>
          <button className="ws-publish" disabled>
            Publicar · pronto
          </button>
          <p className="ws-note center">Cuando llegue, la versión publicada queda congelada y los cambios siguientes van a la próxima.</p>
        </div>
      </div>
    </>
  );
}
