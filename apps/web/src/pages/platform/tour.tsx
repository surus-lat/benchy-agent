import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

// Issue #11: first-visit walkthrough. A tour is a sequence of steps anchored to
// the REAL UI (never screenshots): a ring spotlights a control and a small card
// explains it. "Siguiente" advances and navigates with the app's own router;
// the step index is persisted so a reload resumes mid-tour. First-visit state
// lives in localStorage keyed per user: "off" dismissed, "done" finished,
// absent means eligible. Mirrors rememberConversation's try/catch style.

export type TourLevel = "home" | "workspace";
// The page a step is anchored on. "nuevo" is the create-benchmark form, which
// belongs to the home level (the tour starts there and continues into the
// workspace once a benchmark exists).
export type TourPage = "home" | "nuevo" | "workspace";

export type TourStep = {
  id: string;
  /** Id of the anchor element this step highlights. */
  anchor: string;
  page: TourPage;
  title: string;
  text: string;
  /** App route the step opens from; "{slug}" is replaced with the benchmark. */
  route?: string;
  /** The workspace steps need at least one benchmark to make sense. */
  requireBench?: boolean;
};

export type TourState = { s: "on" | "off" | "done"; i: number };

const PAGE_LEVEL: Record<TourPage, TourLevel> = { home: "home", nuevo: "home", workspace: "workspace" };
// Flow order: home → nuevo → workspace. A step of an earlier page is left
// behind; a step of a later page makes the tour dormant on this page.
const PAGE_RANK: Record<TourPage, number> = { home: 0, nuevo: 1, workspace: 2 };

// One continuous list: home first, then the workspace stages in the real flow
// order (fuentes → autoría → revisión → evaluación → publicación).
export const TOUR_STEPS: TourStep[] = [
  {
    id: "home-new",
    anchor: "tour-home-new",
    page: "home",
    title: "Nuevo benchmark",
    text: "Para crear tu primera evaluación, empezá acá: un benchmark es un examen de tu campo para los modelos.",
  },
  {
    id: "nuevo-create",
    anchor: "tour-nuevo-create",
    page: "nuevo",
    route: "/app/nuevo",
    title: "Creá y abrí",
    text: "Ponele un nombre y crealo: se abre en Fuentes, donde elegís las bases del examen.",
  },
  {
    id: "ws-fuentes",
    anchor: "tour-ws-tab-fuentes",
    page: "workspace",
    route: "/app/b/{slug}/fuentes",
    requireBench: true,
    title: "01 · Fuentes",
    text: "Subí o buscá las fuentes sobre las que vas a examinar: las preguntas salen de acá.",
  },
  {
    id: "ws-autoria",
    anchor: "tour-ws-calidad",
    page: "workspace",
    route: "/app/b/{slug}/autoria",
    requireBench: true,
    title: "02 · Autoría",
    text: "Escribí preguntas o pedí un lote al agente, y medilas con Verificar calidad.",
  },
  {
    id: "ws-revision",
    anchor: "tour-ws-revision",
    page: "workspace",
    route: "/app/b/{slug}/revision",
    requireBench: true,
    title: "03 · Revisión",
    text: "Antes de evaluar, el juez revisa cada respuesta experta y vos aprobás la pregunta.",
  },
  {
    id: "ws-evaluacion",
    anchor: "tour-ws-ejecutar",
    page: "workspace",
    route: "/app/b/{slug}/evaluacion",
    requireBench: true,
    title: "04 · Evaluación",
    text: "Elegí los modelos y tocá Ejecutar evaluación: el agente los corre sobre el examen.",
  },
  {
    id: "ws-publicacion",
    anchor: "tour-ws-tab-publicacion",
    page: "workspace",
    route: "/app/b/{slug}/publicacion",
    requireBench: true,
    title: "05 · Publicación",
    text: "Leé el informe de la corrida en Análisis y publicalo: ya tenés tu evaluación hecha.",
  },
];

export function tourStepsFor(level: TourLevel): TourStep[] {
  return TOUR_STEPS.filter((st) => PAGE_LEVEL[st.page] === level);
}

// ── localStorage (per user) ────────────────────────────────────────────────

export function tourKey(userId: string) {
  return `benchy-tour:${userId}`;
}

/** The stored state, or null when the user is eligible (nothing stored yet). */
export function loadTourState(userId: string | undefined | null): TourState | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(tourKey(userId));
    if (raw === "off") return { s: "off", i: 0 };
    if (raw === "done") return { s: "done", i: 0 };
    if (!raw) return null;
    const v = JSON.parse(raw) as TourState;
    if ((v.s === "on" || v.s === "off" || v.s === "done") && Number.isInteger(v.i)) return v;
    return null;
  } catch {
    // Private mode: the tour still works in-memory, just not remembered.
    return null;
  }
}

export function saveTourState(userId: string | undefined | null, st: TourState) {
  if (!userId) return;
  try {
    // Finished or dismissed: store the bare word. Mid-tour: store the index
    // too, so a reload resumes where the walkthrough left off.
    localStorage.setItem(tourKey(userId), st.s === "on" ? JSON.stringify(st) : st.s);
  } catch {
    // Same: not remembered across reloads, but the tour keeps running.
  }
}

// ── pure step-resolution helpers ───────────────────────────────────────────

export type TourOpts = { hasBench: boolean };

export function stepAvailable(step: TourStep, o: TourOpts): boolean {
  return !step.requireBench || o.hasBench;
}

/**
 * The step to show on `page` given the persisted index `from`: steps that need
 * a benchmark the org doesn't have are skipped, steps of an earlier page are
 * left behind, and a step of a later page makes the tour dormant here (null)
 * until its page opens.
 */
export function currentStepIndex(steps: TourStep[], from: number, o: TourOpts, page: TourPage): number | null {
  for (let i = Math.max(0, from); i < steps.length; i++) {
    const st = steps[i];
    if (!stepAvailable(st, o)) continue;
    const rank = PAGE_RANK[st.page];
    if (rank < PAGE_RANK[page]) continue;
    if (rank > PAGE_RANK[page]) return null;
    return i;
  }
  return null;
}

export function resolveTourRoute(step: TourStep, slug?: string): string | null {
  if (!step.route) return null;
  // A workspace route without a known benchmark: the user gets there on their
  // own (creating or opening one), so the tour does not navigate there itself.
  if (step.route.includes("{slug}")) return slug ? step.route.replace("{slug}", encodeURIComponent(slug)) : null;
  return step.route;
}

/** "Siguiente" on step i: the state to persist and the route to open. */
export function advanceFrom(steps: TourStep[], i: number, slug?: string): { state: TourState; route: string | null } {
  if (i >= steps.length - 1) return { state: { s: "done", i }, route: null };
  return { state: { s: "on", i: i + 1 }, route: resolveTourRoute(steps[i + 1], slug) };
}

// ── anchor registry ────────────────────────────────────────────────────────
// Anchors register their DOM node by id; the overlay re-renders when the
// registry version changes, and waits (capped) for an anchor to appear.

const anchorEls = new Map<string, HTMLElement>();
const anchorSubs = new Set<() => void>();
let anchorVersion = 0;

function bumpAnchors() {
  anchorVersion++;
  for (const fn of anchorSubs) fn();
}

/** Ref callback for any existing element: <button ref={tourAnchorRef("x")} />. */
export function tourAnchorRef(id: string) {
  return (el: HTMLElement | null) => {
    if (el) anchorEls.set(id, el);
    else anchorEls.delete(id);
    bumpAnchors();
  };
}

function useAnchorVersion(): number {
  return useSyncExternalStore(
    (onChange) => {
      anchorSubs.add(onChange);
      return () => anchorSubs.delete(onChange);
    },
    () => anchorVersion,
    () => anchorVersion,
  );
}

/** Wrap a control to make it a tour anchor (layout-neutral inline-flex). */
export function TourAnchor({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span ref={tourAnchorRef(id)} className="tour-anchor">
      {children}
    </span>
  );
}

// ── the overlay ────────────────────────────────────────────────────────────

type Rect = { top: number; left: number; width: number; height: number };

/** How long the overlay waits for a not-yet-rendered anchor before skipping. */
export const ANCHOR_WAIT_MS = 4000;

export function Tour({
  page,
  slug,
  hasBench,
  userId,
  navigate,
}: {
  page: TourPage;
  slug?: string;
  hasBench: boolean;
  userId: string | undefined | null;
  navigate: (to: string) => void;
}) {
  const version = useAnchorVersion();
  const [st, setSt] = useState<TourState | null>(() => loadTourState(userId));
  // The first visit starts the tour at step 0 once the user is known.
  useEffect(() => {
    if (userId && st === null) setSt({ s: "on", i: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const persist = useCallback(
    (next: TourState) => {
      saveTourState(userId, next);
      setSt(next);
    },
    [userId],
  );

  const opts: TourOpts = { hasBench };
  const idx = st && st.s === "on" ? currentStepIndex(TOUR_STEPS, st.i, opts, page) : null;
  const step = idx != null ? TOUR_STEPS[idx] : null;

  // Leave behind steps from earlier pages (persist so a reload doesn't walk back).
  useEffect(() => {
    if (st && st.s === "on" && idx != null && idx !== st.i) setSt({ ...st, i: idx });
  }, [st, idx]);

  function advance() {
    if (!st || idx == null) return;
    const { state, route } = advanceFrom(TOUR_STEPS, idx, slug);
    persist(state);
    if (route) navigate(route);
  }

  function dismiss() {
    persist({ s: "off", i: st?.i ?? 0 });
  }

  // Wait for the anchor to appear (the stage may still be rendering); after
  // the cap, skip the step.
  const [anchorRect, setAnchorRect] = useState<Rect | null>(null);
  useEffect(() => {
    if (!step) {
      setAnchorRect(null);
      return;
    }
    let stopped = false;
    const started = Date.now();
    const look = () => {
      const el = anchorEls.get(step.anchor);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (!stopped) setAnchorRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      return true;
    };
    if (look()) return;
    const timer = setInterval(() => {
      if (look()) {
        clearInterval(timer);
      } else if (Date.now() - started > ANCHOR_WAIT_MS) {
        // The anchor never showed: advance past this step.
        clearInterval(timer);
        advance();
      }
    }, 200);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.anchor, version]);

  // Escape dismisses the whole walkthrough.
  useEffect(() => {
    if (!step) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.id]);

  // Focus the primary button on every step so keyboard users land in the card.
  const btnRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    btnRef.current?.focus();
  }, [step?.id]);

  if (!step || idx == null || !userId) return null;

  const last = idx >= TOUR_STEPS.length - 1;
  const pad = 10;
  // Card placement: below the anchor when there is room, above otherwise.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardW = Math.min(340, vw - 24);
  let top = 24;
  let left = 12;
  if (anchorRect) {
    const below = anchorRect.top + anchorRect.height + pad + 150;
    top = below < vh ? anchorRect.top + anchorRect.height + pad : Math.max(12, anchorRect.top - 150 - pad);
    left = Math.min(Math.max(12, anchorRect.left + anchorRect.width / 2 - cardW / 2), vw - cardW - 12);
  }

  return (
    <div className="tour-root">
      {/* The ring's huge shadow spread dims everything outside it. Both the
          dim and the ring are pointer-events:none: the highlighted control
          stays visible and clickable, only the card takes input. */}
      {!anchorRect && <div className="tour-backdrop" aria-hidden="true" />}
      {anchorRect && (
        <div
          className="tour-ring"
          aria-hidden="true"
          style={{
            top: anchorRect.top - pad,
            left: anchorRect.left - pad,
            width: anchorRect.width + pad * 2,
            height: anchorRect.height + pad * 2,
          }}
        />
      )}
      <div className="tour-card" role="dialog" aria-label="Walkthrough" style={{ top, left, width: cardW }}>
        <p className="tour-eyebrow">
          Paso {idx + 1} de {TOUR_STEPS.length}
        </p>
        <h3>{step.title}</h3>
        <p className="tour-text">{step.text}</p>
        <div className="tour-actions">
          <button ref={btnRef} className="tour-btn" onClick={advance}>
            {last ? "Empezar" : "Siguiente"}
          </button>
          <button className="tour-btn-line" onClick={dismiss}>
            Saltar walkthrough
          </button>
        </div>
      </div>
    </div>
  );
}
