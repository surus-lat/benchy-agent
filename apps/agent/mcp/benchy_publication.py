"""Publishing a benchmark: freeze a copy, then keep iterating on a new one.

Publishing takes the benchmark as it stands and keeps an immutable copy of the
whole folder — definition, exam, notes, papers, runs, report — in
<bench>/published/vN/, next to the live one. <bench>/publish.json says where
the workspace copy stands:

  {"state": "published", "version": 3, "basedOn": 2, "updatedAt": 1769900000,
   "by": "Ana Pérez", "note": "primera versión pública"}

  state  "published": the workspace files are v3, and nothing edits them;
                      the app's editors and the agent's tools refuse.
         "editing":   the researcher reverted the publication, so the workspace
                      files are a new draft that grew out of v`basedOn`.

Reverting does not undo anything: v3 stays exactly as it was; the workspace
copy simply becomes editable again and the next publish is v4. Each snapshot
carries a manifest.json (its files with size and mtime, who published it and
when, its note) so a published version can be listed, downloaded or cited long
after the working copy moved on.

The Worker keeps the same facts in D1, so the app's list and editors know them
without reading the workspace; this module is the container's own hard guard,
which also covers the agent's tools.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import shutil
import tempfile
import time
from pathlib import Path

from benchy_shared import workspace

PUBLISH_FILE = "publish.json"
SNAPSHOT_DIR = "published"
# What a published benchmark still accepts from the app: its findings report
# (rewritten after every evaluation) and what the grader grades with. The
# definition — benchmark.yaml, the exam, the questions' notes and design — does
# not change until the publication is reverted.
MUTABLE_WHEN_PUBLISHED = {"report.md", "report.previous.md", "review.json", "quality.json"}


class PublicationError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message}


def bench_dir(bench: str) -> Path:
    """The benchmark's folder: a single top-level workspace folder."""
    root = workspace()
    target = (root / bench).resolve() if isinstance(bench, str) and bench else None
    if target is None or target == root or root not in target.parents or target.parent != root:
        raise PublicationError("bad_bench", "the benchmark must be one workspace folder")
    if not (target / "benchmark.yaml").is_file():
        raise PublicationError("bench_not_found", f"there is no benchmark in {target.name}")
    return target


def _read_json(path: Path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".write-")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    os.replace(tmp, path)


@contextlib.contextmanager
def _locked(folder: Path):
    """One publisher at a time, across the proxy and the agent's MCP process."""
    with open(folder / ".publish.lock", "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def state_of(bench: str) -> dict | None:
    """What publish.json says about the benchmark, or None when it never was
    published (the same answer as a folder the agent reverted by hand)."""
    folder = bench_dir(bench)
    state = _read_json(folder / PUBLISH_FILE)
    if not state or not isinstance(state.get("version"), int) or state.get("state") not in ("published", "editing"):
        return None
    return state


def is_published(bench: str) -> bool:
    try:
        return (state_of(bench) or {}).get("state") == "published"
    except PublicationError:
        return False


def refuses_write(rel: str) -> str | None:
    """Why writing `rel` must be refused while its benchmark is published, or
    None when the write may go through. publish.json itself is never written
    from outside this module."""
    parts = Path(rel).parts
    if len(parts) < 2:
        return None
    if SNAPSHOT_DIR in parts[1:-1] or (len(parts) == 2 and parts[1] == PUBLISH_FILE):
        return "frozen"
    if not is_published(parts[0]):
        return None
    if parts[-1] in MUTABLE_WHEN_PUBLISHED:
        return None
    return "published"


def _versions(folder: Path) -> list[int]:
    out = []
    for entry in (folder / SNAPSHOT_DIR).iterdir() if (folder / SNAPSHOT_DIR).is_dir() else []:
        if entry.is_dir():
            try:
                out.append(int(entry.name.removeprefix("v")))
            except ValueError:
                continue
    return sorted(out)


def _copy_definition(folder: Path, into: Path) -> list[dict]:
    """Every file of the benchmark except its own snapshots and lock files."""
    copied = []
    for path in sorted(folder.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        rel = path.relative_to(folder)
        if rel.parts[0] == SNAPSHOT_DIR or rel.parts[0].startswith("."):
            continue
        if rel.parts[-1] == PUBLISH_FILE:
            continue
        target = into / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        stat = path.stat()
        copied.append({"path": str(rel), "size": stat.st_size, "modified": int(stat.st_mtime)})
    return copied


def publish(bench: str, note: str | None = None, by: str | None = None) -> dict:
    """Freeze the benchmark as v(n+1) and mark the workspace copy as that version."""
    folder = bench_dir(bench)
    with _locked(folder):
        versions = _versions(folder)
        state = state_of(bench) or {}
        version = max(versions + [int(state.get("version") or 0)]) + 1
        snapshot = folder / SNAPSHOT_DIR / f"v{version}"
        if snapshot.exists():
            raise PublicationError("version_exists", f"{snapshot.name} is already there")
        (folder / SNAPSHOT_DIR).mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(dir=folder / SNAPSHOT_DIR, prefix=f".v{version}-"))
        try:
            files = _copy_definition(folder, staging)
            stamp = int(time.time())
            _write_json(
                staging / "manifest.json",
                {
                    "version": version,
                    "bench": folder.name,
                    "publishedAt": stamp,
                    "by": by,
                    "note": (note or "").strip() or None,
                    "files": files,
                },
            )
            os.replace(staging, snapshot)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        _write_json(
            folder / PUBLISH_FILE,
            {
                "state": "published",
                "version": version,
                "basedOn": state.get("basedOn"),
                "updatedAt": stamp,
                "by": by,
                "note": (note or "").strip() or None,
            },
        )
    return {"version": version, "publishedAt": stamp, "path": f"{folder.name}/{SNAPSHOT_DIR}/v{version}", "files": files}


def revert(bench: str, by: str | None = None) -> dict:
    """Unlock the working copy: the publication stays as it is, and the workspace
    files become a draft based on it, ready to keep iterating on."""
    folder = bench_dir(bench)
    with _locked(folder):
        state = state_of(bench)
        if not state:
            raise PublicationError("not_published", "this benchmark has never been published")
        if state["state"] != "published":
            raise PublicationError("not_published", "this benchmark is already being edited")
        stamp = int(time.time())
        _write_json(
            folder / PUBLISH_FILE,
            {"state": "editing", "version": state["version"], "basedOn": state["version"], "updatedAt": stamp, "by": by},
        )
    return {"version": state["version"], "updatedAt": stamp, "state": "editing"}


def list_versions(bench: str) -> list[dict]:
    """The published versions, newest first, from their manifests."""
    folder = bench_dir(bench)
    out = []
    for version in reversed(_versions(folder)):
        manifest = _read_json(folder / SNAPSHOT_DIR / f"v{version}" / "manifest.json") or {}
        out.append(
            {
                "version": version,
                "publishedAt": manifest.get("publishedAt"),
                "by": manifest.get("by"),
                "note": manifest.get("note"),
                "files": len(manifest.get("files") or []),
            }
        )
    return out
