"""Live probe: the read/grep fixes against the running app's own router.

Takes the router port as argv[1]. Exercises the two behaviours a real trace
got wrong: an out-of-range read offset must explain itself, and a catch-all
grep must point at read. Throwaway diagnostic — not part of the test suite.
"""
import json
import sys
import urllib.error
import urllib.request

PORT = int(sys.argv[1])
ROOT = "/Users/saman/Documents/code/codifa"


def call(path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{path}",
        data=data,
        method="POST" if data else "GET",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "{}")


def tool(name, args):
    """Run one native tool through the router's tool endpoint."""
    try:
        return call("/tools/run", {"name": name, "args": args, "root": ROOT})
    except urllib.error.HTTPError as e:
        return {"http_error": e.code, "body": e.read().decode()[:200]}


print("read past the end:")
print(" ", tool("read", {"filePath": "package.json", "offset": 100000, "limit": 10}))

print("read offset=1 (control):")
r = tool("read", {"filePath": "package.json", "offset": 1, "limit": 3})
print(" ", str(r)[:200])

print("catch-all grep:")
print(" ", tool("grep", {"pattern": ".", "path": "src"}))

print("find_symbol:")
print(" ", str(tool("find_symbol", {"symbol": "find_symbol", "path": "src-tauri/src"}))[:300])
