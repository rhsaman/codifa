# Contributing to Codifa

First off, thanks for taking the time to contribute! 🎉

Codifa is an open-source, offline-first AI coding assistant. This document
explains how you can help — whether you're reporting a bug, suggesting a
feature, improving the docs or writing code.

## Table of contents

- [Code of conduct](#code-of-conduct)
- [How to report a bug](#how-to-report-a-bug)
- [How to suggest a feature](#how-to-suggest-a-feature)
- [Setting up the dev environment](#setting-up-the-dev-environment)
- [Project structure](#project-structure)
- [Running tests](#running-tests)
- [Code style](#code-style)
- [Commit conventions](#commit-conventions)
- [Submitting a pull request](#submitting-a-pull-request)

## Code of conduct

Be respectful and constructive. Harassment, hateful content or personal
attacks are not welcome. We're all here to build something useful together.

## How to report a bug

1. **Search existing issues first** — someone may have already reported it.
2. Open a new issue using the **🐛 Bug report** template and fill in every
   field: Codifa version, operating system, model provider and the steps to
   reproduce.
3. Include logs and screenshots when possible:
   - error output from the terminal when running `npm run dev`, and
   - any app logs under the data path (`~/.codifa` by default).

The more context you give, the faster the bug can be fixed.

## How to suggest a feature

1. Check existing issues and the roadmap to avoid duplicates.
2. Open a new issue using the **✨ Feature request** template.
3. Describe the **problem** you're trying to solve, not just the solution you
   have in mind — that opens up better design discussions.

## Setting up the dev environment

**Prerequisites:** Node.js ≥ 20 + npm, [Rust](https://rustup.rs/) (stable) and
the Tauri prerequisites for your OS.

```bash
npm install       # JavaScript dependencies
npm run dev       # opens the Tauri window with hot reload
```

Voice and RAG-memory notes are optional — speech uses the STT/TTS providers you
configure in **Settings → Media Providers**.

## Project structure

```
src/         React renderer — Monaco editor, chat (SSE), file explorer
src-tauri/   Rust shell — agent loop, HTTP API, tools, MCP, skills, PTY
  skills/    built-in skills shipped with the app (*.md)
tests/       frontend tests + the runner
scripts/     build helpers
.github/     CI workflow + issue/PR templates
```

## Running tests

```bash
npm run typecheck      # TypeScript type checking
npm run test:frontend  # frontend tests (tests/run-frontend.sh)
cd src-tauri && cargo test   # Rust tests
```

Please make sure these pass before opening a pull request.

## Code style

- **TypeScript:** strict mode is enabled; follow the existing patterns in
  `src/`.
- **Rust:** run `cargo fmt` and `cargo clippy` in `src-tauri/`. Comments and
docstrings are English.
- Keep changes focused and readable — prefer small, reviewable pull requests
  over one giant change.

## Commit conventions

Use clear, imperative commit messages with a conventional prefix:

```
feat: add /redo slash command
fix: compact history before context runs out
docs: clarify Gatekeeper workaround
refactor: extract provider registry
test: cover small-context compaction
```

## Submitting a pull request

1. Fork the repo and create a branch:
   `git checkout -b fix/your-fix`.
2. Make your changes and add tests where appropriate.
3. Run the checks above (typecheck + frontend + Rust tests).
4. If user-facing behavior changed, update `README.md` — it's bilingual, so
   update **both** the English and Persian sections.
5. Open a pull request against `main` and fill in the PR template.

If you're unsure about a bigger change, open an issue first to discuss it —
that usually saves everyone time.