import { useEffect, useState } from "react";
import { Link } from "wouter";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type Analysis } from "./data";
import { usePlatform } from "./store";
import { letterheadName } from "./publication";
import "./report.css";

// /app/b/:slug/informe — the findings report (report.md, written by the agent
// when an evaluation ends, adjusted with the researcher) on the SURUS letterhead, with the organization's name
// beside SURUS's, and an annex of result tables built from the analysis so the
// numbers are exact. Printing it (A4) gives the PDF.

const FONTS = "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap";

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

export default function ReportPage({ slug }: { slug: string }) {
  const { me, benches, files } = usePlatform();
  const bench = benches.find((b) => b.slug === slug);
  const [text, setText] = useState<string | null | undefined>(undefined);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
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
    if (!reportFile) {
      setText(null);
      return;
    }
    void api.text(`${slug}/report.md`).then(setText, () => setText(null));
  }, [slug, files === null, reportFile?.modified]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!bench) return;
    void api.analysis(bench.yamlPath).then((r) => r.ok && setAnalysis(r), () => {});
  }, [bench?.yamlPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const title = text?.match(/^#\s+(.+)$/m)?.[1] ?? bench?.doc?.title ?? slug;
  const body = text?.replace(/^#\s+.+$/m, "").trim() ?? "";
  const modified = reportFile ? new Date(reportFile.modified * 1000) : new Date();
  const ymd = modified.toISOString().slice(0, 10).replace(/-/g, "");
  const name = letterheadName(me?.org?.name);
  const models = analysis?.models ?? [];

  return (
    <div className="rp">
      <div className="rp-bar">
        <Link href={`/app/b/${encodeURIComponent(slug)}/publicacion`}>← Volver al benchmark</Link>
        <span className="sp" />
        {text && (
          <button onClick={() => window.print()} className="rp-print">
            Imprimir · guardar PDF
          </button>
        )}
      </div>

      {text === undefined ? (
        <p className="rp-wait">Cargando el informe…</p>
      ) : text === null ? (
        <p className="rp-wait">
          Este benchmark todavía no tiene informe: se redacta solo cuando termina una evaluación, o desde Publicación → Informe.{" "}
          <Link href={`/app/b/${encodeURIComponent(slug)}/publicacion`}>Ir a Publicación</Link>
        </p>
      ) : (
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
                  {analysis!.questions.length} preguntas de respuesta abierta, cada una juzgada contra la respuesta experta con la rúbrica.
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
      )}
    </div>
  );
}
