"""The benchy engine as an MCP server — the only way the org's Hermes runs it.

Hermes has no terminal (see config.yaml), so these tools are the engine's whole
surface inside the agent: validate a benchmark, run it, list the models an
AI-system may name, and search the paper library and add papers to a
benchmark. Every path is resolved inside the org's workspace; nothing here can
read or write outside it. The library is read from the Worker with this
container's own key.

Runs as a stdio subprocess of the Hermes gateway, with Hermes's own Python.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

try:  # mcp >= 2.0 (what Hermes ships)
    from mcp.server.mcpserver import MCPServer
except ImportError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as MCPServer

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from benchy_shared import MODELS, WORKSPACE, check_models, inside, model_slug  # noqa: E402
from benchy_review import review  # noqa: E402
import benchy_sources  # noqa: E402

from aiohttp import ClientError, ClientSession, ClientTimeout

from benchy import providers
from benchy.compiler import compile_benchmark
from benchy.errors import BenchyError
from benchy.run import run

MAX_ROWS = int(os.environ.get("BENCHY_MAX_ROWS", "500"))

mcp = MCPServer("benchy")


def _inside(path: str) -> Path:
    """Resolve `path` against the workspace, refusing anything that escapes it."""
    candidate = inside(path)
    if candidate is None:
        raise BenchyError("compile", "data_not_found", f"{path!r} is outside the workspace {WORKSPACE}")
    return candidate


def _error(exc: BenchyError) -> dict:
    return {"ok": False, "error": exc.to_dict()}


def _compile(path: str) -> tuple[Path, dict]:
    source = _inside(path)
    try:
        text = source.read_text(encoding="utf-8")
    except OSError as exc:
        raise BenchyError("compile", "data_not_found", f"cannot read {path}: {exc.strerror}") from None
    return source, compile_benchmark(text)


def _leaves(node: dict, prefix: str = "") -> list[str]:
    out = []
    for key, value in (node or {}).items():
        name = f"{prefix}.{key}" if prefix else key
        out.extend(_leaves(value, name) if isinstance(value, dict) and "type" not in value else [name])
    return out


@mcp.tool()
def benchy_validate(path: str) -> dict:
    """Compile a benchmark YAML and report whether it is valid.

    `path` is relative to the org workspace (e.g. "etnografia/benchmark.yaml").
    On success returns the benchmark's task, its output fields and scoring
    dimensions. On failure returns the engine's exact error (code, message, and
    the field path) — fix the YAML and validate again; the compiler never guesses.
    """
    try:
        _, ir = _compile(path)
    except BenchyError as exc:
        return _error(exc)
    return {
        "ok": True,
        "benchmark": ir.get("benchmark"),
        "outputs": _leaves(ir["program"]["output"]),
        "dimensions": len(ir.get("scoring", {}).get("dimensions", [])),
        "ai_system": ir.get("ai-system"),
    }


@mcp.tool()
async def benchy_run(path: str, model: str | None = None) -> dict:
    """Run a benchmark against its declared AI-system and score it.

    `path` is the benchmark YAML, relative to the org workspace. The AI-system
    must be `type: model` with `provider: bedrock` and a model from
    benchy_models. To compare models, pass `model` — it replaces
    `ai-system.model` for this run only, so the YAML stays the same; run once
    per model. The exam is read relative to the YAML's folder. The full result
    is saved under `runs/` next to the benchmark (the file name and the result
    say which model it was); this returns the score, the summary, and the
    failed examples. Read the failures before the score: invalid outputs and
    execution errors count as 0. A rubric benchmark is graded by its
    `scoring.grader`; each graded result keeps every criterion's grade and
    justification.
    """
    try:
        source, ir = _compile(path)
        if model:
            ir = {**ir, "ai-system": {**ir["ai-system"], "model": model}}
        system = ir["ai-system"]
        check_models(ir)
        workspace = source.parent
        exam = (workspace / ir["data"]["path"]).resolve()
        if exam.is_file():
            with exam.open(encoding="utf-8") as fh:
                rows = sum(1 for line in fh if line.strip())
            if rows > MAX_ROWS:
                raise BenchyError("runtime", "dataset_too_large", f"the exam has {rows} rows; the limit here is {MAX_ROWS}")
        adapter = providers.for_system(ir, workspace)
        # A rubric benchmark is graded by its declared grader (scoring.grader).
        grader = providers.for_grader(ir, workspace) if ir["scoring"].get("grader") else None
        started = time.time()
        result = await run(ir, workspace, adapter, grader=grader)
    except BenchyError as exc:
        return _error(exc)

    runs_dir = source.parent / "runs"
    runs_dir.mkdir(exist_ok=True)
    # <stem>__<model>__<timestamp>.json: the app groups the newest run per
    # model into a comparison, and the result itself records the AI-system.
    out = runs_dir / f"{source.stem}__{model_slug(system.get('model', 'external'))}__{time.strftime('%Y%m%d-%H%M%S')}.json"
    saved = {"ai_system": system, **result}
    out.write_text(json.dumps(saved, indent=2, ensure_ascii=False), encoding="utf-8")

    failures = [r for r in result["results"] if r["status"] != "valid"][:10]
    return {
        "ok": True,
        "benchmark_score": result.get("benchmark_score"),
        "summary": result.get("summary"),
        "model": system.get("model"),
        "seconds": round(time.time() - started, 1),
        "saved_to": str(out.relative_to(WORKSPACE)),
        "failures_shown": failures,
    }


@mcp.tool()
async def benchy_review(path: str) -> dict:
    """Before running a rubric benchmark, grade every expert answer (the
    exam's `expected` answer) against the benchmark's own rubric, with its
    grader.

    The expert answer should meet every criterion. Rows that miss one are a
    weak answer key or a criterion worded too strictly: show the researcher
    which, and fix it with them. Saves `review.json` next to the benchmark,
    which the app shows in its Review stage; returns the rows that missed a
    criterion.
    """
    try:
        source, ir = _compile(path)
        report = await review(ir, source)
    except BenchyError as exc:
        return _error(exc)
    weak = [
        {"index": r["index"], "score": r.get("score"), "error": r.get("error"),
         "missed": r.get("missed", [])}
        for r in report["rows"] if r.get("error") or r.get("missed")
    ]
    return {"ok": True, "rows": len(report["rows"]), "weak": weak[:20],
            "saved_to": str((source.parent / "review.json").relative_to(WORKSPACE))}


async def _library(path: str, params: dict | None = None) -> dict:
    headers = {"Authorization": f"Bearer {benchy_sources.API_KEY}"}
    try:
        async with ClientSession(timeout=ClientTimeout(total=30)) as http:
            async with http.get(benchy_sources.API_URL + path, params=params, headers=headers) as res:
                if res.status == 404:
                    return {"ok": False, "error": {"code": "not_found", "message": "no such paper in the library"}}
                if res.status != 200:
                    return {"ok": False, "error": {"code": "library_unavailable", "message": f"the library answered HTTP {res.status}"}}
                return {"ok": True, **(await res.json())}
    except (ClientError, asyncio.TimeoutError) as exc:
        return {"ok": False, "error": {"code": "library_unavailable", "message": str(exc)}}


@mcp.tool()
async def benchy_library_search(query: str = "", author: str = "", pdf_only: bool = False, page: int = 0) -> dict:
    """Search the paper library: CONICET Digital's 263,000 publications plus
    researchers' BICyT records, by topic, title or keywords (`query`) and/or
    by `author` (surname and given name, e.g. "Chávez Martín"). Accents and
    word endings do not matter. 20 papers per `page`, newest-matching first
    when the query is broad.

    Each paper has its `id`, title, authors, year, whether it has an open
    PDF (`hasPdf`; without one, only the abstract can be used) and the start
    of its abstract. To use one for a benchmark, add it with
    benchy_add_paper. Never invent papers or ids: only what this returns.
    """
    if not query.strip() and not author.strip():
        return {"ok": False, "error": {"code": "empty_query", "message": "give a query or an author"}}
    params = {"q": query, "author": author, "page": str(max(0, page))}
    if pdf_only:
        params["pdf"] = "1"
    return await _library("/api/library/search", params)


@mcp.tool()
async def benchy_add_paper(bench: str, paper_id: int) -> dict:
    """Add a library paper (an `id` from benchy_library_search) to a
    benchmark, by the benchmark's folder name. Fetches its open PDF and keeps
    the text, with [p. N] page markers, in `<bench>/sources/<id>.md`, listed
    in `<bench>/sources.json` — where the app shows it as one of the
    benchmark's papers. Without an open PDF only the abstract is kept.

    Add papers the researcher asked for or agreed to; do not fill a benchmark
    with papers on your own. Adding one that is already there changes nothing.
    """
    found = await _library(f"/api/library/papers/{int(paper_id)}")
    if not found.pop("ok"):
        return {"ok": False, **found}
    try:
        async with ClientSession() as http:
            source = await benchy_sources.add_paper(bench, found, http)
    except benchy_sources.SourceError as exc:
        return {"ok": False, "error": exc.to_dict()}
    return {"ok": True, "source": source}


@mcp.tool()
def benchy_models() -> dict:
    """The Bedrock model ids an AI-system may name, as `ai-system.model` with
    `provider: bedrock`."""
    return {"provider": "bedrock", "models": MODELS}


if __name__ == "__main__":
    asyncio.run(mcp.run_stdio_async())
