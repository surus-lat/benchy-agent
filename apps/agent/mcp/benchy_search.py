"""Semantic search inside one benchmark: papers ranked by their pre-computed
768-d EmbeddingGemma-2 embeddings, exam questions embedded at query time.

Storage: Qdrant local mode (on-disk, no server process) at ``<bench>/.qdrant/``.
Papers are upserted when added via ``benchy_sources``; the collection is
rebuilt lazily on first search if the Qdrant store is empty or stale.

Query embedding: ``sentence-transformers`` with ``google/embeddinggemma-2``
(text-only, 270 M params, CPU).  FastEmbed does not support EmbeddingGemma-2
(only the older 300 M v1 in a different embedding space), so we keep
sentence-transformers for query-time encoding.

Chunk ids: ``src:<source-id>`` for a paper (whole-paper embedding from the
dataset), ``exam:<row>`` for one exam question (embedded at search time).

Shared by the MCP server (``benchy_search``) and the proxy
(``POST /benchy/search``).
"""

from __future__ import annotations

import asyncio
import json
import os
import struct
from pathlib import Path

from benchy_sources import SourceError, _exam_path, _locked, bench_dir, load_index

DIM = 768  # EmbeddingGemma-2 output dimensionality
VERSION = 3  # bumping invalidates the query-side cache
COLLECTION = "benchy_papers"

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


# ---------- Qdrant local helpers ----------


def _qdrant_path(folder: Path) -> str:
    """On-disk Qdrant storage inside the benchmark folder."""
    return str(folder / ".qdrant")


def _get_client(folder: Path):
    """Create a Qdrant client in local (embedded) mode — no server needed."""
    from qdrant_client import QdrantClient

    return QdrantClient(path=_qdrant_path(folder))


def _ensure_collection(client, *, recreate: bool = False) -> None:
    """Create the collection if it does not exist (or recreate it)."""
    from qdrant_client.models import Distance, VectorParams

    if recreate:
        if client.collection_exists(COLLECTION):
            client.delete_collection(COLLECTION)
    if not client.collection_exists(COLLECTION):
        client.create_collection(
            collection_name=COLLECTION,
            vectors_config=VectorParams(size=DIM, distance=Distance.COSINE),
        )


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


# ---------- collection sync ----------


def _sync_collection(folder: Path) -> None:
    """Rebuild the Qdrant collection from sources.json embeddings.

    Called under the benchmark's file lock so sources.json is stable.
    Replaces the whole collection to stay consistent.
    """
    from qdrant_client.models import PointStruct

    sources = load_index(folder)
    points: list = []
    for source in sources:
        sid = str(source.get("id") or "")
        vec = _parse_embedding(source.get("embedding"))
        if sid and vec:
            # Use a deterministic integer id from the string hash
            point_id = abs(hash(sid)) % (2**63)
            points.append(PointStruct(
                id=point_id,
                vector=vec,
                payload={
                    "item_id": sid,
                    "source_type": "paper",
                    "title": source.get("title") or sid,
                },
            ))

    client = _get_client(folder)
    try:
        _ensure_collection(client, recreate=True)
        if points:
            # Upsert in batches of 100
            for i in range(0, len(points), 100):
                client.upsert(collection_name=COLLECTION, points=points[i:i + 100])
    finally:
        client.close()


def _collection_count(folder: Path) -> int:
    """How many points the collection has, 0 if it doesn't exist."""
    client = _get_client(folder)
    try:
        if not client.collection_exists(COLLECTION):
            return 0
        return client.count(collection_name=COLLECTION).count
    except Exception:
        return 0
    finally:
        client.close()


def _source_count_with_embeddings(folder: Path) -> int:
    """Count sources in sources.json that have embeddings."""
    count = 0
    for source in load_index(folder):
        if _parse_embedding(source.get("embedding")) is not None:
            count += 1
    return count


# ---------- search ----------


async def search(bench: str, query: str, k: int = 8) -> dict:
    """Rank a benchmark's papers (and optionally its exam questions) against
    ``query`` by cosine similarity using Qdrant local mode.

    Papers without a stored embedding (uploaded PDFs, papers whose parquet
    row had no vector) are excluded from results — they are still searchable
    via the existing FTS keyword search in the app.
    """
    folder = bench_dir(bench)
    if not isinstance(query, str) or not query.strip():
        raise SourceError("empty_query", "give a query to search for")

    qvec = await embed_query(query.strip())

    # Ensure the Qdrant collection is in sync with sources.json.
    async with _locked(folder):
        expected = _source_count_with_embeddings(folder)
        actual = _collection_count(folder)
        if actual != expected or expected == 0:
            await asyncio.to_thread(_sync_collection, folder)

    # Query Qdrant for similar papers.
    candidates: list[dict] = []

    def _qdrant_search():
        client = _get_client(folder)
        try:
            if not client.collection_exists(COLLECTION):
                return []
            results = client.query_points(
                collection_name=COLLECTION,
                query=qvec,
                limit=max(1, k),
                with_payload=True,
            )
            return results.points
        finally:
            client.close()

    hits = await asyncio.to_thread(_qdrant_search)
    for hit in hits:
        payload = hit.payload or {}
        candidates.append({
            "id": f"src:{payload.get('item_id', '')}",
            "text": payload.get("title", ""),
            "score": round(hit.score, 4),
            "title": payload.get("title", ""),
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

                    # Compute cosine similarity manually for exam questions
                    # (they are not in Qdrant — embedded on-the-fly).
                    dot = sum(a * b for a, b in zip(qvec, evec))
                    na = sum(a * a for a in qvec) ** 0.5
                    nb = sum(b * b for b in evec) ** 0.5
                    score = dot / (na * nb) if na and nb else 0.0

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
