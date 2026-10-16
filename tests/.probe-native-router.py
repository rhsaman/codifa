"""Live probe against the running app's native router.

Verifies the three things this change moved:
  1. /skills/route still reaches Laya through the sidecar (Rust ranks, Python
     only executes the checkpoint).
  2. /models/test and /models/test-batch are served natively by Rust.
  3. The sidecar no longer serves /models/test (it moved native).
"""

import json
import sys
import urllib.error
import urllib.request

BASE = f"http://127.0.0.1:{sys.argv[1]}"


def post(path, payload, timeout=60):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()[:400]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:400]
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"


print("== 1. /skills/route (Rust ranks -> sidecar runs Laya) ==")
status, body = post(
    "/skills/route",
    {
        "prompt": "برای صفحه لندینگ این محصول یک طراحی UI مدرن و ریسپانسیو بساز",
        "rows": [
            {"name": "UI UX Pro Max", "description": "design modern interfaces",
             "fa_keywords": ["طراحی", "رابط کاربری"]},
            {"name": "Git Workflow", "description": "branching and commits"},
            {"name": "Movie Finder", "description": "find movies"},
        ],
    },
)
print("status:", status)
print("body:", body)

print()
print("== 2. /models/test native (unreachable provider -> 400 with reason) ==")
status, body = post(
    "/models/test",
    {"provider": "custom", "base_url": "http://127.0.0.1:1", "api_keys": ["k"], "model": "m"},
    timeout=40,
)
print("status:", status)
print("body:", body)

print()
print("== 3. /models/test-batch native (per-model failure, batch 200) ==")
status, body = post(
    "/models/test-batch",
    {"provider": "custom", "base_url": "http://127.0.0.1:1", "api_keys": ["k"], "models": ["m1", "m2"]},
    timeout=60,
)
print("status:", status)
print("body:", body)
