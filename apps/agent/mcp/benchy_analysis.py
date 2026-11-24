"""What a benchmark's results say, beyond the score.

From the newest run of each model in `<bench>/runs/`: each model's score and
failures; for rubric benchmarks, how often each criterion was met; the score
by topic (questions.json's `group`) and by paper (the papers each question
cites); and every question with each model's answer, its score and the
criteria it missed, with the grader's justification. The app's Results stage
shows it, and the agent uses it to discuss the results and write the findings
report — so both read the same numbers.

Shared by the MCP server (`benchy_analysis`) and the proxy (`GET /benchy/analysis`).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from benchy import data, score

from benchy_shared import CATALOG
from benchy_metrics import exam_digest, failure_path, judge_key, mean as _mean, quality, valid_score

CITED = re.compile(r"^((?:conicet|bicyt|pdf)-[a-z0-9-]+?)(?=[\s,;:]|$)", re.I)


def _text(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for v in value.values():
            if isinstance(v, str):
                return v
    return "" if value is None else json.dumps(value, ensure_ascii=False)


def _json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _runs(folder: Path) -> list[tuple[str, Path, dict]]:
    """The newest run file per model: (model, file, result)."""
    newest: dict[str, tuple[int, Path, dict]] = {}
    for file in (folder / "runs").glob("*.json") if (folder / "runs").is_dir() else []:
        result = _json(file, None)
        if not isinstance(result, dict) or "results" not in result:
            continue
        model = (result.get("ai_system") or {}).get("model")
        if not model:
            parts = file.stem.split("__")
            model = parts[1] if len(parts) == 3 else "modelo del benchmark"
        mtime = file.stat().st_mtime_ns
        if model not in newest or mtime > newest[model][0]:
            newest[model] = (mtime, file, result)
    return [(m, f, r) for m, (_, f, r) in newest.items()]


def analyze(ir: dict, source: Path, answer_chars: int = 1500) -> dict:
    folder = source.parent
    rubric = next((d for d in ir["scoring"]["dimensions"] if d.get("metric") == score.RUBRIC), None)
    criteria = [
        {"key": c["name"], "weight": c.get("weight", 1), "description": c.get("description", ""), "top": c["levels"][-1]["grade"]}
        for c in (rubric["params"]["criteria"] if rubric else [])
    ]
    exam_file = data.resolve_within(ir["data"]["path"], folder, folder, ["data", "path"])
    rows = []
    exam_identity = None
    if exam_file.is_file():
        digest = exam_digest(ir)
        with exam_file.open("rb") as stream:
            for line in stream:
                digest.update(line)
                if line.strip():
                    try:
                        row = json.loads(line)
                        rows.append(row if isinstance(row, dict) else {})
                    except ValueError:
                        rows.append({})
        exam_identity = digest.hexdigest()
    meta = _json(folder / "questions.json", {}).get("rows") or []
    papers = {s.get("id"): s for s in _json(folder / "sources.json", {}).get("sources") or [] if isinstance(s, dict)}

    def cites(i: int) -> list[str]:
        found = []
        for ref in (meta[i].get("sources") if i < len(meta) and isinstance(meta[i], dict) else None) or []:
            m = CITED.match(str(ref).strip())
            if m and m.group(1).lower() not in found:
                found.append(m.group(1).lower())
        return found

    def group(i: int) -> str:
        g = meta[i].get("group") if i < len(meta) and isinstance(meta[i], dict) else None
        return (g or "").strip() or "Preguntas"

    questions = [
        {
            "index": i,
            "num": f"{i + 1:02d}",
            "question": _text(r.get("input", {}).get("question", r.get("input"))),
            "expert_answer": _text(r.get("expected", {}).get("answer", r.get("expected"))),
            "group": group(i),
            "papers": cites(i),
            "models": {},
        }
        for i, r in enumerate(rows)
    ]

    models = []
    judges = {}
    evaluation = _json(folder / "evaluation.json", {}) or {}
    latest = {e["model"]: e for e in evaluation.get("models", [])}
    for model, file, result in _runs(folder):
        per_criterion = {c["key"]: [] for c in criteria}
        scores = {}
        stale = not exam_identity or result.get("exam_identity") != exam_identity
        summary = result.get("summary") or {}
        entry = latest.get(model, {})
        failure = failure_path(folder, model)
        latest_error = _json(failure, None) if failure.is_file() and failure.stat().st_mtime_ns >= file.stat().st_mtime_ns else None
        grader = ((result.get("grader") or {}).get("system") or {}).get("model")
        key = judge_key(result) if rubric else "deterministic"
        for r in ([] if stale else result.get("results", [])):
            i = r.get("index")
            s = valid_score(r)
            scores[i] = s
            graded = next((f.get("criteria") for f in r.get("field_scores") or [] if f.get("criteria")), {}) if s is not None else {}
            missed = []
            for c in criteria:
                g = graded.get(c["key"])
                if g is None:
                    continue
                met = g.get("grade", 0) >= c["top"]
                per_criterion[c["key"]].append(1.0 if met else 0.0)
                if not met:
                    missed.append({"criterion": c["key"], "justification": g.get("justification", "")})
            if isinstance(i, int) and 0 <= i < len(questions):
                answer = _text(r.get("prediction"))
                questions[i]["models"][model] = {
                    "score": s,
                    "status": r.get("status"),
                    "answer": answer[:answer_chars] + ("…" if len(answer) > answer_chars else ""),
                    "missed": missed,
                    "error": (r.get("error") or {}).get("message") if r.get("error") else None,
                }
        by_group: dict[str, list[float]] = {}
        by_paper: dict[str, list[float]] = {}
        for q in questions:
            s = scores.get(q["index"])
            if s is None:
                continue
            by_group.setdefault(q["group"], []).append(s)
            for p in q["papers"]:
                by_paper.setdefault(p, []).append(s)
        current = not stale and not latest_error and entry.get("state") not in ("pending", "running")
        if current and summary.get("valid", 0):
            judges[model] = key
        known = next((c for c in CATALOG if c["id"] == model), {})
        models.append({
            "model": model,
            "name": known.get("name", model),
            "maker": known.get("maker", ""),
            "region": known.get("region", "Otras"),
            "file": str(file.relative_to(folder.parent)),
            "run_at": int(file.stat().st_mtime),
            "score": None if stale else quality(result),
            "operational_score": result.get("benchmark_score"),
            "summary": summary,
            "stale": stale,
            "grader": grader,
            "latest_error": latest_error,
            "comparable": current and key is not None and bool(questions)
            and all(scores.get(q["index"]) is not None for q in questions),
            "criteria": {k: _mean(v) for k, v in per_criterion.items()},
            "groups": {g: _mean(v) for g, v in by_group.items()},
            "papers": {p: _mean(v) for p, v in by_paper.items()},
        })
    models.sort(key=lambda m: m["model"])
    judge_keys = set(judges.values())
    blocked = "unknown_judge" if None in judge_keys else "different_judges" if len(judge_keys) > 1 else None
    ranked = sorted((m for m in models if m["comparable"] and m["score"] is not None and not blocked), key=lambda m: -m["score"])
    ranking = [m["model"] for m in ranked]
    regions: dict[str, list[float]] = {}
    for m in ranked:
        regions.setdefault(m["region"], []).append(m["score"])

    for q in questions:
        q["mean"] = _mean([q["models"][m]["score"] for m in ranking if m in q["models"] and q["models"][m]["score"] is not None])
    hardest = [q["index"] for q in sorted((q for q in questions if q["mean"] is not None), key=lambda q: q["mean"])[:8]]
    return {
        "ok": True,
        "benchmark": str(source.relative_to(folder.parent)),
        "grader": next((m["grader"] for m in models if m["model"] in judges), None) if not blocked else None,
        "ranking": ranking,
        "comparison_blocked": blocked,
        "criteria": criteria,
        "groups": sorted({q["group"] for q in questions}),
        "papers": [
            {"id": pid, "title": (papers.get(pid) or {}).get("title", pid), "year": (papers.get(pid) or {}).get("year")}
            for pid in sorted({p for q in questions for p in q["papers"]})
        ],
        "models": models,
        # Mean score of each region's models: a first look at regional differences.
        "regions": {r: _mean(v) for r, v in regions.items()},
        "questions": questions,
        "hardest": hardest,
    }
