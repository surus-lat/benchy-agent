import { describe, expect, it } from "vitest";
import { ago, badgeText, recentOf, runningOf, STATUS_LABEL, titleOf, type ProcessItem } from "./processes-model";

// The indicator's presentation logic (issue #7).

const NOW = Date.parse("2026-10-17T12:00:00Z");

function proc(partial: Partial<ProcessItem>): ProcessItem {
  return {
    id: "x",
    type: "evaluation",
    status: "running",
    bench: "capitales",
    who: null,
    mine: false,
    detail: null,
    startedAt: "2026-10-17T11:55:00Z",
    finishedAt: null,
    ...partial,
  };
}

describe("ago", () => {
  it("speaks in seconds, minutes, hours, and days — never negative", () => {
    expect(ago("2026-10-17T11:59:40Z", NOW)).toBe("ahora");
    expect(ago("2026-10-17T11:57:00Z", NOW)).toBe("hace 3 min");
    expect(ago("2026-10-17T10:00:00Z", NOW)).toBe("hace 2 h");
    expect(ago("2026-10-15T12:00:00Z", NOW)).toBe("hace 2 d");
    expect(ago("2026-10-17T12:00:10Z", NOW)).toBe("ahora");
  });
});

describe("titleOf", () => {
  it("joins the type label and the bench", () => {
    expect(titleOf(proc({}))).toBe("Evaluación · capitales");
    expect(titleOf(proc({ bench: null }))).toBe("Evaluación");
    expect(titleOf(proc({ type: "agent", bench: null }))).toBe("Agente");
    expect(titleOf(proc({ type: "report" }))).toBe("Informe · capitales");
  });
});

describe("badgeText", () => {
  it("is null when nothing runs, names the one running process, counts the rest", () => {
    expect(badgeText([])).toBeNull();
    expect(badgeText([proc({ status: "done", finishedAt: "2026-10-17T11:58:00Z" })])).toBeNull();
    expect(badgeText([proc({})])).toBe("Evaluación · capitales");
    const three = [proc({ id: "a" }), proc({ id: "b", type: "agent", bench: null }), proc({ id: "c", status: "done" })];
    expect(badgeText(three)).toBe("2 procesos en curso");
  });
});

describe("runningOf / recentOf", () => {
  it("splits the list by status, with labels for each", () => {
    const list = [proc({ id: "a" }), proc({ id: "b", status: "done" }), proc({ id: "c", status: "failed" })];
    expect(runningOf(list).map((p) => p.id)).toEqual(["a"]);
    expect(recentOf(list).map((p) => p.id)).toEqual(["b", "c"]);
    expect(STATUS_LABEL.running).toBe("En curso");
    expect(STATUS_LABEL.done).toBe("Terminó");
    expect(STATUS_LABEL.failed).toBe("Falló");
  });
});
