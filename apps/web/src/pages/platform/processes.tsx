import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ago, badgeText, recentOf, runningOf, STATUS_LABEL, titleOf, type ProcessItem } from "./processes-model";

// The global process indicator (issue #7): a badge over every platform view
// showing what is running — the researcher's own agent turns and the org's
// evaluations — plus what just finished or failed. Polls /api/processes every
// 30 s while the tab is visible and refetches on every navigation; no
// websockets, no SSE.

const POLL_MS = 30_000;

async function fetchProcesses(): Promise<ProcessItem[]> {
  const res = await fetch("/api/processes", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return ((await res.json()) as { processes: ProcessItem[] }).processes;
}

export function ProcessIndicator() {
  const [processes, setProcesses] = useState<ProcessItem[]>([]);
  const [open, setOpen] = useState(false);
  const [location] = useLocation();

  const load = useCallback(async () => {
    try {
      setProcesses(await fetchProcesses());
    } catch {
      // A failed poll keeps the last known state; the next one retries.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, location]);

  useEffect(() => {
    const look = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = setInterval(look, POLL_MS);
    document.addEventListener("visibilitychange", look);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", look);
    };
  }, [load]);

  const running = runningOf(processes);
  const recent = recentOf(processes);
  const text = badgeText(processes);
  const warn = running.length === 0 && recent.some((p) => p.status === "failed");
  if (processes.length === 0 && !open) return null;

  return (
    <div className="bp-procs">
      {open && (
        <div className="bp-procs-panel" role="dialog" aria-label="Procesos en la plataforma">
          <div className="bp-procs-head">
            <span>Procesos</span>
            <button className="bp-procs-close" onClick={() => setOpen(false)} aria-label="Cerrar">
              ×
            </button>
          </div>
          {running.length > 0 && <p className="bp-procs-eyebrow">En curso</p>}
          {running.map((p) => (
            <Row key={p.id} p={p} />
          ))}
          {recent.length > 0 && <p className="bp-procs-eyebrow">Recientes</p>}
          {recent.map((p) => (
            <Row key={p.id} p={p} />
          ))}
          {processes.length === 0 && <p className="bp-procs-empty">Nada en curso ni reciente.</p>}
        </div>
      )}
      <button
        className={`bp-procs-badge${running.length ? " on" : ""}${warn ? " warn" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={`bp-procs-dot${running.length ? " pulse" : ""}`} />
        <span className="bp-procs-text">{text ?? "Sin procesos en curso"}</span>
      </button>
    </div>
  );
}

function Row({ p }: { p: ProcessItem }) {
  return (
    <div className="bp-procs-row">
      <span className={`bp-procs-row-dot ${p.status}`} />
      <div className="bp-procs-row-main">
        <span className="bp-procs-row-title">{titleOf(p)}</span>
        <span className="bp-procs-row-sub">
          {STATUS_LABEL[p.status]}
          {p.who && !p.mine ? ` · ${p.who}` : ""}
          {p.detail ? ` · ${p.detail}` : ""}
          {` · ${ago(p.finishedAt ?? p.startedAt)}`}
        </span>
      </div>
    </div>
  );
}
