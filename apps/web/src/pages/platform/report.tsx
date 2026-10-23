import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "wouter";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, ApiError, errorText, spellcheckFor, type Analysis } from "./data";
import { usePlatform } from "./store";
import { letterheadName } from "./publication";
import "./report.css";

// /app/b/:slug/informe — the findings report on the SURUS letterhead, with the
// organization's name beside SURUS's, and an annex of result tables built from
// the analysis so the numbers are exact. What it shows (and printing it, A4,
// gives the PDF) is the effective report: the version edited by hand here when
// there is one — report.md as the agent wrote it stays intact in the workspace
// and shows again if the edit is discarded.

const FONTS = "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap";

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

/** The report as the platform serves it: the hand edit when there is one, else the agent's report.md. */
type ReportState = { bench: string; source: "edited" | "generated" | null; markdown: string | null; updatedAt: string | null };

async function reportCall(path: string, init?: RequestInit): Promise<ReportState> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError("NETWORK", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `HTTP_${res.status}`, res.status);
  }
  return (await res.json()) as ReportState;
}

const getReport = (bench: string) => reportCall(`/api/workspace/report?bench=${encodeURIComponent(bench)}`);
/** Save the hand edit, or drop it (markdown null) and show the generated report again. */
const putReport = (bench: string, markdown: string | null) =>
  reportCall("/api/workspace/report", { method: "PUT", body: JSON.stringify({ bench, markdown }) });

export default function ReportPage({ slug }: { slug: string }) {
  const { me, benches, files } = usePlatform();
  const bench = benches.find((b) => b.slug === slug);
  const [report, setReport] = useState<ReportState | undefined>(undefined);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const reportFile = files?.find((f) => f.path === `${slug}/report.md`);

  useEffect(() => {
    if (document.querySelector(`link[href="${FONTS}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = FONTS;
    document.head.appendChild(link);
  }, []);

  useEffect(() => {
    if (files === null) return;
    let alive = true;
    void getReport(slug).then(
      (r) => alive && setReport(r),
      () => alive && setReport({ bench: slug, source: null, markdown: null, updatedAt: null }),
    );
    return () => {
      alive = false;
    };
  }, [slug, files === null, reportFile?.modified]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!bench) return;
    void api.analysis(bench.yamlPath).then((r) => r.ok && setAnalysis(r), () => {});
  }, [bench?.yamlPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const text = report?.markdown ?? null;
  const edited = report?.source === "edited";
  const title = text?.match(/^#\s+(.+)$/m)?.[1] ?? bench?.doc?.title ?? slug;
  const body = text?.replace(/^#\s+.+$/m, "").trim() ?? "";
  const modified = report?.updatedAt ? new Date(report.updatedAt) : new Date();
  const ymd = modified.toISOString().slice(0, 10).replace(/-/g, "");
  const name = letterheadName(me?.org?.name);
  const models = analysis?.models ?? [];

  function startEdit() {
    if (!text) return;
    setDraft(text);
    setSaveError(null);
    setConfirmDiscard(false);
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      setReport(await putReport(slug, draft));
      setEditing(false);
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  async function discard() {
    setDiscarding(true);
    try {
      await putReport(slug, null);
      setReport(await getReport(slug));
      setConfirmDiscard(false);
      setEditing(false);
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setDiscarding(false);
    }
  }

  return (
    <div className="rp" style={me?.org?.brandColor ? ({ "--rp-teal": me.org.brandColor } as CSSProperties) : undefined}>
      <div className="rp-bar">
        <Link href={`/app/b/${encodeURIComponent(slug)}/publicacion`}>← Volver al benchmark</Link>
        <span className="sp" />
        {editing ? (
          <>
            <button className="rp-edit-cancel" disabled={saving} onClick={() => setEditing(false)}>
              Cancelar
            </button>
            <button className="rp-print" disabled={saving || !draft.trim()} onClick={() => void save()}>
              {saving ? "Guardando…" : "Guardar"}
            </button>
          </>
        ) : (
          text && (
            <>
              {edited && <span className="rp-flag">Editado a mano</span>}
              <button className="rp-edit-start" onClick={startEdit}>
                Editar
              </button>
              <button onClick={() => window.print()} className="rp-print">
                Imprimir · guardar PDF
              </button>
            </>
          )
        )}
      </div>

      {report === undefined ? (
        <p className="rp-wait">Cargando el informe…</p>
      ) : text === null ? (
        <p className="rp-wait">
          Este benchmark todavía no tiene informe: se redacta solo cuando termina una evaluación, o desde Publicación → Informe.{" "}
          <Link href={`/app/b/${encodeURIComponent(slug)}/publicacion`}>Ir a Publicación</Link>
        </p>
      ) : editing ? (
        <div className="rp-edit">
          <p className="rp-edit-note">
            Estás tocando el informe a mano: al guardar, esta es la versión que se muestra y se exporta. El informe que generó el agente queda
            intacto.
          </p>
          {saveError && <p className="rp-edit-error">{saveError}</p>}
          <div className="rp-edit-cols">
            <textarea
              className="rp-edit-src"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={spellcheckFor(bench?.doc?.language ?? "")}
              aria-label="Informe en markdown"
            />
            <div className="rp-edit-preview rp-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown>
            </div>
          </div>
        </div>
      ) : (
        <>
          {edited && (
            <p className="rp-edited-note">
              Editado a mano — el informe generado queda intacto.{" "}
              {confirmDiscard ? (
                <>
                  ¿Segura/o? se pierde la edición.{" "}
                  <button className="rp-link" disabled={discarding} onClick={() => void discard()}>
                    {discarding ? "Descartando…" : "Sí, descartar"}
                  </button>
                  {" · "}
                  <button className="rp-link" disabled={discarding} onClick={() => setConfirmDiscard(false)}>
                    No, quedármela
                  </button>
                </>
              ) : (
                <button className="rp-link" onClick={() => setConfirmDiscard(true)}>
                  Descartar la edición
                </button>
              )}
              {saveError && !confirmDiscard && <span className="rp-edit-error"> {saveError}</span>}
            </p>
          )}
          <article className="rp-page">
            <header className="rp-head">
              <div className="brand">
                <img src="/brand/surus-logo.png" alt="" />
                <div>
                  <div className="name">{name}</div>
                  <div className="tag">Building the Intelligence Layer</div>
                </div>
              </div>
              <div className="kind">Informe de resultados</div>
            </header>

            <div className="rp-meta">
              <div>
                <div className="k">Referencia</div>
                <div className="v">BENCHY-{slug.toUpperCase()}-{ymd}</div>
              </div>
              <div>
                <div className="k">Fecha</div>
                <div className="v">{modified.toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric" })}</div>
              </div>
              <div>
                <div className="k">Benchmark</div>
                <div className="v">{bench?.doc?.title ?? slug}</div>
              </div>
            </div>

            <div className="rp-eyebrow">Benchy · evaluación de modelos de IA{me?.org?.name ? ` · ${me.org.name}` : ""}</div>
            {me?.org?.brandTagline && <p className="rp-tagline">{me.org.brandTagline}</p>}
            <h1 className="rp-title">{title}</h1>

            <div className="rp-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>

              {models.length > 0 && (
                <section className="rp-annex">
                  <h2>Anexo · Resultados</h2>
                  <p>
                    La corrida más reciente de cada modelo. Puntaje de 0 a 1; juez: {analysis?.grader ?? "—"}.
                    {models.some((m) => m.stale) ? " Las marcadas con * son de una versión anterior del examen." : ""}
                  </p>
                  <table>
                    <thead>
                      <tr>
                        <th>Modelo</th>
                        <th>Región</th>
                        <th>Puntaje</th>
                        <th>Respuestas válidas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {models.map((m) => (
                        <tr key={m.model}>
                          <td>
                            {m.name}
                            {m.maker ? ` (${m.maker})` : ""}
                            {m.stale ? " *" : ""}
                          </td>
                          <td>{m.region}</td>
                          <td>{m.score?.toFixed(2) ?? "—"}</td>
                          <td>
                            {m.summary.valid ?? "—"} de {m.summary.examples ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {analysis!.criteria.length > 0 && (
                    <table>
                      <thead>
                        <tr>
                          <th>Criterio (importancia)</th>
                          {models.map((m) => (
                            <th key={m.model}>{m.name}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {analysis!.criteria.map((c) => (
                          <tr key={c.key}>
                            <td>
                              {c.description || c.key} ({c.weight})
                            </td>
                            {models.map((m) => (
                              <td key={m.model}>{pct(m.criteria[c.key])}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {analysis!.groups.length > 1 && (
                    <table>
                      <thead>
                        <tr>
                          <th>Tema</th>
                          {models.map((m) => (
                            <th key={m.model}>{m.name}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {analysis!.groups.map((g) => (
                          <tr key={g}>
                            <td>{g}</td>
                            {models.map((m) => (
                              <td key={m.model}>{m.groups[g]?.toFixed(2) ?? "—"}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <p className="fine">
                    {analysis!.questions.length} preguntas de respuesta abierta, cada una juzgada contra la respuesta experta con los criterios de evaluación.
                    {analysis!.papers.length ? ` Fuentes: ${analysis!.papers.map((p) => p.title).join("; ")}.` : ""}
                  </p>
                </section>
              )}
            </div>

            <footer className="rp-foot">
              <div>GRADIENTESUR LLC (opera como SURUS) · LLC, Estado de Delaware · EIN 32-0800531 · 254 Chapman Rd, Ste 209, Newark, DE 19702</div>
              <div className="links">
                <a href="https://surus.lat">surus.lat</a>
                <a href="https://getbenchy.lat">getbenchy.lat</a>
              </div>
            </footer>
          </article>
        </>
      )}
    </div>
  );
}
