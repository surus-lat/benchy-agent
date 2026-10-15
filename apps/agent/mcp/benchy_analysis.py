"""What a benchmark's results say, beyond the score.

From the newest run of each model in `<bench>/runs/`: each model's score and
failures; for rubric benchmarks, how often each criterion was met; the score
by topic (questions.json's `group`) and by paper (the papers each question
cites); and every question with each model's answer, its score and the
criteria it missed, with the grader's justification. The app's Publication
stage shows it, and the agent uses it to discuss the results and write the
findings report — so both read the same numbers.

Shared by the MCP server (`benchy_analysis`) and the proxy (`GET /benchy/analysis`).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from benchy import score

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
    newest: dict[str, tuple[float, Path, dict]] = {}
    for file in (folder / "runs").glob("*.json") if (folder / "runs").is_dir() else []:
        result = _json(file, None)
        if not isinstance(result, dict) or "results" not in result:
            continue
        model = (result.get("ai_system") or {}).get("model")
        if not model:
            parts = file.stem.split("__")
            model = parts[1] if len(parts) == 3 else "modelo del benchmark"
        mtime = file.stat().st_mtime
        if model not in newest or mtime > newest[model][0]:
            newest[model] = (mtime, file, result)
    return [(m, f, r) for m, (_, f, r) in newest.items()]


def _mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 4) if values else None


def analyze(ir: dict, source: Path, answer_chars: int = 1500) -> dict:
    folder = source.parent
    rubric = next((d for d in ir["scoring"]["dimensions"] if d.get("metric") == score.RUBRIC), None)
    criteria = [
        {"key": c["name"], "weight": c.get("weight", 1), "description": c.get("description", ""), "top": c["levels"][-1]["grade"]}
        for c in (rubric["params"]["criteria"] if rubric else [])
    ]
    exam_file = (folder / ir["data"]["path"]).resolve()
    rows = []
    if exam_file.is_file():
        for line in exam_file.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    rows.append({"input": {}, "expected": {}})
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

    exam_mtime = exam_file.stat().st_mtime if exam_file.is_file() else 0
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
    for model, file, result in _runs(folder):
        per_criterion = {c["key"]: [] for c in criteria}
        scores = {}
        for r in result.get("results", []):
            i = r.get("index")
            s = r.get("score") if r.get("status") == "valid" else 0.0
            s = float(s or 0.0)
            scores[i] = s
            graded = next((f.get("criteria") for f in r.get("field_scores") or [] if f.get("criteria")), None) or {}
            missed = []
            for c in criteria:
                g = graded.get(c["key"])
                if g is None:
                    continue
                met = g.get("grade", 0) >= c["top"]
                per_criterion[c["key"]].append(1.0 if met else 0.0)
                if not met:
                    missed.append({"criterion": c["key"], "justification": g.get("justification", "")})
            if isinstance(i, int) and i < len(questions):
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
            s = scores.get(q["index"], 0.0)
            by_group.setdefault(q["group"], []).append(s)
            for p in q["papers"]:
                by_paper.setdefault(p, []).append(s)
        summary = result.get("summary") or {}
        models.append({
            "model": model,
            "file": str(file.relative_to(folder.parent)),
            "run_at": int(file.stat().st_mtime),
            "score": result.get("benchmark_score"),
            "summary": summary,
            # The exam changed after this run: its score is for a previous version.
            "stale": exam_mtime > file.stat().st_mtime or summary.get("examples") not in (None, len(rows)),
            "criteria": {k: _mean(v) for k, v in per_criterion.items()},
            "groups": {g: _mean(v) for g, v in by_group.items()},
            "papers": {p: _mean(v) for p, v in by_paper.items()},
        })
    models.sort(key=lambda m: -(m["score"] or 0))

    for q in questions:
        q["mean"] = _mean([m["score"] for m in q["models"].values()])
    hardest = [q["index"] for q in sorted((q for q in questions if q["mean"] is not None), key=lambda q: q["mean"])[:8]]
    return {
        "ok": True,
        "benchmark": str(source.relative_to(folder.parent)),
        "grader": (ir["scoring"].get("grader") or {}).get("model"),
        "criteria": criteria,
        "groups": sorted({q["group"] for q in questions}),
        "papers": [
            {"id": pid, "title": (papers.get(pid) or {}).get("title", pid), "year": (papers.get(pid) or {}).get("year")}
            for pid in sorted({p for q in questions for p in q["papers"]})
        ],
        "models": models,
        "questions": questions,
        "hardest": hardest,
    }
