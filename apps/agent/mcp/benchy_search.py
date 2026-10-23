"""Semantic search inside one benchmark: the text of its papers and its exam
questions, embedded and ranked in the agent container.

No external vector store: the vectors live next to the benchmark, in
`<bench>/.vectors.json`, keyed by a hash of the chunk's text. Every search
re-reads the sources and the exam and only pays the embedder for chunks that
are new or changed. The index is bounded: at most MAX_CHUNKS chunks per
benchmark (chunking the papers is what runs out first; a benchmark with more
text than that is searched over its first MAX_CHUNKS windows).

Chunk ids say what a hit is: `src:<source-id>:<n>` for a window of a paper's
markdown, `exam:<row>` for one exam question (0-based, the index the app
shows as pregunta row+1).

Shared by the MCP server (`benchy_search`) and the proxy (`POST /benchy/search`).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
from pathlib import Path

from aiohttp import ClientError, ClientSession, ClientTimeout

from benchy_sources import SourceError, _exam_path, _locked, _write, bench_dir, load_index

MODEL = "amazon.titan-embed-text-v2:0"
DIM = 1024
# Bumping VERSION, MODEL or DIM invalidates every cached vector.
VERSION = 1
CHUNK_WORDS = 500
CHUNK_OVERLAP = 100
MAX_CHUNKS = 2000
CONCURRENCY = 4

# Titan v2 was trained to expect these prefixes: the same text embeds
# differently as a query than as a passage.
PREFIXES = {"query": "prefix0 query: ", "document": "prefix0 passage: "}

_gate = asyncio.Semaphore(CONCURRENCY)


def _endpoint() -> str:
    region = os.environ.get("AWS_BEDROCK_REGION", "us-east-1")
    return (
        f"https://bedrock-runtime.{region}.amazonaws.com"
        f"/model/{MODEL.replace(':', '%3A')}/invoke"
    )


async def embed(text: str, kind: str) -> list[float]:
    """One embedding from Bedrock. The key is read at call time: the container
    gets it from its runtime environment, not from this module's import."""
    key = os.environ.get("AWS_BEARER_TOKEN_BEDROCK")
    if not key:
        raise SourceError("embed_not_configured", "this container has no Bedrock key to embed with")
    if kind not in PREFIXES:
        raise SourceError("bad_kind", f"unknown embed kind {kind!r}")
    body = {"inputText": PREFIXES[kind] + text}
    headers = {"authorization": f"Bearer {key}", "content-type": "application/json"}
    timeout = ClientTimeout(total=60)
    async with _gate:
        try:
            async with ClientSession(timeout=timeout) as http:
                async with http.post(_endpoint(), headers=headers, json=body) as res:
                    if res.status != 200:
                        raise SourceError("embed_failed", f"the embedder answered HTTP {res.status}")
                    data = await res.json()
        except (ClientError, asyncio.TimeoutError) as exc:
            raise SourceError("embed_failed", f"the embedder could not be reached: {exc}") from exc
    vec = data.get("embedding") if isinstance(data, dict) else None
    if not isinstance(vec, list) or len(vec) != DIM:
        raise SourceError("embed_failed", "the embedder returned an unexpected vector")
    return [float(v) for v in vec]


def chunk(markdown: str) -> list[str]:
    """The text cut into ~500-word sliding windows, 100 words of overlap."""
    words = markdown.split()
    if not words:
        return []
    step = CHUNK_WORDS - CHUNK_OVERLAP
    out: list[str] = []
    i = 0
    while True:
        out.append(" ".join(words[i : i + CHUNK_WORDS]))
        if i + CHUNK_WORDS >= len(words):
            break
        i += step
    return out


def _documents(folder: Path) -> list[dict]:
    """Every searchable piece of the benchmark: each paper's markdown cut into
    windows, then each exam row as one document (its question text). Capped at
    MAX_CHUNKS documents."""
    docs: list[dict] = []
    for source in load_index(folder):
        sid = str(source.get("id") or "")
        if not sid:
            continue
        file = folder / str(source.get("file") or f"sources/{sid}.md")
        try:
            text = file.read_text(encoding="utf-8")
        except OSError:
            continue  # the index lists a paper whose file is gone: search without it
        for n, piece in enumerate(chunk(text)):
            docs.append({"id": f"src:{sid}:{n}", "text": piece, "title": source.get("title") or sid})
    try:
        exam = _exam_path(folder)
    except SourceError:
        exam = None  # a benchmark whose exam does not (yet) exist: papers only
    if exam is not None:
        row = 0
        for line in exam.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except ValueError:
                row += 1
                continue
            question = (record.get("input") or {}).get("question")
            if isinstance(question, str) and question.strip():
                docs.append({"id": f"exam:{row}", "text": question, "title": None})
            row += 1
    return docs[:MAX_CHUNKS]


def _cache_path(folder: Path) -> Path:
    return folder / ".vectors.json"


def _load_cache(folder: Path) -> dict[str, dict]:
    """The cached items keyed by id, or none if the file is missing, unreadable
    or made by another version of this index (version, model or dim changed)."""
    try:
        data = json.loads(_cache_path(folder).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict) or data.get("version") != VERSION or data.get("model") != MODEL or data.get("dim") != DIM:
        return {}
    items = data.get("items")
    if not isinstance(items, list):
        return {}
    return {
        it["id"]: it
        for it in items
        if isinstance(it, dict) and isinstance(it.get("id"), str) and isinstance(it.get("vec"), list)
    }


def _save_cache(folder: Path, items: list[dict]) -> None:
    _write(
        _cache_path(folder),
        json.dumps({"version": VERSION, "model": MODEL, "dim": DIM, "items": items}, ensure_ascii=False) + "\n",
    )


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


async def search(bench: str, query: str, k: int = 8) -> dict:
    """Embed what is new, then rank every chunk of the benchmark against `query`
    by cosine similarity; returns the top `k` as {id, text, score, title}."""
    folder = bench_dir(bench)
    if not isinstance(query, str) or not query.strip():
        raise SourceError("empty_query", "give a query to search for")
    async with _locked(folder):
        cached = _load_cache(folder)
        docs = _documents(folder)
        items: list[dict] = []
        todo: list[tuple[dict, str]] = []
        for doc in docs:
            digest = hashlib.sha256(doc["text"].encode("utf-8")).hexdigest()[:16]
            old = cached.get(doc["id"])
            if old and old.get("hash") == digest:
                items.append({"id": doc["id"], "text": doc["text"], "hash": digest, "vec": old["vec"]})
            else:
                todo.append((doc, digest))
        if todo:
            vectors = await asyncio.gather(*(embed(doc["text"], "document") for doc, _ in todo))
            for (doc, digest), vec in zip(todo, vectors):
                items.append({"id": doc["id"], "text": doc["text"], "hash": digest, "vec": vec})
            _save_cache(folder, items)
    qvec = await embed(query, "query")
    scored = sorted(items, key=lambda it: _cosine(qvec, it["vec"]), reverse=True)[: max(1, k)]
    return {
        "query": query,
        "results": [
            {"id": it["id"], "text": it["text"], "score": round(_cosine(qvec, it["vec"]), 4), "title": _title_of(it["id"], folder)}
            for it in scored
        ],
    }


def _title_of(doc_id: str, folder: Path) -> str | None:
    """The paper's title for a `src:` hit; exam hits carry their own number."""
    parts = doc_id.split(":")
    if parts[0] != "src" or len(parts) < 2:
        return None
    source = next((s for s in load_index(folder) if s.get("id") == parts[1]), None)
    return (source or {}).get("title") or parts[1]
