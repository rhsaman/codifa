use super::*;

/// One queued mid-turn steer: the renderer's user-message id (so the bubble can
/// be moved inline) plus the prompt text to inject.
#[derive(Clone, Debug)]
pub struct SteerMessage {
    pub id: String,
    pub prompt: String,
}

/// Chats with a turn currently running. `/chat/steer` consults it to answer
/// `ok: false` when nothing is running (the renderer then re-sends the message
/// as the next turn instead of leaving it stuck as pending).
pub(super) fn running_turns() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static RUNNING: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    RUNNING.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// Is a turn running for `chat_id` right now?
///
/// The browser's idle reaper asks this: a tab the AGENT is driving must never be
/// closed for lack of panel polls. When the user switches chat the panel stops
/// polling that chat's tab, but the turn keeps using it — reaping it on the 5-min
/// TTL is what turned a running agent's browser into "Browser is stopped".
pub fn is_turn_running(chat_id: &str) -> bool {
    if chat_id.trim().is_empty() {
        return false;
    }
    running_turns()
        .lock()
        .map(|r| r.contains(chat_id))
        .unwrap_or(false)
}


/// Mid-turn steer inbox: chat_id -> messages typed while that turn is running.
/// The loop drains it before every model call, so a steer lands in the SAME turn
/// with the whole conversation already in `messages` above it — the model keeps
/// every tool result it had produced instead of restarting from the steer alone
/// (the "steering forgets what it was doing" bug).
pub(super) fn steer_inbox() -> &'static std::sync::Mutex<std::collections::HashMap<String, Vec<SteerMessage>>> {
    static INBOX: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, Vec<SteerMessage>>>,
    > = std::sync::OnceLock::new();
    INBOX.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Per-chat "a steer just landed" flags.
///
/// The inbox alone is not enough: it is only read BETWEEN model calls, so a
/// steer typed while a request was already streaming had to wait for that whole
/// request to finish — exactly the "steer behaves like a queue message" report.
/// `push_steer` raises this flag and the live stream polls it, so an in-flight
/// request is dropped at once and re-issued with the steer appended.
pub(super) fn steer_flags(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<InterruptSignal>>>
{
    static FLAGS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<InterruptSignal>>>,
    > = std::sync::OnceLock::new();
    FLAGS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Ids of the steers currently waiting for this chat (non-destructive peek).
/// Used to tell the renderer WHICH bubbles the interrupt concerns; the actual
/// delivery stays with `deliver_steers`, which drains the inbox at the top of
/// the next step.
pub(super) fn pending_steer_ids(chat_id: &str) -> Vec<String> {
    steer_inbox()
        .lock()
        .unwrap()
        .get(chat_id)
        .map(|v| v.iter().map(|s| s.id.clone()).collect())
        .unwrap_or_default()
}

/// Monotonic id for a user-answer gate (`ask_user` / `confirm_action`).
pub(super) fn next_gate_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!("gate-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

/// Open user-answer gates: gate id -> the oneshot that resumes the waiting
/// turn. Resolved by POST /ask/respond or /permission/respond (see
/// `deliver_answer`). The turn BLOCKS on the oneshot until the renderer
/// answers, so a permission/ask popup really pauses the agent.
/// Open user-answer gates: gate id -> (chat that owns it, the oneshot that
/// resumes the waiting turn).
///
/// The chat id rides along so a DELETED chat can release its gates. Without it
/// the only removals were `deliver_answer` and the waiter's own cancel tick, and
/// a chat deleted while a popup was still open kept the blocked turn task —
/// together with that chat's entire `Vec<Value>` message history — alive for the
/// rest of the session.
pub(super) fn answer_gates() -> &'static std::sync::Mutex<
    std::collections::HashMap<String, (String, tokio::sync::oneshot::Sender<Value>)>,
> {
    static GATES: std::sync::OnceLock<
        std::sync::Mutex<
            std::collections::HashMap<String, (String, tokio::sync::oneshot::Sender<Value>)>,
        >,
    > = std::sync::OnceLock::new();
    GATES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Drop every gate belonging to `chat_id`.
///
/// Dropping the sender makes the parked `await_answer` observe a closed channel
/// and return `None`, so the turn unwinds through its normal refusal path and
/// releases everything it was holding.
pub(super) fn release_chat_gates(chat_id: &str) {
    if chat_id.trim().is_empty() {
        return;
    }
    answer_gates()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|_, (owner, _)| owner != chat_id);
}

/// Called when a chat is deleted: nothing will ever answer its popups again.
pub fn forget_chat(chat_id: &str) {
    release_chat_gates(chat_id);
}

/// Deliver an answer to a waiting gate. False when no such gate is open (a
/// stale or duplicate answer) — the renderer then simply ignores it.
pub fn deliver_answer(id: &str, payload: Value) -> bool {
    let tx = answer_gates()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(id)
        .map(|(_, tx)| tx);
    match tx {
        Some(tx) => tx.send(payload).is_ok(),
        None => false,
    }
}

/// Block the turn until the renderer answers `id`.
///
/// There is deliberately NO deadline: the user may take as long as they need
/// (the popup stays open). The 500 ms tick is NOT a timeout — it only re-reads
/// the cancel flag so the Stop button still ends a wait that nobody answered.
pub(super) async fn await_answer(
    id: &str,
    chat_id: &str,
    cancel: &std::sync::atomic::AtomicBool,
) -> Option<Value> {
    let (tx, mut rx) = tokio::sync::oneshot::channel::<Value>();
    answer_gates()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.to_string(), (chat_id.to_string(), tx));
    loop {
        match tokio::time::timeout(std::time::Duration::from_millis(500), &mut rx).await {
            Ok(res) => return res.ok(),
            Err(_) => {
                if cancel.load(Ordering::Relaxed) {
                    answer_gates()
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(id);
                    return None;
                }
            }
        }
    }
}

/// Queue a message to inject into the running turn for `chat_id`.
/// Returns false when no turn is running — the caller should tell the renderer
/// so it re-sends the message as a normal next turn.
#[must_use]
pub fn push_steer(chat_id: &str, id: &str, prompt: &str) -> bool {
    if chat_id.trim().is_empty() || !running_turns().lock().unwrap().contains(chat_id) {
        return false;
    }
    steer_inbox()
        .lock()
        .unwrap()
        .entry(chat_id.to_string())
        .or_default()
        .push(SteerMessage { id: id.to_string(), prompt: prompt.to_string() });
    // Wake the in-flight stream: it drops the current request and re-issues it
    // with this steer appended, instead of letting the model finish first.
    if let Some(signal) = steer_flags().lock().unwrap().get(chat_id) {
        signal.raise();
    }
    true
}

/// Drop a queued steer the user deleted before the agent read it.
pub fn cancel_steer(chat_id: &str, id: &str) {
    if let Some(list) = steer_inbox().lock().unwrap().get_mut(chat_id) {
        list.retain(|s| s.id != id);
    }
}

/// Take (and clear) every steer queued for this chat.
pub(super) fn drain_steers(chat_id: &str) -> Vec<SteerMessage> {
    steer_inbox()
        .lock()
        .unwrap()
        .remove(chat_id)
        .unwrap_or_default()
}

/// Move every queued steer into the running conversation and tell the renderer.
/// Returns how many steers were delivered.
///
/// Called at the top of every step AND right before the turn would end. The
/// end-of-turn call is what fixes "steer behaves like a queue": when the model
/// answered without tool calls the loop used to `return`, leaving the steer in
/// the inbox where `SteerGuard::drop` erased it — so the message only ever
/// arrived as a brand-new turn, i.e. after all the work had already finished.
pub(super) fn deliver_steers(
    messages: &mut Vec<Value>,
    chat_id: &str,
    emit: &mut (dyn FnMut(&AgentEvent) + Send),
) -> usize {
    let steers = drain_steers(chat_id);
    if steers.is_empty() {
        return 0;
    }
    let mut ids: Vec<String> = Vec::with_capacity(steers.len());
    for steer in steers {
        if steer.prompt.trim().is_empty() {
            continue;
        }
        messages.push(json!({"role": "user", "content": steer.prompt}));
        ids.push(steer.id);
    }
    let n = ids.len();
    if n > 0 {
        emit(&AgentEvent::SteerApplied { ids });
    }
    n
}

/// Report every steer still waiting in the inbox as DROPPED, so the renderer
/// keeps those bubbles pending and re-sends them as the next turn.
///
/// This is the counterpart of `deliver_steers` for paths where the turn ends
/// WITHOUT a model call to carry the steer: a provider error, the step budget
/// running out, or a Stop that lands inside a tool batch. `SteerGuard::drop`
/// used to erase the inbox silently, so a message typed mid-turn just vanished
/// ("sometimes steering works, sometimes it doesn't") — the difference being
/// purely which exit the turn happened to take.
///
/// Returns the number of steers handed back.
pub(super) fn drop_steers(chat_id: &str, emit: &mut (dyn FnMut(&AgentEvent) + Send)) -> usize {
    if chat_id.trim().is_empty() {
        return 0;
    }
    let ids: Vec<String> = drain_steers(chat_id)
        .into_iter()
        // A steer with no text was never deliverable; do not ask the renderer
        // to re-send it.
        .filter(|s| !s.prompt.trim().is_empty())
        .map(|s| s.id)
        .collect();
    if ids.is_empty() {
        return 0;
    }
    let n = ids.len();
    emit(&AgentEvent::SteerDropped { ids });
    n
}

/// RAII marker for a running turn: registers the chat for `/chat/steer` and
/// guarantees the inbox + flag are cleared however `run_turn` exits (normal
/// return, early `return Ok(())`, or a panic unwinding the task).
pub(super) struct SteerGuard {
    chat_id: String,
    /// Live "a steer arrived" signal handed to the in-flight model stream.
    pub(super) flag: std::sync::Arc<InterruptSignal>,
}

impl SteerGuard {
    pub(super) fn new(chat_id: &str) -> Self {
        let flag = std::sync::Arc::new(InterruptSignal::new());
        if !chat_id.trim().is_empty() {
            running_turns().lock().unwrap().insert(chat_id.to_string());
            steer_flags()
                .lock()
                .unwrap()
                .insert(chat_id.to_string(), flag.clone());
        }
        SteerGuard { chat_id: chat_id.to_string(), flag }
    }

    /// A guard that owns nothing.
    ///
    /// The explore sub-agent runs `run_turn` with the PARENT's chat id (traces
    /// and plan writes are keyed by it). Registering that id a second time made
    /// the sub-turn's Drop un-register the still-running parent and wipe its
    /// steer inbox, so a steer typed while explore worked was lost.
    pub(super) fn inert() -> Self {
        SteerGuard {
            chat_id: String::new(),
            flag: std::sync::Arc::new(InterruptSignal::new()),
        }
    }
}

impl Drop for SteerGuard {
    fn drop(&mut self) {
        if !self.chat_id.trim().is_empty() {
            running_turns().lock().unwrap().remove(&self.chat_id);
            steer_flags().lock().unwrap().remove(&self.chat_id);
        }
        // A steer nobody consumed must not leak into the next turn of this chat.
        steer_inbox().lock().unwrap().remove(&self.chat_id);
    }
}
