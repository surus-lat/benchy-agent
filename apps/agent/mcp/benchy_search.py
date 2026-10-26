"""Query embedding for semantic library search.

Embeds text with google/embeddinggemma-2 (768d, text-only, CPU) via ONNX Runtime.
No torch or sentence-transformers needed at runtime — only onnxruntime, tokenizers,
and numpy.

Used by the proxy's POST /benchy/embed and the MCP tool.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import numpy as np

DIM = 768

_PROMPT = "task: search result | query: "
_MODEL_DIR = os.environ.get(
    "EMBED_MODEL_DIR",
    str(Path(__file__).resolve().parent / "embed_model"),
)

_session = None
_tokenizer = None
_init_lock = asyncio.Lock()


class EmbedError(Exception):
    """Raised when embedding fails (missing dependency, model load error)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message}


def _load_sync():
    """Load ONNX session + tokenizer (runs once, in a thread)."""
    import onnxruntime as ort
    from tokenizers import Tokenizer

    model_path = os.path.join(_MODEL_DIR, "model_q8.onnx")
    tokenizer_path = os.path.join(_MODEL_DIR, "tokenizer.json")

    if not os.path.isfile(model_path):
        raise EmbedError(
            "embed_not_configured",
            f"ONNX model not found at {model_path}",
        )
    if not os.path.isfile(tokenizer_path):
        raise EmbedError(
            "embed_not_configured",
            f"Tokenizer not found at {tokenizer_path}",
        )

    session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])

    tokenizer = Tokenizer.from_file(tokenizer_path)
    tokenizer.enable_padding()
    tokenizer.enable_truncation(max_length=8192)

    return session, tokenizer


async def _get_session():
    global _session, _tokenizer
    if _session is not None:
        return _session, _tokenizer
    async with _init_lock:
        if _session is not None:
            return _session, _tokenizer
        try:
            _session, _tokenizer = await asyncio.to_thread(_load_sync)
        except ImportError as exc:
            raise EmbedError("embed_not_configured", str(exc))
        return _session, _tokenizer


def _embed_sync(session, tokenizer, text: str) -> list[float]:
    """Tokenize, run ONNX inference, mean-pool, L2-normalize."""
    encoded = tokenizer.encode(_PROMPT + text)
    input_ids = np.array([encoded.ids], dtype=np.int64)
    attention_mask = np.array([encoded.attention_mask], dtype=np.int64)

    hidden = session.run(
        ["last_hidden_state"],
        {"input_ids": input_ids, "attention_mask": attention_mask},
    )[0]  # (1, seq_len, 768)

    mask = attention_mask[:, :, np.newaxis].astype(np.float32)
    pooled = (hidden * mask).sum(axis=1) / mask.sum(axis=1)
    norm = np.linalg.norm(pooled, axis=1, keepdims=True)
    normed = pooled / norm
    return [float(v) for v in normed[0]]


async def embed_query(text: str) -> list[float]:
    """Embed a query string and return its 768-d vector."""
    session, tokenizer = await _get_session()
    return await asyncio.to_thread(_embed_sync, session, tokenizer, text)
