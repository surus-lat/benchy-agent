"""The benchy engine as an MCP server — the only way the org's Hermes runs it.

Hermes has no terminal (see config.yaml), so these tools are the engine's whole
surface inside the agent: validate a benchmark, run it, list the models an
AI-system may name. Every path is resolved inside the org's workspace; nothing
here can read or write outside it.

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

from benchy import providers
from benchy.compiler import compile_benchmark
from benchy.errors import BenchyError
from benchy.run import run

WORKSPACE = Path(os.environ.get("BENCHY_WORKSPACE", "/opt/data/workspace")).resolve()
MAX_ROWS = int(os.environ.get("BENCHY_MAX_ROWS", "500"))
MODELS = [
    m.strip()
    for m in os.environ.get(
        "BENCHY_MODELS",
        "us.moonshotai.kimi-k3,qwen.qwen3-next-80b-a3b,qwen.qwen3-32b-v1:0,"
        "deepseek.v3.2,openai.gpt-oss-120b-1:0,openai.gpt-oss-20b-1:0",
    ).split(",")
    if m.strip()
]

mcp = MCPServer("benchy")


def _inside(path: str) -> Path:
    """Resolve `path` against the workspace, refusing anything that escapes it."""
    candidate = (WORKSPACE / path).resolve()
    if candidate != WORKSPACE and WORKSPACE not in candidate.parents:
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
async def benchy_run(path: str) -> dict:
    """Run a benchmark against its declared AI-system and score it.

    `path` is the benchmark YAML, relative to the org workspace. The AI-system
    must be `type: model` with `provider: bedrock` and a model from
    benchy_models. The exam is read relative to the YAML's folder. The full
    result is saved under `runs/` next to the benchmark; this returns the
    score, the summary, and the failed examples. Read the failures before the
    score: invalid outputs and execution errors count as 0.
    """
    try:
        source, ir = _compile(path)
        system = ir["ai-system"]
        if system.get("type") == "model" and system.get("provider") == "bedrock" and system.get("model") not in MODELS:
            raise BenchyError(
                "runtime", "adapter_not_bound",
                f"model {system.get('model')!r} is not available here; use one of: {', '.join(MODELS)}",
                ["ai-system", "model"],
            )
        workspace = source.parent
        exam = (workspace / ir["data"]["path"]).resolve()
        if exam.is_file():
            with exam.open(encoding="utf-8") as fh:
                rows = sum(1 for line in fh if line.strip())
            if rows > MAX_ROWS:
                raise BenchyError("runtime", "dataset_too_large", f"the exam has {rows} rows; the limit here is {MAX_ROWS}")
        adapter = providers.for_system(ir, workspace)
        started = time.time()
        result = await run(ir, workspace, adapter)
    except BenchyError as exc:
        return _error(exc)

    runs_dir = source.parent / "runs"
    runs_dir.mkdir(exist_ok=True)
    out = runs_dir / f"{source.stem}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")

    failures = [r for r in result["results"] if r["status"] != "valid"][:10]
    return {
        "ok": True,
        "benchmark_score": result.get("benchmark_score"),
        "summary": result.get("summary"),
        "seconds": round(time.time() - started, 1),
        "saved_to": str(out.relative_to(WORKSPACE)),
        "failures_shown": failures,
    }


@mcp.tool()
def benchy_models() -> dict:
    """The Bedrock model ids an AI-system may name, as `ai-system.model` with
    `provider: bedrock`."""
    return {"provider": "bedrock", "models": MODELS}


if __name__ == "__main__":
    asyncio.run(mcp.run_stdio_async())
