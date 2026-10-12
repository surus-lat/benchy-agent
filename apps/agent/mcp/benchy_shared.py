"""What the MCP server (the agent's tools) and the proxy (the app's read-only
routes) must agree on: the workspace root and the models a benchmark may run."""

from __future__ import annotations

import os
from pathlib import Path

WORKSPACE = Path(os.environ.get("BENCHY_WORKSPACE", "/opt/data/workspace")).resolve()

# gpt-oss is left out on purpose: it prefixes its reasoning to the JSON
# answer, so every structured output scores invalid_output.
MODELS = [
    m.strip()
    for m in os.environ.get(
        "BENCHY_MODELS",
        "us.moonshotai.kimi-k3,qwen.qwen3-next-80b-a3b,qwen.qwen3-32b-v1:0,deepseek.v3.2",
    ).split(",")
    if m.strip()
]


def inside(rel: str) -> Path | None:
    """`rel` resolved against the workspace, or None if it escapes it."""
    candidate = (WORKSPACE / rel).resolve()
    return candidate if candidate == WORKSPACE or WORKSPACE in candidate.parents else None


def model_slug(model: str) -> str:
    """A model id made safe for a file name: us.moonshotai.kimi-k3 → us.moonshotai.kimi-k3,
    qwen.qwen3-32b-v1:0 → qwen.qwen3-32b-v1-0."""
    return "".join(c if c.isalnum() or c in ".-_" else "-" for c in model)
