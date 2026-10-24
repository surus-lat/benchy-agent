"""Semantic search inside one benchmark: papers ranked by the embeddings
already computed in the UNRN/ri-conicet dataset, exam questions as text.

No external vector store and no re-vectorisation: the papers' 768-d
EmbeddingGemma-2 vectors travel from the parquet through the library,
through the Worker, and into ``sources.json`` alongside each paper.
Only the *query* is embedded at search time — by loading the same
EmbeddingGemma-2 model (text-only, 270 M params, runs on CPU) lazily
on first use and caching it for subsequent searches.

Chunk ids: ``src:<source-id>`` for a paper (whole-paper embedding from
the dataset), ``exam:<row>`` for one exam question (embedded at search
time, if a query-model is available — otherwise exam hits are excluded).

Shared by the MCP server (``benchy_search``) and the proxy
(``POST /benchy/search``).
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import struct
from pathlib import Path

from benchy_sources import SourceError, _exam_path, _locked, bench_dir, load_index

DIM = 768  # EmbeddingGemma-2 output dimensionality
VERSION = 2  # bumping invalidates the query-side cache

# ---------- lazy query embedder (EmbeddingGemma-2, text-only) ----------

_model = None
_model_lock = asyncio.Lock()


async def _get_model():
    """Load google/embeddinggemma-2 text-only on first call.  The model is
    ~270 M params when vision+audio encoders are skipped.  Runs on CPU in
    float32.  The download goes to the HF cache (persistent volume in
    Railway)."""
    global _model
    if _model is not None:
        return _model
    async with _model_lock:
        if _model is not None:
            return _model
        try:
            from sentence_transformers import SentenceTransformer  # type: ignore
        except ImportError:
            raise SourceError(
                "embed_not_configured",
                "sentence-transformers is not installed in this container",
            )
        _model = await asyncio.to_thread(
            SentenceTransformer,
            "google/embeddinggemma-2",
            config_kwargs={"vision_config": None, "audio_config": None},
            model_kwargs={"torch_dtype": "float32"},
        )
        return _model


async def embed_query(text: str) -> list[float]:
    """Embed a search query with EmbeddingGemma-2."""
    model = await _get_model()
    vec = await asyncio.to_thread(model.encode, text, prompt_name="SearchQuery")
    return [float(v) for v in vec]


# ---------- reading stored embeddings ----------


def _parse_embedding(raw) -> list[float] | None:
    """Accept a stored embedding in any of the formats we might encounter:
    a list of floats (JSON-serialised), a base64 string of packed float32s,
    or ``None``."""
    if raw is None:
        return None
    if isinstance(raw, list) and len(raw) == DIM:
        return [float(v) for v in raw]
    if isinstance(raw, str):
        import base64
        try:
            data = base64.b64decode(raw)
        except Exception:
            return None
        if len(data) == DIM * 4:
            return list(struct.unpack(f"<{DIM}f", data))
    return None


def _source_embeddings(folder: Path) -> dict[str, list[float]]:
    """Read the pre-computed embedding for each source whose entry in
    ``sources.json`` carries one."""
    out: dict[str, list[float]] = {}
    for source in load_index(folder):
        sid = str(source.get("id") or "")
        vec = _parse_embedding(source.get("embedding"))
        if sid and vec:
            out[sid] = vec
    return out


# ---------- cosine similarity ----------


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


# ---------- search ----------


async def search(bench: str, query: str, k: int = 8) -> dict:
    """Rank a benchmark's papers (and optionally its exam questions) against
    ``query`` by cosine similarity with their stored embeddings.

    Papers without a stored embedding (uploaded PDFs, papers whose parquet
    row had no vector) are excluded from results — they are still searchable
    via the existing FTS keyword search in the app.
    """
    folder = bench_dir(bench)
    if not isinstance(query, str) or not query.strip():
        raise SourceError("empty_query", "give a query to search for")

    qvec = await embed_query(query.strip())

    # Collect papers with their pre-computed embeddings.
    async with _locked(folder):
        embeddings = _source_embeddings(folder)
        sources_index = {str(s.get("id") or ""): s for s in load_index(folder)}

    candidates: list[dict] = []
    for sid, vec in embeddings.items():
        score = _cosine(qvec, vec)
        source = sources_index.get(sid, {})
        candidates.append({
            "id": f"src:{sid}",
            "text": (source.get("title") or sid),
            "score": round(score, 4),
            "title": source.get("title") or sid,
        })

    # Optionally embed exam questions (at query time, since they have no
    # pre-computed embedding).
    try:
        exam_path = _exam_path(folder)
        row = 0
        for line in exam_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except ValueError:
                row += 1
                continue
            question = (record.get("input") or {}).get("question")
            if isinstance(question, str) and question.strip():
                # Embed the question text with the same model.
                try:
                    evec = await embed_query(question.strip())
                    score = _cosine(qvec, evec)
                    candidates.append({
                        "id": f"exam:{row}",
                        "text": question.strip()[:200],
                        "score": round(score, 4),
                        "title": None,
                    })
                except SourceError:
                    pass  # model not available — skip exam hits
            row += 1
    except SourceError:
        pass  # no exam yet — papers only

    scored = sorted(candidates, key=lambda c: c["score"], reverse=True)[:max(1, k)]
    return {"query": query.strip(), "results": scored}
