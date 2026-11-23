"""Demand-driven eligibility, scoped to this worker's evaluation identity."""
from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path

log = logging.getLogger(__name__)


def global_profiles(pages):
    return {
        row["inferenceProfileId"]: row.get("inferenceProfileName") or row["inferenceProfileId"]
        for page in pages for row in page["inferenceProfileSummaries"]
        if row["status"] == "ACTIVE" and row["inferenceProfileId"].startswith("global.")
    }


async def discover():
    import boto3
    from botocore.config import Config

    if not os.environ.get("AWS_BEARER_TOKEN_BEDROCK"):
        raise RuntimeError("The Benchy Bedrock bearer token is required for discovery")

    def list_profiles():
        client = boto3.session.Session().client(
            "bedrock", region_name=os.environ["AWS_REGION"],
            config=Config(connect_timeout=3, read_timeout=4, retries={"total_max_attempts": 1}),
        )
        return global_profiles(client.get_paginator("list_inference_profiles").paginate(typeEquals="SYSTEM_DEFINED"))

    async with asyncio.timeout(10):
        return await asyncio.to_thread(list_profiles)


async def probe(model):
    from benchy_adapters import for_system

    schema = {"type": "object", "fields": {"answer": {"type": "string"}}}
    adapter = for_system({
        "ai-system": {"type": "model", "provider": "bedrock", "model": model,
                      "parameters": {"max_tokens": 512}},
        "program": {"input": schema, "output": schema},
    }, Path.cwd(), {**os.environ, "BENCHY_CACHE": "", "BENCHY_TIMEOUT": "8"},
        default_prompt="Return a JSON object with the answer field copied exactly from the input.")
    return await adapter.invoke({"answer": "benchy"}) == {"answer": "benchy"}


class GlobalCatalog:
    def __init__(self, list_profiles=discover, invoke=probe):
        self.list_profiles = list_profiles
        self.invoke = invoke
        self.result = None
        self.expires = 0
        self.lock = asyncio.Lock()

    async def get(self):
        async with self.lock:
            if time.monotonic() < self.expires:
                return self.result
            candidates = await self.list_profiles()
            slots = asyncio.Semaphore(16)

            async def check(model):
                async with slots:
                    try:
                        async with asyncio.timeout(12):
                            return await self.invoke(model)
                    except Exception as exc:
                        log.info("Catalog probe skipped %s (%s)", model, type(exc).__name__)
                        return False

            async with asyncio.timeout(50):
                passed = await asyncio.gather(*(check(model) for model in candidates))
            ids = sorted(model for model, ok in zip(candidates, passed, strict=True) if ok)
            rows = [{"id": model, "name": candidates[model], "maker": model.split(".")[1],
                     "region": "Otras", "default": index == 0} for index, model in enumerate(ids)]
            self.result = {"provider": "bedrock", "models": ids, "catalog": rows}
            self.expires = time.monotonic() + (120 if ids else 15)
            return self.result


CATALOG = GlobalCatalog()
