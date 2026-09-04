"""Regression: gateways that attach the FULL ``usage`` block to EVERY SSE chunk
must not inflate the merged ``usage_metadata``.

LangChain merges streamed chunks via ``AIMessageChunk.__add__`` → ``add_usage``,
which SUMS usage across chunks. TokenRouter / opencode-style gateways send the
running/full usage on every mid-stream delta, so a 350-chunk reply with a real
14K-token request was reported as ~4.9M input tokens (the "16M tokens in one
message" bug). ``ReasoningChatOpenAI._convert_chunk_to_generation_chunk`` now
drops ``usage`` from non-terminal chunks, so the merged usage always equals one
request's true counts.
"""
from langchain_core.messages import HumanMessage, SystemMessage

from llm import ReasoningChatOpenAI

_REAL_IN = 14_082
_REAL_OUT = 1_578


def _chunk(delta, finish_reason=None, usage=None):
    c = {
        "id": "c-0",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "mock-model",
        "choices": [
            {"index": 0, "delta": delta, "finish_reason": finish_reason}
        ],
    }
    if usage is not None:
        c["usage"] = usage
    return c


async def _merged_usage(mock_server, script):
    base, mock = mock_server
    mock.script = [script]
    llm = ReasoningChatOpenAI(
        model="mock-model", api_key="test", base_url=base, streaming=True
    )
    msgs = [SystemMessage(content="x"), HumanMessage(content="hi")]
    ai = None
    async for chunk in llm.astream(msgs):
        ai = chunk if ai is None else ai + chunk
    um = getattr(ai, "usage_metadata", None)
    return dict(um) if um else None


async def test_usage_on_every_chunk_not_summed(mock_server):
    """Gateway sends full usage in EVERY chunk (TokenRouter style).

    The mock re-derives the terminal chunk's counts from the actual request, so
    exact values are not asserted — what matters for the regression is that
    the merged usage equals ONE request's counts, not N chunks' worth summed.
    """
    usage = {
        "prompt_tokens": _REAL_IN,
        "completion_tokens": _REAL_OUT,
        "total_tokens": _REAL_IN + _REAL_OUT,
    }
    script = [
        _chunk({"content": "x"}, usage=usage) for _ in range(349)
    ] + [
        # Terminal usage-only chunk (OpenAI spec shape: no choices).
        {
            "id": "c-end",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "mock-model",
            "choices": [],
            "usage": usage,
        }
    ]
    um = await _merged_usage(mock_server, script)
    assert um is not None, "terminal usage chunk was dropped entirely"
    # Exactly one request's worth — NOT 349 x full usage.
    assert um["input_tokens"] < _REAL_IN * 2
    assert um["output_tokens"] < _REAL_OUT * 2
    # The 349 mid-stream usage blocks must not have been summed: the merged
    # input must be orders of magnitude below N x full usage.
    assert um["input_tokens"] * 10 < _REAL_IN * 349
    assert um["total_tokens"] == um["input_tokens"] + um["output_tokens"]


async def test_usage_only_final_chunk_still_works(mock_server):
    """OpenAI-spec gateway: usage arrives once on the terminal chunk only.

    The mock re-derives the terminal chunk's counts from the actual request;
    assert against those same derived values (one request's worth) rather than
    the script's placeholder numbers.
    """
    import json as _json

    script = [
        _chunk({"content": "x"}) for _ in range(10)
    ] + [
        _chunk({}, finish_reason="stop", usage={
            "prompt_tokens": _REAL_IN,
            "completion_tokens": _REAL_OUT,
            "total_tokens": _REAL_IN + _REAL_OUT,
        })
    ]
    base, mock = mock_server
    mock.script = [script]
    llm = ReasoningChatOpenAI(
        model="mock-model", api_key="test", base_url=base, streaming=True
    )
    msgs = [SystemMessage(content="x"), HumanMessage(content="hi")]
    ai = None
    async for chunk in llm.astream(msgs):
        ai = chunk if ai is None else ai + chunk
    um = getattr(ai, "usage_metadata", None)
    assert um is not None
    req = next((b for b in mock.captured if b.get("messages")), None)
    assert req is not None
    prompt_tokens = max(1, len(_json.dumps(req, ensure_ascii=False)) // 4)
    completion_tokens = max(0, len("x" * 10) // 4)
    assert um["input_tokens"] == prompt_tokens
    assert um["output_tokens"] == completion_tokens
    assert um["total_tokens"] == prompt_tokens + completion_tokens


async def test_no_usage_in_script_gets_mock_derived_usage(mock_server):
    """A script that never sends usage gets the mock's derived counts on the
    final chunk — exactly one request's worth, never summed across chunks."""
    script = [
        _chunk({"content": "x"}) for _ in range(10)
    ] + [_chunk({}, finish_reason="stop")]
    um = await _merged_usage(mock_server, script)
    assert um is not None
    # A single small request — the merged usage must be tiny, not 10x.
    assert um["input_tokens"] < 500
    assert um["total_tokens"] == um["input_tokens"] + um["output_tokens"]


def test_chunk_is_terminal_shapes():
    """The terminal-chunk predicate used to gate usage passthrough."""
    term = ReasoningChatOpenAI._chunk_is_terminal
    # Usage-only final chunk (empty choices) is terminal.
    assert term({"choices": []})
    # finish_reason-bearing chunk is terminal.
    assert term({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
    # Ordinary mid-stream delta is NOT terminal.
    assert not term(
        {"choices": [{"index": 0, "delta": {"content": "x"}, "finish_reason": None}]}
    )
    # No choices key at all (defensive) is treated as terminal — an empty
    # payload can never be a mid-stream delta.
    assert term({"id": "c"})
    # Non-dict junk is not terminal (usage dropped, usage never trusted).
    assert not term("junk")
