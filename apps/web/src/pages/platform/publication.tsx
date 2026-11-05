import { useEffect, useMemo, useState } from "react";
import { api, errorText, newestPerModel, publicPath, since, type Analysis } from "./data";
import { usePlatform, type BenchSummary } from "./store";
import { useRunResults, type EvaluationState, type ExamState } from "./use-exam";
import { hasDesign } from "./exam-model";

// 05 · Publicación: what the results say (the analysis: by criterion, topic,
// paper and question), the findings report (report.md: the agent writes it on
// its own when an evaluation ends, and the researcher adjusts it with the agent;
// rendered on the SURUS letterhead at /app/b/:slug/informe), and the public
// card, still a preview.

export type PubStage = "criterios" | "fuentes" | "autoria" | "evaluacion" | "publicacion";

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
  mcExam,
  go,
  ask,
  showAgent,
  busy,
  evaluation,
}: {
  bench: BenchSummary;
  exam: ExamState;
  openExam: boolean;
  /** Multiple choice: published as exact-match questions, no rubric line. */
  mcExam: boolean;
  go: (s: PubStage) => void;
  ask: (t: string) => Promise<void>;
  showAgent: () => void;
  busy: boolean;
  evaluation: EvaluationState;
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
        <ReportView bench={bench} analysis={analysis} showAgent={showAgent} evaluation={evaluation} />
      ) : (
        <PublishView bench={bench} exam={exam} openExam={openExam} mcExam={mcExam} go={go} />
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
                <span className="m" title={`${m.model} · ${m.maker} · ${m.region}`}>{m.name}</span>
                <span className="track">
                  <span className={i === 0 ? "top" : ""} style={{ width: `${(m.score ?? 0) * 100}%` }} />
                </span>
                <span className="v">{num(m.score)}</span>
              </div>
              <p className="ws-bar-line">
                {m.region}
                {m.maker ? ` · ${m.maker}` : ""} ·{" "}
                {bad === 0 ? `todas válidas · ${s.examples ?? "?"} preguntas` : `${bad} sin respuesta válida de ${s.examples ?? "?"}`}
                {m.stale && <span className="amber"> · corrida de una versión anterior del examen</span>}
              </p>
            </div>
          );
        })}
      </section>

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

function ReportView({
  bench,
  analysis,
  showAgent,
  evaluation,
}: {
  bench: BenchSummary;
  analysis: Analysis | null;
  showAgent: () => void;
  evaluation: EvaluationState;
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

  const ev = evaluation.evaluation;
  // The exam was edited (a question deleted, a row changed) after the report was written.
  const examFile = files?.find((f) => f.path === bench.doc?.examPath);
  const reportStale = !!file && !!examFile && examFile.modified > file.modified;
  const writing = ev?.report.state === "running";
  const evaluating = ev?.state === "running";
  const hasRuns = (analysis?.models.length ?? 0) > 0;
  const title = text?.match(/^#\s+(.+)$/m)?.[1];
  // The summary as plain text: no list marks or emphasis from the markdown.
  const summary = text
    ?.split(/^##\s+/m)[1]
    ?.replace(/^[^\n]*\n/, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/[*_`]+/g, "")
    .trim()
    .slice(0, 600);
  const failed = ev?.report.state === "error" ? ev.report.error : null;

  const status = writing ? (
    <div className="ws-evprog reporting" role="status" aria-live="polite">
      <p className="h">
        <span className="mono amber">[···]</span>
        {text ? "El agente está rehaciendo el informe con los últimos resultados." : "El agente está redactando el informe con los resultados de la evaluación."}
      </p>
      <span className="ws-indet wide" aria-hidden="true"><span /></span>
      <p className="ws-note">Aparece acá solo cuando termina, en unos minutos. Podés seguir con otra cosa.</p>
    </div>
  ) : evaluating ? (
    <p className="ws-note ws-pub-wait">Hay una evaluación corriendo: el informe se redacta solo cuando termina.</p>
  ) : null;

  return (
    <div className="ws-narrow">
      {status}
      {failed && !writing && <p className="ws-note fail">El informe no se pudo redactar: {failed}</p>}
      {evaluation.error && <p className="ws-note fail">{evaluation.error}</p>}
      {!text ? (
        !writing && (
          <div className="ws-empty">
            <p className="t">El informe de hallazgos</p>
            <p className="d">
              Se redacta solo cuando termina una evaluación, a partir del análisis: qué fallan los modelos y por qué, con la evidencia de cada
              pregunta, las limitaciones y el ángulo para un paper o una nota. Sale en el membrete de SURUS con el nombre de tu organización,
              listo para descargar en PDF.
            </p>
            <div className="b">
              <button className="ws-btn-dark sm" disabled={!hasRuns || evaluation.active} onClick={() => void evaluation.startReport()}>
                Redactar el informe
              </button>
            </div>
            {!hasRuns && <p className="ws-note">Primero hace falta una evaluación: el informe sale de sus resultados.</p>}
          </div>
        )
      ) : (
        <div className="ws-card ws-pad ws-report-card">
          <p className="ws-eyebrow">Informe de hallazgos · report.md</p>
          {reportStale && (
            <p className="ws-note amber" style={{ margin: "0 0 8px" }}>
              El examen cambió desde que se escribió este informe: puede nombrar preguntas que ya no están. Rehacelo con los últimos resultados.
            </p>
          )}
          <h3>{title ?? "Informe"}</h3>
          {summary && <p className="ws-note">{summary}{summary.length >= 600 ? "…" : ""}</p>}
          <div className="ws-row-btns">
            <a className="ws-btn-dark sm" href={`/app/b/${encodeURIComponent(bench.slug)}/informe`} target="_blank" rel="noreferrer">
              Abrir el informe ↗
            </a>
            <button className="ws-btn-line sm" onClick={showAgent}>
              Pedirle cambios al agente
            </button>
            <button className="ws-btn-line sm" disabled={evaluation.active} onClick={() => void evaluation.startReport()}>
              Rehacer con los últimos resultados
            </button>
          </div>
          <p className="ws-note">
            Pedile al agente lo que quieras cambiar («sumá un hallazgo sobre la pregunta 03», «escribí un párrafo para prensa»): edita el informe y
            acá se actualiza solo. Rehacerlo guarda la versión anterior en report.previous.md.
          </p>
        </div>
      )}
    </div>
  );
}

// ---- Publicar ---------------------------------------------------------------------

function PublishView({ bench, exam, openExam, mcExam, go }: { bench: BenchSummary; exam: ExamState; openExam: boolean; mcExam: boolean; go: (s: PubStage) => void }) {
  const { me } = usePlatform();
  const results = useRunResults(bench);
  const board = newestPerModel(results, bench.doc?.model);
  const [scope, setScope] = useState<"approved" | "all">("approved");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  /** One line for this version: what it measures or what changed. */
  const [note, setNote] = useState("");
  /** The step before freezing or unlocking a version, so neither is an accident. */
  const [confirming, setConfirming] = useState<"publish" | "revert" | null>(null);
  const qs = exam.questions;
  const approved = openExam ? qs.filter((q) => q.status === "done").length : qs.length;
  const n = scope === "approved" ? approved : qs.length;
  const title = exam.doc?.title ?? bench.slug;
  const org = me?.org?.name ?? "";
  const rubricCount = exam.criteria?.length ?? 0;
  const pub = exam.publication;
  const published = pub?.state === "published";
  const lastVersion = pub?.version ?? 0;
  const basedOn = pub?.basedOn ?? null;
  const nextVersion = lastVersion + 1;
  const versions = pub?.versions ?? [];
  const checks: { ok: boolean; label: string; soft?: boolean; go: PubStage; goLabel: string }[] = [
    {
      ok: hasDesign(exam.design),
      label: hasDesign(exam.design) ? "El diseño dice qué se evalúa" : "Falta definir qué se quiere evaluar",
      go: "criterios" as PubStage,
      goLabel: "Criterios",
    },
    // An open exam with an empty rubric has nothing to grade with: it says so.
    ...(openExam
      ? [
          {
            ok: rubricCount > 0,
            label: rubricCount > 0 ? `${rubricCount} ${rubricCount === 1 ? "criterio" : "criterios"} de evaluación` : "Sin criterios: el juez no tiene con qué medir",
            go: "criterios" as PubStage,
            goLabel: "Criterios",
          },
        ]
      : []),
    {
      ok: qs.length > 0 && approved > 0,
      label: qs.length === 0 ? "Todavía no hay preguntas" : `${approved} de ${qs.length} preguntas aprobadas`,
      go: "autoria" as PubStage,
      goLabel: "Preguntas",
    },
    // A benchmark is worth freezing before anyone has run it: what it measures
    // does not depend on the results. Only say out loud that the version has none.
    {
      ok: board.length > 0,
      soft: true,
      label: board.length ? "Hay una evaluación para adjuntar" : "Sin evaluación todavía: la versión queda sin resultados",
      go: "evaluacion" as PubStage,
      goLabel: "Evaluación",
    },
    { ok: !!bench.validation?.ok, label: bench.validation?.ok ? "El benchmark compila (benchy_validate)" : "El benchmark no compila todavía", go: "autoria" as PubStage, goLabel: "Preguntas" },
  ];
  const missing = checks.filter((c) => !c.ok && !c.soft);
  const busy = exam.publicationBusy;

  const doPublish = async () => {
    if (await exam.publish(note)) setNote("");
    setConfirming(null);
  };
  const doRevert = async () => {
    await exam.revertPublication();
    setConfirming(null);
  };

  const state = published
    ? `Está publicado como v${lastVersion}${pub?.at ? ` · ${since(new Date(pub.at).getTime() / 1000)} por ${pub.by ?? "alguien de la organización"}` : ""}. La copia congelada quedó en ${bench.slug}/published/v${lastVersion} y nada la cambia. Mientras esté publicada podés seguir evaluándolo y rehacer su informe; la definición no se edita.`
    : basedOn
      ? `La última versión publicada es v${basedOn}${pub?.at ? ` · ${since(new Date(pub.at).getTime() / 1000)}` : ""}. Revertiste la publicación: lo que hay acá es una copia editable de esa versión, y v${basedOn} sigue congelada donde estaba. Al publicar, esto pasa a ser v${nextVersion}.`
      : "Todavía no publicaste este benchmark. Publicar guarda una copia exacta de lo que es hoy —su definición, sus preguntas, sus papers y sus resultados— y la congela; después podés seguir iterando y publicar versiones nuevas.";

  const radio = (on: boolean) => `ws-radio${on ? " on" : ""}`;
  return (
    <>
      <div className="ws-soon-banner">
        <span className="mono amber">[·]</span>
        Publicar y congelar versiones ya funciona: guarda la copia y bloquea la definición. Lo que falta es el tablero público, el paquete descargable y el DOI. Así se va a ver.
      </div>
      <div className="ws-pub">
        <div className="ws-col">
          <p className="ws-eyebrow">Así se va a ver publicado · tablero de Benchy</p>
          <div className="ws-card ws-preview">
            <div className="ws-browser">
              <span className="dots"><span /><span /><span /></span>
              <span>{publicPath(me?.org, bench.slug)}</span>
            </div>
            <div className="ws-pad ws-preview-body">
              <div>
                <div className="tags">
                  <span className="ws-chip">{published ? `PUBLICADO v${lastVersion}` : basedOn ? `BORRADOR DE v${basedOn}` : "BORRADOR"}</span>
                  <span className="ws-chip">{[exam.doc?.domain, exam.doc?.language].filter(Boolean).join(" · ").toUpperCase()}</span>
                </div>
                <h2>{title}</h2>
                <p className="ws-note">{org}</p>
                {me?.org?.brandTagline && <p className="ws-note" style={{ color: me?.org?.brandColorSecondary ?? me?.org?.brandColor ?? undefined }}>{me.org.brandTagline}</p>}
              </div>
              <p className="about">
                {n} preguntas
                {openExam
                  ? rubricCount === 0
                    ? " de respuesta abierta, todavía sin criterios de evaluación."
                    : ` de respuesta abierta, cada una juzgada contra una respuesta experta con ${rubricCount} criterios de evaluación.`
                  : mcExam
                    ? " de opción múltiple, corregidas por coincidencia exacta con la respuesta correcta."
                    : "."}
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
                  ? "Las preguntas no se publican: se muestran 3 ejemplos y los criterios de evaluación. Así el examen no se filtra en el entrenamiento de los modelos."
                  : `Las ${n} preguntas, sus respuestas expertas y los criterios de evaluación son públicos.`}
              </p>
              <div>
                <p className="ws-eyebrow">Cómo citar</p>
                <p className="cite">
                  {org} ({new Date().getFullYear()}). {title} [Benchmark]. Benchy. https://{publicPath(me?.org, bench.slug)}
                </p>
              </div>
            </div>
          </div>
        </div>
        <div className="ws-col">
          <div className="ws-card ws-pad ws-publish-state">
            <p className="ws-eyebrow">La versión que se congela</p>
            <p className="now">{state}</p>
            {exam.publicationError && <p className="ws-note fail">{exam.publicationError}</p>}
            {exam.publicationBusy && <p className="ws-note">[···] Congelando la copia en el workspace…</p>}
            {published ? (
              confirming === "revert" ? (
                <>
                  <p className="ws-note amber">
                    ¿Revertir la publicación? v{lastVersion} queda tal cual y el benchmark vuelve a ser editable: lo que cambies después arma la
                    versión siguiente.
                  </p>
                  <div className="ws-row-btns">
                    <button className="ws-btn-dark sm" disabled={busy} onClick={() => void doRevert()}>
                      Sí, volver a editarlo
                    </button>
                    <button className="ws-btn-line sm" onClick={() => setConfirming(null)}>
                      Cancelar
                    </button>
                  </div>
                </>
              ) : (
                <button className="ws-publish-undo" disabled={busy} onClick={() => setConfirming("revert")}>
                  Revertir la publicación y seguir iterando
                </button>
              )
            ) : confirming === "publish" ? (
              <>
                <p className="ws-note amber">
                  ¿Publicar v{nextVersion}? Se congela una copia exacta de {bench.slug} (definición, preguntas, papers y resultados) en
                  published/v{nextVersion}, y desde ahora nada de eso se edita.
                </p>
                <div className="ws-row-btns">
                  <button className="ws-btn-dark sm" disabled={busy} onClick={() => void doPublish()}>
                    Sí, publicar v{nextVersion}
                  </button>
                  <button className="ws-btn-line sm" onClick={() => setConfirming(null)}>
                    Cancelar
                  </button>
                </div>
              </>
            ) : (
              <>
                <label>
                  <span className="t">Nota de esta versión (opcional)</span>
                  <input
                    value={note}
                    maxLength={280}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={lastVersion ? "Qué cambia respecto de la versión anterior" : "Qué mide esta primera versión"}
                  />
                </label>
                <button
                  className="ws-publish"
                  disabled={busy || missing.length > 0}
                  title={missing.length ? `Falta: ${missing.map((m) => m.label.toLowerCase()).join(" · ")}` : `Congela v${nextVersion} y deja el benchmark listo para citar`}
                  onClick={() => setConfirming("publish")}
                >
                  {busy ? "Publicando…" : `Publicar v${nextVersion} y congelar`}
                </button>
              </>
            )}
            <p className="ws-note">
              {published
                ? "Un benchmark publicado se puede evaluar y citar. Para cambiar su definición, revertí la publicación: la versión congelada no se toca."
                : "Mientras no esté publicado, el benchmark se edita como siempre. Publicar no borra nada: la copia queda al lado de la que seguís usando."}
            </p>
          </div>
          {versions.length > 0 && (
            <div className="ws-card ws-pad ws-stack">
              <p className="ws-eyebrow">Versiones publicadas · la más reciente primero</p>
              <div className="ws-versions">
                {versions.map((v) => (
                  <div key={v.version} className="ws-version">
                    <span className="v">v{v.version}</span>
                    <span className="t">{v.note || (published && v.version === lastVersion ? "La versión publicada hoy" : "Versión congelada")}</span>
                    <span className="d">
                      {v.at ? since(new Date(v.at).getTime() / 1000) : ""}
                      {v.by ? ` · ${v.by}` : ""} · {v.files} archivos · {bench.slug}/published/v{v.version}
                    </span>
                  </div>
                ))}
              </div>
              <p className="ws-note">Cada versión guarda su propio manifiesto: qué archivos tenía y cuándo se congelaron.</p>
            </div>
          )}
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
            <p className="ws-eyebrow">Qué preguntas entran · vista previa</p>
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
            <p className="ws-eyebrow">Las preguntas, ¿se ven? · vista previa</p>
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
          <p className="ws-note center">
            La publicación guarda la definición y lo que ya se midió. Estas dos decisiones entran en la ficha pública cuando llegue el tablero.
          </p>
        </div>
      </div>
    </>
  );
}
