"""Unit tests: context-meter alignment with opencode's compaction trigger.

Covers the backend side that the frontend meter must mirror:
- `_usable_tokens` (opencode's `usable()`) used by auto-compaction.
- `CompactRequest.compact_at_percent` default now matches the auto-compact / UI default.
"""

import graph
import server


def test_usable_tokens_opencode_parity():
    # No output limit known -> opencode reserves 0 (usable == ctx).
    assert graph._agents._usable_tokens(200_000, 0, None) == 200_000
    # UI headroom (reserved) is honored directly — the meter fills toward this.
    assert graph._agents._usable_tokens(200_000, 0, 20_000) == 180_000
    # Known max output -> opencode reserves min(COMPACTION_BUFFER, max_output).
    assert graph._agents._usable_tokens(200_000, 8192, None) == 200_000 - 8192
    # reserved is clamped to [0, ctx].
    assert graph._agents._usable_tokens(8000, 0, 200_000) == 0


def test_compact_request_percent_default_matches_auto_compact():
    # The manual /compact default must equal the auto-compact / UI threshold
    # default (80), so a manual compact without an explicit percent behaves
    # identically to auto-compaction. The frontend always sends the user's
    # actual compactAtPercent, so this is only a fallback.
    req = server.CompactRequest()
    assert req.compact_at_percent == 80
    # context_window still defaults to 0 (resolved from the active model).
    assert req.context_window == 0
