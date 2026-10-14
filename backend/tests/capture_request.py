"""Capture the exact request body the backend sends to a custom gateway.

Run: env -u PYTHONHOME .venv/bin/python tests/capture_request.py
Then trigger a chat turn against the mock and read /tmp/codifa-req.json.
"""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer

LOG = "/tmp/codifa-req.json"


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        with open(LOG, "wb") as f:
            f.write(body)
        # Minimal OpenAI-compatible SSE reply so the agent loop proceeds.
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        chunk = json.dumps(
            {"choices": [{"delta": {"content": "ok"}, "index": 0}]}
        )
        self.wfile.write(f"data: {chunk}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 59950), Handler).serve_forever()
