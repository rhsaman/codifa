---
name: git-workflow
description: Follow a clean, safe git workflow: status, branch, staged commits, push.
---

# git-workflow

When doing git work:
1. Always run `git status` first; review the diff before staging.
2. Work on a descriptive feature branch (git checkout -b <feature>).
3. Stage only intended files (git add <paths>), never secrets or build artifacts.
4. Commit with a concise message in the repo's style; keep changes focused.
5. Pull/merge recent main before pushing to avoid conflicts; push and open a PR when asked.
