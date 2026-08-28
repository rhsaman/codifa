"""تست: dedup نقشهٔ CODE MAP باید marker "unchanged" فقط وقتی بفرسته که نقشهٔ
کامل هنوز تو recent tail (lc_history) هست — وگرنه نقشهٔ کامل رو دوباره می‌فرسته.

این باگ رو پوشش می‌ده: اگه historyLimit یا auto-compact turn حاوی نقشهٔ کامل رو
حذف/خلاصه کنه، marker "see previous turn" به هیچی اشاره نمی‌کنه و مدل رو گمراه
می‌کنه. کش هش هم باید per-chat باشه (chat_id کلید dict) نه scalar global.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from langchain_core.messages import HumanMessage, SystemMessage

import graph as _graph

_FULL_MAP = (
    "\n\n===== CODE MAP (live symbol index — go straight to read, no grep needed) =====\n"
    "📁 ./a.py\n  function foo (L1)\n"
)
_UNCHANGED = (
    "\n\n===== CODE MAP (live symbol index — unchanged since last turn) =====\n"
    "[see previous turn's CODE MAP — no files changed]"
)


def _reset_cache():
    _graph.build_turn_context._code_map_hash_cache = {}


def _history_with_full_map():
    return [HumanMessage(content="user said hi"), HumanMessage(content=_FULL_MAP)]


def _history_without_full_map():
    return [HumanMessage(content="user said hi"), SystemMessage(content="[Compacted earlier context]")]


def test_same_hash_with_full_map_in_history_sends_marker():
    _reset_cache()
    # اولین بار: نقشهٔ کامل می‌ره (هش ذخیره می‌شه)
    first = _graph._dedup_code_map(_FULL_MAP, "h1", "chatA", _history_with_full_map())
    assert first == _FULL_MAP
    # دومین بار با همون هش + نقشهٔ کامل هنوز تو history: marker می‌ره
    second = _graph._dedup_code_map(_FULL_MAP, "h1", "chatA", _history_with_full_map())
    assert second == _UNCHANGED


def test_same_hash_without_full_map_in_history_sends_full():
    _reset_cache()
    out = _graph._dedup_code_map(_FULL_MAP, "h1", "chatA", _history_without_full_map())
    assert out == _FULL_MAP  # نقشهٔ کامل دوباره فرستاده می‌شه، نه marker


def test_different_hash_sends_full():
    _reset_cache()
    out = _graph._dedup_code_map(_FULL_MAP, "h2", "chatA", _history_with_full_map())
    assert out == _FULL_MAP


def test_per_chat_isolation():
    _reset_cache()
    # chatA اولین بار نقشه رو می‌فرسته (هش ذخیره می‌شه)
    a1 = _graph._dedup_code_map(_FULL_MAP, "h1", "chatA", _history_with_full_map())
    assert a1 == _FULL_MAP
    # chatB هنوز هش نداره → نقشهٔ کامل می‌فرسته (گمراه نمی‌شه با هش chatA)
    b1 = _graph._dedup_code_map(_FULL_MAP, "h1", "chatB", _history_with_full_map())
    assert b1 == _FULL_MAP
    # حالا chatB هم هش داره → marker می‌فرسته
    b2 = _graph._dedup_code_map(_FULL_MAP, "h1", "chatB", _history_with_full_map())
    assert b2 == _UNCHANGED
    # chatA دومین بار با همون هش → marker می‌فرسته (مستقل از chatB)
    a2 = _graph._dedup_code_map(_FULL_MAP, "h1", "chatA", _history_with_full_map())
    assert a2 == _UNCHANGED
