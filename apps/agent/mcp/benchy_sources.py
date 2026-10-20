"""A benchmark's papers: the sources its questions are written from.

Each paper is kept as text next to the exam, where the agent reads it:

  <bench>/sources.json             {"sources": [{id, origin, title, authors, year, url,
                                     pdf_url, file, pages, chars, text, added}]}
  <bench>/sources/<id>.md          the paper: metadata, abstract, full text with
                                     [p. N] page markers to cite

Papers come from the library (CONICET Digital, whose open-access PDFs are in
the UNRN/ri-conicet dataset on Hugging Face, and BICyT records whose PDFs the
Worker keeps in R2) or are PDFs the researcher uploads. A library paper
without an open PDF, or whose PDF has no text, is kept with its abstract only
(text: "abstract").

Both the proxy (the app's buttons) and the MCP server (the agent's tools)
write here, so the index is changed under a file lock.
"""

from __future__ import annotations

import asyncio
import contextlib
import fcntl
import hashlib
import io
import json
import os
import re
import shutil
import tempfile
import threading
import time
import unicodedata
from pathlib import Path

from aiohttp import ClientError, ClientSession, ClientTimeout

WORKSPACE = Path(os.environ.get("BENCHY_WORKSPACE", "/opt/data/workspace")).resolve()
# The Worker: the library's own PDFs (R2), fetched with this container's key.
API_URL = os.environ.get("BENCHY_API_URL", "https://getbenchy.lat").rstrip("/")
API_KEY = os.environ.get("API_SERVER_KEY", "")
DATASET_PDF = re.compile(r"^https://huggingface\.co/datasets/UNRN/ri-conicet/resolve/main/papers/\d{3}/\d+\.pdf$")
LIBRARY_PDF = re.compile("^" + re.escape(API_URL) + r"/api/library/files/[a-z]+/\d+\.pdf$")
ORIGINS = {"conicet", "bicyt"}
MAX_PDF_BYTES = 40 * 1024 * 1024
MAX_PAGES = 400
MAX_CHARS = 800_000
# Fewer characters than this in the whole PDF: a scan, not text.
MIN_TEXT = 200

_locks: dict[str, asyncio.Lock] = {}


@contextlib.asynccontextmanager
async def _locked(folder: Path):
    """This process's lock, then the cross-process one on <bench>/.sources.lock."""
    async with _locks.setdefault(str(folder), asyncio.Lock()):
        with open(folder / ".sources.lock", "a") as fh:
            await asyncio.to_thread(fcntl.flock, fh, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)
# PDFium is not thread-safe: one extraction at a time.
_pdfium = threading.Lock()


class SourceError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message}


def bench_dir(bench: str) -> Path:
    """The benchmark's folder: a top-level workspace folder with a benchmark.yaml."""
    target = (WORKSPACE / bench).resolve() if isinstance(bench, str) and bench else None
    if (
        target is None
        or target.parent != WORKSPACE
        or target.name.startswith(".")
        or target.is_symlink()
        or not (target / "benchmark.yaml").is_file()
    ):
        raise SourceError("bench_not_found", f"no benchmark {bench!r} in the workspace")
    return target


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".write-")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def load_index(folder: Path) -> list[dict]:
    try:
        sources = json.loads((folder / "sources.json").read_text(encoding="utf-8")).get("sources")
    except (OSError, ValueError, AttributeError):
        return []
    return [s for s in sources if isinstance(s, dict)] if isinstance(sources, list) else []


def _save_index(folder: Path, sources: list[dict]) -> None:
    _write(folder / "sources.json", json.dumps({"sources": sources}, ensure_ascii=False, indent=2) + "\n")


def _clean(text: str) -> str:
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)  # words hyphenated across lines
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def is_pdf(data: bytes) -> bool:
    # The header may follow some junk, within the first 1024 bytes (PDF 1.7, 7.5.2).
    return b"%PDF-" in data[:1024]


def extract(data: bytes) -> tuple[list[str], dict]:
    """The PDF's pages as text, and its title and author if it declares them."""
    import pypdfium2 as pdfium

    with _pdfium:
        try:
            pdf = pdfium.PdfDocument(data)
        except Exception as exc:
            raise SourceError("unreadable_pdf", f"the PDF could not be read: {exc}") from exc
        try:
            pages, total = [], 0
            for i in range(min(len(pdf), MAX_PAGES)):
                try:
                    text = _clean(pdf[i].get_textpage().get_text_range().replace("\r\n", "\n").replace("\r", "\n"))
                except Exception:  # one unreadable page does not lose the paper
                    text = ""
                pages.append(text)
                total += len(text)
                if total >= MAX_CHARS:
                    break
            meta = pdf.get_metadata_dict(skip_empty=True)
        finally:
            pdf.close()
    return pages, {"title": str(meta.get("Title", "")).strip(), "author": str(meta.get("Author", "")).strip()}


async def _download(http: ClientSession, url: str) -> bytes:
    headers = {"Authorization": f"Bearer {API_KEY}"} if LIBRARY_PDF.match(url) else {}
    try:
        async with http.get(url, headers=headers, timeout=ClientTimeout(total=90)) as res:
            if res.status != 200:
                raise SourceError("pdf_unavailable", f"the PDF could not be downloaded (HTTP {res.status})")
            data = bytearray()
            async for chunk in res.content.iter_chunked(1 << 16):
                data += chunk
                if len(data) > MAX_PDF_BYTES:
                    raise SourceError("pdf_too_large", "the PDF is larger than 40 MB")
    except (ClientError, asyncio.TimeoutError) as exc:
        raise SourceError("pdf_unavailable", f"the PDF could not be downloaded: {exc}") from exc
    return bytes(data)


def render(source: dict, abstract: str, pages: list[str], missing: str | None) -> str:
    lines = [
        f"# {source['title']}",
        "",
        f"id: {source['id']}",
        f"autores: {'; '.join(source['authors']) or '—'}",
        f"año: {source['year'] or '—'}",
    ]
    if source.get("url"):
        lines.append(f"fuente: {source['url']}")
    if source.get("pdf_url"):
        lines.append(f"pdf: {source['pdf_url']}")
    lines.append(f"texto: completo, {source['pages']} páginas" if not missing else "texto: solo el resumen")
    lines += ["", "## Resumen", "", abstract.strip() or "(sin resumen)", "", "## Texto", ""]
    if missing:
        lines.append(f"(No hay texto completo: {missing}. Las preguntas salen solo del resumen.)")
    else:
        body, used = [], 0
        for n, page in enumerate(pages, 1):
            if not page:
                continue
            body.append(f"[p. {n}]\n{page}")
            used += len(page)
            if used >= MAX_CHARS:
                body.append("(El texto sigue en el PDF: se guardó hasta acá.)")
                break
        lines.append("\n\n".join(body))
    return "\n".join(lines).rstrip() + "\n"


async def _store(folder: Path, source: dict, abstract: str, pages: list[str], missing: str | None) -> dict:
    async with _locked(folder):
        sources = load_index(folder)
        existing = next((s for s in sources if s.get("id") == source["id"]), None)
        if existing:
            return existing
        _write(folder / source["file"], render(source, abstract, pages, missing))
        sources.append(source)
        _save_index(folder, sources)
    return source


def _pages_info(pages: list[str]) -> tuple[int, int]:
    return len(pages), sum(len(p) for p in pages)


async def add_paper(bench: str, paper: dict, http: ClientSession) -> dict:
    """A library paper (the Worker's Paper shape) into the benchmark."""
    folder = bench_dir(bench)
    try:
        pid = int(paper["id"])
        title = str(paper.get("title") or "").strip() or "(sin título)"
    except (KeyError, TypeError, ValueError) as exc:
        raise SourceError("bad_paper", "the paper needs an id and a title") from exc
    pdf_url = paper.get("pdfUrl")
    if pdf_url is not None and not (isinstance(pdf_url, str) and (DATASET_PDF.match(pdf_url) or LIBRARY_PDF.match(pdf_url))):
        raise SourceError("bad_paper", "the PDF must come from the library (the CONICET dataset or the Worker)")
    origin = paper.get("origin") or "conicet"
    if origin not in ORIGINS:
        raise SourceError("bad_paper", f"unknown paper origin {origin!r}")
    sid = f"{origin}-{pid}"
    existing = next((s for s in load_index(folder) if s.get("id") == sid), None)
    if existing:
        return existing

    pages: list[str] = []
    missing = None
    if not pdf_url:
        missing = "el paper no tiene PDF de acceso abierto"
    else:
        data = await _download(http, pdf_url)
        pages, _ = await asyncio.to_thread(extract, data)
        if _pages_info(pages)[1] < MIN_TEXT:
            pages, missing = [], "el PDF no tiene texto extraíble (probablemente está escaneado)"

    n_pages, chars = _pages_info(pages)
    source = {
        "id": sid,
        "origin": origin,
        "title": title,
        "authors": [str(a) for a in paper.get("creators") or []][:50],
        "year": paper.get("year") if isinstance(paper.get("year"), int) else None,
        "url": paper.get("url") if isinstance(paper.get("url"), str) else None,
        "pdf_url": pdf_url,
        "file": f"sources/{sid}.md",
        "pages": n_pages,
        "chars": chars,
        "text": "abstract" if missing else "full",
        "added": int(time.time()),
    }
    return await _store(folder, source, str(paper.get("description") or ""), pages, missing)


def _slug(name: str) -> str:
    stem = re.sub(r"\.pdf$", "", name.strip(), flags=re.I)
    ascii_stem = unicodedata.normalize("NFKD", stem.lower()).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_stem).strip("-")
    return slug[:40].strip("-") or "paper"


async def add_upload(bench: str, name: str, data: bytes) -> dict:
    """A PDF the researcher uploaded into the benchmark."""
    folder = bench_dir(bench)
    if not is_pdf(data):
        raise SourceError("not_pdf", "the file is not a PDF")
    if len(data) > MAX_PDF_BYTES:
        raise SourceError("pdf_too_large", "the PDF is larger than 40 MB")
    sid = f"pdf-{_slug(name)}-{hashlib.sha256(data).hexdigest()[:8]}"
    existing = next((s for s in load_index(folder) if s.get("id") == sid), None)
    if existing:
        return existing
    pages, info = await asyncio.to_thread(extract, data)
    n_pages, chars = _pages_info(pages)
    if chars < MIN_TEXT:
        raise SourceError("no_text", "the PDF has no extractable text (is it a scan?)")
    stem = re.sub(r"\.pdf$", "", name.strip(), flags=re.I)
    source = {
        "id": sid,
        "origin": "upload",
        "title": info.get("title") or stem,
        "authors": [info["author"]] if info.get("author") else [],
        "year": None,
        "url": None,
        "pdf_url": None,
        "file": f"sources/{sid}.md",
        "pages": n_pages,
        "chars": chars,
        "text": "full",
        "added": int(time.time()),
    }
    return await _store(folder, source, "", pages, None)


async def remove(bench: str, sid: str) -> bool:
    folder = bench_dir(bench)
    async with _locked(folder):
        sources = load_index(folder)
        keep = [s for s in sources if s.get("id") != sid]
        if len(keep) == len(sources):
            return False
        target = (folder / "sources" / f"{sid}.md").resolve()
        if target.parent == (folder / "sources").resolve() and target.is_file():
            target.unlink()
        _save_index(folder, keep)
    return True


async def remove_benchmark(bench: str) -> None:
    """Delete a benchmark: the whole folder — exam, sources, runs, report."""
    folder = bench_dir(bench)
    async with _locked(folder):
        await asyncio.to_thread(shutil.rmtree, folder)
