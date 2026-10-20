// Presentation logic for the global process indicator (issue #7) — labels,
// summaries, and relative times, pure so the component stays thin.

export type ProcessStatus = "running" | "done" | "failed";
export type ProcessType = "evaluation" | "report" | "agent";

export type ProcessItem = {
  id: string;
  type: ProcessType;
  status: ProcessStatus;
  bench: string | null;
  who: string | null;
  mine: boolean;
  detail: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export const TYPE_LABEL: Record<ProcessType, string> = {
  evaluation: "Evaluación",
  report: "Informe",
  agent: "Agente",
};

export const STATUS_LABEL: Record<ProcessStatus, string> = {
  running: "En curso",
  done: "Terminó",
  failed: "Falló",
};

/** One line: what it is, and on which benchmark when there is one. */
export function titleOf(p: Pick<ProcessItem, "type" | "bench">): string {
  const what = TYPE_LABEL[p.type] ?? p.type;
  return p.bench ? `${what} · ${p.bench}` : what;
}

/** "ahora", "hace 3 min", "hace 2 h", "hace 1 d". */
export function ago(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return "ahora";
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

export function runningOf(list: ProcessItem[]): ProcessItem[] {
  return list.filter((p) => p.status === "running");
}

export function recentOf(list: ProcessItem[]): ProcessItem[] {
  return list.filter((p) => p.status !== "running");
}

/** The badge's one-line summary, or null when nothing is running. */
export function badgeText(list: ProcessItem[]): string | null {
  const running = runningOf(list);
  if (running.length === 0) return null;
  if (running.length === 1) return titleOf(running[0]);
  return `${running.length} procesos en curso`;
}
