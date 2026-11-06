use super::*;

/// Whether an idle browser should be reaped. Pure so the policy is unit-tested
/// without spawning a real Chromium.
pub(super) fn should_reap(elapsed: Duration, ttl: Duration) -> bool {
    elapsed >= ttl
}

/// Port of the live shared browser, or None when it is down. Reaps a browser
/// nobody has touched for `IDLE_REAP` (the process, not the profile) and forgets
/// its tabs, since a dead browser can serve none of them.
pub(super) fn alive_port() -> Option<u16> {
    let mut guard = BROWSER.lock().ok()?;
    let reap = guard
        .as_ref()
        .map(|b| should_reap(b.last_used.elapsed(), IDLE_REAP))
        .unwrap_or(false);
    if reap {
        if let Some(mut b) = guard.take() {
            let _ = b.child.kill();
            let _ = b.child.wait();
            invalidate_cdp_pool();
            forget_all_tabs();
        }
    }
    match guard.as_mut() {
        Some(b) => {
            // A crashed process must never look active.
            if b.child.try_wait().ok().flatten().is_some() {
                let mut dead = guard.take().expect("browser entry just checked");
                let _ = dead.child.kill();
                invalidate_cdp_pool();
                forget_all_tabs();
                return None;
            }
            // Only a LIVE TAB may keep the process alive.
            //
            // Touching the clock on every poll made the browser immortal: a
            // panel (or a health check) that keeps asking for the port while
            // ZERO tabs are open refreshed `last_used` forever, so a browser
            // with no tab and no user — ~300 MB of process plus helpers — was
            // never reaped. With no tab there is nothing to serve, so the
            // `IDLE_REAP` clock is left running and the reaper can take it.
            if !tabs_is_empty() {
                b.last_used = Instant::now();
            }
            Some(b.port)
        }
        None => None,
    }
}

/// Whether the shared browser currently serves any tab.
pub(super) fn tabs_is_empty() -> bool {
    TABS.lock().map(|t| t.is_empty()).unwrap_or(true)
}

/// Restart the browser's idle budget after its LAST tab went away.
///
/// Closing a tab costs its renderer, but the browser process (and its GPU and
/// utility children) stays warm so a reopened panel is instant. That warm
/// process must still time out: `close_tab` and the tab reaper both call this,
/// so the `IDLE_REAP` countdown begins when the browser actually went unused
/// rather than from whenever a tab last happened to touch it.
pub(super) fn restart_idle_clock_if_unused() {
    if !tabs_is_empty() {
        return;
    }
    if let Ok(mut guard) = BROWSER.lock() {
        if let Some(b) = guard.as_mut() {
            b.last_used = Instant::now();
        }
    }
}

/// Drop every tab entry (called when the shared browser dies).
pub(super) fn forget_all_tabs() {
    drop_all_frames();
    if let Ok(mut tabs) = TABS.lock() {
        tabs.clear();
    }
}

/// How often the background reaper checks the idle policy.
pub(super) const REAPER_INTERVAL: Duration = Duration::from_secs(60);

/// Kill the shared browser when nothing has touched it for `IDLE_REAP`.
///
/// `alive_port` already reaps LAZILY, but only on the next request — and with
/// nobody asking (panel closed, chat switched away) no request ever comes, so
/// the Chromium lived until the app quit. That is how a stray headless browser
/// outlived its window and made the machine look permanently short of memory.
pub(super) fn reap_if_idle() {
    let reap = match BROWSER.lock() {
        Ok(guard) => guard
            .as_ref()
            .map(|b| should_reap(b.last_used.elapsed(), IDLE_REAP))
            .unwrap_or(false),
        Err(_) => false,
    };
    if reap {
        kill_running_browser();
    }
}

/// Take the browser out of the registry and kill its process.
pub(super) fn kill_running_browser() {
    let taken = BROWSER.lock().ok().and_then(|mut guard| guard.take());
    if let Some(mut proc) = taken {
        kill_process_tree(&mut proc.child);
        invalidate_cdp_pool();
        forget_all_tabs();
    }
}

/// Kill a browser process left behind by a PREVIOUS run of this app.
///
/// A crash, a `SIGKILL`, a Cmd-Q that skips the window event or an OS-forced
/// quit all bypass the shutdown hook, and the headless Chromium then holds its
/// process and helper tree indefinitely. The next launch sweeps for any process
/// carrying BOTH this app's own profile directory and a debugging-port flag
/// before starting a fresh one. The match is deliberately narrow: a browser the
/// user started themselves has neither marker, so it can never be a target.
///
/// Returns how many processes were signalled, so the caller can log it.
pub fn reap_orphans() -> usize {
    let profile = profile_dir();
    let Ok(out) = Command::new("/bin/ps")
        .args(["-A", "-o", "pid=,args="])
        .output()
    else {
        return 0;
    };
    if !out.status.success() {
        return 0;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let me = std::process::id();
    let mut killed = 0;
    for line in text.lines() {
        let Some((pid, args)) = line.trim_start().split_once(char::is_whitespace) else {
            continue;
        };
        let Ok(pid) = pid.trim().parse::<u32>() else {
            continue;
        };
        // Never signal ourselves, and only ever a process that is ours.
        if pid == me || !is_our_driver(args, &profile) {
            continue;
        }
        if Command::new("/bin/kill").arg(pid.to_string()).status().is_ok() {
            killed += 1;
        }
    }
    killed
}

/// Sweep orphans once at startup, then reap the idle browser on a timer.
///
/// The sweep covers the previous run; the timer covers THIS one, so a session
/// left open for days does not keep a Chromium alive after its last tab closed.
/// The thread is detached and owns no app handle, so it never blocks or
/// outlives the quit path.
pub fn start_idle_reaper() {
    let swept = reap_orphans();
    if swept > 0 {
        println!("[browser] reaped {swept} orphaned browser process(es) from a previous run");
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(REAPER_INTERVAL);
        reap_idle_tabs();
        reap_if_idle();
    });
}

