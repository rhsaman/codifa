from __future__ import annotations

import tools


async def _ctx_small(m):
    return 4096


async def _ctx_large(m):
    return 128000


async def _ctx_unknown(m):
    return 0


async def test_cap_small_window_never_overflows():
    orig = tools._model_context_window
    tools._model_context_window = _ctx_small
    try:
        for narrow in (True, False):
            cap = await tools._resolve_subagent_max_tokens(object(), narrow=narrow)
            assert cap is not None
            assert cap + 512 <= 4096, cap  # leaves headroom
    finally:
        tools._model_context_window = orig


async def test_cap_large_window_is_bounded():
    orig = tools._model_context_window
    tools._model_context_window = _ctx_large
    try:
        cap_n = await tools._resolve_subagent_max_tokens(object(), narrow=True)
        cap_w = await tools._resolve_subagent_max_tokens(object(), narrow=False)
    finally:
        tools._model_context_window = orig
    assert cap_n == 8000
    assert cap_w == 8000


async def test_cap_unknown_window_is_none():
    orig = tools._model_context_window
    tools._model_context_window = _ctx_unknown
    try:
        res = await tools._resolve_subagent_max_tokens(object(), narrow=True)
    finally:
        tools._model_context_window = orig
    assert res is None
