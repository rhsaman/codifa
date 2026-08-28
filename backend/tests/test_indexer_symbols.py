"""Tests for symbol extraction edge cases (no IndexError on capture-less langs)."""

from indexer import _extract_symbols


def test_extract_symbols_bash_no_index_error():
    """bash/fish/sql/scss/less fall into the `else` branch whose pattern now
    captures group(1); previously it raised IndexError on m.group(1)."""
    for lang in ("bash", "fish", "sql", "scss", "less", "unknown"):
        syms = _extract_symbols("echo hello\nmyfunc()\n", lang)
        # Should not raise; a definition-looking line yields a symbol.
        assert isinstance(syms, list)


def test_extract_symbols_python_still_works():
    text = "def foo():\n    pass\n\nclass Bar:\n    pass\n"
    syms = _extract_symbols(text, "python")
    names = {s["name"] for s in syms}
    assert "foo" in names
    assert "Bar" in names
