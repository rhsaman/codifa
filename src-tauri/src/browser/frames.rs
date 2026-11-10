use super::*;

/// Latest pushed frame of a tab: a monotonically increasing sequence (the
/// panel sends back the seq it has seen) plus the JPEG data URI.
pub(super) struct LiveFrame {
    seq: u64,
    image: String,
}

/// One GLOBAL sequence across every target's frames. The panel's long-poll
/// carries `after` = the last seq it rendered, and the VISIBLE target can
/// switch underneath it (a popup opening): with a per-target counter the
/// popup's first frame (seq 1) could never beat the tab's last seq (57), and
/// the panel stayed frozen on the old page forever — "clicked the button and
/// it just stayed there" while the URL bar already showed the popup. One
/// shared counter makes every switch strictly newer.
pub(super) static FRAME_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Frames keyed by target id, each with a notify that wakes long-polls.
/// `Option` (not a lazy cell) so the static stays `const`-constructible.
pub(super) static FRAMES: Mutex<
    Option<std::collections::HashMap<String, (LiveFrame, std::sync::Arc<tokio::sync::Notify>)>>,
> = Mutex::new(None);

/// Cache one pushed frame and wake anything waiting for it.
pub(super) fn store_frame(target_id: &str, image: &str) {
    let Ok(mut guard) = FRAMES.lock() else {
        return;
    };
    let map = guard.get_or_insert_with(Default::default);
    let entry = map.entry(target_id.to_string()).or_insert_with(|| {
        (
            LiveFrame {
                seq: 0,
                image: String::new(),
            },
            std::sync::Arc::new(tokio::sync::Notify::new()),
        )
    });
    entry.0.seq = FRAME_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    entry.0.image = image.to_string();
    entry.1.notify_waiters();
}

/// `(seq, image)` of a tab's cached frame, when one exists.
pub(super) fn peek_frame(target_id: &str) -> Option<(u64, String)> {
    let guard = FRAMES.lock().ok()?;
    guard
        .as_ref()?
        .get(target_id)
        .map(|f| (f.0.seq, f.0.image.clone()))
}

/// The notify a long-poll should wait on, or None when nothing is cached yet.
pub(super) fn frame_notify(target_id: &str) -> Option<std::sync::Arc<tokio::sync::Notify>> {
    let guard = FRAMES.lock().ok()?;
    guard.as_ref()?.get(target_id).map(|f| f.1.clone())
}

/// Forget a tab's frame (tab closed or browser gone).
pub(super) fn drop_frame(target_id: &str) {
    if let Ok(mut guard) = FRAMES.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(target_id);
        }
    }
    drop_pushed(target_id);
}

/// Forget every cached frame.
pub(super) fn drop_all_frames() {
    if let Ok(mut guard) = FRAMES.lock() {
        *guard = None;
    }
}

/// Targets that have received at least one GENUINE pushed frame. A tab whose
/// frames only ever come from the forced-capture fallback (a build without
/// screencast support, say) reports `pushed: false` so the panel can fall back
/// to capture polling instead of waiting on a push that never comes.
pub(super) static PUSHED: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);

pub(super) fn mark_pushed(target_id: &str) {
    if let Ok(mut guard) = PUSHED.lock() {
        guard
            .get_or_insert_with(Default::default)
            .insert(target_id.to_string());
    }
}

pub(super) fn is_pushed(target_id: &str) -> bool {
    PUSHED
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.contains(target_id)))
        .unwrap_or(false)
}

pub(super) fn drop_pushed(target_id: &str) {
    if let Ok(mut guard) = PUSHED.lock() {
        if let Some(set) = guard.as_mut() {
            set.remove(target_id);
        }
    }
}

/// Long-poll one frame for the panel: answers the moment Chromium pushes a
/// frame newer than `after`, else falls back to one forced capture when the
/// cache is empty, else times out quietly (the panel just asks again).
pub async fn frame(chat_id: &str, after: u64) -> Value {
    let chat = normalize_chat(chat_id);
    // Popup discovery rides the panel's poll loop (throttled inside); the
    // blocking CDP read stays off the async workers, same rule as the seed
    // capture below.
    let _ = tokio::task::spawn_blocking(sync_popups).await;
    let Some(tab) = panel_tab(&chat) else {
        return json!({"ok": false, "error": "browser is not running"});
    };
    let target = tab.target_id.clone();
    // Chromium PAUSES screencast frames for a background tab. With one
    // Chromium shared by every chat, opening a second chat's browser made the
    // first chat's tab background — and a navigation there pushed NO frame, so
    // its panel kept rendering the previous page until a resize forced a
    // capture. The polled tab is the one on screen: bring it to the front
    // (idempotent when it already is) so repaints keep reaching the panel.
    let target_for_activate = target.clone();
    let _ = tokio::task::spawn_blocking(move || {
        let _ = cdp_browser_batch(vec![(
            "Target.activateTarget",
            json!({"targetId": target_for_activate}),
        )]);
    })
    .await;
    if peek_frame(&target).is_none() {
        // Nothing cached yet — a fresh panel (or the first moment after
        // attach, before the first push). One forced capture seeds the cache
        // AND starts the screencast (the capture batch opens the session).
        let chat_for_shot = chat.clone();
        let shot = tokio::task::spawn_blocking(move || screenshot(&chat_for_shot))
            .await
            .unwrap_or(Value::Null);
        if let Some(img) = shot.get("image").and_then(Value::as_str) {
            store_frame(&target, img);
        }
    }
    let deadline = Instant::now() + Duration::from_secs(4);
    let pushed = is_pushed(&target);
    loop {
        if let Some((seq, image)) = peek_frame(&target) {
            if seq > after {
                return json!({
                    "ok": true,
                    "pushed": pushed,
                    "seq": seq,
                    "image": image,
                    "width": tab.viewport.0,
                    "height": tab.viewport.1,
                });
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            // Nothing newer within the window: an empty frame tells the panel
            // to simply ask again (the page has not repainted).
            return json!({
                "ok": true,
                "pushed": pushed,
                "seq": after,
                "image": Value::Null,
                "width": tab.viewport.0,
                "height": tab.viewport.1,
            });
        }
        // Register interest BEFORE re-peeking so a frame pushed between the
        // peek and the wait cannot be missed, then wait bounded.
        if let Some(notify) = frame_notify(&target) {
            let notified = notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some((seq, image)) = peek_frame(&target) {
                if seq > after {
                    return json!({
                        "ok": true,
                        "pushed": pushed,
                        "seq": seq,
                        "image": image,
                        "width": tab.viewport.0,
                        "height": tab.viewport.1,
                    });
                }
            }
            let _ = tokio::time::timeout(remaining, notified).await;
        } else {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
}

