"""Review an exam before running it: the grader grades every expert answer
against the benchmark's own rubric.

The expert answer is the answer key, so it should meet every criterion. A
criterion it misses is either a weak answer or a criterion worded so even the
expert fails it, and both are worth fixing before any model is scored. The
result goes to `<benchmark folder>/review.json`, which the app reads; it keeps
each question and answer verbatim so the app can tell when a row changed after
its review.

Shared by the MCP server (`benchy_review`) and the proxy (`POST /benchy/review`).
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

from benchy import data, providers, score, types
from benchy.errors import BenchyError

from benchy_shared import check_models

CONCURRENCY = 4


def rubric_dimension(ir: dict) -> dict:
    for dimension in ir["scoring"]["dimensions"]:
        if dimension.get("metric") == score.RUBRIC:
            return dimension
    raise BenchyError("runtime", "invalid_rubric", "this benchmark has no rubric to review against", ["scoring"])


async def review(ir: dict, source: Path) -> dict:
    """Grade every expected answer of the benchmark at `source`; write and return review.json."""
    dimension = rubric_dimension(ir)
    check_models(ir)
    path, criteria = dimension["path"], dimension["params"]["criteria"]
    workspace = source.parent
    grader = providers.for_grader(ir, workspace)
    program = score.grader_program(ir)
    rows = list(data.examples(ir, workspace))
    gate = asyncio.Semaphore(CONCURRENCY)

    async def one(index: int, inputs: dict, expected: dict) -> dict:
        reference = score.value_at(expected, path)
        async with gate:
            try:
                reply = await grader.invoke(score.grader_input(inputs, reference, reference, criteria))
                graded = types.validate(reply, program["output"], phase="runtime")
            except BenchyError as exc:
                return {"index": index, "input": inputs, "answer": reference, "error": exc.to_dict()}
            except Exception as exc:  # noqa: BLE001 - one row's grader failure is reported on that row
                return {"index": index, "input": inputs, "answer": reference,
                        "error": {"code": "grader_error", "message": f"{type(exc).__name__}: {exc}"}}
        return {
            "index": index,
            "input": inputs,
            "answer": reference,
            "score": score.rubric_score(graded, criteria),
            "criteria": graded,
            "missed": [c["name"] for c in criteria if graded[c["name"]]["grade"] < c["levels"][-1]["grade"]],
        }

    results = await asyncio.gather(*(one(i, x, y) for i, x, y in rows))
    report = {
        "created": int(time.time()),
        "grader": ir["scoring"]["grader"],
        "criteria": [c["name"] for c in criteria],
        # Their wording too: the app counts a review only for the rubric it was made with.
        "rubric": [{"name": c["name"], "description": c.get("description", "")} for c in criteria],
        "rows": sorted(results, key=lambda r: r["index"]),
    }
    (workspace / "review.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return report
