import { useLocation } from "wouter";
import { usePlatform } from "./store";
import { statusOf } from "./platform-app";
import { since } from "./data";

export function Pip({ variant = "thinking" }: { variant?: "thinking" | "idle" | "done" | "lg" }) {
  const dots = variant === "idle" ? 1 : 3;
  return (
    <span className={`bp-pip ${variant}`} aria-hidden="true">
      <span className="br l" />
      <span className="dots">
        {Array.from({ length: dots }, (_, i) => (
          <span key={i} className="d" />
        ))}
      </span>
      <span className="br r" />
    </span>
  );
}

const STATUS_LABEL = { valid: "válido", error: "con errores", draft: "borrador" } as const;

export default function Home() {
  const { benches, files, loadError } = usePlatform();
  const [, navigate] = useLocation();
  const loading = files === null;
  const empty = !loading && benches.length === 0;

  return (
    <section className="bp-page">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1 className="bp-h1">Benchmarks</h1>
          <p style={{ margin: "6px 0 0", fontSize: 14 }} className="body">
            {loading
              ? "Cargando…"
              : empty
                ? "Tu organización todavía no tiene benchmarks."
                : `${benches.length} ${benches.length === 1 ? "benchmark" : "benchmarks"} en tu organización`}
          </p>
        </div>
        <button className="btn" onClick={() => navigate("/app/nuevo")}>
          + Nuevo benchmark
        </button>
      </div>

      {loadError && <p className="bp-error" style={{ marginTop: 16 }}>No pudimos leer el workspace ({loadError}).</p>}

      {benches.length > 0 && (
        <div className="card" style={{ marginTop: 24, overflow: "hidden" }}>
          <div className="bp-row head">
            <span>Benchmark</span>
            <span className="col-items" style={{ textAlign: "right" }}>
              Ítems
            </span>
            <span style={{ textAlign: "right" }}>Mejor</span>
            <span className="col-when">Última corrida</span>
            <span>Estado</span>
          </div>
          {benches.map((b) => {
            const st = statusOf(b.validation);
            const meta = [b.slug, b.doc?.domain, b.doc?.task, b.doc?.language].filter(Boolean).join(" · ");
            return (
              <button key={b.slug} className="bp-row" onClick={() => navigate(`/app/b/${encodeURIComponent(b.slug)}/autoria`)}>
                <span style={{ minWidth: 0 }}>
                  <span className="t">{b.doc?.title ?? b.slug}</span>
                  <span className="m">{meta}</span>
                </span>
                <span className="num col-items">{b.items ?? "—"}</span>
                <span className="num strong">{b.best == null ? "—" : b.best.toFixed(2)}</span>
                <span className="when col-when">{b.runs[0] ? since(b.runs[0].modified) : "sin corridas"}</span>
                <span className={`badge ${st}`}>
                  {b.validation && !b.validation.ok ? b.validation.error.code : STATUS_LABEL[st]}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {empty && (
        <div className="bp-empty">
          <span role="img" aria-label="benchy agent">
            <Pip variant="idle" />
          </span>
          <h2 style={{ margin: "20px 0 0", fontSize: 22, fontWeight: 500, letterSpacing: "-.015em" }}>Todavía no hay benchmarks</h2>
          <p style={{ margin: "8px 0 0", maxWidth: "30rem", fontSize: 15, lineHeight: 1.6 }} className="body">
            Contale al agente qué sabe tu campo que los modelos deberían saber. Arma el benchmark con vos.
          </p>
          <button className="btn" style={{ marginTop: 20 }} onClick={() => navigate("/app/nuevo")}>
            Empezar con el agente
          </button>
        </div>
      )}
    </section>
  );
}
