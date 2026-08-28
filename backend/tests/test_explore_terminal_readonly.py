"""Unit test: the explore sub-agent's run_terminal is read-only.

The explore agent is allowed to run bash only for read-only inspection
(opencode's explore agent is bash-read-only). `_is_terminal_write` is the
heuristic used to reject any command that would mutate the filesystem or
system state before it reaches the shell.

Guards:
1. Read-only inspection commands (ls, cat, grep, find, git log/diff/status,
   git branch/tag list, redirects to /dev/null, fd-to-fd redirects) -> False.
2. Mutating commands (rm, mv, cp, touch, chmod, kill, docker rm, npm install,
   python/node, git commit/push/checkout/branch -d, file writes via >) -> True.
"""

import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
for _p in (_THIS, os.path.dirname(_THIS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from tools import _is_terminal_write

_READ_ONLY = [
    "ls -la",
    "git log --oneline",
    "git diff",
    "git status",
    "cat a.py | grep foo",
    "find . -name \"*.py\"",
    "cd src && ls",
    "cat file > /dev/null",
    "ls > /dev/null 2>&1",
    "grep -r foo .",
    "wc -l file",
    "head -n 5 file",
    "git branch",
    "git tag",
    "git show HEAD",
]

_WRITE = [
    "rm -rf x",
    "mv a b",
    "cp a b",
    "touch new",
    "chmod +x script",
    "kill 1234",
    "docker rm c",
    "npm install",
    "pip install requests",
    "python -c \"open('x').write('y')\"",
    "node -e \"require('fs').writeFileSync('x','y')\"",
    "echo hi > out.txt",
    "cat a > b",
    "tee out.txt < file",
    "git commit -m x",
    "git push",
    "git pull",
    "git fetch",
    "git checkout main",
    "git branch -d old",
    "git tag -d v1",
    "git clean -fd",
]


def main():
    for cmd in _READ_ONLY:
        assert _is_terminal_write(cmd) is False, f"expected read-only: {cmd!r}"
    for cmd in _WRITE:
        assert _is_terminal_write(cmd) is True, f"expected write: {cmd!r}"
    print(f"  {len(_READ_ONLY)} read-only + {len(_WRITE)} write cases verified")
    print("EXPLORE-TERMINAL-READONLY TEST PASSED")


if __name__ == "__main__":
    main()
