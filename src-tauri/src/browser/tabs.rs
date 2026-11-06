use super::*;

/// The chat's tab, opening it on `about:blank` when the chat has none yet.
/// A tab whose target vanished (surfaced as a `No target` CDP error) is
/// replaced rather than returned, so a stale entry never wedges a chat.
pub(super) fn ensure_tab(chat: &str) -> Result<Tab, String> {
    // Reading the tab refreshes its idle clock (`existing_tab` does that), which
    // is exactly right: the agent asking for the tab IS the tab being in use, so
    // the per-tab reaper must not close it between two tool calls.
    if let Some(tab) = existing_tab(chat) {
        if tab_usable(&tab.target_id) {
            return Ok(tab);
        }
        TABS.lock()
            .ok()
            .map(|mut tabs| tabs.retain(|(k, _)| k != chat));
    }
    ensure_browser()?;
    let out = cdp_browser_batch(vec![(
        "Target.createTarget",
        json!({"url": "about:blank"}),
    )])?;
    let target_id = out
        .into_iter()
        .next()
        .and_then(|v| v["targetId"].as_str().map(str::to_string))
        .ok_or_else(|| "Target.createTarget returned no targetId".to_string())?;
    let tab = Tab {
        target_id,
        viewport: DEFAULT_VIEWPORT,
        last_used: Instant::now(),
    };
    if let Ok(mut tabs) = TABS.lock() {
        tabs.retain(|(k, _)| k != chat);
        tabs.push((chat.to_string(), tab.clone()));
    }
    Ok(tab)
}

/// True when a target still exists in the browser.
pub(super) fn tab_usable(target_id: &str) -> bool {
    if alive_port().is_none() {
        return false;
    }
    match cdp_browser_batch(vec![(
        "Target.getTargetInfo",
        json!({"targetId": target_id}),
    )]) {
        Ok(out) => out
            .into_iter()
            .next()
            .map(|res| res["targetInfo"]["targetId"].as_str() == Some(target_id))
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// True when a target's URL is not a real page yet (nothing for the panel to
/// show). Used to decide whether the chat's own tab is worth keeping.
pub(super) fn is_blank_page_url(url: &str) -> bool {
    let u = url.trim();
    u.is_empty() || u == "about:blank" || u.starts_with("devtools://")
}

/// Do two URLs mean the same page (so navigating again would only reload it)?
///
/// Compares scheme, host, path and fragment while ignoring the trailing `/`,
/// the `www.` prefix and the query: a link the user re-submits with a tracking
/// parameter is still the page already on screen, and reloading it would throw
/// away the agent's in-page state. Deliberately NOT a URL parser — a browser
/// reports `about:blank` and `data:` URLs, which a strict parser rejects; this
/// just needs to be conservative about calling two strings identical.
pub(super) fn same_page(a: &str, b: &str) -> bool {
    fn norm(u: &str) -> String {
        let mut s = u.trim().to_string();
        if let Some((base, _)) = s.split_once('#') {
            s = base.to_string();
        }
        if let Some((base, _)) = s.split_once('?') {
            s = base.to_string();
        }
        for scheme in ["https://", "http://"] {
            if let Some(rest) = s.strip_prefix(scheme) {
                let rest = rest.strip_prefix("www.").unwrap_or(rest);
                return rest.trim_end_matches('/').to_string();
            }
        }
        s.trim_end_matches('/').to_string()
    }
    !a.trim().is_empty() && norm(a) == norm(b)
}

    /// Every PAGE target in the shared browser as
    /// `(target_id, url, opener_target_id)`.
    ///
    /// `Target.getTargets` is a browser-level call (no `sessionId` needed), so
    /// it rides the shared connection. An error or a dead browser yields an
    /// empty list rather than failing the caller. The opener id is empty for
    /// targets no other page opened (chat tabs, `Target.createTarget` pages);
    /// it is what ties a `window.open` popup back to the tab that opened it.
    pub(super) fn page_targets() -> Vec<(String, String, String)> {
        let Ok(out) = cdp_browser_batch(vec![("Target.getTargets", json!({}))]) else {
            return Vec::new();
        };
        out.into_iter()
            .next()
            .and_then(|res| {
                res["targetInfos"].as_array().map(|a| {
                    a.iter()
                        .filter_map(|t| {
                            if t["type"].as_str() != Some("page") {
                                return None;
                            }
                            // CDP's TargetInfo spells the key `targetId` (the
                            // legacy `/json/list` HTTP endpoint uses `id`); a
                            // miss here silently emptied the list and made
                            // adoption a no-op.
                            let id = t["targetId"]
                                .as_str()
                                .or_else(|| t["id"].as_str())?
                                .to_string();
                            let url = t["url"].as_str().unwrap_or_default().to_string();
                            let opener =
                                t["openerId"].as_str().unwrap_or_default().to_string();
                            Some((id, url, opener))
                        })
                        .collect()
                })
            })
            .unwrap_or_default()
    }

/// The chat's tab, ADOPTING a page another CDP client opened when the chat has
/// nothing real to show.
///
/// The panel and the agent's driver share ONE browser but not one tab list: a
/// client can open its own page through the browser-level endpoint, so the
/// chat's registered target could sit on `about:blank` while the agent browsed a
/// real page — the panel then showed an empty Browser with no URL at all.
/// Adopting registers that page as the chat's tab, so every later
/// screenshot/input follows the page the agent is actually driving instead of a
/// blank one.
pub(super) fn adopt(chat: &str) -> Option<Tab> {
    let registered = existing_tab(chat);
    let targets = page_targets();
    if targets.is_empty() {
        // Browser down (or a unit-test registry): nothing to adopt.
        return registered;
    }
    // The chat's own tab already shows a real page — the common case, and the
    // one that must stay cheap.
    if let Some(tab) = &registered {
        let real = targets
            .iter()
            .find(|(id, _, _)| id == &tab.target_id)
            .map(|(_, url, _)| !is_blank_page_url(url))
            .unwrap_or(false);
        if real {
            return registered;
        }
    }
    let claimed: Vec<String> = TABS
        .lock()
        .ok()
        .map(|t| t.iter().map(|(_, x)| x.target_id.clone()).collect())
        .unwrap_or_default();
    let popups: Vec<String> = POPUPS
        .lock()
        .ok()
        .map(|p| p.iter().map(|x| x.target_id.clone()).collect())
        .unwrap_or_default();
    let Some(target_id) = targets
        .iter()
        .find(|(id, url, opener)| {
            !is_blank_page_url(url)
                && !claimed.contains(id)
                && !popups.contains(id)
                // A POPUP of a claimed tab (or of a known popup) belongs to
                // that chat's flow — an OAuth window mid-login must never be
                // stolen by whichever chat currently has no real page.
                && !(claimed.contains(opener) || popups.contains(opener))
        })
        .map(|(id, _, _)| id.clone())
    else {
        return registered;
    };
    let viewport = registered
        .as_ref()
        .map(|t| t.viewport)
        .unwrap_or(DEFAULT_VIEWPORT);
    let tab = Tab {
        target_id,
        viewport,
        last_used: Instant::now(),
    };
    if let Ok(mut tabs) = TABS.lock() {
        tabs.retain(|(k, _)| k != chat);
        tabs.push((chat.to_string(), tab.clone()));
    }
    Some(tab)
}

/// Root chat-tab target of a popup chain, given the live target list
/// `(id, url, opener)` and the registered chat-tab ids.
///
/// A popup opened by a POPUP (some flows do) rolls up to the same chat tab.
/// `None` when the chain leaves the app's own tabs — a foreign CDP client's
/// popup tree is none of the panel's business — or is absurdly deep. Pure so
/// the walk is unit-testable without a browser.
pub(super) fn popup_root(id: &str, targets: &[(String, String, String)], claimed: &[String]) -> Option<String> {
    let mut cur = id.to_string();
    for _ in 0..8 {
        let (_, _, opener) = targets.iter().find(|(tid, _, _)| *tid == cur)?;
        if opener.is_empty() {
            // `cur` is itself a root: `id` was never a popup.
            return None;
        }
        if claimed.contains(opener) {
            return Some(opener.clone());
        }
        cur = opener.clone();
    }
    None
}

/// How often the panel's poll paths re-read the target list for popup
/// discovery. The pushed `Target.targetDestroyed` events already snap the
/// registry when a popup CLOSES; this cadence bounds how long a popup that
/// OPENS can stay invisible (one poll cycle, ~1s).
pub(super) const POPUP_SYNC_MIN: Duration = Duration::from_millis(400);
pub(super) static LAST_POPUP_SYNC: Mutex<Option<Instant>> = Mutex::new(None);

/// Bring `POPUPS` in step with what Chromium actually has.
///
/// `window.open` (TradingView's "Continue with Google", every OAuth button) is
/// answered by Chromium with a SECOND target that the opener reaches through
/// `window.opener`. Nothing used to look at it, so login popups ran invisibly.
/// This re-reads the browser-level target list and registers every page whose
/// opener chain lands on a registered chat tab; the panel then displays the
/// newest live popup instead of the tab (`with_visible_popup`).
///
/// Callers sit on blocking contexts (the `/browser/*` handlers' spawn_blocking
/// pool, or `frame`'s seed path) — never directly on an async worker.
pub(super) fn sync_popups() {
    // Panel polls arrive in pairs (status + frame) a few hundred ms apart;
    // one target re-read per `POPUP_SYNC_MIN` is plenty for both.
    if let Ok(mut last) = LAST_POPUP_SYNC.lock() {
        if last.map(|t| t.elapsed() < POPUP_SYNC_MIN).unwrap_or(false) {
            return;
        }
        *last = Some(Instant::now());
    }
    let targets = page_targets();
    if targets.is_empty() {
        // Browser down (or no targets at all): nothing can be alive.
        if let Ok(mut popups) = POPUPS.lock() {
            let gone: Vec<String> = popups.drain(..).map(|p| p.target_id).collect();
            for id in gone {
                drop_frame(&id);
            }
        }
        return;
    }
    let claimed: Vec<String> = TABS
        .lock()
        .ok()
        .map(|t| t.iter().map(|(_, x)| x.target_id.clone()).collect())
        .unwrap_or_default();
    let discovered: Vec<Popup> = targets
        .iter()
        .filter(|(id, _, opener)| !opener.is_empty() && !claimed.contains(id))
        .filter_map(|(id, _, _)| {
            popup_root(id, &targets, &claimed).map(|root| Popup {
                target_id: id.clone(),
                root,
            })
        })
        .collect();
    if let Ok(mut popups) = POPUPS.lock() {
        // Keep the discovery order stable (oldest first, "newest wins" for the
        // display) and forget frames of popups that went away.
        let mut merged: Vec<Popup> = popups
            .iter()
            .filter_map(|old| {
                discovered
                    .iter()
                    .find(|d| d.target_id == old.target_id)
                    .cloned()
            })
            .collect();
        for d in &discovered {
            if !merged.iter().any(|m| m.target_id == d.target_id) {
                merged.push(d.clone());
            }
        }
        let gone: Vec<String> = popups
            .iter()
            .filter(|old| !merged.iter().any(|m| m.target_id == old.target_id))
            .map(|old| old.target_id.clone())
            .collect();
        *popups = merged;
        for id in gone {
            // A dropped entry is either a popup Chromium already closed (its
            // target is gone — nothing to do) or one that OUTLIVED its root
            // (root reaped/closed first): close the straggler so no invisible
            // renderer lingers holding the profile.
            if targets.iter().any(|(tid, _, _)| *tid == id) {
                let _ = cdp_browser_batch(vec![(
                    "Target.closeTarget",
                    json!({"targetId": id}),
                )]);
            }
            drop_frame(&id);
        }
    }
}

/// Root chat-tab target of `target_id` when it is a live popup, else None.
/// Used by the CDP driver to silence an opener tab's screencast while one of
/// its popups owns the display.
pub(super) fn popup_root_of(target_id: &str) -> Option<String> {
    let popups = POPUPS.lock().ok()?;
    popups
        .iter()
        .find(|p| p.target_id == target_id)
        .map(|p| p.root.clone())
}

/// Target id of the chat's live popup to display instead of `root`, if any.
/// The NEWEST popup wins (a second `window.open` replaces the first on
/// screen); when it closes the view falls back to any older one, then to the
/// tab itself.
pub(super) fn visible_popup(root: &str) -> Option<String> {
    let popups = POPUPS.lock().ok()?;
    popups
        .iter()
        .rev()
        .find(|p| p.root == root)
        .map(|p| p.target_id.clone())
}

/// The chat's tab with the display swapped to its live popup, if one is open.
///
/// Only the CDP target changes: the viewport stays the chat's own, and every
/// batch re-applies it to whichever target is visible, so frames and click
/// coordinates keep one coordinate space across the swap.
pub(super) fn with_visible_popup(mut tab: Tab) -> Tab {
    if let Some(popup) = visible_popup(&tab.target_id) {
        tab.target_id = popup;
    }
    tab
}

/// The chat's registered tab as the PANEL should see it (no discovery — input
/// calls stay cheap; the poll paths refresh the registry).
pub(super) fn panel_tab(chat: &str) -> Option<Tab> {
    existing_tab(chat).map(with_visible_popup)
}

/// ADOPT a page another CDP client opened when the chat has nothing real to
/// show, then follow the chat's own popups. Deliberately used ONLY by
/// `launch`/`status`/`screenshot`: those three run on the panel's polling
/// path, so when one of them adopts a foreign page it is registered for the
/// chat and every other `/browser/*` call follows it automatically — no other
/// call site needs to know about adoption.
pub(super) fn active_tab(chat: &str) -> Option<Tab> {
    sync_popups();
    adopt(chat).map(with_visible_popup)
}

/// The chat's registered tab without creating one.
///
/// Reading a tab IS using it: every panel poll and every driver call funnels
/// through here, so this refresh is what keeps a tab that is genuinely in use
/// from being reaped as idle.
pub(super) fn existing_tab(chat: &str) -> Option<Tab> {
    let mut tabs = TABS.lock().ok()?;
    let idx = tabs.iter().position(|(k, _)| k == chat)?;
    tabs[idx].1.last_used = Instant::now();
    Some(tabs[idx].1.clone())
}

/// Whether a tab has gone untouched long enough to be closed. Pure so the policy
/// is unit-tested without spawning a browser.
pub(super) fn tab_is_stale(tab: &Tab) -> bool {
    tab.last_used.elapsed() >= TAB_IDLE_TTL
}

/// Whether a tab may be reaped: idle long enough AND its chat is not running a
/// turn right now.
///
/// The panel poll is not the only way a tab stays in use: when the user switches
/// to another chat, the agent's turn keeps driving this one's browser with no
/// panel poll at all. Reaping on idleness alone closed the tab out from under a
/// running agent, and coming back to the chat showed "Browser is stopped". A tab
/// the agent can still reach must survive regardless of the TTL.
pub(super) fn tab_may_be_reaped(chat: &str, tab: &Tab) -> bool {
    tab_is_stale(tab) && !crate::agent::is_turn_running(chat)
}

/// Close every tab nobody has looked at for `TAB_IDLE_TTL`.
///
/// Per-tab reaping is what actually releases the renderer processes: closing the
/// CDP target makes Chromium tear down that tab's renderer, which is the only
/// per-chat memory cost in the shared browser (~20-50 MB each measured).
pub(super) fn reap_idle_tabs() {
    let stale: Vec<(String, String)> = match TABS.lock() {
        Ok(mut tabs) => {
            let mut stale = Vec::new();
            tabs.retain(|(chat, tab)| {
                if !tab_may_be_reaped(chat, tab) {
                    return true;
                }
                stale.push((chat.clone(), tab.target_id.clone()));
                false
            });
            stale
        }
        Err(_) => return,
    };
    if stale.is_empty() {
        return;
    }
    // Close each stale target through the shared connection. One batch per
    // target: a target that is ALREADY gone errors the batch, and a batch that
    // stops at its first error must not skip the remaining targets.
    for (chat, target) in &stale {
        let _ = cdp_browser_batch(vec![(
            "Target.closeTarget",
            json!({"targetId": target}),
        )]);
        drop_frame(target);
        crate::browser_driver::forget(chat);
    }
    // If that was the last tab, start the browser's own timeout now so the
    // empty-but-warm process cannot outlive its usefulness.
    restart_idle_clock_if_unused();
}

/// Remember a tab's viewport so later polls report the same size.
pub(super) fn store_viewport(chat: &str, size: (u32, u32)) {
    if let Ok(mut tabs) = TABS.lock() {
        if let Some((_, tab)) = tabs.iter_mut().find(|(k, _)| k == chat) {
            tab.viewport = size;
        }
    }
}

// ---------------------------------------------------------------------------
// Session cookie import ("log in outside, keep the session inside")
// ---------------------------------------------------------------------------

/// Close one chat's tab (the shared browser stays up: other chats may be using
/// it, and a fresh panel reuses the warm process and its profile).
///
/// The chat's open POPUPS are closed with it: Chromium tears them down with
/// the opener anyway, but closing them here keeps the registry, the frame
/// cache and the renderer count from depending on that timing.
pub(super) fn close_tab(chat: &str) -> bool {
    let Some(tab) = existing_tab(chat) else {
        return false;
    };
    let mut targets = vec![tab.target_id.clone()];
    if let Ok(popups) = POPUPS.lock() {
        targets.extend(
            popups
                .iter()
                .filter(|p| p.root == tab.target_id)
                .map(|p| p.target_id.clone()),
        );
    }
    TABS.lock()
        .ok()
        .map(|mut tabs| tabs.retain(|(k, _)| k != chat));
    restart_idle_clock_if_unused();
    // One batch per target: an "already gone" target arrives as a
    // transport-shaped error that would stop a merged batch short, and a
    // vanished popup must not prevent the tab itself from closing.
    for target in &targets {
        let _ = cdp_browser_batch(vec![(
            "Target.closeTarget",
            json!({"targetId": target}),
        )]);
        drop_frame(target);
    }
    if let Ok(mut popups) = POPUPS.lock() {
        popups.retain(|p| p.root != tab.target_id);
    }
    true
}

/// Kill the shared browser (and with it every tab). Called on app shutdown so
/// no orphaned browser keeps holding memory after the window is gone.
pub fn kill_all_sessions() -> usize {
    let tabs = TABS.lock().ok().map(|t| t.len()).unwrap_or(0);
    let had_browser = BROWSER.lock().map(|g| g.is_some()).unwrap_or(false);
    kill_running_browser();
    if had_browser {
        tabs.max(1)
    } else {
        0
    }
}

// ---------------------------------------------------------------------------
// One-click automation browser install
// ---------------------------------------------------------------------------

