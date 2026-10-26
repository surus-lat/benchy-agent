#!/usr/bin/env python3
"""Export google/embeddinggemma-2 to a quantized ONNX model.

Requires torch and transformers (only at export time, not at runtime).
Produces model_q8.onnx + tokenizer.json in the output directory.

Usage:
    python export_onnx.py [OUTPUT_DIR]
    # default OUTPUT_DIR: ./embed_model
"""

from __future__ import annotations

import os
import sys

import torch
import torch.nn as nn
from transformers import AutoModel, AutoTokenizer

MODEL_ID = "google/embeddinggemma-2"
PROMPT = "task: search result | query: "


class TextEncoder(nn.Module):
    """Thin wrapper that takes (input_ids, attention_mask) → last_hidden_state."""

    def __init__(self, language_model: nn.Module) -> None:
        super().__init__()
        self.language_model = language_model

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor) -> torch.Tensor:
        return self.language_model(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state


def main() -> None:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "embed_model"
    os.makedirs(out_dir, exist_ok=True)

    print(f"Loading {MODEL_ID} (text-only, float32)...")
    full_model = AutoModel.from_pretrained(
        MODEL_ID, vision_config=None, audio_config=None, dtype=torch.float32,
    )
    full_model.eval()
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)

    encoder = TextEncoder(full_model.language_model)
    encoder.eval()

    # Dummy input for tracing
    dummy = tokenizer(PROMPT + "test", return_tensors="pt", padding=True, truncation=True)

    fp32_path = os.path.join(out_dir, "model.onnx")
    print("Exporting to ONNX (legacy TorchScript trace)...")
    with torch.no_grad():
        torch.onnx.export(
            encoder,
            (dummy["input_ids"], dummy["attention_mask"]),
            fp32_path,
            input_names=["input_ids", "attention_mask"],
            output_names=["last_hidden_state"],
            dynamic_axes={
                "input_ids": {0: "batch", 1: "seq"},
                "attention_mask": {0: "batch", 1: "seq"},
                "last_hidden_state": {0: "batch", 1: "seq"},
            },
            opset_version=17,
            dynamo=False,
        )

    fp32_size = os.path.getsize(fp32_path) / 1024 / 1024
    print(f"FP32 model: {fp32_size:.0f} MB")

    # Dynamic INT8 quantization
    print("Quantizing to INT8...")
    from onnxruntime.quantization import QuantType, quantize_dynamic

    q8_path = os.path.join(out_dir, "model_q8.onnx")
    quantize_dynamic(fp32_path, q8_path, weight_type=QuantType.QInt8)

    q8_size = os.path.getsize(q8_path) / 1024 / 1024
    print(f"INT8 model: {q8_size:.0f} MB ({(1 - q8_size / fp32_size) * 100:.0f}% smaller)")

    # Remove FP32 (only keep quantized)
    os.remove(fp32_path)

    # Save tokenizer
    tokenizer.save_pretrained(out_dir)
    print(f"Tokenizer saved to {out_dir}/")

    # Verify
    print("Verifying ONNX inference...")
    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer as FastTokenizer

    sess = ort.InferenceSession(q8_path, providers=["CPUExecutionProvider"])
    tok = FastTokenizer.from_file(os.path.join(out_dir, "tokenizer.json"))
    tok.enable_padding()
    tok.enable_truncation(max_length=8192)

    encoded = tok.encode(PROMPT + "machine learning for natural language processing")
    ids = np.array([encoded.ids], dtype=np.int64)
    mask = np.array([encoded.attention_mask], dtype=np.int64)
    hidden = sess.run(["last_hidden_state"], {"input_ids": ids, "attention_mask": mask})[0]

    m = mask[:, :, np.newaxis].astype(np.float32)
    pooled = (hidden * m).sum(axis=1) / m.sum(axis=1)
    norm = np.linalg.norm(pooled, axis=1, keepdims=True)
    vec = (pooled / norm)[0]
    print(f"Output dim: {len(vec)}, first 3: {vec[:3].tolist()}")
    assert len(vec) == 768, f"Expected 768-d, got {len(vec)}"
    print("OK")


if __name__ == "__main__":
    main()
