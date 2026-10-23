import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { rememberConversation, usePlatform, type BenchSummary } from "./store";
import { statusOf } from "./platform-app";
import { api, since } from "./data";
import type { Activity } from "../app/api";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";

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

/** The org home's numbers, straight from the benchmarks the store already has. */
export function orgStats(benches: BenchSummary[]) {
  const items = benches.reduce((s, b) => s + (b.items ?? 0), 0);
  const evaluated = benches.filter((b) => b.runs.length > 0).length;
  const scores = benches.map((b) => b.best).filter((v): v is number => v != null);
  return { benches: benches.length, items, evaluated, best: scores.length ? Math.max(...scores) : null };
}

export default function Home() {
  const { me, benches, files, loadError, refresh } = usePlatform();
  const [, navigate] = useLocation();
  const loading = files === null;
  const empty = !loading && benches.length === 0;
  // Slug asked to be deleted: the row becomes the confirmation. "busy" while
  // the Worker and the agent remove it.
  const [removing, setRemoving] = useState<string | null>(null);
  const [removingState, setRemovingState] = useState<"idle" | "busy" | "failed">("idle");
  const stats = orgStats(benches);

  async function confirmRemove(b: BenchSummary) {
    setRemovingState("busy");
    try {
      const r = await api.removeBenchmark(b.slug);
      if (!r.ok) throw new Error("refused");
      // The conversation for it stays in the record; the local pointer goes.
      rememberConversation(b.slug, null);
      setRemoving(null);
      setRemovingState("idle");
      await refresh();
    } catch {
      setRemovingState("failed");
    }
  }

  return (
    <section className="bp-page">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1 className="bp-h1">{me?.org?.name ?? "Tu organización"}</h1>
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

      {loadError && <p className="bp-error" style={{ marginTop: 16 }}>No pudimos cargar los benchmarks de tu organización. {loadError}</p>}

      {!loading && benches.length > 0 && (
        <div className="card" style={{ marginTop: 24, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 16, padding: "18px 22px" }}>
          {[
            { k: "Evaluaciones", v: String(stats.benches) },
            { k: "Ítems", v: String(stats.items) },
            { k: "Con evaluación hecha", v: String(stats.evaluated) },
            { k: "Mejor puntaje", v: stats.best == null ? "—" : stats.best.toFixed(2) },
          ].map((s) => (
            <div key={s.k}>
              <div className="eyebrow" style={{ fontSize: 10 }}>{s.k}</div>
              <div style={{ fontSize: 24, fontWeight: 500, letterSpacing: "-.02em", marginTop: 4 }}>{s.v}</div>
            </div>
          ))}
        </div>
      )}

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
            <span />
          </div>
          {benches.map((b) => {
            const st = statusOf(b.validation);
            const meta = [b.slug, b.doc?.domain, b.doc?.task, b.doc?.language].filter(Boolean).join(" · ");
            const title = b.doc?.title ?? b.slug;
            if (removing === b.slug) {
              return (
                <div key={b.slug} className="bp-row bp-row-confirm">
                  <span style={{ minWidth: 0 }}>
                    <span className="t">¿Eliminar «{title}»?</span>
                    <span className="m">Se borran las preguntas, fuentes, validaciones y evaluaciones. No hay vuelta atrás.</span>
                  </span>
                  <span />
                  <span />
                  <span />
                  <span className="bp-confirm-actions">
                    <button className="bp-btn-danger" disabled={removingState === "busy"} onClick={() => void confirmRemove(b)}>
                      {removingState === "busy" ? "Eliminando…" : "Eliminar"}
                    </button>
                    <button className="bp-btn-line" disabled={removingState === "busy"} onClick={() => { setRemoving(null); setRemovingState("idle"); }}>
                      Cancelar
                    </button>
                  </span>
                  {removingState === "failed" && <span className="m" style={{ gridColumn: "1 / -1" }}>No se pudo eliminar. Probá de nuevo.</span>}
                </div>
              );
            }
            return (
              <ContextMenu key={b.slug}>
                <ContextMenuTrigger asChild>
              <div
                className="bp-row bp-row-click"
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/app/b/${encodeURIComponent(b.slug)}/autoria`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    navigate(`/app/b/${encodeURIComponent(b.slug)}/autoria`);
                  }
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span className="t">{title}</span>
                  <span className="m">{meta}</span>
                </span>
                <span className="num col-items">{b.items ?? "—"}</span>
                <span className="num strong">{b.best == null ? "—" : b.best.toFixed(2)}</span>
                <span className="when col-when">{b.runs[0] ? since(b.runs[0].modified) : "sin corridas"}</span>
                <span className={`badge ${st}`}>
                  {b.validation && !b.validation.ok ? b.validation.error.code : STATUS_LABEL[st]}
                </span>
                <button
                  className="bp-del"
                  aria-label={`Eliminar el benchmark ${title}`}
                  title="Eliminar"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRemoving(b.slug);
                    setRemovingState("idle");
                  }}
                >
                  ×
                </button>
              </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    className="text-destructive"
                    onSelect={() => {
                      setRemoving(b.slug);
                      setRemovingState("idle");
                    }}
                  >
                    Eliminar benchmark…
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
      )}

      <OrgActivity />

      <div className="card" style={{ marginTop: 24 }}>
        <div className="card-head">
          <span className="eyebrow">Configuración</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 22px" }}>
          <span style={{ minWidth: 0 }}>
            <span className="t" style={{ display: "block", fontSize: 15 }}>Cuenta y modelo juez</span>
            <span className="m" style={{ display: "block", fontSize: 13 }}>Tu nombre, las formas de ingresar y el juez default de la organización.</span>
          </span>
          <button className="bp-btn-line" onClick={() => navigate("/app/cuenta")}>Abrir cuenta</button>
        </div>
        {me?.org && <BrandingCard />}
      </div>

      {empty && (
        <div className="bp-empty">
          <span role="img" aria-label="benchy agent">
            <Pip variant="idle" />
          </span>
          <h2 style={{ margin: "20px 0 0", fontSize: 22, fontWeight: 500, letterSpacing: "-.015em" }}>Todavía no hay benchmarks</h2>
          <p style={{ margin: "8px 0 0", maxWidth: "30rem", fontSize: 15, lineHeight: 1.6 }} className="body">
            Un benchmark es un examen de tu campo para los modelos: preguntas con su respuesta experta y sus criterios de evaluación. Escribilas vos o partí de
            tus papers.
          </p>
          <button className="btn" style={{ marginTop: 20 }} onClick={() => navigate("/app/nuevo")}>
            Crear un benchmark
          </button>
        </div>
      )}
    </section>
  );
}

const FILES: Record<string, string> = {
  "exam.jsonl": "las preguntas y respuestas",
  "questions.json": "las notas de las preguntas",
  "benchmark.yaml": "los criterios de evaluación y la definición",
  "report.md": "el informe",
};

/** One line of the record: "Ana editó las preguntas y respuestas". */
export function activityLine(a: Activity): string {
  if (a.kind === "edit") return `${a.who} editó ${FILES[a.detail] ?? a.detail}`;
  return `${a.who} ${a.detail}`;
}

/** What the organization did lately, and who: kept in D1 for every member. */
function OrgActivity() {
  const { benches } = usePlatform();
  const [, navigate] = useLocation();
  const [items, setItems] = useState<Activity[] | null>(null);
  useEffect(() => {
    void api
      .activity(undefined, 15)
      .then((r) => setItems(r.activity))
      .catch(() => setItems([]));
  }, []);
  if (!items || items.length === 0) return null;
  return (
    <div className="card bp-activity">
      <div className="card-head">
        <span className="eyebrow">Actividad de la organización</span>
      </div>
      {items.map((a) => {
        const bench = benches.find((b) => b.slug === a.bench);
        return (
          <button key={a.id} className="bp-act-row" onClick={() => a.bench && navigate(`/app/b/${encodeURIComponent(a.bench)}/autoria`)}>
            <span className="t">{activityLine(a)}</span>
            <span className="b">{bench?.doc?.title ?? a.bench}</span>
            <span className="w">{since(Date.parse(a.createdAt) / 1000)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The org's visual identity (issue #5): an accent color and a tagline that
 *  the findings report and the publication card co-brand with. */
function BrandingCard() {
  const { me, reloadMe } = usePlatform();
  const [color, setColor] = useState(me?.org?.brandColor ?? "");
  const [tagline, setTagline] = useState(me?.org?.brandTagline ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  useEffect(() => {
    setColor(me?.org?.brandColor ?? "");
    setTagline(me?.org?.brandTagline ?? "");
  }, [me?.org?.brandColor, me?.org?.brandTagline]);
  const clean = isBrandColor(color) ? color : "";
  const dirty = clean !== (me?.org?.brandColor ?? "") || tagline.trim() !== (me?.org?.brandTagline ?? "");

  async function save() {
    setState("saving");
    try {
      await api.setOrgBranding({ color: clean || null, tagline: tagline.trim() || null });
      // `me` carries the org's brand: reload it so the heading and the chip
      // show the new identity without a page reload.
      await reloadMe();
      setState("saved");
    } catch {
      setState("error");
    }
  }

  return (
    <div style={{ padding: "16px 22px", borderTop: "1px solid var(--line-soft)", display: "grid", gap: 12 }}>
      <p className="body" style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>
        Identidad visual de tu organización. Se aplica a los informes y publicaciones: el color acompaña el membrete y la bajada aparece bajo el nombre.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <input
          type="color"
          value={clean || "#0f766e"}
          onChange={(e) => {
            setColor(e.target.value);
            setState("idle");
          }}
          aria-label="Color de la identidad"
          style={{ width: 44, height: 34, padding: 2 }}
        />
        <input
          value={color}
          onChange={(e) => {
            setColor(e.target.value);
            setState("idle");
          }}
          placeholder="#rrggbb"
          spellCheck={false}
          style={{ width: 110 }}
        />
        <input
          value={tagline}
          onChange={(e) => {
            setTagline(e.target.value);
            setState("idle");
          }}
          placeholder="Bajada corta, si querés (hasta 120 caracteres)"
          maxLength={120}
          style={{ flex: 1, minWidth: 220 }}
        />
        <button className="btn-ghost" onClick={() => void save()} disabled={state === "saving" || !dirty}>
          {state === "saving" ? "Guardando…" : state === "saved" ? "Guardado" : "Guardar"}
        </button>
      </div>
      {color && !isBrandColor(color) && <span style={{ color: "var(--fail)", fontSize: 13 }}>El color tiene que ser un hexadecimal, por ejemplo #1e6fd9.</span>}
      {state === "error" && <span style={{ color: "var(--fail)", fontSize: 13 }}>No se pudo guardar.</span>}
    </div>
  );
}

/** A brand color is exactly "#rrggbb"; anything else is treated as none. */
export function isBrandColor(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v);
}
