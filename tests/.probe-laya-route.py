"""Live probe: the native agent routes skills through Laya when the decision
slot is "laya".

Takes the router port as argv[1] (or discovers it). Drives /chat/stream with a
mock LLM and a decision slot set to "laya", then checks the app's trace for the
skill-routing call — proving the Rust agent asked the sidecar instead of
silently dropping back to the keyword matcher.

Throwaway diagnostic — not part of the test suite.
"""
import json
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def live_port() -> int:
    """The router port changes on every rebuild — ask the OS which one listens."""
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        return int(sys.argv[1])
    out = subprocess.run(
        ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"], capture_output=True, text=True
    ).stdout
    for line in out.splitlines():
        if "codifa" in line and "127.0.0.1:" in line:
            return int(line.split("127.0.0.1:")[1].split()[0])
    raise SystemExit("no live router port")


ROUTER = live_port()
print("router:", ROUTER)
ROOT = "/Users/saman/Documents/code/codifa"
CALLS = {"n": 0}


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *a):  # silence
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        CALLS["n"] += 1
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.wfile.write(
            b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
            b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
            b"data: [DONE]\n\n"
        )
        self.wfile.flush()


srv = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
print("mock llm on", port)

body = {
    "provider": "custom",
    "provider_id": "mock",
    "model": "mock-model",
    "base_url": f"http://127.0.0.1:{port}/v1",
    "api_key": "test-key",
    "api_keys": ["test-key"],
    "root": ROOT,
    "mode": "agent",
    "prompt": "find me a good movie to watch tonight",
    "chat_id": "probe-laya-route",
    "data_root": "",
    # The decision slot selects the on-device Laya classifier.
    "subagent_models": {"decision": "laya"},
}

try:
    req = urllib.request.Request(
        f"http://127.0.0.1:{ROUTER}/chat/stream",
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if line:
                print("SSE:", line[:220])
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:400])
except Exception as e:  # noqa: BLE001 — probe only
    print(type(e).__name__, e)

print("model calls:", CALLS["n"])

# The skill routing shows up in the trace store as an "llm" row.
try:
    with urllib.request.urlopen(
        f"http://127.0.0.1:{ROUTER}/chats/probe-laya-route/traces", timeout=20
    ) as r:
        traces = json.loads(r.read().decode() or "[]")
except Exception as e:  # noqa: BLE001 — probe only
    print("trace read failed:", type(e).__name__, e)
    traces = []

rows = traces if isinstance(traces, list) else traces.get("traces") or []
print("trace rows:", len(rows))
for t in rows:
    print("  ", t.get("kind"), "|", str(t.get("summary"))[:90])
laya_rows = [t for t in rows if "laya" in json.dumps(t).lower()]
print("laya routing visible in trace:", bool(laya_rows))
