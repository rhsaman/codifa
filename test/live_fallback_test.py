"""LIVE test: subagent fallback → events must show the MAIN model name.

Replicates the app's real tool path (make_tool_callbacks + grep_tool) with a
deliberately BROKEN search model, then asserts:
  1. the first grep falls back to the main model (distilled, model=main),
  2. a SECOND grep in the same turn ALSO distills via the main model
     (not raw output) — the sticky-fallback consistency fix,
  3. every emitted event carries the main model name after fallback.
"""
import asyncio
import os
import sys

# Use the app's default data dir unless the user overrides it (no hardcoded
# machine-specific path committed to git).
os.environ.setdefault("CODER_DATA_DIR", os.path.join(os.path.expanduser("~"), ".codifa"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from providers import build_model, _provider_meta  # noqa: E402
from state_db import get_settings  # noqa: E402


def env_key(provider: str, env_var: str) -> str:
    if env_var:
        return os.environ.get(env_var, "") or ""
    meta = _provider_meta(provider)
    for v in meta.get("env_vars", []):
        val = os.environ.get(v, "")
        if val:
            return val
    return ""


def subagent_provider(pid: str, settings: dict):
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
    kind = parent.get("kind") or "custom"
    model = parent.get("model") or ""
    base = parent.get("baseUrl") or ""
    key = parent.get("apiKey") or ""
    env = parent.get("envVar") or ""
    oauth = parent.get("oauthRefreshToken") or ""

    main_model = build_model(kind, model, base, key, env, oauth_token=oauth)
    print(f"MAIN model: {getattr(main_model, 'model_name', '?')!r}")

    # Deliberately broken search model → forces fallback to main.
    broken = build_model(kind, "openrouter/nonexistent-model-xyz", base, key, env, oauth_token=oauth)
    print(f"BROKEN search model: {getattr(broken, 'model_name', '?')!r}")

    events: list[dict] = []

    def emit(ev: dict) -> None:
        events.append(dict(ev))
        kind = ev.get("kind")
        if kind in ("tool", "tool_result", "usage", "retry"):
            print(f"  EVENT {kind:12s} tool={ev.get('tool',''):12s} model={ev.get('model','')!r} fallback={ev.get('fallback')}")

    from tools import make_tool_callbacks

    tools = make_tool_callbacks(
        root=os.path.join(os.path.dirname(__file__), ".."),
        emit=emit,
        context_window=0,
        search_model=broken,
        main_model=main_model,
    )

    print("\n--- grep #1 (search model broken → must fall back to main) ---")
    r1 = await tools["grep"]("def main", path="backend", include="*.py")
    print(f"  result head: {r1[:90]!r}")

    print("\n--- grep #2 (same turn → must STILL distill via main, not raw) ---")
    r2 = await tools["grep"]("async def", path="backend", include="*.py")
    print(f"  result head: {r2[:90]!r}")

    # Assertions
    retry_evs = [e for e in events if e.get("kind") == "retry"]
    print(f"\nretry events: {len(retry_evs)}")
    for e in retry_evs:
        print(f"  retry → model={e.get('model')!r} fallback={e.get('fallback')}")

    main_name = str(getattr(main_model, "model_name", "") or "")
    broken_name = str(getattr(broken, "model_name", "") or "")
    tool_evs = [e for e in events if e.get("kind") == "tool" and e.get("tool") == "grep"]
    res_evs = [e for e in events if e.get("kind") == "tool_result" and e.get("tool") == "grep"]

    ok = True
    # grep#1 tool event starts on the (broken) search model — correct.
    good = tool_evs[0].get("model") == broken_name
    ok &= good
    print(f"  grep#1 tool event model={tool_evs[0].get('model')!r} == broken search {broken_name!r}: {good}")
    # grep#2 tool event must already be the MAIN model (sticky fallback).
    good = tool_evs[1].get("model") == main_name
    ok &= good
    print(f"  grep#2 tool event model={tool_evs[1].get('model')!r} == main {main_name!r}: {good}")
    for i, e in enumerate(res_evs):
        good = e.get("model") == main_name
        ok &= good
        print(f"  grep#{i+1} result event model={e.get('model')!r} == main {main_name!r}: {good}  summary={e.get('summary')!r}")

    # grep #2 must be distilled (not raw "MATCHES for ...")
    distilled2 = "distilled" in r2 or "SEARCH RESULTS" in r2
    print(f"  grep#2 distilled (not raw): {distilled2}")
    ok &= distilled2

    print(f"\nRESULT: {'✅ ALL OK' if ok else '❌ FAILED'}")


if __name__ == "__main__":
    asyncio.run(main())