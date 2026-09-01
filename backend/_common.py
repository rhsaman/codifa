"""توابع و ثابت‌های مشترک بین ماژول‌های backend.

این ماژول برای رفع تکرار (DRY) ایجاد شده است: توابعی مثل ``_strip_think_tags``،
``_is_repeating`` و ``_extract_cache_tokens`` قبلاً به‌صورت کپی‌شده در ``graph.py``،
``llm.py`` و ``agents.py`` وجود داشتند. قرار دادن آن‌ها در یک ماژول مشترک باعث
می‌شود یک منبع واحد (single source of truth) داشته باشیم و از ناهماهنگی جلوگیری
شود. این ماژول وابستگی به هیچ ماژول backend دیگری ندارد، پس خطر circular import
ندارد.
"""

from __future__ import annotations

import re

# All literal chain-of-thought tag flavors some gateways / opencode-style
# OpenAI-compatible servers surface inside the visible ``content`` stream.
# Each entry is the literal opener we look for at the START of a tag, paired
# with the matching closer. We strip ALL of them (not just ``<think>``) so a
# gateway that emits ``<reasoning>…</reasoning>`` or ``<reflection>…</reflection>``
# can never leak raw CoT into the chat transcript.
_THINK_OPENERS: tuple[tuple[str, str], ...] = (
    ("<think", "think"),
    ("<thinking", "thinking"),
    ("<reasoning", "reasoning"),
    ("<reflection", "reflection"),
    ("<thought", "thought"),
)
# After matching an opener, we read the rest of the opening tag and either
# accept it (when the closing ``>`` is in this chunk) or buffer it for the next
# chunk. Anything before the matched opener prefix (e.g. ``<rea`` of
# ``<reasoning>``) is left untouched and re-scanned on the next call.
_THINK_OPENER_RE = re.compile(
    r"<("
    + "|".join(re.escape(o[0][1:]) for o in _THINK_OPENERS)
    + r")"
)
_THINK_CLOSER_RE = re.compile(
    r"</("
    + "|".join(re.escape(o[1]) for o in _THINK_OPENERS)
    + r")>"
)


def _strip_think_tags(
    text: str, in_think: bool, think_buf: str
) -> tuple[str, bool, str]:
    """Remove literal ``<think>…</think>`` (and flavor variants) from streamed text.

    Some models (DeepSeek/Qwen/llama.cpp and a few OpenAI-compatible gateways
    such as opencode/openrouter) emit their chain-of-thought as a literal
    ``<think>…</think>`` (or ``<reasoning>…</reasoning>``, ``<thought>…</thought>``,
    ``<reflection>…</reflection>``) block inside the ``content`` stream instead
    of using a dedicated reasoning field. We drop it from the visible text so
    it never leaks to the frontend. The tag may span multiple streamed deltas,
    so the ``in_think`` / ``think_buf`` state is preserved across calls.

    State machine:
      * ``in_think=False``: scan for the next opener. When found, append the
        preceding visible text to ``out`` and switch to ``in_think=True``.
        If the opening tag is incomplete (the ``>`` hasn't arrived), buffer
        what we have so the next chunk can finish it.
      * ``in_think=True``: scan for the closer. When found, capture the hidden
        text in ``think_buf`` and switch back. If the closer hasn't arrived,
        keep appending hidden text to ``think_buf`` (it's never re-emitted).
    """
    if not text:
        return text, in_think, think_buf
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        if not in_think:
            # Fast path: no opener can start before the next '<'. find() avoids
            # the regex engine for the common (no-tag) case.
            lt = text.find("<", i)
            if lt == -1:
                out.append(text[i:])
                break
            # If we just consumed a partial opener in a previous chunk, ``lt``
            # is the start of a tag we already matched — handle it inline.
            if lt > i:
                out.append(text[i:lt])
            i = lt
            m = _THINK_OPENER_RE.match(text, i)
            if not m:
                # Not any of our opener prefixes; emit the '<' literally and
                # advance. Avoids accidentally eating real text like ``<div>``
                # in code samples — those tags are not in _THINK_OPENERS.
                out.append("<")
                i += 1
                continue
            in_think = True
            i = m.end()  # right after the matched prefix (e.g. "think" / "reasoning")
            # Skip the optional 'i' of ``<thinking>`` so the opener absorbs both
            # ``<think>`` and ``<thinking>``. Other flavors (reasoning/thought/
            # reflection) have no such optional letter, so this is a no-op for them.
            if i < n and text[i] == "i":
                i += 1
            # Consume the rest of the opening tag up to the closing '>'.
            gt = text.find(">", i)
            if gt == -1:
                # Opening tag is split across chunks — buffer the rest so the
                # next chunk knows we ARE inside a think block (not just that
                # we saw a stray '<'). Without this, a literal "<think>partial "
                # would leak the '<' to the UI on the first chunk.
                think_buf += text[i:]
                i = n
            else:
                i = gt + 1
        else:
            # We're inside a think block. Look for ANY of the configured closers
            # so a stream that started as <think> can still close with </thinking>
            # and vice versa (mixed gateway output, malformed finishers, etc.).
            m = _THINK_CLOSER_RE.search(text, i)
            if not m:
                think_buf += text[i:]
                i = n
            else:
                think_buf = ""
                in_think = False
                i = m.end()
    return "".join(out), in_think, think_buf


def _scrub_think_prefix(text: str) -> str:
    """Drop a leading partial think-opener from the very first chunk.

    Some providers emit ``content: [{\"type\": \"text\", \"text\": \"<think>\"}]``
    as the FIRST list-part, before any streaming delta arrives. The main
    stream handler (``_run_mode_turn``) calls this on each text part so a
    standalone opening tag is consumed without leaking to the UI, while any
    visible text after the opener is preserved for the next pass through
    ``_strip_think_tags``.

    Returns the input unchanged when there's no leading opener.
    """
    if not text:
        return text
    m = _THINK_OPENER_RE.match(text)
    if not m:
        return text
    i = m.end()
    if i < len(text) and text[i] == "i":
        i += 1
    gt = text.find(">", i)
    if gt == -1:
        # Partial opener: consume only what we matched, leave the rest for the
        # streaming loop to handle via _strip_think_tags with in_think=True.
        return text[i:]
    return text[gt + 1 :]


def _is_repeating(
    text: str, min_len: int = 20, max_len: int = 200, min_reps: int = 3
) -> bool:
    """Detect a degenerate text loop at the tail of ``text``.

    Models sometimes emit the same sentence/phrase dozens of times with no
    tool call (e.g. "Let me check that. Let me check that. …"). The existing
    guards only watch the tool-call signature, so this text-only check catches
    it. It only flags *exact* back-to-back repetition of a bounded-length unit,
    so normal prose that happens to reuse a phrase (or even a sentence) a couple
    of times never trips it.

    ``min_len``/``max_len`` bound the repeated unit so a single repeated
    character or a huge block can't false-positive. ``min_reps`` is how many
    consecutive copies we need to call it a loop.
    """
    if not text or len(text) < min_len * min_reps:
        return False
    # Scan candidate unit lengths from longest to shortest so we match the
    # largest repeated phrase first (e.g. a whole sentence, not one word).
    for unit in range(min(max_len, len(text) // min_reps), min_len - 1, -1):
        tail = text[-(unit * min_reps) :]
        if len(tail) < unit * min_reps:
            continue
        first = tail[:unit]
        if all(tail[i * unit : (i + 1) * unit] == first for i in range(1, min_reps)):
            return True
    return False


def _resolve_stream_end_text(
    ai_content: str | list | None,
    emitted_text_len: int,
) -> str:
    """Decide what text (if any) to re-emit at stream-end when reasoning is enabled.

    Some providers null out ``reasoning_content`` and stream the chain-of-thought
    as plain content before the real answer. The streaming loop in
    ``_run_mode_turn`` drops those pre-answer content chunks while we are still
    waiting for a genuine reasoning field (``_saw_real_reasoning``). Once the
    stream ends, the cumulative ``ai.content`` therefore contains BOTH the
    dropped pre-answer CoT and the real answer that was already streamed as
    ``kind: "text"`` events.

    Blindly re-emitting the whole ``ai.content`` would duplicate the visible
    answer. The right behaviour is:

      * If nothing was emitted yet (the entire response was CoT), emit the full
        ``ai_content`` so the user sees the model's "best-effort" answer.
      * If something was already emitted, return ONLY the part of ``ai_content``
        that comes AFTER what was already streamed, so the user gets exactly
        one copy of the final answer.

    The split is by character count. The streaming loop only ever appends
    ``content`` to the emitted-text counter in the order it appeared, and the
    LangChain ``AIMessageChunk.__add__`` accumulator preserves that order, so
    the prefix of ``ai_content`` is exactly what was emitted.

    Parameters
    ----------
    ai_content:
        The full ``ai.content`` (string or list of parts) at stream-end.
    emitted_text_len:
        How many characters of text were already emitted as ``kind: "text"``
        events during the stream.

    Returns
    -------
    The suffix of ``ai_content`` that was NOT yet emitted, or ``""`` if
    everything was already streamed. For a list content, returns a list of
    parts (only the un-emitted suffix) or ``""`` when nothing is left.
    """
    if isinstance(ai_content, list):
        # For list-parts the streaming loop already emits each text part in
        # order, so by the time the stream ends EVERY visible text part has
        # already been flushed — nothing left to re-emit.
        return ""
    if not isinstance(ai_content, str):
        return ""
    if emitted_text_len <= 0:
        return ai_content
    if emitted_text_len >= len(ai_content):
        return ""
    return ai_content[emitted_text_len:]


def _extract_cache_tokens(um: dict) -> tuple[int, int, bool]:
    """Extract cache read/write token counts from ANY provider's usage metadata.

    Handles Anthropic (cache_read_input_tokens / cache_read, additive with
    input_tokens), OpenAI / Google (cached_tokens, a subset of input_tokens), and
    OpenAI raw (prompt_tokens_details.cached_tokens). Returns
    (cache_read, cache_write, additive) where ``additive`` means the cache is
    reported separately and must be summed in.
    """
    details = um.get("input_token_details") or {}
    if not isinstance(details, dict):
        details = {}
    prompt_details = um.get("prompt_tokens_details") or {}
    if not isinstance(prompt_details, dict):
        prompt_details = {}
    anthropic_read = (
        details.get("cache_read_input_tokens") or um.get("cache_read_input_tokens") or 0
    )
    anthropic_write = (
        details.get("cache_creation_input_tokens")
        or um.get("cache_creation_input_tokens")
        or 0
    )
    openai_read = (
        details.get("cached_tokens")
        or details.get("cache_read")
        or details.get("cache_read_tokens")
        or prompt_details.get("cached_tokens")
        or um.get("cache_read_tokens")
        or 0
    )
    openai_write = (
        details.get("cache_creation")
        or details.get("cache_creation_tokens")
        or details.get("cache_write_tokens")
        or um.get("cache_write_tokens")
        or 0
    )
    cache_read = int(anthropic_read or openai_read or 0)
    cache_write = int(anthropic_write or openai_write or 0)
    key_additive = bool(anthropic_read or anthropic_write)
    return cache_read, cache_write, key_additive


def _extract_reasoning_tokens(um: dict) -> int:
    """Extract reasoning/chain-of-thought token counts from ANY provider's usage.

    Reasoning-capable models (OpenAI o-series, Anthropic extended thinking,
    DeepSeek reasoner, Gemini thinking, …) report their thinking tokens in
    different places: ``output_token_details.reasoning_tokens`` (OpenAI/Anthropic
    native), ``completion_tokens_details.reasoning_tokens`` (OpenAI raw / DeepSeek),
    or a bare ``reasoning_tokens`` key. Returns the integer count (0 when absent).
    """
    if not isinstance(um, dict):
        return 0
    details = um.get("output_token_details") or {}
    if not isinstance(details, dict):
        details = {}
    completion_details = um.get("completion_tokens_details") or {}
    if not isinstance(completion_details, dict):
        completion_details = {}
    reasoning = (
        details.get("reasoning_tokens")
        or completion_details.get("reasoning_tokens")
        or um.get("reasoning_tokens")
        or 0
    )
    return int(reasoning or 0)


# Thinking level -> the downstream "reasoning effort" token. '' / 'none' mean
# reasoning is disabled. LangChain forwards these through model_kwargs to the
# provider. Kept here so graph.py / llm.py / agents.py share one definition.
_THINKING_LEVELS = {
    "": None,
    "none": False,
    "minimal": "minimal",
    "low": "low",
    "medium": "medium",
    "high": "high",
}
