"""LIVE test: make a real API call to each of the user's 5 sub-agent models.

Each model is built exactly like agents.py builds it (same provider rows,
same env vars), then called with a tiny prompt. This shows whether the
sub-agent models actually WORK at runtime or fail (which would trigger the
fallback to the main model in the app).
"""
import asyncio
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-live-subagent-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from agents import _subagent_target
from llm import (
    build_chat_model,
    llm_complete,
)

PROVIDERS = {
    "opencode": {
        "id": "opencode", "kind": "opencode",
        "baseUrl": "https://opencode.ai/zen/v1", "apiKey": "",
        "envVar": "OPENCODE_ZEN_API_KEY", "oauthRefreshToken": "",
    },
    "nvidia": {
        "id": "nvidia", "kind": "nvidia",
        "baseUrl": "https://integrate.api.nvidia.com/v1", "apiKey": "",
        "envVar": "NVIDIA_API_KEY", "oauthRefreshToken": "",
    },
    "openrouter": {
        "id": "openrouter", "kind": "openrouter",
        "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "",
        "envVar": "OPENROUTER_API_KEY", "oauthRefreshToken": "",
    },
}

PARENT = {
    "parent_provider": "opencode",
    "parent_base_url": "https://opencode.ai/zen/v1",
    "parent_api_key": "",
    "parent_env_var": "OPENCODE_ZEN_API_KEY",
    "parent_oauth_token": "",
}

ENTRIES = {
    "explore": "nvidia/nemotron-3-super-120b-a12b",
    "search": "nvidia/nemotron-3-ultra-550b-a55b",
    "web": "openrouter/free",
    "compact": "openrouter/free",
    "vision": "openrouter/openrouter/free",
}


async def main():
    ok = True
    for slot, entry in ENTRIES.items():
        t = _subagent_target(entry, **PARENT, provider_lookup=lambda pid: PROVIDERS.get(pid))
        if t is None:
            print(f"  {slot:8s} {entry:45s} -> None (falls back to parent)")
            continue
        kind, model, base, key, env, oauth, _pid = t
        try:
            m = build_chat_model(kind, model, base, key, env, oauth_token=oauth, provider_id=_pid)
            out = await asyncio.wait_for(
                llm_complete(m, user="Reply with exactly: OK"), timeout=90
            )
            out = str(out).strip()
            print(f"  {slot:8s} {entry:45s} -> OK: {out[:60]!r}")
        except Exception as exc:  # noqa: BLE001
            ok = False
            print(f"  {slot:8s} {entry:45s} -> FAILED: {type(exc).__name__}: {str(exc)[:220]}")
    print("LIVE-SUBAGENT-MODELS " + ("ALL OK" if ok else "SOME FAILED"))


if __name__ == "__main__":
    asyncio.run(main())