"""What the MCP server (the agent's tools) and the proxy (the app's read-only
routes) must agree on: the workspace root and the models a benchmark may run."""

from __future__ import annotations

import os
from pathlib import Path

WORKSPACE = Path(os.environ.get("BENCHY_WORKSPACE", "/opt/data/workspace")).resolve()

# The models a benchmark may run, by where they are made: a field's knowledge,
# and its biases, change with the lab's region, and Latin America is often
# answered through another region's lens. Each was checked through the engine
# (Bedrock's chat-completions endpoint with structured output); also in the
# IAM policy of benchy-agent-bedrock. Left out, after trying them:
#   gpt-oss, magistral        prefix reasoning or ```json fences: every output invalid
#   llama 4, nova             not served on the chat-completions endpoint (Converse only)
#   minimax m2.5              spends max_tokens reasoning before it answers
#   gpt-5/6, grok, claude     not available to this AWS account
#   jamba (AI21, Israel)      retired by the provider
#   ministral 3 14b           valid but empty answers (a title, no content)
CATALOG = [
    {"id": "nvidia.nemotron-super-3-120b", "name": "Nemotron Super 3 120B", "maker": "NVIDIA", "region": "Norteamérica"},
    {"id": "google.gemma-3-27b-it", "name": "Gemma 3 27B", "maker": "Google", "region": "Norteamérica"},
    {"id": "mistral.mistral-large-3-675b-instruct", "name": "Mistral Large 3", "maker": "Mistral AI", "region": "Europa"},
    {"id": "us.moonshotai.kimi-k3", "name": "Kimi K3", "maker": "Moonshot AI", "region": "China"},
    {"id": "qwen.qwen3-next-80b-a3b", "name": "Qwen3 Next 80B", "maker": "Alibaba", "region": "China"},
    {"id": "qwen.qwen3-32b-v1:0", "name": "Qwen3 32B", "maker": "Alibaba", "region": "China"},
    {"id": "deepseek.v3.2", "name": "DeepSeek V3.2", "maker": "DeepSeek", "region": "China"},
    {"id": "zai.glm-5", "name": "GLM-5", "maker": "Z.ai", "region": "China"},
]
# One per region: what an evaluation runs unless the researcher picks.
DEFAULT_MODELS = ["nvidia.nemotron-super-3-120b", "mistral.mistral-large-3-675b-instruct", "us.moonshotai.kimi-k3"]

MODELS = [
    m.strip()
    for m in os.environ.get("BENCHY_MODELS", ",".join(c["id"] for c in CATALOG)).split(",")
    if m.strip()
]


def catalog() -> list[dict]:
    """The models this deployment allows, with maker and region, default ones marked."""
    known = {c["id"]: c for c in CATALOG}
    return [
        {**known.get(m, {"id": m, "name": m, "maker": "", "region": "Otras"}), "default": m in DEFAULT_MODELS}
        for m in MODELS
    ]


def inside(rel: str) -> Path | None:
    """`rel` resolved against the workspace, or None if it escapes it."""
    candidate = (WORKSPACE / rel).resolve()
    return candidate if candidate == WORKSPACE or WORKSPACE in candidate.parents else None


def model_slug(model: str) -> str:
    """A model id made safe for a file name: us.moonshotai.kimi-k3 → us.moonshotai.kimi-k3,
    qwen.qwen3-32b-v1:0 → qwen.qwen3-32b-v1-0."""
    return "".join(c if c.isalnum() or c in ".-_" else "-" for c in model)


def check_models(ir: dict) -> None:
    """Refuse a Bedrock model this deployment cannot call — for the AI-system
    and, when the benchmark has a rubric, for its grader."""
    from benchy.errors import BenchyError

    seats = [(ir.get("ai-system") or {}, ["ai-system", "model"])]
    grader = (ir.get("scoring") or {}).get("grader")
    if grader:
        seats.append((grader, ["scoring", "grader", "model"]))
    for system, path in seats:
        if system.get("type") == "model" and system.get("provider") == "bedrock" and system.get("model") not in MODELS:
            raise BenchyError(
                "runtime", "adapter_not_bound",
                f"model {system.get('model')!r} is not available here; use one of: {', '.join(MODELS)}",
                path,
            )
