"""Run with AWS_REGION and the worker's AWS_BEARER_TOKEN_BEDROCK in the environment."""
import asyncio
import json
import time

from benchy_catalog import GlobalCatalog, discover


async def main():
    began = time.monotonic()
    profiles = await discover()

    async def candidates():
        return profiles

    result = await GlobalCatalog(candidates).get()
    print(json.dumps({"candidates": len(profiles), "models": result["models"],
                      "seconds": round(time.monotonic() - began, 2)}))
    if not result["models"]:
        raise SystemExit("No model passed the structured evaluation probe")


if __name__ == "__main__":
    asyncio.run(main())
