"""The container's only public port.

Hermes's API server listens on 127.0.0.1 only; this process fronts it:

  GET /benchy/files          the org workspace, listed (read-only)
  GET /benchy/file?path=...  one workspace file's text (read-only, <= 1 MB)
  everything else            reverse-proxied to Hermes, streamed, unmodified

The /benchy routes check the same bearer key Hermes does (API_SERVER_KEY), so
the Worker — the only caller — uses one credential for both. Paths are
confined to the workspace; nothing here writes.
"""

from __future__ import annotations

import hmac
import os
import time
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, web

WORKSPACE = Path(os.environ.get("BENCHY_WORKSPACE", "/opt/data/workspace")).resolve()
UPSTREAM = f"http://127.0.0.1:{os.environ.get('API_SERVER_PORT', '8642')}"
KEY = os.environ["API_SERVER_KEY"]
MAX_FILE_BYTES = 1_000_000
MAX_ENTRIES = 2000
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
    app.router.add_route("*", "/{tail:.*}", proxy)
    port = int(os.environ.get("PORT", "8080"))
    print(f"[benchy-proxy] :{port} -> {UPSTREAM}, workspace {WORKSPACE}", flush=True)
    web.run_app(app, host="0.0.0.0", port=port, access_log=None, print=None)


if __name__ == "__main__":
    main()
