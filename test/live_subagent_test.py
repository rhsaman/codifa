"""LIVE test: replicate the app's exact subagent resolution + build + real API call.

Runs against the REAL settings the app uses (CODER_DATA_DIR defaults to ~/.codifa)
and the REAL backend code (providers.build_model / agents._subagent_target), then
actually calls each subagent model with a tiny prompt to prove it works or show
the exact failure that makes the app fall back to the parent model.
"""
import asyncio
import os
import sys

# Use the app's default data dir unless the user overrides it (no hardcoded
# machine-specific path committed to git).
os.environ.setdefault("CODER_DATA_DIR", os.path.join(os.path.expanduser("~"), ".codifa"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from providers import build_model, _provider_meta  # noqa: E402
from agents import _subagent_target  # noqa: E402
from state_db import get_settings  # noqa: E402


def env_key(provider: str, env_var: str) -> str:
    """Mirror providers.env_key: env_var wins, else provider-specific vars."""
    if env_var:
        return os.environ.get(env_var, "") or ""
    meta = _provider_meta(provider)
    for v in meta.get("env_vars", []):
        val = os.environ.get(v, "")
        if val:
            return val
    return ""


def subagent_provider(pid: str, settings: dict):
    """Mirror agents._subagent_provider (closure inside run_agent)."""
    providers = [p for p in (settings.get("providers") or []) if isinstance(p, dict)]
    match = next((p for p in providers if p.get("id") == pid), None)
    if match is None:
        match = next((p for p in providers if p.get("kind") == pid), None)
    if match is None:
        return None
    return {
        **match,
        "apiKey": match.get("apiKey") or "",
        "oauthClientId": match.get("oauthClientId") or "",
        "oauthClientSecret": match.get("oauthClientSecret") or "",
        "oauthRefreshToken": match.get("oauthRefreshToken") or "",
    }


async def main() -> None:
    settings = get_settings() or {}
    providers = [p for p in (settings.get("providers") or []) if isinstance(p, dict)]
    parent = next((p for p in providers if p.get("id") == "opencode"), providers[0])
    parent_provider = parent.get("kind") or "custom"
    parent_model = parent.get("model") or ""
    parent_base = parent.get("baseUrl") or ""
    parent_key = parent.get("apiKey") or ""
    parent_env = parent.get("envVar") or ""
    parent_oauth = parent.get("oauthRefreshToken") or ""

    print(f"PARENT: provider={parent_provider} model={parent_model}")
    print(f"  parent key source: apiKey={bool(parent_key)} envVar={parent_env} "
          f"env_set={bool(env_key(parent_provider, parent_env))}")
    print()

    subs = settings.get("subagentModels") or {}
    print(f"subagentModels: {subs}")
    print()

    for slot, entry in subs.items():
        print(f"=== {slot}: {entry!r} ===")
        target = _subagent_target(
            entry,
            parent_provider,
            parent_base,
            parent_key,
            parent_env,
            parent_oauth,
            lambda pid: subagent_provider(pid, settings),
        )
        if target is None:
            print("  → None (uses parent model)")
            continue
        kind, model, base, key, env, oauth = target
        key_resolved = oauth or key or env_key(kind, env)
        print(f"  resolved: kind={kind} model={model!r} base={base!r}")
        print(f"  key: saved={bool(key)} envVar={env!r} env_set={bool(env_key(kind, env))} "
              f"oauth={bool(oauth)} → usable={bool(key_resolved)}")
        try:
            m = build_model(kind, model, base, key, env, oauth_token=oauth)
            print(f"  BUILD OK → model_name={getattr(m, 'model_name', '?')!r}")
            # Real API call
            from pydantic_ai import Agent
            from pydantic_ai.settings import ModelSettings

            agent = Agent(m, system_prompt="Reply with exactly: OK")
            res = await agent.run(
                "ping",
                model_settings=ModelSettings(timeout=60, max_tokens=10),
            )
            out = str(getattr(res, "output", "") or "").strip()
            print(f"  LIVE CALL OK → {out[:40]!r}")
        except Exception as exc:  # noqa: BLE001
            print(f"  ❌ BUILD/CALL FAILED: {type(exc).__name__}: {exc}")
        print()


if __name__ == "__main__":
    asyncio.run(main())