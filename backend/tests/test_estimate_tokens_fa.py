"""Unit tests for _estimate_tokens: Persian text must be counted more densely
than Latin text (Persian ~2.5 chars/token vs Latin ~4 chars/token)."""

from agents import _estimate_tokens


def test_latin_400_chars_about_100_tokens():
    text = "a" * 400
    assert _estimate_tokens(text) == 100


def test_persian_counts_denser_than_latin():
    latin = "a" * 400
    persian = "ا" * 400  # single Persian char repeated
    assert _estimate_tokens(persian) > _estimate_tokens(latin)


def test_empty_returns_one():
    assert _estimate_tokens("") == 1
    assert _estimate_tokens(None) == 1


def test_mixed_text_between_bounds():
    # 200 latin + 200 persian should be more than 200/4=50 but less than pure persian.
    mixed = "a" * 200 + "ب" * 200
    latin_only = _estimate_tokens("a" * 400)
    persian_only = _estimate_tokens("ب" * 400)
    est = _estimate_tokens(mixed)
    assert latin_only < est < persian_only


if __name__ == "__main__":
    test_latin_400_chars_about_100_tokens()
    test_persian_counts_denser_than_latin()
    test_empty_returns_one()
    test_mixed_text_between_bounds()
    print("ESTIMATE TOKENS FA TESTS PASSED")
