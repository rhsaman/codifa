"""Diagnostic: resolve the USER's exact sub-agent model config (from their
settings.json) and verify each entry builds a model on the right provider.

Parent = opencode (deepseek-v4-flash-free). Sub-agent entries:
  explore  nvidia/nemotron-3-super-120b-a12b
  search   nvidia/nemotron-3-ultra-550b-a55b
  web      openrouter/free
  compact  openrouter/free
  vision   openrouter/openrouter/free
"""
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="coder-user-cfg-")
os.environ["CODER_DATA_DIR"] = _TMP

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from agents import _subagent_target
from llm import build_chat_model

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


def main():
    ok = True
    for slot, entry in ENTRIES.items():
        t = _subagent_target(entry, **PARENT, provider_lookup=lambda pid: PROVIDERS.get(pid))
        if t is None:
            print(f"  {slot:8s} {entry:45s} -> None (falls back to parent)")
            continue
        kind, model, base, key, env, oauth = t
        print(f"  {slot:8s} {entry:45s} -> kind={kind} model={model!r} env={env!r}")
        try:
            m = build_chat_model(kind, model, base, key, env, oauth_token=oauth)
            name = str(getattr(m, "model_name", "") or "")
            print(f"           built OK, model_name={name!r}")
        except Exception as exc:  # noqa: BLE001
            ok = False
            print(f"           BUILD FAILED: {exc!r}")
    print("USER-SUBAGENT-CONFIG " + ("PASSED" if ok else "FAILED"))


if __name__ == "__main__":
    main()