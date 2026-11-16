import { describe, expect, it } from "vitest";
import {
  TOUR_STEPS,
  advanceFrom,
  advanceWouldStall,
  currentStepIndex,
  loadTourState,
  resolveTourRoute,
  saveTourState,
  stepAvailable,
  tourKey,
  tourStepsFor,
} from "./tour";

// In-memory localStorage: the pure model reads/writes it under try/catch.
function stubStorage() {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
  return m;
}

const WITH_BENCH = { hasBench: true };
const NO_BENCH = { hasBench: false };

describe("walkthrough first-visit state", () => {
  it("is eligible when nothing is stored, and remembers off/done verbatim", () => {
    stubStorage();
    expect(loadTourState("u1")).toBeNull(); // absent means eligible
    saveTourState("u1", { s: "off", i: 3 });
    expect(localStorage.getItem(tourKey("u1"))).toBe("off");
    expect(loadTourState("u1")).toEqual({ s: "off", i: 0 });
    saveTourState("u1", { s: "done", i: 6 });
    expect(localStorage.getItem(tourKey("u1"))).toBe("done");
    expect(loadTourState("u1")).toEqual({ s: "done", i: 0 });
  });

  it("resumes mid-tour: the progress index survives a reload", () => {
    stubStorage();
    saveTourState("u1", { s: "on", i: 4 });
    expect(loadTourState("u1")).toEqual({ s: "on", i: 4 });
  });

  it("ignores a garbage value and treats the user as eligible again", () => {
    stubStorage();
    localStorage.setItem(tourKey("u1"), "not-json");
    expect(loadTourState("u1")).toBeNull();
  });
});

describe("walkthrough step model", () => {
  it("orders the steps: home first, then the workspace stages", () => {
    expect(tourStepsFor("home").map((s) => s.id)).toEqual(["home-new", "nuevo-create"]);
    expect(tourStepsFor("workspace").map((s) => s.id)).toEqual(["ws-criterios", "ws-fuentes", "ws-autoria", "ws-evaluacion", "ws-resultados", "ws-publicacion"]);
    expect(new Set(TOUR_STEPS.map((s) => s.anchor)).size).toBe(TOUR_STEPS.length);
  });

  it("advances one step per click and finishes at Empezar", () => {
    expect(advanceFrom(TOUR_STEPS, 0, "b1")).toEqual({ state: { s: "on", i: 1 }, route: "/app/nuevo" });
    expect(advanceFrom(TOUR_STEPS, 1, "b1")).toEqual({ state: { s: "on", i: 2 }, route: "/app/b/b1/criterios" });
    expect(advanceFrom(TOUR_STEPS, 5, "b1").state).toEqual({ s: "on", i: 6 });
    expect(advanceFrom(TOUR_STEPS, 6, "b1")).toEqual({ state: { s: "on", i: 7 }, route: "/app/b/b1/publicacion" });
    expect(advanceFrom(TOUR_STEPS, 7, "b1")).toEqual({ state: { s: "done", i: 7 }, route: null });
  });

  it("skips the workspace steps when the org has no benchmark yet", () => {
    expect(TOUR_STEPS.filter((s) => stepAvailable(s, NO_BENCH)).length).toBe(2);
    // On home without a benchmark there is nothing to show; the tour waits
    // dormant (null) until the workspace opens, it never ends early.
    expect(currentStepIndex(TOUR_STEPS, 2, NO_BENCH, "home")).toBeNull();
  });

  it("is dormant on home while its step lives in the workspace, and resumes there", () => {
    // Persisted on a workspace step, but the page is home: nothing to show.
    expect(currentStepIndex(TOUR_STEPS, 3, WITH_BENCH, "home")).toBeNull();
    // Persisted on home steps, but the user opened a benchmark: skip ahead.
    expect(currentStepIndex(TOUR_STEPS, 1, WITH_BENCH, "workspace")).toBe(2);
    expect(currentStepIndex(TOUR_STEPS, 2, WITH_BENCH, "workspace")).toBe(2);
  });

  it("routes each workspace step to its stage, encoding the slug", () => {
    expect(resolveTourRoute(TOUR_STEPS[2], "mi bench")).toBe("/app/b/mi%20bench/criterios");
    expect(resolveTourRoute(TOUR_STEPS[3], "x")).toBe("/app/b/x/fuentes");
    expect(resolveTourRoute(TOUR_STEPS[6], "x")).toBe("/app/b/x/resultados");
    expect(resolveTourRoute(TOUR_STEPS[7], "x")).toBe("/app/b/x/publicacion");
    expect(resolveTourRoute(TOUR_STEPS[0], "x")).toBeNull();
    // No benchmark known yet: the tour does not navigate to a workspace step.
    expect(resolveTourRoute(TOUR_STEPS[3])).toBeNull();
  });
});

describe("walkthrough stall guard", () => {
  it("reproduces the bug: Siguiente on the nuevo step would advance into the void", () => {
    // On /app/nuevo there is no slug, so the next step's route can't open and
    // every later step is dormant on this page — the card would vanish.
    expect(advanceFrom(TOUR_STEPS, 1, undefined).route).toBeNull();
    expect(advanceWouldStall(TOUR_STEPS, 1, NO_BENCH, "nuevo")).toBe(true);
    // Same with a benchmark the page doesn't know: still no route from here.
    expect(advanceWouldStall(TOUR_STEPS, 1, WITH_BENCH, "nuevo")).toBe(true);
  });

  it("never stalls when the advance opens a route or finishes the tour", () => {
    expect(advanceWouldStall(TOUR_STEPS, 0, NO_BENCH, "home")).toBe(false); // /app/nuevo
    expect(advanceWouldStall(TOUR_STEPS, 0, WITH_BENCH, "home")).toBe(false);
    expect(advanceWouldStall(TOUR_STEPS, 2, WITH_BENCH, "workspace", "b1")).toBe(false);
    expect(advanceWouldStall(TOUR_STEPS, 6, WITH_BENCH, "workspace", "b1")).toBe(false);
    expect(advanceWouldStall(TOUR_STEPS, 7, WITH_BENCH, "workspace", "b1")).toBe(false); // done
  });

  it("does not stall when the next step renders on this same page", () => {
    // Persisted at a home step while on home: advancing walks to nuevo-create,
    // whose route opens — covered above. A step whose successor lives on the
    // same page is fine even without a route: build a two-step home-only tour.
    const steps: typeof TOUR_STEPS = [
      { id: "a", anchor: "a", page: "home", title: "a", text: "a" },
      { id: "b", anchor: "b", page: "home", title: "b", text: "b" },
    ];
    expect(advanceWouldStall(steps, 0, NO_BENCH, "home")).toBe(false);
    expect(advanceWouldStall(steps, 0, NO_BENCH, "workspace")).toBe(true);
  });
});
