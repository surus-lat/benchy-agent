"""An evaluation: a benchmark run with several models, then its findings report.

It runs in the container (the proxy starts it for the app), not as a turn in a
chat with the agent: it neither waits for the researcher's conversation nor
blocks it, and its state lives in `<bench>/evaluation.json`, so the app can
show it after a reload, on any device:

    {"state": "running" | "reporting" | "done" | "error" | "interrupted",
     "started": 1760000000, "finished": 1760000300 | null,
     "models": [{"model", "state": "pending" | "running" | "done" | "error",
                 "score", "summary", "file", "error", "seconds"}],
     "report": {"state": "pending" | "running" | "done" | "error" | "skipped", "error"}}

`run_model` is also the agent's benchy_run, so a run from the app and one from
the chat are the same run. The report is written by the org's agent in a
session of its own (never the researcher's), with the benchy-report-findings
skill; the proxy passes the function that asks it.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
from pathlib import Path
from typing import Awaitable, Callable

from benchy import providers
from benchy.errors import BenchyError
from benchy.run import run

from benchy_shared import WORKSPACE, check_models, model_slug

MAX_ROWS = int(os.environ.get("BENCHY_MAX_ROWS", "500"))
# Models run two at a time: faster than one by one, gentle on the grader.
CONCURRENCY = 2
STATUS = "evaluation.json"

ReportWriter = Callable[[str], Awaitable[None]]

# The evaluation running in this process for each benchmark folder. A state
# file that says "running" with no task here was cut short (a restart).
_tasks: dict[Path, asyncio.Task] = {}


class Busy(Exception):
    """An evaluation or a report is already running for this benchmark."""

    def __init__(self, status: dict):
        super().__init__("busy")
        self.status = status


def exam_rows(source: Path, ir: dict) -> int:
    exam = (source.parent / ir["data"]["path"]).resolve()
    if not exam.is_file():
        return 0
    with exam.open(encoding="utf-8") as fh:
        return sum(1 for line in fh if line.strip())


async def run_model(source: Path, ir: dict, model: str | None = None) -> dict:
    """Run the benchmark at `source` with `model` (or its own AI-system) and
    save the result under runs/. Raises BenchyError."""
    if model:
        ir = {**ir, "ai-system": {**ir["ai-system"], "model": model}}
    system = ir["ai-system"]
    check_models(ir)
    workspace = source.parent
    rows = exam_rows(source, ir)
    if rows > MAX_ROWS:
        raise BenchyError("runtime", "dataset_too_large", f"the exam has {rows} rows; the limit here is {MAX_ROWS}")
    adapter = providers.for_system(ir, workspace)
    # A rubric benchmark is graded by its declared grader (scoring.grader).
    grader = providers.for_grader(ir, workspace) if ir["scoring"].get("grader") else None
    started = time.time()
    result = await run(ir, workspace, adapter, grader=grader)
    runs_dir = workspace / "runs"
    runs_dir.mkdir(exist_ok=True)
    # <stem>__<model>__<timestamp>.json: the app groups the newest run per
    # model into a comparison, and the result itself records the AI-system.
    out = runs_dir / f"{source.stem}__{model_slug(system.get('model', 'external'))}__{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps({"ai_system": system, **result}, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"system": system, "result": result, "file": out, "seconds": round(time.time() - started, 1)}


def _write(folder: Path, status: dict) -> None:
    tmp = folder / f".{STATUS}.tmp"
    tmp.write_text(json.dumps(status, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, folder / STATUS)


def status(folder: Path) -> dict | None:
    """The benchmark's last evaluation, or None if it never had one."""
    try:
        data = json.loads((folder / STATUS).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    task = _tasks.get(folder)
    if data.get("state") in ("running", "reporting") and (task is None or task.done()):
        data = {**data, "state": "interrupted"}
    return data


def _busy(folder: Path) -> bool:
    task = _tasks.get(folder)
    return task is not None and not task.done()


def start(source: Path, ir: dict, models: list[str], write_report: ReportWriter | None, grader_model: str | None = None) -> dict:
    """Start an evaluation of the benchmark at `source` with `models`; returns its first state.
    `grader_model`, when given, is the judge these runs grade with instead of the
    benchmark's own scoring.grader (the org's judge config); a benchmark with no
    rubric judge ignores it."""
    folder = source.parent
    if _busy(folder):
        raise Busy(status(folder) or {})
    if grader_model and ir["scoring"].get("grader"):
        ir = {**ir, "scoring": {**ir["scoring"], "grader": {**ir["scoring"]["grader"], "model": grader_model}}}
    for m in models:  # refuse a model this deployment cannot call before starting anything
        check_models({**ir, "ai-system": {**ir["ai-system"], "model": m}})
    if exam_rows(source, ir) == 0:
        raise BenchyError("runtime", "empty_exam", "the exam has no questions yet")
    state = {
        "state": "running",
        "started": int(time.time()),
        "finished": None,
        "models": [{"model": m, "state": "pending"} for m in models],
        "report": {"state": "pending" if write_report else "skipped"},
    }
    _write(folder, state)
    _tasks[folder] = asyncio.create_task(_evaluate(source, ir, state, write_report))
    return state


def start_report(source: Path, write_report: ReportWriter) -> dict:
    """Write (or rewrite) the findings report from the results there are."""
    folder = source.parent
    if _busy(folder):
        raise Busy(status(folder) or {})
    runs_dir = folder / "runs"
    if not (runs_dir.is_dir() and any(runs_dir.glob("*.json"))):
        raise BenchyError("runtime", "no_runs", "the benchmark has no results to report on yet")
    previous = status(folder) or {}
    state = {
        "state": "reporting",
        "started": previous.get("started") or int(time.time()),
        "finished": previous.get("finished"),
        "models": previous.get("models") or [],
        "report": {"state": "running", "started": int(time.time())},
    }
    _write(folder, state)
    _tasks[folder] = asyncio.create_task(_report(folder, state, write_report))
    return state


async def _evaluate(source: Path, ir: dict, state: dict, write_report: ReportWriter | None) -> None:
    folder = source.parent
    gate = asyncio.Semaphore(CONCURRENCY)

    async def one(entry: dict) -> None:
        async with gate:
            entry["state"] = "running"
            _write(folder, state)
            try:
                done = await run_model(source, ir, entry["model"])
                entry.update(
                    state="done",
                    score=done["result"].get("benchmark_score"),
                    summary=done["result"].get("summary"),
                    file=str(done["file"].relative_to(WORKSPACE)),
                    seconds=done["seconds"],
                )
            except BenchyError as exc:
                entry.update(state="error", error=exc.to_dict())
            except Exception as exc:  # a provider failure must not leave the state "running"
                entry.update(state="error", error={"code": "runtime_error", "message": str(exc)[:300]})
            _write(folder, state)

    await asyncio.gather(*(one(e) for e in state["models"]))
    if not any(e["state"] == "done" for e in state["models"]):
        state.update(state="error", finished=int(time.time()))
        state["report"] = {"state": "skipped"}
        _write(folder, state)
        return
    state["finished"] = int(time.time())
    if write_report is None:
        state["state"] = "done"
        _write(folder, state)
        return
    state["state"] = "reporting"
    state["report"] = {"state": "running", "started": int(time.time())}
    _write(folder, state)
    await _report(folder, state, write_report)


async def _report(folder: Path, state: dict, write_report: ReportWriter) -> None:
    report = folder / "report.md"
    started = state["report"]["started"]
    asked = time.time()
    # The researcher may have edited the last one with the agent: keep it one step back.
    if report.is_file():
        shutil.copyfile(report, folder / "report.previous.md")
    try:
        await write_report(folder.name)
        if not report.is_file() or report.stat().st_mtime < asked:
            raise RuntimeError("el agente terminó sin escribir report.md")
        state["report"] = {"state": "done", "started": started, "finished": int(time.time())}
    except Exception as exc:
        state["report"] = {"state": "error", "started": started, "error": str(exc)[:300] or exc.__class__.__name__}
    state["state"] = "done"
    _write(folder, state)
