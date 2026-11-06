use super::*;

/// Run a shell command in `root` with a timeout, returning combined output.
/// Mirrors tools.py run_terminal: kill on timeout, cap the output.
pub fn run_terminal(root: &str, command: &str, timeout_secs: u64) -> Result<String, String> {
    run_terminal_bounded(root, command, timeout_secs, MAX_TERMINAL_TIMEOUT_SECS)
}

/// Same as [`run_terminal`], with an explicit ceiling instead of the global
/// one.
///
/// A plugin-script run passes its own bound here: a paid article/image call
/// legitimately takes minutes, so the script's window is decided by the plugin
/// layer rather than inherited from the terminal default.
pub fn run_terminal_bounded(
    root: &str,
    command: &str,
    timeout_secs: u64,
    ceiling: u64,
) -> Result<String, String> {
    run_terminal_bounded_with(root, command, timeout_secs, ceiling, None)
}

/// The last `max` bytes of the combined output buffer, as lossy UTF-8 cut on a
/// char boundary (the buffer can end mid-char while a reader holds half of a
/// Persian/emoji codepoint).
pub(super) fn combined_tail(output: &Mutex<Vec<u8>>, max: usize) -> String {
    let guard = output.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_empty() {
        return String::new();
    }
    let mut cut = guard.len().saturating_sub(max);
    // A byte position is a char boundary unless it lands INSIDE a multi-byte
    // UTF-8 sequence (a continuation byte: 0b10xxxxxx).
    while cut < guard.len() && (guard[cut] & 0xC0) == 0x80 {
        cut += 1;
    }
    String::from_utf8_lossy(&guard[cut..]).into_owned()
}

/// Same as [`run_terminal_bounded`], plus an optional [`TailSink`] that
/// receives the live output tail while the command is still running.
pub fn run_terminal_bounded_with(
    root: &str,
    command: &str,
    timeout_secs: u64,
    ceiling: u64,
    on_tail: Option<&TailSink>,
) -> Result<String, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    let start = Instant::now();
    // Second belt beside the dispatch-side clamp: EVERY caller of this
    // function is bounded by the caller's ceiling, so a future caller cannot
    // re-open the hole the dispatch clamp closed.
    //
    // TWO zeroes mean "wait for the child, however long it takes":
    //  * `timeout_secs == 0` — the caller wants no deadline (a plugin script,
    //    which must never be killed after it has already paid for its work);
    //  * `ceiling == 0` — the caller has no cap to impose, so its own value is
    //    used as given instead of being clipped.
    let timeout_secs = if timeout_secs == 0 {
        0
    } else if ceiling == 0 {
        timeout_secs
    } else {
        let clamped = timeout_secs.min(ceiling);
        if clamped != timeout_secs {
            eprintln!(
                "[tool] run_terminal: caller asked for {timeout_secs}s; bounded to {clamped}s"
            );
        }
        clamped
    };
    // The app bundle's PATH misses the user's tool dirs (cargo lived outside
    // it), so `cargo`-class calls died with `command not found` and each one
    // billed a repair round. Inherit the LOGIN-shell PATH, probed once.
    static LOGIN_PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let login_path = LOGIN_PATH.get_or_init(crate::shell_env::shell_path);
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(root)
        .env("PATH", login_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot spawn: {e}"))?;

    // `None` = unbounded: the loop below then only exits on child exit or a
    // full output buffer.
    let deadline = (timeout_secs > 0).then(|| Duration::from_secs(timeout_secs));
    let cap = MAX_TERMINAL_OUTPUT * 2;
    let output: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let drained = Arc::new(AtomicUsize::new(0));
    let mut readers = 0usize;

    // Drain both pipes on their own threads. A blocking `read` on the child's
    // stdout used to keep the timeout check below unreachable: a command that
    // writes nothing (`sleep 100000`, a prompt waiting on stdin) never returned
    // from `read`, so `timeout_secs` was dead code and the turn hung forever
    // (blocking a tokio worker with it, since this runs inline in the agent
    // loop). The single shared cap covers BOTH streams — the stderr side
    // previously had no cap at all, so a noisy child grew this buffer without
    // bound until the timeout.
    if let Some(mut s) = child.stdout.take() {
        let sink = output.clone();
        let done = drained.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match s.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut guard = sink.lock().unwrap_or_else(|e| e.into_inner());
                        // Past the cap the bytes are DISCARDED but the pipe keeps
                        // being drained: an unbounded child (a plugin script) that
                        // writes more than the buffer must never block on a full
                        // pipe, because there is no deadline left to rescue it.
                        if guard.len() < cap {
                            let room = cap - guard.len();
                            let take = n.min(room);
                            guard.extend_from_slice(&buf[..take]);
                        }
                    }
                }
            }
            done.fetch_add(1, Ordering::Relaxed);
        });
        readers += 1;
    }
    if let Some(mut s) = child.stderr.take() {
        let sink = output.clone();
        let done = drained.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match s.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut guard = sink.lock().unwrap_or_else(|e| e.into_inner());
                        if guard.len() < cap {
                            let room = cap - guard.len();
                            let take = n.min(room);
                            guard.extend_from_slice(&buf[..take]);
                        }
                    }
                }
            }
            done.fetch_add(1, Ordering::Relaxed);
        });
        readers += 1;
    }

    let mut overflowed = false;
    // Live-output ticker: every TERMINAL_TAIL_EMIT_MS the current tail of the
    // combined output goes to `on_tail` while the child is still alive. Only a
    // GROWN buffer emits — a command sitting quiet (a build with no new
    // output) does not re-send the same bytes.
    let mut next_tail = Duration::from_millis(TERMINAL_TAIL_EMIT_MS);
    let mut last_tail_len = 0usize;
    let timed_out = loop {
        if deadline.map(|d| start.elapsed() > d).unwrap_or(false) {
            break true;
        }
        match child.try_wait() {
            Ok(Some(_)) => break false,
            // Still running (or the wait itself failed) — keep polling.
            Ok(None) | Err(_) => {}
        }
        // Once either stream filled the cap a BOUNDED call has nothing left to
        // gain by waiting: the child is killed below, which also closes the
        // pipes. An UNBOUNDED one (a plugin script) is never killed for talking
        // too much — it keeps running to completion and its output is truncated
        // at the end, since killing it after it already paid for its work is the
        // very bug this budget was introduced to stop.
        if deadline.is_some() {
            let full = output.lock().map(|o| o.len() >= cap).unwrap_or(false);
            if full {
                overflowed = true;
                break false;
            }
        }
        if let Some(sink) = on_tail {
            if start.elapsed() >= next_tail {
                next_tail = start.elapsed() + Duration::from_millis(TERMINAL_TAIL_EMIT_MS);
                let len = output.lock().map(|o| o.len()).unwrap_or(0);
                if len != last_tail_len {
                    last_tail_len = len;
                    let tail = combined_tail(&output, TERMINAL_TAIL_BYTES);
                    if !tail.is_empty() {
                        sink(&tail);
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    };

    if timed_out || overflowed {
        // Kill on BOTH exits. The old code broke out of the read loop without
        // killing, then blocked in `wait()` on a child that could never exit
        // because nobody was draining its full pipe — a permanent hang plus an
        // orphaned `sh`/`yes`.
        let _ = child.kill();
    }
    let status = child.wait().map_err(|e| e.to_string())?;

    // Let the readers flush the tail, but never wait on them indefinitely: a
    // background grandchild (`sleep 100 &`) keeps the pipe open after `sh`
    // died, so a blocking join would reintroduce the hang. Detached reader
    // threads parked on such a pipe are bounded and harmless.
    let flush_deadline = Instant::now() + Duration::from_millis(300);
    while drained.load(Ordering::Relaxed) < readers && Instant::now() < flush_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }

    let output = output.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut text = String::from_utf8_lossy(&output).to_string();
    if text.len() > MAX_TERMINAL_OUTPUT {
        let mut cut = text.len() - MAX_TERMINAL_OUTPUT;
        // Move forward to a char boundary — slicing mid-char panics on
        // Persian / emoji / U+FFFD output.
        while cut < text.len() && !text.is_char_boundary(cut) {
            cut += 1;
        }
        text = format!("…[head truncated]\n{}", &text[cut..]);
    }
    // An empty body is a dead end, not an answer: a traced round ran
    // `cargo run … 2>/dev/null` with `cargo` off PATH, the redirect threw the
    // only diagnostic away, and the model spent a whole round-trip (18 160
    // input tokens, 17 152 cached) to learn nothing. Say so in-band, and name
    // the redirect as the likely culprit so the next round fixes the command.
    if text.trim().is_empty() && !timed_out && !overflowed {
        if status.success() {
            return Ok(format!(
                "The command exited successfully but produced NO output (stdout and stderr were both empty). Do not repeat it unchanged: if you redirected a stream (`2>/dev/null`, `>/dev/null`), drop the redirect so the error or result is visible, and check the binary is on PATH."
            ));
        }
        return Ok(format!(
            "EXIT CODE: {}\nThe command FAILED but produced no output — its stderr was redirected away or empty. Re-run it WITHOUT `2>/dev/null` so the real error is visible.",
            status.code().unwrap_or(-1)
        ));
    }
    if timed_out {
        // In-band timeout (Ok), exactly like before the fix, so the model can
        // react to it instead of seeing a tool error.
        return Ok(format!(
            "ERROR: command timed out after {timeout_secs}s\n{text}"
        ));
    }
    if overflowed {
        // The old code `break`ed out of the read loop without killing the child
        // and then parked in `wait()` on a child whose full pipe nobody was
        // draining — a permanent deadlock plus a leaked process.
        return Ok(format!(
            "ERROR: command output exceeded the {cap} byte limit and was killed\n{text}"
        ));
    }
    if !status.success() {
        return Ok(format!("EXIT CODE: {}\n{text}", status.code().unwrap_or(-1)));
    }
    Ok(text)
}

// ---------------------------------------------------------------------------
// JSON tool-call dispatch (used by the agent loop)
// ---------------------------------------------------------------------------

