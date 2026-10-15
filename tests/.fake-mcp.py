"""Minimal MCP stdio server used by the live MCP test (not a test file)."""
import json
import sys

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except Exception:
        continue
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        res = {"protocolVersion": "2024-11-05", "capabilities": {}}
    elif method == "tools/list":
        res = {
            "tools": [
                {
                    "name": "echo",
                    "description": "Echo text back",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"text": {"type": "string"}},
                    },
                }
            ]
        }
    elif method == "tools/call":
        res = {"content": [{"type": "text", "text": "MCP-ECHO-OK"}]}
    else:
        continue
    if mid is not None:
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": mid, "result": res}) + "\n")
        sys.stdout.flush()
