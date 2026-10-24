"""The container's only public port.

Hermes's API server listens on 127.0.0.1 only; this process fronts it:

  GET /benchy/files              the org workspace, listed (read-only)
  GET /benchy/file?path=...      one workspace file's text (read-only, <= 1 MB)
  GET /benchy/validate?path=...  compile a benchmark.yaml: valid, or the exact error
  GET /benchy/exam?path=...      every exam row checked against the program
  GET /benchy/models             the models a benchmark may run
  PUT /benchy/file               write one benchmark text file (the app's editors)
  POST /benchy/review?path=...   grade the expert answers against the rubric
  POST /benchy/quality?path=...   score each question: claridad, relevancia, respaldo, calibre
  GET /benchy/analysis?path=...  the results beyond the score: criteria, topics, papers, answers
  POST /benchy/evaluation        run a benchmark with several models, then write its report (background)
  GET /benchy/evaluation?path=   that evaluation's state: each model, then the report
  POST /benchy/report?path=...   (re)write the findings report from the results there are (background)
  GET /benchy/backup             the whole workspace as a .tar.gz (the Worker's daily backup)
  POST /benchy/sources           add a library paper to a benchmark (fetches its PDF)
  POST /benchy/sources/upload?bench=...&name=...   add an uploaded PDF to a benchmark
  DELETE /benchy/sources?bench=...&id=...          take a paper out of a benchmark
  DELETE /benchy/benchmark?bench=...               delete a benchmark and everything in it
  DELETE /benchy/benchmark/question?bench=...&q=...  take one question out of a benchmark's exam
  POST /benchy/search             semantic search over a benchmark's papers and exam questions
  everything else                reverse-proxied to Hermes, streamed, unmodified

The /benchy routes check the same bearer key Hermes does (API_SERVER_KEY), so
the Worker — the only caller — uses one credential for both. Paths are
confined to the workspace. Writes are limited to benchmark text files, never
run results, and refuse to overwrite a file that changed since the caller read
it (the agent may have written it meanwhile).
"""

from __future__ import annotations

import asyncio
import hmac
import io
import json
import os
import re
import sys
import tarfile
import tempfile
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, web

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "mcp"))  # /opt/benchy/mcp in the image
import benchy_evaluation  # noqa: E402
import benchy_sources  # noqa: E402
import benchy_search  # noqa: E402
from benchy_analysis import analyze  # noqa: E402
from benchy_review import review as review_answers  # noqa: E402
from benchy_quality import quality as score_questions  # noqa: E402
from benchy_shared import MODELS, catalog  # noqa: E402

from benchy import types  # noqa: E402
from benchy.compiler import compile_benchmark  # noqa: E402
from benchy.errors import BenchyError  # noqa: E402

WORKSPACE = Path(os.environ.get("BENCHY_WORKSPACE", "/opt/data/workspace")).resolve()
UPSTREAM = f"http://127.0.0.1:{os.environ.get('API_SERVER_PORT', '8642')}"
KEY = os.environ["API_SERVER_KEY"]
MAX_FILE_BYTES = 1_000_000
MAX_ENTRIES = 2000
# A backup is one KV value on the Worker's side (25 MiB at most).
MAX_BACKUP_BYTES = 24 * 1024 * 1024
WRITABLE = {".yaml", ".yml", ".jsonl", ".json", ".md", ".txt"}
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
    "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}


def _authorized(request: web.Request) -> bool:
    supplied = request.headers.get("Authorization", "")
    return hmac.compare_digest(supplied.encode(), f"Bearer {KEY}".encode())


def _inside(rel: str) -> Path | None:
    candidate = (WORKSPACE / rel).resolve()
    if candidate == WORKSPACE or WORKSPACE in candidate.parents:
        return candidate
    return None


async def list_files(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    entries = []
    if WORKSPACE.is_dir():
        for path in sorted(WORKSPACE.rglob("*")):
            if len(entries) >= MAX_ENTRIES:
                break
            if path.is_symlink() or not path.is_file() or any(p.startswith(".") for p in path.relative_to(WORKSPACE).parts):
                continue
            stat = path.stat()
            entries.append({
                "path": str(path.relative_to(WORKSPACE)),
                "size": stat.st_size,
                "modified": int(stat.st_mtime),
            })
    return web.json_response({"files": entries, "truncated": len(entries) >= MAX_ENTRIES})


async def read_file(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    target = _inside(request.query.get("path", ""))
    if target is None or target.is_symlink() or not target.is_file():
        return web.json_response({"error": "not_found"}, status=404)
    size = target.stat().st_size
    with target.open("rb") as fh:
        raw = fh.read(MAX_FILE_BYTES)
    return web.json_response({
        "path": str(target.relative_to(WORKSPACE)),
        "size": size,
        "truncated": size > MAX_FILE_BYTES,
        "content": raw.decode("utf-8", errors="replace"),
    })


def _compile(rel: str) -> tuple[Path, dict]:
    target = _inside(rel)
    if target is None or not target.is_file():
        raise BenchyError("compile", "data_not_found", f"{rel!r} does not exist in the workspace")
    return target, compile_benchmark(target.read_text(encoding="utf-8"))


def _dimensions(ir: dict) -> list[dict]:
    return [{"path": d["path"], "weight": d["weight"]} for d in ir.get("scoring", {}).get("dimensions", [])]


async def validate(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        _, ir = _compile(request.query.get("path", ""))
    except BenchyError as exc:
        return web.json_response({"ok": False, "error": exc.to_dict()})
    return web.json_response({
        "ok": True,
        "benchmark": ir.get("benchmark"),
        "dimensions": _dimensions(ir),
        "ai_system": ir.get("ai-system"),
    })


async def exam(request: web.Request) -> web.Response:
    """Each row of the benchmark's exam checked the way the engine checks it
    before a run — but row by row, so one bad row is a rejection, not an abort."""
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        source, ir = _compile(request.query.get("path", ""))
    except BenchyError as exc:
        return web.json_response({"ok": False, "error": exc.to_dict()})
    dataset = (source.parent / ir["data"]["path"]).resolve()
    if WORKSPACE not in dataset.parents or not dataset.is_file():
        return web.json_response({"ok": False, "error": {"code": "data_not_found", "message": "exam file not found"}})
    rows, total = [], 0
    with dataset.open(encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            if not line.strip():
                continue
            total += 1
            if len(rows) >= 500:
                continue
            entry = {"line": lineno, "input": None, "expected": None, "status": "valid", "error": None}
            try:
                row = json.loads(line)
                entry["input"], entry["expected"] = row.get("input"), row.get("expected")
                if set(row) != {"input", "expected"}:
                    raise BenchyError("dataset", "invalid_dataset_record", "expected exactly 'input' and 'expected'")
                # Artifact paths are checked for shape only here, not opened.
                types.validate(row["input"], ir["program"]["input"], phase="dataset", resolve=lambda ref, _f: ref)
                types.validate(row["expected"], ir["program"]["output"], phase="dataset", resolve=lambda ref, _f: ref)
            except BenchyError as exc:
                entry["status"], entry["error"] = "rejected", exc.to_dict()
            except (json.JSONDecodeError, AttributeError) as exc:
                entry["status"] = "rejected"
                entry["error"] = {"code": "invalid_dataset_record", "message": f"malformed JSON: {exc}", "path": None}
            rows.append(entry)
    valid = sum(r["status"] == "valid" for r in rows)
    return web.json_response({"ok": True, "total": total, "valid": valid, "rejected": len(rows) - valid,
                              "truncated": total > len(rows), "rows": rows, "dimensions": _dimensions(ir)})


async def models(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    return web.json_response({"provider": "bedrock", "models": MODELS, "catalog": catalog()})


async def write_file(request: web.Request) -> web.Response:
    """Body: {path, content, base_modified?}. `base_modified` is the `modified`
    the caller last saw; if the file is newer, nothing is written (409)."""
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        body = await request.json()
        rel, content = body["path"], body["content"]
        base = body.get("base_modified")
        if not isinstance(rel, str) or not isinstance(content, str):
            raise TypeError
    except (ValueError, KeyError, TypeError):
        return web.json_response({"error": "bad_request"}, status=400)
    target = _inside(rel)
    parts = target.relative_to(WORKSPACE).parts if target is not None and target != WORKSPACE else ()
    if (
        not parts
        or len(parts) < 2  # files live in a benchmark folder
        or target.suffix not in WRITABLE
        or any(p.startswith(".") for p in parts)
        or "runs" in parts[:-1]
        or target.is_symlink()
    ):
        return web.json_response({"error": "forbidden_path"}, status=403)
    raw = content.encode("utf-8")
    if len(raw) > MAX_FILE_BYTES:
        return web.json_response({"error": "too_large"}, status=413)
    if target.exists():
        current = int(target.stat().st_mtime)
        if isinstance(base, int) and current > base:
            return web.json_response({"error": "conflict", "modified": current}, status=409)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".write-")
    with os.fdopen(fd, "wb") as fh:
        fh.write(raw)
    os.replace(tmp, target)
    return web.json_response({"path": str(target.relative_to(WORKSPACE)), "modified": int(target.stat().st_mtime)})


async def review(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        source, ir = _compile(request.query.get("path", ""))
        report = await review_answers(ir, source)
    except BenchyError as exc:
        return web.json_response({"ok": False, "error": exc.to_dict()})
    return web.json_response({"ok": True, **report})


async def quality(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        source, ir = _compile(request.query.get("path", ""))
        report = await score_questions(ir, source)
    except BenchyError as exc:
        return web.json_response({"ok": False, "error": exc.to_dict()})
    return web.json_response({"ok": True, **report})

async def analysis(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        source, ir = _compile(request.query.get("path", ""))
    except BenchyError as exc:
        return web.json_response({"ok": False, "error": exc.to_dict()})
    return web.json_response(analyze(ir, source))


# The findings report is the agent's: asked in a session of its own, not in
# any researcher's conversation, so it never waits for one or blocks it.
REPORT_PROMPT = (
    "Redactá el informe de hallazgos de este benchmark en {bench}/report.md, siguiendo la skill "
    "benchy-report-findings: los números de benchy_analysis, los hallazgos con su evidencia (pregunta, "
    "respuesta experta, respuesta del modelo, criterio que falla), las limitaciones y el ángulo para publicar."
)
REPORT_SPEAKER = (
    "No researcher is in this conversation: the app asks for the findings report when an evaluation "
    "finishes. Write the file, then reply in one line."
)
REPORT_TIMEOUT_S = 15 * 60


async def _write_report(bench: str) -> None:
    headers = {"authorization": f"Bearer {KEY}", "content-type": "application/json", "x-hermes-session-key": "benchy:report"}
    async with ClientSession(timeout=ClientTimeout(total=REPORT_TIMEOUT_S, sock_connect=10)) as http:
        async with http.post(f"{UPSTREAM}/api/sessions", json={}, headers=headers) as res:
            if res.status >= 400:
                raise RuntimeError(f"el agente no abrió una sesión ({res.status})")
            data = await res.json()
        session = (data.get("session") or {}).get("id") or data.get("session_id") or data.get("id")
        if not isinstance(session, str):
            raise RuntimeError("el agente no devolvió una sesión")
        body = {"message": REPORT_PROMPT.format(bench=bench), "system_message": REPORT_SPEAKER}
        async with http.post(f"{UPSTREAM}/api/sessions/{session}/chat", json=body, headers=headers) as res:
            if res.status >= 400:
                raise RuntimeError(f"el agente respondió {res.status}")
            await res.read()


async def evaluation(request: web.Request) -> web.Response:
    """GET: the benchmark's last evaluation. POST {path, models, grader_model?}: start one.
    `grader_model` (the org's judge config) judges these runs instead of the
    benchmark's own scoring.grader; without it, the benchmark's grader judges."""
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    if request.method == "GET":
        try:
            source, _ = _compile(request.query.get("path", ""))
        except BenchyError as exc:
            return web.json_response({"ok": False, "error": exc.to_dict()})
        return web.json_response({"ok": True, "evaluation": benchy_evaluation.status(source.parent)})
    try:
        body = await request.json()
        path, models = body["path"], body["models"]
        grader_model = body.get("grader_model")
        if not isinstance(path, str) or not isinstance(models, list) or not models or len(models) > len(MODELS):
            raise TypeError
        if not all(isinstance(m, str) for m in models):
            raise TypeError
        if grader_model is not None and (not isinstance(grader_model, str) or not grader_model):
            raise TypeError
    except (ValueError, KeyError, TypeError):
        return web.json_response({"error": "bad_request"}, status=400)
    try:
        source, ir = _compile(path)
        state = benchy_evaluation.start(source, ir, list(dict.fromkeys(models)), _write_report, grader_model=grader_model)
    except benchy_evaluation.Busy as busy:
        return web.json_response({"error": "busy", "evaluation": busy.status}, status=409)
    except BenchyError as exc:
        return web.json_response({"ok": False, "error": exc.to_dict()})
    return web.json_response({"ok": True, "evaluation": state})


async def report(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        source, _ = _compile(request.query.get("path", ""))
        state = benchy_evaluation.start_report(source, _write_report)
    except benchy_evaluation.Busy as busy:
        return web.json_response({"error": "busy", "evaluation": busy.status}, status=409)
    except BenchyError as exc:
        return web.json_response({"ok": False, "error": exc.to_dict()})
    return web.json_response({"ok": True, "evaluation": state})


def _archive() -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", compresslevel=9) as tar:
        if WORKSPACE.is_dir():
            for path in sorted(WORKSPACE.rglob("*")):
                if path.is_file() and not path.is_symlink() and not path.name.startswith(".write-"):
                    tar.add(path, arcname=str(path.relative_to(WORKSPACE)), recursive=False)
    return buf.getvalue()


async def backup(request: web.Request) -> web.Response:
    """The workspace (benchmarks, papers, runs, reports) as one .tar.gz."""
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    data = await asyncio.to_thread(_archive)
    if len(data) > MAX_BACKUP_BYTES:
        return web.json_response({"error": "too_large", "bytes": len(data)}, status=413)
    return web.Response(body=data, content_type="application/gzip")


async def add_source(request: web.Request) -> web.Response:
    """Body: {bench, paper} with the Worker's library Paper. Domain failures
    (no such benchmark, PDF unavailable) are {ok: false, error}, not HTTP errors."""
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        body = await request.json()
        bench, paper = body["bench"], body["paper"]
        if not isinstance(bench, str) or not isinstance(paper, dict):
            raise TypeError
    except (ValueError, KeyError, TypeError):
        return web.json_response({"error": "bad_request"}, status=400)
    try:
        source = await benchy_sources.add_paper(bench, paper, request.app["client"])
    except benchy_sources.SourceError as exc:
        return web.json_response({"ok": False, "error": exc.to_dict()})
    return web.json_response({"ok": True, "source": source})


async def upload_source(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    bench, name = request.query.get("bench", ""), request.query.get("name", "").strip()
    if not bench or not name or len(name) > 200:
        return web.json_response({"error": "bad_request"}, status=400)
    try:
        source = await benchy_sources.add_upload(bench, name, await request.read())
    except benchy_sources.SourceError as exc:
        return web.json_response({"ok": False, "error": exc.to_dict()})
    return web.json_response({"ok": True, "source": source})


async def remove_source(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    bench, sid = request.query.get("bench", ""), request.query.get("id", "")
    if not bench or not re.fullmatch(r"[a-z0-9-]{1,120}", sid):
        return web.json_response({"error": "bad_request"}, status=400)
    try:
        removed = await benchy_sources.remove(bench, sid)
    except benchy_sources.SourceError as exc:
        return web.json_response({"ok": False, "error": exc.to_dict()})
    return web.json_response({"ok": removed})


async def remove_benchmark(request: web.Request) -> web.Response:
    """Delete one benchmark and everything it produced: exam, sources, runs,
    report. Domain failures (no such benchmark) are {ok: false, error}."""
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    bench = request.query.get("bench", "")
    if not bench:
        return web.json_response({"error": "bad_request"}, status=400)
    try:
        await benchy_sources.remove_benchmark(bench)
    except benchy_sources.SourceError as exc:
        return web.json_response({"ok": False, "error": exc.to_dict()})
    return web.json_response({"ok": True})


async def remove_question(request: web.Request) -> web.Response:
    """Take one question out of a benchmark's exam: the row, its notes, its
    review, and every run's answers to it. Domain failures (no such benchmark
    or question) are {ok: false, error}."""
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    bench = request.query.get("bench", "")
    try:
        q = int(request.query.get("q", ""))
    except ValueError:
        q = 0
    if not bench or q < 1:
        return web.json_response({"error": "bad_request"}, status=400)
    try:
        await benchy_sources.remove_question(bench, q)
    except benchy_sources.SourceError as exc:
        return web.json_response({"ok": False, "error": exc.to_dict()})
    return web.json_response({"ok": True})


async def search(request: web.Request) -> web.Response:
    """Body: {bench, q}. Semantic search over the benchmark's papers and exam
    questions. Domain failures (no such benchmark, embedder unavailable) are
    {ok: false, error}, not HTTP errors."""
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        body = await request.json()
        bench, q = body["bench"], body["q"]
        if not isinstance(bench, str) or not isinstance(q, str) or not q.strip() or len(q) > 300:
            raise TypeError
    except (ValueError, KeyError, TypeError):
        return web.json_response({"error": "bad_request"}, status=400)
    try:
        found = await benchy_search.search(bench, q)
    except benchy_sources.SourceError as exc:
        return web.json_response({"ok": False, "error": exc.to_dict()})
    return web.json_response({"ok": True, **found})


async def proxy(request: web.Request) -> web.StreamResponse:
    session: ClientSession = request.app["client"]
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP}
    async with session.request(
        request.method,
        UPSTREAM + request.rel_url.path_qs,
        headers=headers,
        data=await request.read() if request.can_read_body else None,
        allow_redirects=False,
    ) as upstream:
        response = web.StreamResponse(
            status=upstream.status,
            headers={k: v for k, v in upstream.headers.items() if k.lower() not in HOP_BY_HOP},
        )
        await response.prepare(request)
        async for chunk in upstream.content.iter_any():
            await response.write(chunk)
        await response.write_eof()
        return response


async def _client(app: web.Application):
    # No total timeout: a turn may run a whole benchmark. The Worker owns the deadline.
    app["client"] = ClientSession(timeout=ClientTimeout(total=None, sock_connect=10))
    yield
    await app["client"].close()


def main() -> None:
    app = web.Application(client_max_size=25 * 1024 * 1024)
    app.cleanup_ctx.append(_client)
    app.router.add_get("/benchy/files", list_files)
    app.router.add_get("/benchy/file", read_file)
    app.router.add_get("/benchy/validate", validate)
    app.router.add_get("/benchy/exam", exam)
    app.router.add_get("/benchy/models", models)
    app.router.add_put("/benchy/file", write_file)
    app.router.add_post("/benchy/review", review)
    app.router.add_post("/benchy/quality", quality)
    app.router.add_get("/benchy/analysis", analysis)
    app.router.add_get("/benchy/evaluation", evaluation)
    app.router.add_post("/benchy/evaluation", evaluation)
    app.router.add_post("/benchy/report", report)
    app.router.add_get("/benchy/backup", backup)
    app.router.add_post("/benchy/sources", add_source)
    app.router.add_post("/benchy/sources/upload", upload_source)
    app.router.add_delete("/benchy/sources", remove_source)
    app.router.add_delete("/benchy/benchmark", remove_benchmark)
    app.router.add_delete("/benchy/benchmark/question", remove_question)
    app.router.add_post("/benchy/search", search)
    app.router.add_route("*", "/{tail:.*}", proxy)
    port = int(os.environ.get("PORT", "8080"))
    print(f"[benchy-proxy] :{port} -> {UPSTREAM}, workspace {WORKSPACE}", flush=True)
    web.run_app(app, host="0.0.0.0", port=port, access_log=None, print=None)


if __name__ == "__main__":
    main()
