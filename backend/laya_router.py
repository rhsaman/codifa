"""On-device Laya decision router for skill auto-loading.

Routes a request to skills with the downloaded Laya checkpoint
(``convaiinnovations/laya`` via Settings -> Models). Laya is a
non-autoregressive ModernBERT classifier answering every question in one
forward pass, so skill routing asks one binary skill-vs-none question per
prefiltered candidate in a single tiny local call with no provider traffic
and no token cost.

Contract with ``graph._route_skills``:

* :func:`is_laya_entry` detects the ``"laya"`` decision-slot value.
* :func:`predict` returns skill names (``[]`` = none fits), or ``None``
  when routing is unavailable (not downloaded, load/infer failure) so the
  caller inlines nothing (no keyword fallback).
* Local routing emits NO usage event (local models are free); it appends a
  best-effort ``llm`` trace entry so the Trace panel still shows the call.
"""

from __future__ import annotations

import gc
import json
import logging
import os
import threading
import time

logger = logging.getLogger(__name__)

#: Decision-slot value selecting the downloaded on-device router.
LAYA_ENTRY = "laya"

#: Extra choice option meaning "no skill fits this request".
_NONE_OPTION = "none"

#: Max skills offered to Laya per turn. The base checkpoints are near-chance
#: zero-shot on high-cardinality choices (model card: accuracy falls off
#: sharply past ~20 options because options share the small head budget), so
#: routing asks one binary question per candidate instead of one big choice.
#: The embedding prefilter narrows any store size to these top candidates.
_MAX_OPTIONS = 5

#: Min margin (P(skill) - P(none)) for a candidate to be picked. Below this
#: the candidate is treated as not matching, so a missing skill loads nothing.
_MIN_MARGIN = 0.3

#: Max skills auto-loaded per turn (mirrors agents._SKILL_AUTO_MAX).
_MAX_PICKS = 2

#: Max chars of the request text fed to Laya (matches the caller's cap).
_PROMPT_MAX_CHARS = 1500

_BIN_INSTRUCTIONS = (
    "Is this request exactly the kind of task this skill is for? "
    "Pick the skill only when the request is that exact task; otherwise pick none."
)

_NONE_DESC = (
    "no skill fits: the request is a plain bug fix, refactor, "
    "debugging task, or a different task entirely"
)

# RLock: _laya_touch() re-arms the timer from paths that already hold this
# lock (cache hit / post-load store) — a plain Lock would deadlock.
_lock = threading.RLock()
_agent: object | None = None
_agent_dir = ""
_load_error = ""

# Idle eviction: the Laya weights stay resident after routing, adding to the
# sidecar's RAM for the rest of the session. After this many seconds without
# a predict call the agent is dropped; the next call reloads it lazily.
try:
    _LAYA_IDLE_EVICT_S = float(os.environ.get("LAYA_IDLE_EVICT_S") or 60)
except (TypeError, ValueError):
    _LAYA_IDLE_EVICT_S = float(60)
_laya_last_used = 0.0
_laya_evict_timer: threading.Timer | None = None


def _laya_touch() -> None:
    """Record Laya activity and (re)arm the idle-eviction timer."""
    global _laya_last_used, _laya_evict_timer
    with _lock:
        _laya_last_used = time.monotonic()
        if _laya_evict_timer is not None:
            _laya_evict_timer.cancel()
        _laya_evict_timer = threading.Timer(
            _LAYA_IDLE_EVICT_S, _evict_laya_if_idle
        )
        _laya_evict_timer.daemon = True
        _laya_evict_timer.start()


def _evict_laya_if_idle() -> None:
    """Drop the cached Laya agent after a full idle window; next use reloads."""
    global _agent, _agent_dir, _load_error
    with _lock:
        if _agent is None:
            return
        if time.monotonic() - _laya_last_used < _LAYA_IDLE_EVICT_S:
            return
        _agent = None
        _agent_dir = ""
        _load_error = ""
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001, S110 - cache clear is best-effort
        pass


def unload() -> bool:
    """Drop the cached Laya agent immediately, freeing RAM.

    Returns True when a loaded agent was dropped. Safe anytime; the next
    predict call reloads lazily. Used by the manual free-memory endpoint.
    """
    global _agent, _agent_dir, _load_error, _laya_evict_timer
    with _lock:
        had_model = _agent is not None
        _agent = None
        _agent_dir = ""
        _load_error = ""
        if _laya_evict_timer is not None:
            try:
                _laya_evict_timer.cancel()
            except Exception:  # noqa: BLE001, S110 -- timer cancel never fails
                pass
            _laya_evict_timer = None
    if had_model:
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001, S110 - cache clear is best-effort
            pass
    return had_model


def is_laya_entry(entry: object) -> bool:
    """True when the decision-slot value selects the local Laya router."""
    return isinstance(entry, str) and entry.strip().lower() == LAYA_ENTRY


def laya_ready() -> bool:
    """True when a usable Laya build is downloaded."""
    try:
        from model_download import decision_model_dir
    except Exception:  # noqa: BLE001 — fail-open, caller falls back
        return False
    try:
        return bool(decision_model_dir())
    except Exception:  # noqa: BLE001 — status must never break routing
        return False


def _has_non_latin(text: str) -> bool:
    return any(ord(c) > 127 for c in str(text or ""))


def _resolve_model_dir(prompt: str) -> str:
    """Concrete RLAgent dir for ``prompt``; '' when nothing is downloaded.

    Prefers the multilingual checkpoint for non-Latin requests (e.g.
    Persian) when that sub-build is present, mirroring the upstream Router
    which picks the checkpoint per request.
    """
    from model_download import decision_model_dir

    base = decision_model_dir()
    if not base:
        return ""
    if _has_non_latin(prompt):
        multi = os.path.join(base, "multilingual")
        try:
            if os.path.isfile(
                os.path.join(multi, "model.safetensors")
            ) and os.path.isfile(os.path.join(multi, "rl_agent_config.json")):
                return multi
        except OSError:
            pass
    return base


def _find_rl_common(model_dir: str) -> str:
    """Absolute path of the ``rl_common.py`` shipped with the snapshot."""
    cands = [
        os.path.join(model_dir, "rl_common.py"),
        os.path.join(os.path.dirname(model_dir), "rl_common.py"),
    ]
    for cand in cands:
        try:
            if os.path.isfile(cand):
                return cand
        except OSError:
            continue
    return ""


def _get_agent(model_dir: str) -> object:
    """Load (once) the RLAgent for ``model_dir``; raises on any problem."""
    global _agent, _agent_dir, _load_error
    with _lock:
        if _agent is not None and _agent_dir == model_dir:
            cached = _agent
        else:
            cached = None
    if cached is not None:
        _laya_touch()
        return cached
    import importlib.util

    common_path = _find_rl_common(model_dir)
    if not common_path:
        raise FileNotFoundError("rl_common.py missing from Laya snapshot")
    with open(os.path.join(model_dir, "rl_agent_config.json")) as f:
        cfg = json.load(f)
    mod_name = "laya_rl_common_cached"
    spec = importlib.util.spec_from_file_location(mod_name, common_path)
    if spec is None or spec.loader is None:
        raise ImportError("cannot load rl_common.py")
    import sys

    rl_common = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = rl_common
    spec.loader.exec_module(rl_common)  # type: ignore[union-attr]

    import torch
    from safetensors.torch import load_file
    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained(os.path.join(model_dir, "tokenizer"))
    model = rl_common.build_model(
        cfg, encoder_dir=os.path.join(model_dir, "encoder")
    )
    model.load_state_dict(
        load_file(os.path.join(model_dir, "model.safetensors")), strict=True
    )
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device).eval()
    agent = _MiniAgent(rl_common, cfg, tok, model, device)
    with _lock:
        _agent = agent
        _agent_dir = model_dir
        _load_error = ""
    _laya_touch()
    return agent


class _MiniAgent:
    """Minimal RLAgent surface: ``system_one(state, questions)``."""

    def __init__(self, rl_common, cfg: dict, tok, model, device) -> None:
        self._rc = rl_common
        self._cfg = cfg
        self._tok = tok
        self._model = model
        self._device = device
        self._temperature: list[float] = list(
            cfg.get("temperature", [1.0, 1.0, 1.0])
        )
        self._temp_by_options: dict = dict(
            cfg.get("temperature_by_options", {})
        )

    def system_one(self, state: str, questions: dict) -> dict:
        import numpy as np
        import torch

        rc = self._rc
        ids = list(questions.keys())
        items = []
        for qid in ids:
            q = _to_internal(questions[qid])
            seq, markers = rc.build_sequence(
                self._tok, state, q,
                self._cfg["max_len"], self._cfg["head_max_len"],
            )
            items.append({
                "ids": seq, "markers": markers,
                "qtype": rc.QTYPES[q["t"]],
                "target": [0.0] * len(markers), "label": -1,
                "episode": 0, "ep_step": 0, "ep_len": 1, "src": "api",
            })
        b = rc.collate_items([items], self._tok.pad_token_id)
        with torch.no_grad():
            logits, _act = self._model(
                b["input_ids"].to(self._device),
                b["attention_mask"].to(self._device),
                b["marker_pos"].to(self._device),
                b["marker_mask"].to(self._device),
                b["qtype"].to(self._device),
            )
        logits = logits.float().cpu().numpy()
        answers: dict = {}
        for r, qid in enumerate(ids):
            q = _to_internal(questions[qid])
            k = len(items[r]["markers"])
            z = logits[r, :k] / self._temp_by_options.get(
                rc.temp_bucket(rc.QTYPES[q["t"]], k),
                self._temperature[rc.QTYPES[q["t"]]],
            )
            p = np.exp(z - z.max())
            p = p / p.sum()
            keys = list(q["crit"].keys())
            answers[qid] = {
                "type": "choice",
                "choice": keys[int(p.argmax())],
                "probabilities": {
                    kk: round(float(v), 4) for kk, v in zip(keys, p)
                },
                "confidence": round(
                    float(rc.confidence_from_probs(p, k)), 4
                ),
            }
        return {"model": "laya-local", "answers": answers}


def _to_internal(qdef: dict) -> dict:
    crit = qdef.get("criteria")
    if isinstance(crit, list):
        crit = {c: None for c in crit}
    ins = qdef.get("instructions")
    return {
        "t": qdef.get("type", "choice"),
        "ins": ins if isinstance(ins, str) else json.dumps(ins),
        "crit": crit,
    }


def _binary_questions(rows: list[dict]) -> dict:
    """One skill-vs-none choice question per candidate, keyed by skill name."""
    questions: dict = {}
    for s in rows[:_MAX_OPTIONS]:
        name = str(s.get("name") or "").strip()
        if not name or name in questions:
            continue
        questions[name] = {
            "type": "choice",
            "instructions": _BIN_INSTRUCTIONS,
            "criteria": {
                name: str(s.get("description") or "").strip()[:140] or name,
                _NONE_OPTION: _NONE_DESC,
            },
        }
    return questions


def predict(
    prompt: str, rows: list[dict], chat_id: str = ""
) -> list[str] | None:
    """Route ``prompt`` to skill names with local Laya.

    ``rows`` are the prefiltered top candidates from ``skill_prefilter``
    (any store size narrows to these before Laya sees them). Each candidate
    gets one binary skill-vs-none question in a single forward pass; a pick
    needs a margin of at least ``_MIN_MARGIN`` over ``none`` so a missing
    skill loads nothing. Returns ``[]`` when no skill fits, ``None`` when
    Laya is unavailable (caller inlines nothing). Never raises.
    """
    text = (prompt or "").strip()
    usable = [s for s in rows or [] if str(s.get("name") or "").strip()]
    if not text or not usable:
        return None
    try:
        model_dir = _resolve_model_dir(text)
    except Exception:  # noqa: BLE001 — fail-open
        return None
    if not model_dir:
        return None
    questions = _binary_questions(usable)
    if not questions:
        return None
    try:
        agent = _get_agent(model_dir)
        out = agent.system_one(  # type: ignore[union-attr]
            text[:_PROMPT_MAX_CHARS], questions
        )
        answers = out.get("answers") or {}
        margins: list[tuple[float, str]] = []
        for name in questions:
            probs = (answers.get(name) or {}).get("probabilities") or {}
            margin = float(probs.get(name, 0.0)) - float(probs.get(_NONE_OPTION, 0.0))
            if margin >= _MIN_MARGIN:
                margins.append((margin, name))
        margins.sort(reverse=True)
        names = [n for _, n in margins[:_MAX_PICKS]]
    except Exception as exc:  # noqa: BLE001 — routing never breaks the turn
        logger.warning("[skills] laya local failed: %s", exc)
        return None
    try:
        import trace_store

        trace_store.append(
            str(chat_id or ""),
            "llm",
            f"laya · {', '.join(names) or '-'}",
            detail={"provider": "local", "provider_id": "local",
                    "sub": True, "local": True},
            model="laya",
            prompt=text[:_PROMPT_MAX_CHARS],
            result=", ".join(names),
        )
    except Exception:  # noqa: BLE001, S110 — trace never breaks routing
        pass
    return names
