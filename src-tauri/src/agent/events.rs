use super::*;

#[derive(Debug, Clone)]
pub enum AgentEvent {
    Status { stage: String, content: String },
    Text { content: String },
    Thinking { active: bool },
    /// Emitted when `use_mcp` loads a connector, so the renderer can persist the
    /// activated set and echo it back on the next turn. Without it the model
    /// would have to ask again every turn — and the schemas would be re-inlined
    /// per turn, which is the cost this whole mechanism exists to avoid.
    McpLoaded { servers: Vec<String> },
    /// Emitted when a tool call STARTS — the frontend mints a running card.
    /// `id` is the provider tool_call id so the frontend can dedup/re-pair.
    ToolStart { id: String, name: String, args: Value },
    /// Live output tail of a RUNNING `run_terminal` call, streamed every
    /// ~500 ms from the tool's reader loop (`tools::TailSink`). UI-only: the
    /// renderer folds it into the still-running card (progress bar + live
    /// output) and the FINAL output still arrives on the `Tool` event — a
    /// dropped or replayed ToolOutput loses nothing. Not written to the trace.
    ToolOutput { id: String, tail: String },
    /// Emitted when the tool FINISHES — resolves the running card.
    ///
    /// `result` is what the MODEL sees (for `web_search` that is the distilled
    /// answer, and for `fetch_url` the raw page). `results` carries the
    /// structured rows the CARD renders — the search hits / the fetched page —
    /// because a distilled answer no longer contains the link list.
    Tool {
        id: String,
        name: String,
        args: Value,
        result: String,
        ok: bool,
        results: Option<Value>,
        /// Engine that actually served a `web_search` (`duckduckgo`, `tavily`,
        /// …) — the chat card badges it so the user can tell which provider
        /// answered, including when a fallback stepped in.
        engine: Option<String>,
    },
    /// Unified diff of an edit_file/write_file call. Emitted while the card is
    /// still "running" so the frontend folds it into the card and the Review
    /// panel can show/revert the change — without it Review always answered
    /// "No changes in this turn." (the Python sidecar used to emit this; the
    /// native agent must too).
    Diff { tool: String, path: String, diff: String },
    /// Net change of one file since the turn's FIRST edit of it: a unified diff
    /// against the turn's first snapshot (empty = a later edit undid the earlier
    /// ones). `Diff` above is only THAT call's change; the Review panel's
    /// "Last Turn" view needs this one so its +N/-M match `git diff` instead of
    /// summing every intermediate edit. A variant of its own (not a field on
    /// `Diff`) so no existing `Diff { .. }` pattern changes shape.
    TurnDiff { path: String, diff: String },
    Warn { content: String },
    /// Carries the model + provider_id that actually served this request so
    /// the frontend attributes sub-agent tokens to the SUB model, not the
    /// parent's.
    ///
    /// `sub` marks a request made by the explore sub-agent. The frontend must
    /// NOT let those replace the parent's context meter / message badge (a
    /// sub-agent request is small and isolated — it never enters the parent's
    /// context), so without the flag the meter dropped to the explore's 5-16k
    /// every time an explore ran.
    /// tokens. `cache_read` is the part of `input` the provider served from
    /// its prefix cache (DeepSeek `prompt_cache_hit_tokens`, OpenAI
    /// `prompt_tokens_details.cached_tokens`, Anthropic
    /// `cache_read_input_tokens`); `cache_write` is the part that FILLED the
    /// cache (Anthropic `cache_creation_input_tokens` — a cold call is all
    /// write). `input_tokens` is INCLUSIVE: the provider's whole billed input
    /// with the cache share inside it (see `llm::NormalizedUsage`), so the
    /// cost math (`input − read − write` at fresh-input price) is right for
    /// every provider without per-provider cases.
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        cache_write_tokens: u64,
        /// The payload carried a cache-read field at all — unknown (no field)
        /// must stay distinguishable from a real zero (the cache missed).
        cache_read_reported: bool,
        cache_write_reported: bool,
        model: String,
        provider_id: String,
        sub: bool,
        /// The size of the prompt the provider just billed, INCLUSIVE of the
        /// cache share — the SAME number the mid-turn auto-compaction trigger
        /// uses as its baseline, so the renderer's context meter and the fold
        /// agree: the ring reaches 100% exactly when compaction fires. 0 = the
        /// provider reported no usage (the renderer then keeps its own
        /// estimate).
        context_tokens: u64,
        /// The window the trigger divides `context_tokens` by — the model's real
        /// window, resolved by the backend when the renderer did not know it.
        /// 0 for sub-agent requests. The renderer prefers this over its own
        /// lookup so the meter's percentage cannot drift from the trigger's.
        context_window: u64,
        /// Characters of reasoning content (`reasoning_content`, Anthropic
        /// `thinking` deltas) this call really produced — 0 when it produced
        /// none. This is the only GROUND TRUTH that a provider+model reasons:
        /// NVIDIA NIM and most custom gateways describe no capability at all in
        /// their `/models` payload (`id`/`object`/`created`/`owned_by` only),
        /// so the renderer learns the flag from what the model demonstrably
        /// did instead of parsing the model's name.
        reasoning_chars: u64,
    },
    /// A tool event tagged with the sub-agent branch it belongs to. Serialized
    /// as the inner event plus `branch` (and `sub`). Without the tags the
    /// explore card never gets a branch id, so every call the explore makes
    /// is an orphan and the frontend promotes it to a flat top-level card
    /// ("Search Files ×48" in the chat) instead of nesting it under the card.
    /// `sub` is false for the explore/task card's own start event (it must
    /// stay a top-level card) and true for the calls made INSIDE it.
    Branch { branch: u64, sub: bool, inner: Box<AgentEvent> },
    /// Plan mode finished: the collapsed plan document (title + markdown
    /// body) — the frontend renders it as the Plan card and the docked
    /// Plan viewer tab.
    PlanCard { title: String, body: String },
    /// An `@mention`ed skill that is not in the store any more: `note` carries
    /// the warning the renderer shows (a deleted or renamed attachment would
    /// otherwise fail silently). `skills` is empty and `manual` is always true —
    /// nothing is auto-picked for the model any more, so this is the only
    /// `Skills` event left.
    Skills { skills: Vec<String>, manual: bool, note: Option<String> },
    /// Mid-turn steer messages were injected into the running turn. `ids` are
    /// the renderer's user-message ids so it can move each bubble inline (right
    /// after the tool call that carried it) and clear its `steerPending` flag.
    SteerApplied { ids: Vec<String> },
    /// The user steered while a model call was ALREADY streaming. The steer
    /// cannot be injected into that in-flight request, so the running stream is
    /// dropped and re-issued immediately with the steer appended — this is what
    /// removes the "steer waits for the turn to end" wait (it used to look
    /// exactly like a queue message). Emitted so the renderer can keep the
    /// bubble pending until `SteerApplied` confirms the injection.
    SteerInterrupt { ids: Vec<String> },
    /// Emitted when the turn is ending while steers are still sitting in the
    /// inbox — the model errored, the step budget ran out, or the user hit
    /// Stop before a step could carry them.
    ///
    /// Without this the un-consumed steers were erased by `SteerGuard::drop`
    /// and the message the user typed mid-turn simply vanished. The frontend
    /// keeps those bubbles pending and re-sends them as the next turn.
    SteerDropped { ids: Vec<String> },
    /// Auto-compaction started mid-turn — the renderer shows its loading
    /// banner until the `Compact`/`CompactFailed` event lands.
    CompactStart {},
    /// Live compaction progress (`crate::compact::CompactProgress`). Streamed
    /// while the summarizer runs so the renderer can show the phase, which
    /// attempt is running and the elapsed time instead of an anonymous spinner.
    CompactProgress {
        phase: String,
        attempt: usize,
        attempts: usize,
        model: String,
        /// Provider ROW the model is routed to, so the banner can name the
        /// provider the user configured instead of its wire kind.
        provider_id: String,
        percent: u8,
        budget_secs: u64,
        elapsed_secs: u64,
    },
    /// Auto-compaction finished: `content` is the summary, `keep` the number
    /// of trailing history entries preserved verbatim, `usage` the summarizer
    /// call's token usage (None when the provider reported none).
    Compact { content: String, keep: usize, usage: Option<Value> },
    /// Auto-compaction failed — NOTHING was dropped, the turn continues with
    /// the full history (the renderer surfaces a retry banner).
    CompactFailed { content: String },
    /// The checklist was written by `update_plan`: the renderer replaces its
    /// todo list with `items` (serialized as `kind:"plan"`). Without this event
    /// the tool persisted the file but the Todos panel stayed empty.
    Plan { items: Value, chat_id: String },
    /// The agent asked the user a question and is WAITING for the answer
    /// (POST /ask/respond). The renderer shows its ask popup. `sections`
    /// carries the multi-part form (2-4 related sub-questions in ONE card):
    /// `Value::Null` when the model used the flat question+options form.
    Ask {
        id: String,
        question: String,
        options: Value,
        sections: Value,
    },
    /// The agent is waiting for the user to allow a destructive /
    /// out-of-workspace / SSH / DESKTOP action (POST /permission/respond).
    /// `scope` says which gate asked: `confirm`, `outside`, `ssh` or
    /// `computer`. A desktop grant is per TASK — it ends with the turn and is
    /// never persisted; the composer switch is the standing willingness.
    Permission {
        id: String,
        action: String,
        /// The exact file / folder / command target the call names — what the
        /// card shows. Separate from `folder` below, which is what "Always
        /// allow" widens: the gate used to put the parent folder here, so a
        /// write to /etc/hosts was shown as /etc.
        path: String,
        reason: String,
        scope: String,
        /// The subtree a "Always allow" would register (the nearest existing
        /// parent of `path`). Empty for a request with no path. The renderer
        /// shows it so the user can see exactly what they are widening — the
        /// field the frontend already declares as `folder` in `PermissionReq`.
        folder: String,
    },
    /// A failed model call is being retried after `delay_secs`. Mirrors the
    /// renderer's self-heal `retry` event so a SUB-AGENT failure (which runs
    /// on the parent's own stream and is therefore invisible to the frontend's
    /// reconnect ladder) surfaces with the very same banner, attempt counter
    /// and delay as a main-model retry. `agent` labels WHICH model to change
    /// (e.g. "explore subagent") and `tool` names the tool that owns the retry
    /// (e.g. "explore") — the banner shows both, so the user can tell a
    /// main-agent retry from a specific tool's.
    Retry {
        attempt: usize,
        max_attempts: usize,
        delay_secs: u64,
        reason: String,
        agent: String,
        /// The tool whose call is being retried ("explore"), or empty for the
        /// main agent's own retry ladder.
        tool: String,
        model: String,
        /// The provider ROW (id) the model is routed to. The banner resolves it
        /// to the name the user configured, so it can say WHICH provider the
        /// failing model lives on — a bare model id names nothing when several
        /// providers serve the same one.
        provider_id: String,
        /// True: this is a SELF-HEAL (the agent resumes from the existing
        /// transcript), not a user-triggered restart — the renderer keeps the
        /// already-streamed text and tool cards instead of wiping them.
        reconnecting: bool,
        /// True once the sub-agent's OWN model hard-failed and the tool fell
        /// back to the MAIN chat model. The renderer renders a distinct
        /// "Sub-agent failed — using main model" banner instead of a generic
        /// retry, so the user knows WHICH model no longer needs fixing.
        fallback: bool,
    },
    /// The retry ladder was exhausted — the call is final. The renderer keeps
    /// the banner up with its Retry button instead of clearing it on `done`.
    RetryGiveup {
        attempt: usize,
        max_attempts: usize,
        reason: String,
        agent: String,
        tool: String,
        model: String,
        /// See `Retry::provider_id`.
        provider_id: String,
        /// See `Retry::fallback`.
        fallback: bool,
    },
    Done { aborted: bool },
    Error { content: String },
    /// A chat artifact was created or updated: the renderer docks a card in the
    /// transcript and can open the body in the sandboxed preview panel.
    Artifact {
        id: String,
        title: String,
        kind: String,
        content: String,
        version: u64,
        /// Supporting files of this version (backend, data, config). Empty for a
        /// plain document; the panel serves them to the sandboxed frame.
        assets: Vec<String>,
    },
    /// An UPDATE landed on a plugin/skill/connector/artifact: the renderer pins
    /// an "editing" badge above the composer so follow-up messages keep
    /// targeting the same folder (Build mode, rooted there) without the user
    /// repeating the update command. Emitted ONLY for updates — a fresh
    /// create/install announces itself once and pins nothing.
    EditTarget {
        target: String,
        action: String,
        name: String,
        path: String,
    },
}

impl AgentEvent {
    pub fn to_json(&self) -> Value {
        match self {
            AgentEvent::Status { stage, content } => {
                json!({"kind": "status", "stage": stage, "content": content})
            }
            AgentEvent::Text { content } => json!({"kind": "text", "content": content}),
            AgentEvent::Thinking { active } => json!({"kind": "thinking", "active": active}),
            AgentEvent::ToolStart { id, name, args } => json!({
                "kind": "tool", "id": id, "name": name, "tool": name, "args": args,
            }),
            AgentEvent::ToolOutput { id, tail } => json!({
                "kind": "tool_output", "id": id, "tail": tail,
            }),
            AgentEvent::Tool { id, name, args, result, ok, results, engine } => json!({
                "kind": "tool_result", "id": id, "name": name, "tool": name, "args": args,
                "result": result, "ok": ok, "results": results, "engine": engine,
            }),
            AgentEvent::Diff { tool, path, diff } => json!({
                "kind": "diff", "tool": tool, "path": path, "diff": diff,
            }),
            AgentEvent::TurnDiff { path, diff } => json!({
                "kind": "turn_diff", "path": path, "diff": diff,
            }),
            AgentEvent::Warn { content } => json!({"kind": "warn", "content": content}),
            AgentEvent::McpLoaded { servers } => json!({"kind": "mcp_loaded", "servers": servers}),
            AgentEvent::EditTarget { target, action, name, path } => json!({
                "kind": "edit_target", "target": target, "action": action,
                "name": name, "path": path,
            }),
            AgentEvent::Usage { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_read_reported, cache_write_reported, model, provider_id, sub, context_tokens, context_window, reasoning_chars } => json!({
                "kind": "usage", "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_read_tokens": cache_read_tokens,
                "cache_write_tokens": cache_write_tokens,
                "cache_read_reported": cache_read_reported,
                "cache_write_reported": cache_write_reported,
                "model": model, "provider_id": provider_id,
                "sub": sub,
                "context_tokens": context_tokens,
                "context_window": context_window,
                "reasoning_chars": reasoning_chars,
            }),
            AgentEvent::Branch { branch, sub, inner } => {
                let mut v = inner.to_json();
                v["branch"] = json!(branch);
                v["sub"] = json!(sub);
                v
            }
            // Same wire shape the renderer's self-heal reconnect emits, so
            // Chat.tsx's `retry` handler needs no special-casing for
            // sub-agents — it just sees attempt/max_attempts/delay/reason and
            // the `agent` label it renders in the banner.
            AgentEvent::Retry {
                attempt,
                max_attempts,
                delay_secs,
                reason,
                agent,
                tool,
                model,
                provider_id,
                reconnecting,
                fallback,
            } => json!({
                "kind": "retry",
                "attempt": attempt,
                "max_attempts": max_attempts,
                "delay": delay_secs,
                "reason": reason,
                "agent": agent,
                "tool": tool,
                "model": model,
                "provider_id": provider_id,
                "reconnecting": reconnecting,
                "fallback": fallback,
            }),
            AgentEvent::RetryGiveup {
                attempt,
                max_attempts,
                reason,
                agent,
                tool,
                model,
                provider_id,
                fallback,
            } => json!({
                "kind": "retry_giveup",
                "attempt": attempt,
                "max_attempts": max_attempts,
                "reason": reason,
                "agent": agent,
                "tool": tool,
                "model": model,
                "provider_id": provider_id,
                "fallback": fallback,
            }),
            AgentEvent::Done { aborted } => json!({"kind": "done", "aborted": aborted}),            AgentEvent::PlanCard { title, body } => {
                json!({"kind": "plan_card", "title": title, "body": body})
            }
            AgentEvent::Skills { skills, manual, note } => {
                let mut v = json!({"kind": "skill", "skills": skills, "manual": manual});
                if let Some(n) = note {
                    v["note"] = json!(n);
                }
                v
            }
            AgentEvent::SteerApplied { ids } => {
                json!({"kind": "steer_applied", "ids": ids})
            }
            AgentEvent::SteerInterrupt { ids } => {
                json!({"kind": "steer_interrupt", "ids": ids})
            }
            AgentEvent::SteerDropped { ids } => {
                json!({"kind": "steer_dropped", "ids": ids})
            }
            AgentEvent::CompactStart {} => json!({"kind": "compact_start"}),
            AgentEvent::CompactProgress {
                phase,
                attempt,
                attempts,
                model,
                provider_id,
                percent,
                budget_secs,
                elapsed_secs,
            } => json!({
                "kind": "compact_progress",
                "phase": phase,
                "attempt": attempt,
                "attempts": attempts,
                "model": model,
                "provider_id": provider_id,
                "percent": percent,
                "budget_secs": budget_secs,
                "elapsed_secs": elapsed_secs,
            }),
            AgentEvent::Compact { content, keep, usage } => {
                let mut v = json!({"kind": "compact", "content": content, "keep": keep});
                if let Some(u) = usage {
                    v["usage"] = u.clone();
                }
                v
            }
            AgentEvent::CompactFailed { content } => {
                json!({"kind": "compact_failed", "content": content})
            }
            AgentEvent::Plan { items, chat_id } => json!({
                "kind": "plan", "items": items, "chat_id": chat_id,
            }),
            AgentEvent::Artifact { id, title, kind, content, version, assets } => json!({
                "kind": "artifact",
                "id": id,
                "title": title,
                // The document format travels as `artifact_kind`: `kind` is
                // already the event's own discriminator.
                "artifact_kind": kind,
                "content": content,
                "version": version,
                "assets": assets,
            }),
            AgentEvent::Ask { id, question, options, sections } => json!({
                "kind": "ask", "id": id, "question": question, "options": options,
                "sections": sections,
            }),
            AgentEvent::Permission { id, action, path, reason, scope, folder } => json!({
                "kind": "permission", "id": id, "action": action, "path": path,
                "reason": reason, "scope": scope, "folder": folder,
            }),
            AgentEvent::Error { content } => json!({"kind": "error", "content": content}),
        }
    }
}

