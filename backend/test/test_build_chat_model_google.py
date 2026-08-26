"""Unit test: build_chat_model for the Google provider must NOT pass
``default_headers`` to ``ChatGoogleGenerativeAI`` (that class rejects the
argument and emits a warning)."""


from llm import build_chat_model


def test_google_model_has_no_default_headers(monkeypatch):
    captured = {}

    class FakeGoogle:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setitem(
        __import__("sys").modules,
        "langchain_google_genai",
        type("m", (), {"ChatGoogleGenerativeAI": FakeGoogle})(),
    )

    build_chat_model(
        provider="google",
        model="gemini-1.5-pro",
        api_key="test-key",
    )

    assert "default_headers" not in captured
    assert captured.get("google_api_key") == "test-key"
    assert captured.get("model") == "gemini-1.5-pro"
