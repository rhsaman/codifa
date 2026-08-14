"""Context builder: composes the RAG block injected into the agent's prompt.

Turns raw retrieval hits into a compact, clearly-labelled system-prompt
section so the model starts every run already knowing what matters for the
current prompt — without blowing the context budget:

* **Learned memory** — the agent's own saved notes (``kind=memory``), the
  top few most relevant to the current prompt.
* **Project files** — the most relevant indexed file chunks (``kind=file``),
  each with its real path so the agent can ``read_file`` the full thing when
  a snippet isn't enough. Only the snippet text is injected (never the whole
  file), so big files stay cheap.
* **Web pages** — saved pages (``kind=web``), when the prompt is about them.

Sections are bounded (``per_section_chars``) and the whole block is capped
(``max_chars``); whichever budget hits first wins. Each hit is deduped and
labelled with its path/title and relevance source, so the model can weigh it.

Never raises: a missing store, empty index or dead embedder yields ``""``.
"""

from __future__ import annotations

import re

from retrieval import Hit, RetrievalSettings, retrieve
from vector_store import KIND_FILE, KIND_MEMORY, KIND_WEB, VectorStore

_DEFAULT_MAX_CHARS = 3_600
_DEFAULT_PER_SECTION = 1_400

# Titles for each injected section.
_SECTION_TITLES = {
    KIND_MEMORY: "YOUR OWN MEMORY (saved notes from earlier sessions on this project)",
    KIND_FILE: "RELEVANT PROJECT FILES (chunks from the workspace index)",
    KIND_WEB: "SAVED WEB PAGES (relevant to this prompt)",
}

# How to label one hit inside its section.
def _line(h: Hit, idx: int) -> str:
    label = h.title or h.key or f"item {idx}"
    path = ""
    if h.kind == KIND_FILE:
        rel = str(h.meta.get("file_path") or "")
        if rel:
            path = f" ({rel})"
    elif h.kind == KIND_WEB:
        url = str(h.meta.get("source_url") or "")
        if url:
            path = f" ({url})"
    text = re.sub(r"\s+", " ", h.text or "").strip()
    return f"- [{label}]{path}: {text}"


def _section(kind: str, hits: list[Hit], budget: int) -> str:
    if not hits:
        return ""
    lines: list[str] = []
    used = 0
    for idx, h in enumerate(hits, 1):
        line = _line(h, idx)
        if used + len(line) > budget and lines:
            break
        lines.append(line)
        used += len(line)
    body = "\n".join(lines)
    title = _SECTION_TITLES.get(kind, kind.upper())
    return f"\n\n===== {title} =====\n{body}"


def build_context(
    store: VectorStore | None,
    prompt: str,
    settings: RetrievalSettings | None = None,
    max_chars: int = _DEFAULT_MAX_CHARS,
    per_section_chars: int = _DEFAULT_PER_SECTION,
    kinds: tuple[str, ...] | None = None,
) -> str:
    """Assemble the RAG context block for ``prompt`` (or ``""`` when nothing
    is relevant / the store is unavailable / auto-recall is off).

    ``kinds`` overrides which document kinds are included (default: memory,
    file, web — everything the settings allow).
    """
    if store is None:
        return ""
    settings = settings or RetrievalSettings()
    if not settings.auto_recall:
        return ""
    prompt = (prompt or "").strip()
    if not prompt:
        return ""

    order = kinds or (KIND_MEMORY, KIND_FILE, KIND_WEB)
    parts: list[str] = []
    used = 0
    for kind in order:
        if kind not in settings.active_kinds():
            continue
        try:
            hits = retrieve(
                store,
                prompt,
                kinds=(kind,),
                top_k=max(2, settings.top_k // 2) if kind != KIND_MEMORY else settings.top_k,
                max_chars=per_section_chars // 3,
            )
        except Exception:  # noqa: BLE001, S112 — best-effort, never raises
            continue
        sec = _section(kind, hits, per_section_chars)
        if not sec:
            continue
        # Whole-block budget: drop the rest once we're over.
        if used + len(sec) > max_chars and parts:
            break
        parts.append(sec)
        used += len(sec)
        if used >= max_chars:
            break
    return "".join(parts)


def build_context_with_memory(
    store: VectorStore | None,
    prompt: str,
    settings: RetrievalSettings | None = None,
    memory_block: str = "",
    max_chars: int = _DEFAULT_MAX_CHARS,
) -> str:
    """Like ``build_context`` but also carries a precomputed memory block
    (e.g. from ``MemoryManager.search``) when the caller already has one.

    Used by the agent run path so memory notes fetched via the memory manager
    (which also touches their TTL) aren't fetched twice through different
    paths.
    """
    rag = build_context(store, prompt, settings, max_chars=max_chars)
    memory_block = (memory_block or "").strip()
    if not memory_block:
        return rag
    if rag and len(rag) + len(memory_block) > max_chars:
        # Prefer the memory block (agent's own knowledge) over file snippets
        # when both can't fit.
        return memory_block
    return memory_block + rag
