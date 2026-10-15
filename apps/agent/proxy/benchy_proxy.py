"""The container's only public port.

Hermes's API server listens on 127.0.0.1 only; this process fronts it:

  GET /benchy/files              the org workspace, listed (read-only)
  GET /benchy/file?path=...      one workspace file's text (read-only, <= 1 MB)
  GET /benchy/validate?path=...  compile a benchmark.yaml: valid, or the exact error
  GET /benchy/exam?path=...      every exam row checked against the program
  GET /benchy/models             the models a benchmark may run
  PUT /benchy/file               write one benchmark text file (the app's editors)
  POST /benchy/review?path=...   grade the expert answers against the rubric
  GET /benchy/analysis?path=...  the results beyond the score: criteria, topics, papers, answers
  POST /benchy/sources           add a library paper to a benchmark (fetches its PDF)
  POST /benchy/sources/upload?bench=...&name=...   add an uploaded PDF to a benchmark
  DELETE /benchy/sources?bench=...&id=...          take a paper out of a benchmark
  everything else                reverse-proxied to Hermes, streamed, unmodified

The /benchy routes check the same bearer key Hermes does (API_SERVER_KEY), so
the Worker — the only caller — uses one credential for both. Paths are
confined to the workspace. Writes are limited to benchmark text files, never
run results, and refuse to overwrite a file that changed since the caller read
it (the agent may have written it meanwhile).
"""

from __future__ import annotations

import hmac
import json
import os
import re
import sys
import tempfile
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, web

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "mcp"))  # /opt/benchy/mcp in the image
import benchy_sources  # noqa: E402
from benchy_analysis import analyze  # noqa: E402
from benchy_review import review as review_answers  # noqa: E402
from benchy_shared import MODELS  # noqa: E402

from benchy import types  # noqa: E402
from benchy.compiler import compile_benchmark  # noqa: E402
from benchy.errors import BenchyError  # noqa: E402

WORKSPACE = Path(os.environ.get("BENCHY_WORKSPACE", "/opt/data/workspace")).resolve()
UPSTREAM = f"http://127.0.0.1:{os.environ.get('API_SERVER_PORT', '8642')}"
KEY = os.environ["API_SERVER_KEY"]
MAX_FILE_BYTES = 1_000_000
MAX_ENTRIES = 2000
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
    return web.json_response({"provider": "bedrock", "models": MODELS})


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


async def analysis(request: web.Request) -> web.Response:
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        source, ir = _compile(request.query.get("path", ""))
    except BenchyError as exc:
        return web.json_response({"ok": False, "error": exc.to_dict()})
    return web.json_response(analyze(ir, source))


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
    app.router.add_get("/benchy/analysis", analysis)
    app.router.add_post("/benchy/sources", add_source)
    app.router.add_post("/benchy/sources/upload", upload_source)
    app.router.add_delete("/benchy/sources", remove_source)
    app.router.add_route("*", "/{tail:.*}", proxy)
    port = int(os.environ.get("PORT", "8080"))
    print(f"[benchy-proxy] :{port} -> {UPSTREAM}, workspace {WORKSPACE}", flush=True)
    web.run_app(app, host="0.0.0.0", port=port, access_log=None, print=None)


if __name__ == "__main__":
    main()
