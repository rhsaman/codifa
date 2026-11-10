# Plan — Sub-agent tab, "Sub-agent" model row, custom subagents, default browser & computer subagents

**Status:** PLANNED (not yet implemented). Every line reference below was verified against the current tree.

---

## Confirmed decisions (from the user)

| Item | Choice |
|---|---|
| Model for every sub-agent (builtin `explore`, plugin agents, custom agents, and the two defaults) | **ONE shared** model = Settings → Tools → **"Sub-agent"** row (the existing `explore` slot, renamed). No per-agent model override. |
| Where custom subagents live | **`settings.json`** (`customSubagents[]`). No files on disk. |
| Which model a custom subagent uses | `settings → Tools → Sub-agent` (the `explore` slot already drives all delegation via `resolve_subagent_target`). |
| Browser / Computer subagents | **Gated** behind the parent turn's Browser / Computer Use switches. If the parent switch is off, the subagent degrades to research-only. |

Codebase invariant kept: `src-tauri/src/subagents.rs:8-11` states a plugin profile may **NOT** carry its own model — one Tools slot controls what every sub-agent costs. Custom agents follow the same rule.

---

## Current architecture (verified line references)

| Concern | Where |
|---|---|
| Tools tab slot row | `src/components/SettingsModal.tsx:2469-2478` (`agent="explore"`, `label="Explore"`) |
| Model resolution for all subagents | `src-tauri/src/agent/subagent.rs:1355+` → `resolve_subagent_target` → `src-tauri/src/backend_light/slots.rs` reading `subagent_models["explore"]` |
| Delegation tool names | `DELEGATION_PREFIX = "agent__"` (`subagent.rs:122`), `delegation_tool_name` (`:126`) |
| Delegation schemas advertised to the main agent | `src-tauri/src/agent/schemas.rs:580 delegation_schemas(root)` — maps `enabled_plugin_agents(root)` → `agent__<slug>` |
| Plugin agent lookup | `src-tauri/src/plugins::find_plugin_agent` (used at `subagent.rs:1358`) |
| Subagent child request build | `subagent.rs:1470-1515`; profile system prompt at `:1476`, tool narrowing at `:1487`, hard `allow_computer:false` `:1507`, `allow_browser:false` `:1509` |
| Turn-loop schema selection | `src-tauri/src/agent/turn.rs:888-895` (`mode=="subagent"` → `research_schemas()` + `retain_subagent_tools`) |
| Computer tool binding | `turn.rs:1042-1049` — `if req.allow_computer && req.mode != "subagent"` push `computer::schema()` |
| Browser tool binding | `turn.rs` extends with `browser_driver::actions::entries()` when `req.allow_browser` (schema fn `src-tauri/src/browser_driver/actions.rs:176`) |
| Request fields | `src-tauri/src/agent/types.rs:86 allow_computer`, `:101 allow_browser`, `:190 subagent_tools` |
| Caps / narrowing | `types.rs:258 caps_for_mode`, `:399 retain_subagent_tools` (only REMOVES) |
| Settings body (`subagent_models`) | `src-tauri/src/appstate.rs:690`, populated via `string_map(&settings, "subagentModels")` (~`:805`) |
| Store | `src/lib/store.ts` — `setSubagentModel` `:3564`, `setToolFallbacks` `~:3477`, hydration `~:2834`, `writeSettingsNow` `:586-587` |
| Settings type | `src/types/settings.ts` (185 lines), import line 4; insert near `toolFallbacks` (~`:119`) |
| Provider types | `src/types/providers.ts` — `ToolFallback` at `:143-146` |

---

## Part A — "Sub-agent" row rename + Sub-agents tab

### A1. `src/types/providers.ts` — new type
```ts
/** A user-created sub-agent (Settings → Sub-agents). Stored in settings.json —
 *  no files. Carries ONLY a role prompt + optional tool narrowing + a kind; it
 *  runs on the Tools → "Sub-agent" model row like every other sub-agent. */
export interface CustomSubagent {
  id: string          // stable id → delegation tool name `agent__<id>`
  name: string        // display name the model sees
  description?: string
  prompt: string      // required to be delegable
  tools?: string[]    // empty = full set for its kind; can only NARROW
  kind?: 'research' | 'browser' | 'computer'   // default 'research'
}
```

### A2. `src/types/settings.ts`
- Import `CustomSubagent` on line 4 (in the `./providers.ts` import list).
- After `toolFallbacks?:` add:
```ts
/** User-created sub-agents (Settings → Sub-agents). Advertised as delegation
 *  tools alongside plugin agents; all run on the Tools → "Sub-agent" model. */
customSubagents?: CustomSubagent[]
```

### A3. `src/lib/store.ts`
- **Interface** (next to `toolFallbacks`, ~`1241`): `customSubagents: CustomSubagent[]`, `setCustomSubagents: (rows: CustomSubagent[]) => void`.
- **Default** (~`2296`): `customSubagents: []`.
- **`normalizeCustomSubagents`** helper next to `normalizeToolFallbacks` (`:187`): drop rows with empty `id`/`prompt`, coerce `kind` to the union, de-dupe ids.
- **Hydration** (~`2834`): `customSubagents: normalizeCustomSubagents((raw as Record<string, unknown>).customSubagents)` **with first-run seeding** (see B1).
- **Action** (near `setToolFallbacks`, `~:3477`): `setCustomSubagents: (rows) => { set({ customSubagents: rows }); get().persist() }`.
- **Persistence**: add `customSubagents` to **both** the destructure and the payload in `writeSettingsNow` (`:586-587`) so it round-trips.

### A4. `src/components/SettingsModal.tsx`
- Line `2471`: `label="Explore"` → **`label="Sub-agent"`**; rewrite `desc` to state that **builtin, plugin AND custom** sub-agents all run on this one row.
- Line `228` (tab union) + `1076` (`TABS`): add `'subagents'` with a Persian/English label matching the file's style.
- New `<SubagentsTab/>` (new file `src/components/settings/subagentsTab.tsx`):
  - **Plugin sub-agents**: `listPluginAgents()` (`src/lib/plugins.ts:748`) — read-only rows: name, description, bundle tag, "runs on Sub-agent model".
  - **Custom sub-agents**: CRUD from `store.customSubagents` — Add / Edit / Delete; fields: name, description, prompt (textarea), kind (select research/browser/computer), tools (checkbox list, empty = kind default). Save → `setCustomSubagents`.
  - Reuse `ToolSlotRow` markup/styling from `src/components/settings/rows.tsx:198`.

---

## Part B — Two default subagents (Browser + Computer)

### B1. Seeds (in `store.ts` hydration, only when `customSubagents` is `undefined`)

| id | name | kind | tools | prompt (short) |
|---|---|---|---|---|
| `browser` | Browser Navigator | `browser` | browser action names (navigate/snapshot/click/type/… from `browser_driver::actions::ACTIONS`) | Drive the in-app browser: open pages from the task, snapshot before every action, click/type/fill, verify the result by re-snapshotting, report what the page now shows. |
| `computer` | Desktop Operator | `computer` | `["computer"]` | Do the task by looking at the screen: take a screenshot, move/click/drag by coordinates, type, press keys, scroll; screenshot after each action to confirm the outcome. |

Both are normal custom agents — **editable and deletable**. A deleted seed stays deleted (guard: seed only when the field is `undefined`, never re-add).

### B2. Rust — `src-tauri/src/agent/types.rs`
- `AgentRequest` near `:72`: `#[serde(default)] pub custom_subagents: Vec<Value>`.
- `#[serde(default)] pub subagent_kind: Option<String>` — set on the CHILD snapshot only.
- In `subagent_snapshot()` (`:495-567`): clone `custom_subagents`; carry `subagent_kind: self.subagent_kind.clone()`.

### B3. `src-tauri/src/appstate.rs`
- Beside `subagent_models` (`:690`): `#[serde(default)] pub custom_subagents: Vec<Value>`.
- Populate from settings (`settings.get("customSubagents")`, default `[]`) and thread it into the built `AgentRequest`.

### B4. `src-tauri/src/agent/schemas.rs` — `delegation_schemas()` (`:580`)
- After the plugin-agent map, map `parent custom_subagents` into the SAME `agent__<id>` tool shape (reuse `delegation_tool_name`), skipping empty `id`/`prompt`.
- Description text (`:602`): "Explore model row" → **"Sub-agent model row"**, and append the kind hint for browser/computer profiles.
- Requires passing the custom list in: signature becomes `delegation_schemas(root, &req.custom_subagents)` (call site `turn.rs:906`).

### B5. `src-tauri/src/agent/subagent.rs`
- `:1355`: `explore` → `None`; else try `find_plugin_agent`; if `None`, look up the custom profile in `parent.custom_subagents` by id (strip `agent__`).
- Resolve `kind` from the profile `kind` field (`"research"` default).
- Child request (`:1470-1515`):
  - `allow_browser: parent.allow_browser && kind == "browser"` (replaces the hard `false` at `:1509`)
  - `allow_computer: parent.allow_computer && kind == "computer"` (replaces `:1507`)
  - `allow_create: false` (unchanged)
  - `subagent_kind: Some(kind)`
- Update the comment block `:1350-1354` ("`explore` slot" → "**Sub-agent** row"); the invariant stays.

### B6. `src-tauri/src/agent/turn.rs`
- `:888-895`: for `mode=="subagent"`, start from `research_schemas()`; then
  - if `req.subagent_kind == Some("browser")` → extend with `crate::browser_driver::actions::entries()` schemas;
  - if `req.subagent_kind == Some("computer")` → push `crate::computer::schema()` when not already present;
  - finally `retain_subagent_tools(&mut schemas, &req.subagent_tools)` (narrowing still only removes).
- `:1042`: the computer-binding guard `req.mode != "subagent"` must become `(req.mode != "subagent" || req.subagent_kind == Some("computer"))` so a computer-kind sub-agent gets the tool — while a research sub-agent still can't.
- Browser entries must be bound under the same gate so a browser sub-agent that was NOT granted the parent switch carries no browser tool.

---

## Verification

1. `npx tsc --noEmit` — Part A TS files.
2. `cargo test -p codifa agent` in `src-tauri/`, adding cases:
   - browser kind sets `allow_browser` **only** when the parent switch is on;
   - computer kind binds `computer` **only** when the parent switch is on;
   - a research profile stays read-only (no browser/computer schema);
   - a custom profile is advertised as `agent__<id>` and resolves at run time.
3. Store round-trip: `customSubagents` survives `persist()` (write → hydrate → equal).

---

## Order of work

1. A1–A3 — types + store (+ seed helpers).
2. A4 — rename the row, add the tab UI.
3. B2–B6 — Rust plumbing (types → appstate → schemas → subagent → turn).
4. B1 — wire the seeds to the final shape.
5. Tests + build (typecheck + cargo test).

---

## Safety notes

- The child request is **never** granted a switch its parent lacks: `allow_browser`/`allow_computer` on the child are `parent.AND.kind`. An off switch stays a hard off.
- `caps_for_mode` (`types.rs:258`) is untouched: subagents keep `write_files=false`, so a browser/computer sub-agent still cannot write the workspace.
- `retain_subagent_tools` still only removes — a profile naming `write_file` gains nothing.
- The model invariant (`subagents.rs:8-11`) is untouched: no profile, plugin or custom, carries a model.
