"""Query embedding for semantic library search.

Embeds text with google/embeddinggemma-2 (768d, text-only, CPU).
Used by the proxy's POST /benchy/embed and the MCP tool.
"""

from __future__ import annotations

import asyncio

DIM = 768
_model = None
_model_lock = asyncio.Lock()


class EmbedError(Exception):
    """Raised when embedding fails (missing dependency, model load error)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message}


async def _get_model():
    global _model
    if _model is not None:
        return _model
    async with _model_lock:
        if _model is not None:
            return _model
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError:
            raise EmbedError("embed_not_configured", "sentence-transformers not installed")
        _model = await asyncio.to_thread(
            SentenceTransformer,
            "google/embeddinggemma-2",
            config_kwargs={"vision_config": None, "audio_config": None},
            model_kwargs={"torch_dtype": "float32"},
        )
        return _model


async def embed_query(text: str) -> list[float]:
    """Embed a query string and return its 768-d vector."""
    model = await _get_model()
    vec = await asyncio.to_thread(model.encode, text, prompt_name="SearchQuery")
    return [float(v) for v in vec]
