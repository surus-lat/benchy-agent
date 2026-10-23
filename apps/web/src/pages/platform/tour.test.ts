import { describe, expect, it } from "vitest";
import {
  TOUR_STEPS,
  advanceFrom,
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
    expect(tourStepsFor("workspace").map((s) => s.id)).toEqual(["ws-fuentes", "ws-autoria", "ws-revision", "ws-evaluacion", "ws-publicacion"]);
    expect(new Set(TOUR_STEPS.map((s) => s.anchor)).size).toBe(TOUR_STEPS.length);
  });

  it("advances one step per click and finishes at Empezar", () => {
    expect(advanceFrom(TOUR_STEPS, 0, "b1")).toEqual({ state: { s: "on", i: 1 }, route: "/app/nuevo" });
    expect(advanceFrom(TOUR_STEPS, 1, "b1")).toEqual({ state: { s: "on", i: 2 }, route: "/app/b/b1/fuentes" });
    expect(advanceFrom(TOUR_STEPS, 5, "b1").state).toEqual({ s: "on", i: 6 });
    expect(advanceFrom(TOUR_STEPS, 6, "b1")).toEqual({ state: { s: "done", i: 6 }, route: null });
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
    expect(resolveTourRoute(TOUR_STEPS[2], "mi bench")).toBe("/app/b/mi%20bench/fuentes");
    expect(resolveTourRoute(TOUR_STEPS[6], "x")).toBe("/app/b/x/publicacion");
    expect(resolveTourRoute(TOUR_STEPS[0], "x")).toBeNull();
    // No benchmark known yet: the tour does not navigate to a workspace step.
    expect(resolveTourRoute(TOUR_STEPS[3])).toBeNull();
  });
});
