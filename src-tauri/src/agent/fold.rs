use super::*;

/// Compact the explore sub-agent's message list independently of the main
/// agent's history (user request: explore context/autocompact must be
/// separate). Mirrors compact.rs but with a smaller budget: the sub-agent
/// only needs its recent tool results + the report it is building.
/// Rough token estimate for a slice of wire messages (~4 chars per token, the
/// same heuristic compact.rs uses). Only `content` is measured: it is the only
/// field that grows with tool output, which is what overflows the window.
///
/// This is a HISTORY-only measure — it deliberately omits the system prompt and
/// the tool schemas (both fixed per-request costs that do not grow with the
/// conversation). Use `estimate_prompt_tokens` when the question is "how full is
/// the context window", and this when the question is "has the history grown
/// enough to be worth folding" (the in-turn elision trigger, which only cares
/// about tool output).
pub(super) fn estimate_wire_tokens(messages: &[Value]) -> usize {
    messages.iter().map(estimate_message_tokens).sum()
}

/// Wire tokens one message costs, counting EVERYTHING the provider bills.
///
/// `content` alone is not the cost. Traced on a 38-round build turn, the wire
/// was billed at 89_201 tokens from the first step while the sum of every
/// `content` on it was ~29K: an `assistant` message also carries
/// `tool_calls[].function.arguments`, and for `edit_file` that is the WHOLE
/// `old_string` + `new_string` body — 44_784 chars measured over one turn, none
/// of it visible to a `content`-only reader. The old estimate therefore reported
/// a wire that was less than a third of the real one, which is why the fold
/// trigger believed a 76K-token history was a 29K one and the fold's own
/// `before_tokens` stayed flat at 76-88K while the provider billed 89-113K.
pub(super) fn estimate_message_tokens(m: &Value) -> usize {
    let mut chars = m["content"].as_str().map(str::len).unwrap_or(0);
    if let Some(calls) = m.get("tool_calls").and_then(|t| t.as_array()) {
        for c in calls {
            // The name is a handful of bytes; the arguments are the payload.
            chars += c["function"]["name"].as_str().map(str::len).unwrap_or(0);
            chars += c["function"]["arguments"].as_str().map(str::len).unwrap_or(0);
        }
    }
    chars.div_ceil(4)
}

/// The prompt size the auto-compaction trigger compares against the threshold.
///
/// `provider` is the prompt the provider billed for the round-trip that
/// described `messages[..upto]` (0 = none reported yet). Everything the turn has
/// appended since then is estimated locally, so the number follows the REAL
/// prompt instead of a serde-JSON character count that also bills inline base64
/// images as text — the old `max(provider, local_estimate)` therefore folded the
/// context far below the user's threshold as soon as a screenshot was attached.
///
/// The provider's number already contains the fixed per-request cost (system
/// prompt + tool schemas), so the delta must NOT add it a second time: it
/// measures the appended `content` only. Before the first usage of a turn there
/// is nothing to anchor to, so the full local estimate stands alone.
pub(super) fn measured_prompt_tokens(
    messages: &[Value],
    tools_chars: usize,
    upto: usize,
    provider: usize,
) -> usize {
    if provider == 0 || upto == 0 || upto > messages.len() {
        return estimate_prompt_tokens(messages, tools_chars);
    }
    provider + estimate_wire_tokens(&messages[upto..])
}

/// Estimate the FULL prompt the next request will carry, the way a provider
/// bills it: the system prompt (`messages[0]`), the whole wire history
/// (including per-message overhead and tool-call arguments) and the serialized
/// tool schemas. `estimate_wire_tokens` alone misses the fixed overhead — on a
/// long turn that made the mid-turn compaction trigger plateau below the real
/// prompt size, so it never fired even when the context meter was well past the
/// threshold. This is only the FALLBACK for the first model call of a turn and
/// for providers that report no usage; the trigger prefers the provider's own
/// `prompt_tokens` (ground truth) once a round-trip has happened.
pub(super) fn estimate_prompt_tokens(messages: &[Value], tools_chars: usize) -> usize {
    // Whole serialized prompt at ~4 chars/token. Counting the raw JSON (not just
    // `content`) folds in the per-message envelope and the tool-call arguments
    // for free, and is safe to overcount slightly: overcounting only makes the
    // fold happen a touch earlier, which is the safe direction.
    //
    // Inline base64 images are the exception, and they are why this estimate can
    // no longer drive the trigger on its own: one attached screenshot is
    // megabytes of base64 that the model does NOT receive as text (it goes over
    // the wire as image blocks and is billed by area/patch, orders of magnitude
    // below its character count). Counting it as text made this estimate report
    // millions of "tokens" and fold the context far below the user's threshold.
    // `image_data_chars` subtracts what the serialized JSON spends on images.
    let wire_chars: usize = serde_json::to_string(messages)
        .map(|s| s.chars().count())
        .unwrap_or(0);
    wire_chars
        .saturating_sub(image_data_chars(messages))
        .saturating_add(tools_chars)
        .div_ceil(4)
}

/// Rough token cost of the image blocks inside `messages`, for a prompt the
/// model receives as images rather than as text.
///
/// Every image block carries a data URL. An image is billed by area and
/// resolution (a screenshot is ~1-2k tokens), roughly proportional to its
/// COMPRESSED byte size — never to the base64 CHARACTER count (which is ~4/3 of
/// the bytes, and which the caller charges at 4 chars/token, i.e. ~
/// bytes/3 tokens: hundreds of times the real cost). Returning the EXCESS the
/// serialized JSON is charged for such blocks keeps the number right to within a
/// factor of ~2, which is all the threshold comparison needs.
///
/// The excess is expressed in CHARACTERS, because that is the unit
/// `estimate_prompt_tokens` subtracts in — returning tokens here made a 3 MB
/// screenshot still bill ~563k tokens instead of ~2k (the subtraction removed
/// one unit instead of four per real token), which folded the context far below
/// the user's threshold.
pub(super) const IMAGE_CHARS_PER_TOKEN: usize = 1500;

pub(super) fn image_data_chars(messages: &[Value]) -> usize {
    fn json_chars(v: &Value) -> usize {
        serde_json::to_string(v)
            .map(|s| s.chars().count())
            .unwrap_or(0)
    }
    fn walk(value: &Value, total: &mut usize) {
        match value {
            Value::Array(items) => {
                for item in items {
                    walk(item, total);
                }
            }
            Value::Object(map) => {
                for item in map.values() {
                    match item.as_str() {
                        Some(s) if s.starts_with("data:image") => {
                            // What the estimator will charge for this block …
                            let charged_chars = json_chars(item);
                            // … versus what the model really bills: ~1 image token
                            // per IMAGE_CHARS_PER_TOKEN characters of the data URL,
                            // converted back to characters (the caller divides by 4).
                            let real_tokens = s
                                .chars()
                                .count()
                                .div_ceil(IMAGE_CHARS_PER_TOKEN)
                                .max(200);
                            *total += charged_chars.saturating_sub(real_tokens * 4);
                        }
                        _ => walk(item, total),
                    }
                }
            }
            _ => {}
        }
    }
    let mut total = 0;
    for msg in messages {
        walk(msg, &mut total);
    }
    total
}

/// In-turn elision of stale tool results (main agent only): the main agent's
/// wire history grows by EVERY tool result ever produced in the turn and is
/// re-sent in full on every round-trip (traces show in:out ratios of 23-47:1
/// and 72% of input tokens landing on the main agent). Compaction only fires
/// at 80% of the context window — far too late for cost — so old results ride
/// along at full size (16K per read, 40K per explore report) forever.
///
/// This fold keeps the last `keep_rounds` rounds untouched and shrinks OLDER
/// `tool` messages to a per-result budget: an `explore` report to
/// `explore_budget` (the report is the caller's view of that research), any
/// other tool result to `result_budget` (a targeted re-read is one cheap call).
/// A marker tells the model the tail was dropped and how to get it back — it is
/// a pointer, not silent data loss.
///
/// Idempotent by construction: a stub already carries `MAIN_FOLD_MARKER`, and
/// its content length is under every budget, so re-folding is a no-op. Only
/// `tool` messages are touched — assistant/user messages stay verbatim, and a
/// `tool` message can never be detached from its assistant call (the message
/// list keeps its shape, unlike fold_prefix_len's rebuild).
///
/// `keep_rounds` is how many NEWEST tool rounds are left untouched, and the two
/// budgets are the per-result char caps for an `explore` report and for any
/// other tool result. Both call sites pass 2 kept rounds; they differ only in
/// budgets and trigger thresholds.
/// Returns `(removed_chars, folded_messages)`.
///
/// The numbers exist so the caller can RECORD what the fold actually did. Until
/// now a fold left no trace at all, and every attempt to price it had to infer
/// "a fold happened here" from the prompt shrinking between two calls — which
/// cannot tell a fold from compaction, and cannot measure the one thing that
/// matters: the prefix-cache re-bill it causes versus the per-call saving it
/// earns on the calls that follow. With the two numbers in the trace the
/// trade-off is measured instead of modelled.
pub(super) fn fold_with(
    messages: &mut [Value],
    seen: &mut std::collections::HashSet<String>,
    keep_rounds: usize,
    explore_budget: usize,
    result_budget: usize,
    min_result_chars: usize,
) -> (usize, usize) {
    // A "round" is one `assistant` message carrying tool_calls, together with
    // the `tool` results that follow it. The boundary is the FIRST of the last
    // MAIN_FOLD_KEEP_ROUNDS rounds: everything from there on stays untouched
    // (the model is actively reasoning over those results).
    let rounds: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| {
            m["role"] == "assistant"
                && m.get("tool_calls")
                    .and_then(|t| t.as_array())
                    .is_some_and(|a| !a.is_empty())
        })
        .map(|(i, _)| i)
        .collect();
    if rounds.len() <= keep_rounds {
        return (0, 0);
    }
    let cut = rounds[rounds.len() - keep_rounds];
    // Name + raw args per tool_call id: the `tool` message carries only the id,
    // so both are recovered from the assistant call that produced it. Owned
    // strings — the map must not borrow `messages` while it is mutated below
    // (that kept the immutable borrow alive into `iter_mut` and the borrow
    // checker rejected it outright, E0502: the crate did not compile).
    let mut call_meta: std::collections::HashMap<String, (String, String)> =
        std::collections::HashMap::new();
    for m in messages[..cut].iter() {
        if m["role"] != "assistant" { continue; }
        if let Some(calls) = m.get("tool_calls").and_then(|t| t.as_array()) {
            for c in calls {
                if let (Some(id), Some(name)) = (
                    c["id"].as_str(),
                    c["function"]["name"].as_str(),
                ) {
                    let args = c["function"]["arguments"].as_str().unwrap_or("{}");
                    call_meta.insert(id.to_string(), (name.to_string(), args.to_string()));
                }
            }
        }
    }
    // Every `tool` result BEFORE the boundary is stale — it is at least
    // MAIN_FOLD_KEEP_ROUNDS rounds old. (The results of the kept rounds are
    // fresh and untouched; so is everything after them, including the newest
    // user steer.)
    let mut removed_chars = 0usize;
    let mut folded = 0usize;
    for m in messages[..cut].iter_mut() {
        if m["role"] != "tool" { continue; }
        // Skip already-folded stubs (idempotence).
        if m["content"].as_str().is_some_and(|c| c.contains(MAIN_FOLD_MARKER)) { continue; }
        let meta = m["tool_call_id"].as_str().and_then(|id| call_meta.get(id));
        let is_explore = meta.is_some_and(|(name, _)| name == "explore");
        let budget = if is_explore { explore_budget } else { result_budget };
        // `min_result_chars` is the ELIGIBILITY floor, separate from the head
        // size: the oversized pass wants "fold only when the result alone is
        // worth a fold" (>= 8K chars) while still leaving the SHORT stub head,
        // and the gated passes pass their own budget here so nothing changes.
        let eligible_below = if is_explore {
            budget
        } else {
            budget.max(min_result_chars)
        };
        let Some(content) = m["content"].as_str().map(String::from) else { continue };
        let old_chars = content.chars().count();
        if old_chars <= eligible_below { continue; }
        // Char-boundary-safe truncation: byte slicing panics (and with
        // panic=abort kills the app) on a multi-byte Persian character.
        let head: String = content.chars().take(budget).collect();
        let new_content = format!("{head}\n{MAIN_FOLD_MARKER}");
        let new_chars = new_content.chars().count();
        removed_chars += old_chars.saturating_sub(new_chars);
        folded += 1;
        m["content"] = json!(new_content);
        // The marker tells the model to re-run the tool — so the repeat-guard
        // must FORGET this lookup. Otherwise the re-run is answered with a
        // pointer to a body that no longer exists and the data is unreachable
        // for the rest of the turn (silent quality loss).
        if let Some((name, raw_args)) = meta {
            if let Ok(args) = serde_json::from_str::<Value>(raw_args) {
                if let Some(k) = lookup_key(name, &args) {
                    seen.remove(&k);
                }
                // A folded `read` body is GONE from the wire, so the coverage
                // its windows granted must go with it — otherwise the model's
                // re-run is answered with a pointer to text it can no longer
                // see (the same silent loss the exact key already guards).
                if name == "read" {
                    for (file, _, _) in crate::tools::read_windows_of(&args) {
                        let needle = format!("{READ_COVERAGE_PREFIX}{file}|");
                        seen.retain(|k| !k.starts_with(&needle));
                    }
                }
            }
        }
    }
    // The assistant side is the OTHER half of the wire, and it was never folded.
    // A round's `assistant` message carries its calls' FULL arguments, so every
    // stale `edit_file` keeps its entire `old_string` + `new_string` — the file
    // body it rewrote — on the wire forever. Traced on a 38-round build turn:
    // 44_784 chars of `edit_file` arguments against 131_747 chars of ALL tool
    // results, and the tool-results pass alone left `before_tokens` climbing
    // 76K -> 88K while the provider billed 89K -> 113K. The `tool` result has
    // already been folded to a pointer by the loop above, so keeping the args
    // buys nothing: the model can re-read the file (the marker tells it to).
    //
    // Only the ARGUMENTS are trimmed, never the call itself: dropping the call
    // would orphan its `tool` message and break the provider's
    // assistant/tool pairing (a 400, not a saving).
    for m in messages[..cut].iter_mut() {
        if m["role"] != "assistant" { continue; }
        let Some(calls) = m.get_mut("tool_calls").and_then(|t| t.as_array_mut()) else {
            continue;
        };
        for c in calls.iter_mut() {
            let Some(f) = c.get_mut("function") else { continue };
            if f["name"].as_str() != Some("edit_file") { continue; }
            let Some(raw) = f["arguments"].as_str() else { continue };
            let old_chars = raw.chars().count();
            if old_chars <= result_budget { continue; }
            // `arguments` is STRUCTURED: the provider re-parses it on every
            // subsequent round-trip, so a head-truncated string is not a cheap
            // saving — it is a malformed JSON fragment that can 400 the whole
            // turn. Blank only the bulky string fields instead, keeping the
            // object parseable and the call's IDENTITY (`path`, so the model
            // still knows WHICH file an earlier round touched) intact.
            let Ok(mut parsed) = serde_json::from_str::<Value>(raw) else { continue };
            let mut shrunk = false;
            for field in ["old_string", "new_string"] {
                let Some(body) = parsed[field].as_str() else { continue };
                if body.chars().count() <= result_budget { continue; }
                let head: String = body.chars().take(result_budget).collect();
                parsed[field] = json!(format!("{head}\n{MAIN_FOLD_MARKER}"));
                shrunk = true;
            }
            if !shrunk { continue; }
            let new_args = parsed.to_string();
            removed_chars += old_chars.saturating_sub(new_args.chars().count());
            folded += 1;
            f["arguments"] = json!(new_args);
        }
    }
    (removed_chars, folded)
}

/// Main-agent entry point: two kept rounds, the main budgets and the main
/// trigger threshold.
pub(super) fn fold_stale_tool_results(
    messages: &mut [Value],
    seen: &mut std::collections::HashSet<String>,
) -> (usize, usize) {
    fold_with(
        messages,
        seen,
        MAIN_FOLD_KEEP_ROUNDS,
        MAIN_FOLD_EXPLORE_CHARS,
        MAIN_FOLD_RESULT_CHARS,
        MAIN_FOLD_RESULT_CHARS,
    )
}

/// Sub-agent entry point: an explore run re-sends its whole accumulated history
/// on EVERY one of its rounds, and nothing folded it mid-loop —
/// compact_subagent_messages runs once, before the loop. Its own older reads and
/// greps are therefore the bulk of its input. Unlike the main agent, the
/// sub-agent owns read/grep, so the pointer the marker leaves behind is always
/// resolvable with one cheap targeted call.
pub(super) fn fold_subagent_tool_results(
    messages: &mut [Value],
    seen: &mut std::collections::HashSet<String>,
) -> (usize, usize) {
    fold_with(
        messages,
        seen,
        SUB_FOLD_KEEP_ROUNDS,
        SUB_FOLD_RESULT_CHARS,
        SUB_FOLD_RESULT_CHARS,
        SUB_FOLD_RESULT_CHARS,
    )
}

/// A single result this big is worth a fold ON ITS OWN: traced 6 Nov, `read`
/// results carried 56-75% of every tool-result character sent to the model
/// (n=344, median 3.8K, p90 ≈16K chars ≈ 4K tokens), and on a turn whose whole
/// prompt stays under `MAIN_FOLD_MIN_TOKENS` those giants rode EVERY following
/// round un-folded. This pass ignores the turn gate: any stale non-explore
/// result above `FOLD_OVERSIZED_RESULT_CHARS` is foldable, with the SHORT main
/// stub head — the application itself still goes through the same probe and
/// removal floor as every other fold (see the call sites).
pub(super) fn fold_oversized_search_results(
    messages: &mut [Value],
    seen: &mut std::collections::HashSet<String>,
    keep_rounds: usize,
) -> (usize, usize) {
    // `usize::MAX` for the explore budget keeps SUB-AGENT REPORTS out of this
    // pass: a report is the parent's view of the research and the gated fold
    // already prices it above the turn gate — eliding it early on a small turn
    // would trade the one artifact the caller works from for bytes.
    fold_with(
        messages,
        seen,
        keep_rounds,
        usize::MAX,
        MAIN_FOLD_RESULT_CHARS,
        FOLD_OVERSIZED_RESULT_CHARS,
    )
}

/// Length of the prefix of `history` (messages WITHOUT the system prompt) that a
/// mid-turn compaction may fold into a summary — 0 when nothing is safely
/// foldable.
pub(super) fn fold_prefix_len(history: &[Value]) -> usize {
    let mut cut = history.len();
    while cut > 0 && history[cut - 1]["role"].as_str() == Some("user") {
        cut -= 1;
    }
    while cut > 0 && history[cut - 1]["role"].as_str() != Some("assistant") {
        cut -= 1;
    }
    if cut == 0 {
        0
    } else {
        cut - 1
    }
}

pub(super) fn compact_subagent_messages(messages: &mut Vec<Value>, ctx: usize) {
    // Rough token estimate: ~4 chars per token (same heuristic as compact.rs).
    let est = |m: &Value| -> usize { m["content"].as_str().map(|c| c.len().div_ceil(4)).unwrap_or(0) };
    let total: usize = messages.iter().map(&est).sum();
    // Keep ~60% of the context window usable; compact when over.
    let budget = ctx.saturating_sub(2048).max(4096) * 60 / 100;
    if total <= budget {
        return;
    }
    // Keep the system prompt (index 0) and the last few messages verbatim;
    // summarize the middle into one user message.
    let mut start = messages.len() - 4.min(messages.len().saturating_sub(1));
    // Never orphan a tool message: if the tail would START with a `tool`
    // reply whose assistant tool_calls got compacted away, extend the tail
    // back until it starts with a non-tool message (providers reject orphans).
    while start > 1 && messages[start]["role"].as_str() == Some("tool") {
        start -= 1;
    }
    let head = messages[0].clone();
    let mid: Vec<Value> = messages[1..start].to_vec();
    let tail: Vec<Value> = messages[start..].to_vec();
    let mut summary = String::from("[Earlier research compacted] Key findings so far:\n");
    for m in &mid {
        let c = m["content"].as_str().unwrap_or_default();
        if c.len() > 400 {
            // Char-boundary-safe cut — byte slicing mid-char panics on Persian.
            let mut end = 400;
            while end > 0 && !c.is_char_boundary(end) {
                end -= 1;
            }
            summary.push_str(&format!("- {}…\n", &c[..end]));
        } else if !c.is_empty() {
            summary.push_str(&format!("- {c}\n"));
        }
    }
    *messages = vec![
        head,
        json!({"role": "user", "content": summary}),
    ];
    messages.extend(tail);
}

/// Shared cancel flag for spawned sub-agent tasks: flipping the parent's
/// flag (Stop button) aborts every concurrent explore too.
pub(super) type CancelFlag = std::sync::Arc<std::sync::atomic::AtomicBool>;

/// True when a string contains a redirection whose TARGET is a real file.
///
/// `du -sh ~ 2>/dev/null` writes to a device node: nothing in the workspace
/// changes, so it is a READ. Treating every `>` as a write (the first version of
/// this gate) refused the very inspection a read-only mode exists for — the
/// user hit exactly that. Numeric prefixes (`2>`) need no special case: the
/// scan starts right after the operator, so the token that follows is the
/// target either way.
pub(super) fn redirects_to_a_file(s: &str) -> bool {
    let mut rest = s;
    while let Some(idx) = rest.find('>') {
        let after = &rest[idx + 1..];
        // `>>` appends and `>|` overrides noclobber; the target follows both.
        let target = after.trim_start_matches(['>', '|']).trim_start();
        let word = target
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .trim_matches(['"', '\'']);
        // An empty target is a dangling operator; `&` is a descriptor move; a
        // `/dev/*` node absorbs the stream without touching the workspace.
        if !word.is_empty()
            && !word.starts_with('&')
            && !word.starts_with("/dev/")
            && !always_allowed_target(word)
        {
            return true;
        }
        rest = after;
    }
    false
}

