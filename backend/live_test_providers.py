import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from pydantic_ai import Agent

import providers

CANDIDATES = {
    "nvidia": ["nvidia/nemotron-mini-4b-instruct", "nvidia/nvidia-nemotron-nano-9b-v2"],
    "cloudflare": ["@cf/meta/llama-3.1-8b-instruct-fp8", "@cf/openai/gpt-oss-120b"],
    "tokenrouter": ["MiniMax-M3", "openai/gpt-5.4-nano"],
}

async def m(kind: str) -> bool:
    print(f"\n===== {kind} =====")
    try:
        models = await providers.list_models(kind)
        ids = [m0["id"] for m0 in models]
        print(f"  list_models: {len(ids)} models; sample {ids[:3]}")
        key = providers.env_key(kind)
        print(f"  base_url: {providers.normalize_base_url(kind, '')}")
        for model in CANDIDATES.get(kind, []):
            try:
                mo = providers.build_model(kind, model, "", key)
                agent = Agent(mo, model_settings={"temperature": 0})
                r = await asyncio.wait_for(agent.run("Say OK"), timeout=40)
                print(f"  completion OK [{model}] -> {r.output!r}")
                return True
            except Exception as e:  # noqa: BLE001 — a failing provider is the test subject
                print(f"  model {model} failed: {type(e).__name__}: {str(e)[:100]}")
        return False
    except Exception as e:  # noqa: BLE001 — a failing provider is the test subject
        print(f"  !! {type(e).__name__}: {e}")
        return False

async def main() -> None:
    ok = {kind: await m(kind) for kind in ("nvidia", "cloudflare", "tokenrouter")}
    print("\n\nRESULTS:", ok)
    sys.exit(0 if all(ok.values()) else 1)

asyncio.run(main())