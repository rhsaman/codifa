"""توابع و ثابت‌های مشترک بین ماژول‌های backend.

این ماژول برای رفع تکرار (DRY) ایجاد شده است: توابعی مثل ``_strip_think_tags``،
``_is_repeating`` و ``_extract_cache_tokens`` قبلاً به‌صورت کپی‌شده در ``graph.py``،
``llm.py`` و ``agents.py`` وجود داشتند. قرار دادن آن‌ها در یک ماژول مشترک باعث
می‌شود یک منبع واحد (single source of truth) داشته باشیم و از ناهماهنگی جلوگیری
شود. این ماژول وابستگی به هیچ ماژول backend دیگری ندارد، پس خطر circular import
ندارد.
"""

from __future__ import annotations


def _strip_think_tags(
    text: str, in_think: bool, think_buf: str
) -> tuple[str, bool, str]:
    """Remove literal ``<think>…</think>`` reasoning from streamed text.

    Some models (DeepSeek/Qwen/llama.cpp and a few OpenAI-compatible gateways)
    emit their chain-of-thought as a literal ``<think>…</think>`` block inside
    the ``content`` stream instead of using a dedicated reasoning field. We drop
    it from the visible text so it never leaks to the frontend. The tag may span
    multiple streamed deltas, so the ``in_think`` / ``think_buf`` state is
    preserved across calls.
    """
    if not text:
        return text, in_think, think_buf
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        if not in_think:
            start = text.find("<think", i)
            if start == -1:
                out.append(text[i:])
                break
            out.append(text[i:start])
            in_think = True
            i = start + len("<think")
            # Consume the optional 'i' of the <thinking> variant, then skip to
            # the closing '>' of the opening tag.
            if i < n and text[i] == "i":
                i += 1
            gt = text.find(">", i)
            if gt == -1:
                think_buf += text[i:]
                i = n
            else:
                i = gt + 1
        else:
            end = text.find("</think>", i)
            if end == -1:
                think_buf += text[i:]
                i = n
            else:
                think_buf += text[i:end]
                in_think = False
                i = end + len("</think>")
    return "".join(out), in_think, think_buf


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
