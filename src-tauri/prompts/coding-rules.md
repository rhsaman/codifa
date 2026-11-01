# Coding Rules

Apply these whenever you write, modify or review code.

## 1. Structure and conventions

- Continue the project's existing pattern before inventing one; never create duplicate files or needless folders.
- Each file has a single responsibility (one reason to change). Group related files together and keep UI, business logic, data access, configuration and helpers separate — never mixed in one place.
- Reuse existing project patterns; avoid unnecessary duplication and avoid over-abstraction.
- Read the surrounding code first, then match its naming, structure and error style.
- Put new code where its responsibility lives. Before adding new logic to an existing file, check what that file already does and how long it is. If the new code is a different concern, or the file is already large, create a new file in the matching folder and wire it in with a small change to the existing one. A minimal diff means touching less EXISTING code; it never means appending a new concern to whatever file you happen to have open.
- Keep files small: start splitting around 800 lines and never grow a file past 1500. If you must touch a file that is already past that, do not make it bigger: put the new code in a new module and change the old file only to call it. Moving existing code out is a separate refactor, done only when asked.
- Tests never go inside the source file they test, in any language and whatever the file's size. Write them in a separate test file, following the project's existing test layout; if it has none, use a dedicated tests location that mirrors the source structure. Never add or extend inline test blocks in a source file.

## 2. Smallest correct change

- Make the minimal diff that solves the problem and preserve existing behavior.
- Never edit unrelated code and never reformat a file you are not changing.
- No dead code, no commented-out blocks, no leftover debugging output.
- Do not repeatedly rewrite the same code.

## 3. Never hard-code

No magic values, hard-coded paths, credentials, URLs, ports, feature flags, host or deployment settings, project-specific data, or behavior tied to one particular case. Source them from:

- the project's configuration,
- environment variables,
- existing constants or registries,
- data files,
- explicit parameters or injected dependencies.

Never put secrets or API keys in code.

## 4. Efficiency

- Stream or chunk large data instead of holding it all in memory.
- Avoid repeated computation — reuse results; prefer early exit over nested conditions.
- Avoid needless allocations, copies, loops, I/O, network calls and expensive operations.
- Choose efficient algorithms and data structures where they materially improve performance, not speculatively.

## 5. Errors and safety

- Handle errors explicitly and validate external or user input at the boundary.
- Never swallow an error silently; fail with an explicit, actionable message.
- Avoid security vulnerabilities (injection, path traversal, leaked secrets), race conditions, resource leaks and inappropriate blocking operations.
- Keep types strict; avoid unnecessary `any`, casts and disabled checks.
- Do not add a dependency unless it is clearly necessary.

## 6. Tests

- Add or update tests when a change alters behavior or logic: new functions, branches, edge cases, bug fixes.
- Prefer extending an existing test over adding a trivial new one.
- Skip tests only for purely cosmetic changes (docs, formatting) that touch no tested behavior.

## 7. Debugging protocol (when fixing a bug)

1. **Reproduce** first: run the failing test or a minimal script and read the actual error or traceback. Never guess the cause from a description alone.
2. Form a **root-cause hypothesis**, then confirm or refute it against the exact code or log lines it points to.
3. Apply the **minimal fix** at the root cause, not the symptom.
4. **Verify** by re-running the same test or script (bug gone) and the related test file (no regression). If verification fails, return to step 2 with the new evidence.
5. Never claim a fix without having run it.

## 8. Before finishing

Review the change for correctness, structure, readability, security, CPU usage, memory usage, performance and maintainability. Fix any error you introduced and leave the codebase clean.
