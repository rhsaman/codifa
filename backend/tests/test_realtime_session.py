"""Unit tests for POST /realtime/session (ephemeral realtime token minting)."""

import json

from fastapi.testclient import TestClient

import server

client = TestClient(server.app)

BASE_URL = "https://api.example.com/v1"
MODEL = "gpt-realtime"
MASTER_KEY = "sk-test-master"
EPHEMERAL_TOKEN = "eph_test_token"
EXPIRES_AT = 1700000060


class _FakeUpstreamResponse:
    """Minimal stand-in for the httpx response returned by the upstream call."""

    status_code = 200

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload

    @property
    def text(self):
        return json.dumps(self._payload)


class _FakeAsyncClient:
    """Fake httpx.AsyncClient returning a canned upstream realtime session."""

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, headers=None, json=None):
        assert url == f"{BASE_URL}/realtime/client_secrets"
        assert headers["Authorization"] == f"Bearer {MASTER_KEY}"
        assert json["session"]["model"] == MODEL
        return _FakeUpstreamResponse(
            {"client_secret": {"value": EPHEMERAL_TOKEN, "expires_at": EXPIRES_AT}}
        )


def test_realtime_session_success_returns_ephemeral_token(monkeypatch):
    # Upstream is fully mocked: no real network traffic leaves this test.
    monkeypatch.setattr("httpx.AsyncClient", _FakeAsyncClient)
    resp = client.post(
        "/realtime/session",
        json={"base_url": BASE_URL, "model": MODEL, "api_key": MASTER_KEY},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["ephemeral_token"] == EPHEMERAL_TOKEN
    assert data["websocket_url"] == f"wss://api.example.com/v1/realtime?model={MODEL}"
    assert data["expires_at"] == EXPIRES_AT
    # The long-lived master key must never leak into the response.
    assert MASTER_KEY not in resp.text


def test_realtime_session_missing_key_returns_400(monkeypatch):
    # Force key resolution to fail deterministically regardless of environment.
    monkeypatch.setattr(server, "_resolve_realtime_key", lambda req: "")

    def _fail_client(*args, **kwargs):
        raise AssertionError("upstream must not be called without a key")

    monkeypatch.setattr("httpx.AsyncClient", _fail_client)
    resp = client.post(
        "/realtime/session",
        json={"base_url": BASE_URL, "model": MODEL, "provider": ""},
    )
    assert resp.status_code == 400
    assert "api key" in resp.json()["detail"]
