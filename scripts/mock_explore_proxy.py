"""Probe harness: parent = mock (returns an explore tool_call), sub-agent = proxied to the real provider.

Call 1 (parent)  -> SSE tool_call for `explore`.
Calls >= 2 (sub-agent) -> forward the request body to RIVER_URL and stream back.
"""
import http.server
import json
import urllib.request

RIVER_URL = "https://api.river.ai/v1/chat/completions"
RIVER_KEY = "rv_VgBcBaL51gsmO6yL5m7JEQTUOyRThi96VJr9EgRt_vE"
STATE = {"calls": 0}


class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        STATE["calls"] += 1
        if STATE["calls"] == 1:
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            tc = {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "type": "function", "function": {"name": "explore", "arguments": json.dumps({"description": "probe", "prompt": "List the Rust source files under src-tauri/src and report each file's line count."})}}]}}]}
            self.wfile.write(b"data: " + json.dumps(tc).encode() + b"\n\n")
            self.wfile.write(b"data: " + json.dumps({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}).encode() + b"\n\n")
            self.wfile.write(b"data: [DONE]\n\n")
            return
        # Sub-agent call: proxy to the real provider, stream back verbatim.
        body["stream"] = True
        req = urllib.request.Request(
            RIVER_URL,
            data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {RIVER_KEY}", "Content-Type": "application/json"},
        )
        try:
            upstream = urllib.request.urlopen(req, timeout=120)
        except Exception as e:  # noqa: BLE001 - probe harness
            detail = getattr(e, "read", lambda: b"")()[:400]
            self.send_response(getattr(e, "code", 500))
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(detail or str(e).encode())
            return
        self.send_response(upstream.status)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        while True:
            chunk = upstream.read(4096)
            if not chunk:
                break
            self.wfile.write(chunk)
            self.wfile.flush()

    def log_message(self, *a):
        pass


http.server.HTTPServer(("127.0.0.1", 59980), H).serve_forever()
