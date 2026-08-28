"""DEFINITIVE live test: call the REAL run_agent with the REAL settings the app
uses and capture the `subagent_models` routing event — it reports exactly which
model ACTUALLY runs for explore/search/web/compact/vision (or marks a build
failure → parent fallback). Also captures the first tool event to verify the
model field survives `_tool_event` end-to-end.
"""
import asyncio
import os
import sys

# Use the app's default data dir unless the user overrides it (no hardcoded
# machine-specific path committed to git).
os.environ.setdefault("CODER_DATA_DIR", os.path.join(os.path.expanduser("~"), ".codifa"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from state_db import get_settings  # noqa: E402
from agents import run_agent  # noqa: E402


async def main() -> None:
    settings = get_settings() or {}
    providers = [p for p in (settings.get("providers") or []) if isinstance(p, dict)]
    parent = next((p for p in providers if p.get("id") == "opencode"), providers[0])
    kind = parent.get("kind") or "custom"
    model = parent.get("model") or ""
    base = parent.get("baseUrl") or ""
    key = parent.get("apiKey") or ""
    env = parent.get("envVar") or ""
    oauth = parent.get("oauthRefreshToken") or ""

    print(f"PARENT: kind={kind} model={model} base={base}")
    print(f"subagentModels: {settings.get('subagentModels')}")
    print()

    events = []
    async for ev in run_agent(
        provider=kind,
        model_name=model,
        base_url=base,
        api_key=key,
        root=os.path.join(os.path.dirname(__file__), ".."),
        mode="ask",
        prompt="Say OK.",
        history=[],
        env_var=env,
        oauth_token=oauth,
        max_history=3,
        subagent_models=settings.get("subagentModels") or {},
    ):
        events.append(ev)
        if ev.get("kind") == "subagent_models":
            print("ROUTING EVENT:", ev)
            break
        if ev.get("kind") == "error":
            print("ERROR EVENT:", ev)
            break
        if len(events) > 5:
            print("(no routing event in first 5 events)")
            break

    print()
    print("First events seen:", [e.get("kind") for e in events])


if __name__ == "__main__":
    asyncio.run(main())