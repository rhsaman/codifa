"""Live probe: run one real explore turn and check the trace for find_symbol.

Takes the router port as argv[1]. Posts a minimal /chat/stream request whose
prompt names a symbol, then scans the SSE stream for the tool name. Throwaway
diagnostic — not part of the test suite.
"""
import json
import sys
import urllib.error
import urllib.request

PORT = int(sys.argv[1])
PROMPT = "Where is find_symbol defined and who calls it? Use find_symbol."


def stream(body):
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}/chat/stream",
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if line:
                yield line


# Minimal body first: the error message names the required fields.
try:
    for line in stream({"message": PROMPT}):
        print(line[:400])
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:600])
except Exception as e:  # noqa: BLE001 — probe only
    print(type(e).__name__, e)
