use super::*;

/// Slice one line to the byte cap without splitting a UTF-8 character (a raw
/// byte slice panics on any multi-byte character crossing the boundary).
pub(super) fn truncated_line(line: &str) -> String {
    if line.len() <= MAX_LINE_LENGTH {
        return line.to_string();
    }
    let mut end = MAX_LINE_LENGTH;
    while end > 0 && !line.is_char_boundary(end) {
        end -= 1;
    }
    format!("{} …[truncated]", &line[..end])
}

/// One read window of a file: its lines, or the reason the window is empty.
pub(super) enum Window {
    Lines {
        lines: Vec<String>,
        extended: bool,
        /// Lines in the WHOLE file, so the header can say "of N" — see
        /// [`numbered_window`].
        total: usize,
    },
    Empty(String),
}

/// Read one window of a file (1-indexed offset, line count) with the same
/// truncation rules as tools.py: 2MB byte cap, 2000-char line cap.
pub(super) fn file_window(abs: &Path, offset: usize, limit: usize) -> Result<Window, String> {
    file_window_upto(abs, offset, limit, None)
}

/// `file_window`, allowed to stretch the window to the END of the file.
///
/// A short file read as a 400-line window ends a few lines before EOF, and the
/// model then spends a WHOLE round trip asking for the remainder — the single
/// largest source of extra round trips in the traced corpus: 78 of 80 reads in
/// one run stopped before EOF with a median of 7_951 unused chars left in the
/// result budget, and 106 rounds were a read chained onto another read of the
/// same file. Serving the tail NOW costs those same bytes once (they fit the
/// budget the result already has) and removes the follow-up round — the turn
/// gets shorter and cheaper without withholding a single line.
///
/// The stretch is deliberately conservative: only when the remainder is no
/// larger than the window the caller asked for AND the numbered rendering of the
/// whole thing still fits `budget`. Anything bigger keeps today's behaviour, so
/// a 20k-line file never turns one read into an unbounded payload.
pub(super) fn file_window_upto(
    abs: &Path,
    offset: usize,
    limit: usize,
    budget: Option<usize>,
) -> Result<Window, String> {
    let meta = fs::metadata(abs).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            // A guessed filename returning a bare ENOENT made the model retry
            // blind (traced: 2 rounds on a typo'd/guessed path). Name the
            // siblings so the retry lands first try.
            let dir = abs.parent().map(|p| p.display().to_string()).unwrap_or_default();
            let listing = read_window(abs.parent().unwrap_or(Path::new(".")), 0, 30)
                .unwrap_or_else(|_| "(directory not readable)".into());
            format!(
                "file not found: {} (no such file)\nreal files in {dir}:\n{listing}",
                abs.file_name().and_then(|p| p.to_str()).unwrap_or("?")
            )
        } else {
            format!("file not found: {e}")
        }
    })?;
    if meta.len() as usize > MAX_READ_BYTES {
        return Err(format!(
            "file too large to read in one call ({} bytes > {MAX_READ_BYTES}); use offset/limit windows",
            meta.len()
        ));
    }
    let content = read_viewable_text(abs)?;
    let total = content.lines().count();
    let mut lines: Vec<String> = content
        .lines()
        .skip(offset.saturating_sub(1))
        .take(limit)
        .map(truncated_line)
        .collect();
    if lines.is_empty() {
        // An empty window is never data: say WHY it is empty, otherwise the
        // caller burns another round guessing (a traced run read offset=100000
        // of a short file and got a silent blank).
        return Ok(Window::Empty(if total == 0 {
            format!("{} is empty (0 lines)", abs.display())
        } else {
            format!(
                "offset {offset} is past the end of {} ({total} lines) — read offset=1",
                abs.display()
            )
        }));
    }
    // Stretch to EOF when the tail is small enough to ride along for free (see
    // `file_window_upto`): the model would otherwise spend a whole round trip
    // asking for exactly these lines.
    let mut extended = false;
    if let Some(budget) = budget {
        let served_to = offset.saturating_sub(1) + lines.len();
        let rest_count = total.saturating_sub(served_to);
        if rest_count > 0 && rest_count <= limit {
            let rest: Vec<String> = content
                .lines()
                .skip(served_to)
                .map(truncated_line)
                .collect();
            if rest.len() == rest_count {
                let asked_cost = numbered_cost(offset.max(1), lines.iter().map(|l| l.len()).sum(), lines.len());
                let rest_cost = numbered_cost(served_to + 1, rest.iter().map(|l| l.len()).sum(), rest.len());
                if asked_cost + rest_cost + READ_TRUNCATION_RESERVE <= budget {
                    lines.extend(rest);
                    extended = true;
                }
            }
        }
    }
    Ok(Window::Lines {
        lines,
        extended,
        total,
    })
}

/// Char cost of rendering `count` numbered lines that begin at line `first` and
/// carry `sum_len` chars of text in total.
///
/// An estimate on purpose: it only decides whether a tail RIDES ALONG, and
/// `numbered_window_capped` remains the hard bound afterwards — so being a few
/// chars optimistic never breaks the budget, it just lets a window grow by one
/// line before the cut.
pub(super) fn numbered_cost(first: usize, sum_len: usize, count: usize) -> usize {
    if count == 0 {
        return 0;
    }
    let width = (first + count - 1).to_string().len();
    sum_len + count * (width + 2) + 40
}

/// Bare window text (no line numbers) — the shape non-agent callers expect.
pub fn read_window(abs: &Path, offset: usize, limit: usize) -> Result<String, String> {
    if abs.is_dir() {
        return list_dir(abs, offset, limit);
    }
    match file_window(abs, offset, limit)? {
        Window::Lines { lines, .. } => {
            let mut out = String::with_capacity(lines.iter().map(|l| l.len() + 1).sum());
            for line in lines {
                out.push_str(&line);
                out.push('\n');
            }
            Ok(out)
        }
        Window::Empty(notice) => Ok(notice),
    }
}

/// Read one window for the agent loop: the same lines, each carrying its
/// 1-based number under a `<label> (lines a-b):` header, so the model can cite
/// a line instead of re-reading the file to pin its number down. Directory
/// listings keep their plain form.
pub fn read_window_block(abs: &Path, label: &str, offset: usize, limit: usize) -> Result<String, String> {
    // Programmatic callers asked for exactly this window: never stretch it.
    read_window_block_capped(abs, label, offset, limit, usize::MAX, false)
}

/// Smallest useful share one window gets inside a batch. Below this a block is
/// only a header, which reads as "nothing here" and costs a round trip to
/// disprove — so a batch that cannot afford a real window says so instead.
pub(super) const READ_BLOCK_MIN: usize = 1_200;

/// Default window of a `read` that names no offset/limit. One definition, used
/// by the dispatch arm AND by the repeat-guard's coverage check, so the two can
/// never disagree about which lines a call actually asked for.
pub(crate) const DEFAULT_READ_OFFSET: usize = 1;
pub(crate) const DEFAULT_READ_LIMIT: usize = 400;

/// The (file, offset, limit) entries a `read` call asks for, with the same
/// defaults the dispatch arm applies.
///
/// `ranges` is the batch spelling (an entry without `path` inherits the
/// top-level one), `paths` is the legacy list that shares one window, and a
/// bare `filePath` is the single-window form. Empty when the call names no file
/// at all — the caller decides whether that is an error or simply no coverage.
/// The `ranges` entries of a `read`, tolerating the JSON-STRING spelling.
///
/// Traced (mvxqpye6 r0): the model sent `ranges` as a serialized JSON string
/// instead of an array. Every shape check missed, the call fell through to
/// `resolve_safe(root, "")` — the workspace ROOT — and came back as a directory
/// listing flagged `ok: true`, costing two more rounds to disprove. A string
/// that parses as an array of entries is the same request, so honour it.
pub(super) fn ranges_of(args: &Value) -> Option<Vec<Value>> {
    let raw = &args["ranges"];
    if let Some(list) = raw.as_array() {
        return Some(list.clone());
    }
    let text = raw.as_str()?.trim();
    if !text.starts_with('[') {
        return None;
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(list)) => Some(list),
        _ => None,
    }
}

pub(crate) fn read_windows_of(args: &Value) -> Vec<(String, usize, usize)> {
    let top = args["filePath"]
        .as_str()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| args["path"].as_str().unwrap_or_default())
        .to_string();
    let num = |v: &Value, fallback: usize| v.as_u64().map(|n| n as usize).unwrap_or(fallback);
    let mut out = Vec::new();
    if let Some(ranges) = ranges_of(args) {
        for r in ranges {
            let file = r["path"].as_str().unwrap_or(top.as_str());
            if file.is_empty() {
                continue;
            }
            out.push((
                file.to_string(),
                num(&r["offset"], DEFAULT_READ_OFFSET),
                num(&r["limit"], DEFAULT_READ_LIMIT),
            ));
        }
        return out;
    }
    if let Some(paths) = args["paths"].as_array() {
        for p in paths.iter().filter_map(Value::as_str) {
            out.push((
                p.to_string(),
                num(&args["offset"], DEFAULT_READ_OFFSET),
                num(&args["limit"], DEFAULT_READ_LIMIT),
            ));
        }
        return out;
    }
    if !top.is_empty() {
        out.push((
            top,
            num(&args["offset"], DEFAULT_READ_OFFSET),
            num(&args["limit"], DEFAULT_READ_LIMIT),
        ));
    }
    out
}

/// Collapse a `read` batch into the non-overlapping union of its windows, one
/// span per file, keeping the order the model asked in.
///
/// A batch is one model call and one prompt re-send, so overlapping entries are
/// paid twice for lines the model asked for once: traced on the real corpus, 42
/// batches carried overlapping windows of the SAME file (6_928 lines — ~381K
/// chars — delivered twice inside a single call), because the model stitches a
/// file together from the pieces a precedent grep or report named. Merging is
/// lossless — the union contains every requested line, and each line is sent
/// exactly once — and it needs no state, so nothing can go stale.
///
/// Windows separated by no more than `GAP` lines merge too: the joined block
/// costs a few unrequested lines but saves a second header and, on the corpus,
/// the extra round the model spent reading the seam between two adjacent spans.
pub(super) fn merge_read_targets(targets: Vec<(String, usize, usize, bool)>) -> Vec<(String, usize, usize, bool)> {
    /// Largest gap between two windows of one file that still merges: adjacent
    /// (`(1,130)` then `(130,120)`) and near-adjacent windows are what a model
    /// emits when it walks a file top-down.
    const GAP: usize = 20;
    let mut order: Vec<String> = Vec::new();
    let mut by_file: std::collections::HashMap<String, Vec<(usize, usize, bool)>> =
        std::collections::HashMap::new();
    for (file, offset, limit, extend) in targets {
        // The span is offset+limit, with no normalisation: `dispatch` treats an
        // explicit `limit: 0` as zero lines, so inflating it here would serve
        // (and charge for) lines the caller did not ask for.
        let span = (offset, offset.saturating_add(limit), extend);
        if !by_file.contains_key(&file) {
            order.push(file.clone());
        }
        by_file.entry(file).or_default().push(span);
    }
    let mut out = Vec::new();
    for file in order {
        let mut spans = by_file.remove(&file).unwrap_or_default();
        spans.sort_unstable();
        let mut merged: Vec<(usize, usize, bool)> = Vec::new();
        for (start, end, extend) in spans {
            match merged.last_mut() {
                // A union is only stretchable when EVERY window in it was the
                // default one: a deliberate narrow `limit` must never be widened
                // behind the model's back.
                Some(last) if start <= last.1 + GAP => {
                    last.1 = last.1.max(end);
                    last.2 &= extend;
                }
                _ => merged.push((start, end, extend)),
            }
        }
        for (start, end, extend) in merged {
            out.push((file.clone(), start, end - start, extend));
        }
    }
    out
}

/// `read_window_block` with a char budget for THIS block.
///
/// The turn loop caps every tool result at `agent::MODEL_RESULT_CAP` before it
/// reaches the model, and that cap is a flat TAIL cut. A batched `read` merges
/// several windows into one string, so any batch of 4+ windows silently lost
/// its last windows: traced on the real corpus, 4 of the 5 capped reads were
/// followed by the SAME file again (10, 7, 6 and 3 extra reads on
/// backend_light.rs, plugins.ts, repo.rs and TVKit.mq5) — the batch defeated
/// itself and bought a round trip instead of saving one. Spending the budget
/// per window keeps every window represented and tells the model exactly how to
/// fetch the remainder.
pub fn read_window_block_capped(
    abs: &Path,
    label: &str,
    offset: usize,
    limit: usize,
    budget: usize,
    extend_to_eof: bool,
) -> Result<String, String> {
    if abs.is_dir() {
        return read_window(abs, offset, limit);
    }
    // An unbounded call (`usize::MAX` budget) is the programmatic shape other
    // callers rely on: they asked for THAT window, so it is served exactly.
    let budget = Some(budget).filter(|b| *b != usize::MAX);
    match file_window_upto(abs, offset, limit, budget.filter(|_| extend_to_eof))? {
        Window::Lines {
            lines,
            extended,
            total,
        } => {
            let first = offset.max(1);
            let mut out = numbered_window_capped_of(
                label,
                first,
                &lines,
                budget.unwrap_or(usize::MAX),
                total,
            );
            if extended {
                // The stretch that saved the follow-up round must be VISIBLE, or
                // the model cannot tell a short window from the end of the file
                // and re-reads the tail anyway. The marker is also what the
                // repeat-guard reads to claim the whole served span.
                out.push_str(&format!(
                    "\n{READ_TO_EOF_MARK}{label} to line {} — the rest of the file is above, do NOT re-read it\n",
                    first + lines.len() - 1
                ));
            }
            Ok(out)
        }
        Window::Empty(notice) => Ok(notice),
    }
}

/// Line a `read` block reports having served, when it stretched to end-of-file.
///
/// `"[read] extended <file> to line <last>"` — the file is spelled exactly as
/// the model spelled it, so the caller can match it against the call's own
/// targets without guessing which block is which. A batched `read` emits one
/// marker per block, so every one is reported.
pub(crate) fn read_extended_spans(result: &str) -> Vec<(String, usize)> {
    result
        .split(READ_TO_EOF_MARK)
        .skip(1)
        .filter_map(|rest| {
            let (file, tail) = rest.split_once(" to line ")?;
            let last = tail
                .split(|c: char| !c.is_ascii_digit())
                .next()
                .filter(|d| !d.is_empty())?
                .parse()
                .ok()?;
            Some((file.trim_end().to_string(), last))
        })
        .collect()
}

/// Render one read window as numbered lines under a range header.
///
/// The raw window (bare lines, no numbers) cost the caller an extra round: a
/// traced explore re-read offsets 4730 and 222 in the very turn after they were
/// already delivered, because nothing in the output pinned a real line number
/// it could cite, and a multi-range read glued several windows together with no
/// marker for where each one started. The header states the file and the
/// inclusive line span; every line carries its 1-based number, right-aligned so
/// digits do not shift the code.
pub fn numbered_window(label: &str, first_line: usize, lines: &[String]) -> String {
    numbered_window_of(label, first_line, lines, 0)
}

/// `label (lines a-b of N):` — the header every read block opens with.
///
/// The `of N` half is the cheapest round-trip lever in the whole read path: a
/// traced run walked `plugins.rs` FOURTEEN times, one 120-line window per round,
/// because nothing in the block said how long the file was — the model could not
/// know whether it was near the end or one tenth of the way in, so it stepped
/// blindly. Two extra words per block let it jump straight to the window it
/// needs instead of spending a model round trip per 120 lines.
pub(super) fn window_header(label: &str, first_line: usize, last: usize, total: usize) -> String {
    if total > last {
        format!("{label} (lines {first_line}-{last} of {total}):\n")
    } else {
        format!("{label} (lines {first_line}-{last}):\n")
    }
}

/// `numbered_window` that also states the file's total line count.
pub(super) fn numbered_window_of(label: &str, first_line: usize, lines: &[String], total: usize) -> String {
    if lines.is_empty() {
        return format!("{label} (lines {first_line}+): (empty window)\n");
    }
    let last = first_line + lines.len() - 1;
    let width = last.to_string().len();
    let mut out = window_header(label, first_line, last, total);
    for (i, line) in lines.iter().enumerate() {
        out.push_str(&format!("{:>width$}: {line}\n", first_line + i, width = width));
    }
    out
}

/// `numbered_window` that never exceeds `budget` chars, and says so when it
/// cannot show everything.
///
/// Without the marker a cut window is indistinguishable from a short file and
/// the model re-reads it to find out. The marker names the exact next offset, so
/// the remainder is one cheap call instead of a guess.
pub(super) fn numbered_window_capped(label: &str, first_line: usize, lines: &[String], budget: usize) -> String {
    numbered_window_capped_of(label, first_line, lines, budget, 0)
}

/// `numbered_window_capped` that also states the file's total line count, so the
/// model knows how much of the file is still ahead of it.
pub(super) fn numbered_window_capped_of(
    label: &str,
    first_line: usize,
    lines: &[String],
    budget: usize,
    total: usize,
) -> String {
    let full = numbered_window_of(label, first_line, lines, total);
    if full.chars().count() <= budget {
        return full;
    }
    let last = first_line + lines.len() - 1;
    let width = last.to_string().len();
    // The header is kept even when the body is cut: without it the block reads
    // as "this file has nothing here", and the caller cannot even tell WHICH
    // window answered.
    let mut out = window_header(label, first_line, last, total);
    let header_len = out.chars().count();
    for (i, line) in lines.iter().enumerate() {
        let next = format!("{:>width$}: {line}\n", first_line + i, width = width);
        // Reserve room for the trailer so the marker itself is never the part
        // that gets cut: it is the only thing telling the model where to resume.
        if header_len + out.chars().count() + next.chars().count() + READ_TRUNCATION_RESERVE > budget {
            let shown_to = first_line + i - 1;
            // A budget too small for even one line must still say why.
            if i == 0 {
                return format!(
                    "{label} (lines {first_line}-{last}): (window too large for the result budget — \
read it with a smaller limit, e.g. offset={first_line} limit=80)\n"
                );
            }
            out.push_str(&format!(
                "… (window truncated at line {shown_to}{}: these lines did not fit the \
result budget. Read the rest with offset={} limit={} — do not re-read what is shown here)\n",
                if total > last { format!(" of {total}") } else { String::new() },
                shown_to + 1,
                last - shown_to + 1
            ));
            return out;
        }
        out.push_str(&next);
    }
    out
}

/// Room kept back for the truncation marker in `numbered_window_capped`.
pub(super) const READ_TRUNCATION_RESERVE: usize = 160;

/// Char budget of the current-text window a failed edit may carry.
///
/// The window replaces a round-trip, so it must stay small enough that the
/// failure message itself never trips the model-result cap.
pub(super) const NEAREST_HINT_BUDGET: usize = 1_200;

/// Lines of context printed on each side of the closest match.
pub(super) const NEAREST_HINT_CONTEXT: usize = 4;

/// Marker stamped on a successful writer's result when a `read`/`grep` of the
/// SAME file ran EARLIER IN THE SAME STEP (batch readers run before the
/// sequential writers). Measured in trace `mvpk9qxx` run=106: that pre-edit
/// lookup kept its pre-edit text on the wire, the model rebuilt `old_string`
/// from it and the edit failed 4 rounds in a row. The note tells the model its
/// copy is stale NOW — one line, no content removed.
pub(crate) const POST_EDIT_STALE_NOTE: &str =
    "\n[stale-source note] a `read`/`grep` of this SAME file ran earlier IN THIS STEP, before \
this edit landed; the text it returned is outdated. Treat only the post-edit state (or a \
fresh `grep`/window read) as truth, never that earlier result.";

/// Minimum shared-word ratio for showing a window at all. MEASURED at 0.5 the
/// window kept a stale-edit loop alive: a traced run failed the same edit 4
/// times because the "closest match" it was pointed at (score ~0.6) was the
/// wrong neighbourhood — the model's copy came from a pre-edit grep elsewhere
/// in the file. Only a near-exact line is copyable text; anything weaker means
/// the model's copy is stale and it needs the current text from a tool call.
pub(super) const NEAREST_HINT_FLOOR: f64 = 0.75;

/// Whitespace-insensitive form of a line: runs of whitespace become one space.
pub(super) fn squeeze(line: &str) -> String {
    line.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Char budget of the site list a failed AMBIGUOUS edit may carry.
///
/// Bounded like `NEAREST_HINT_BUDGET`: the window replaces a round-trip, so the
/// failure message itself must never trip the model-result cap.
pub(super) const AMBIGUOUS_HINT_BUDGET: usize = 1_600;
/// How many sites the ambiguous message lists before it stops.
pub(super) const AMBIGUOUS_HINT_MAX_SITES: usize = 3;
/// Lines of context printed at each ambiguous site.
pub(super) const AMBIGUOUS_HINT_CONTEXT: usize = 2;

/// Each occurrence of an ambiguous `old_string`, with its line number and a
/// small window of the CURRENT text, for `edit_file`'s failure message.
///
/// MEASURED on traces `mvy0ausq` / `mvxsy14e`: 5 ambiguous edits failed and
/// every one cost 1-2 recovery rounds at 65-138K re-sent tokens each, because
/// the message named only a COUNT and the model then re-grepped or re-read the
/// file to find text that would make its string unique. The file is already
/// open in this function, so naming the sites costs one call's worth of chars
/// and lets the edit land on the very next attempt.
pub(super) fn ambiguous_hint(content: &str, old_string: &str) -> String {
    if old_string.is_empty() {
        return String::new();
    }
    let lines: Vec<&str> = content.lines().collect();
    // 0-based line index of each occurrence, in file order.
    let mut sites: Vec<usize> = Vec::new();
    let mut from = 0usize;
    while sites.len() < AMBIGUOUS_HINT_MAX_SITES {
        let Some(off) = content[from..].find(old_string) else {
            break;
        };
        let abs = from + off;
        sites.push(content[..abs].matches('\n').count());
        // Always advance past what matched, so an empty-ish match cannot loop.
        from = abs + old_string.len().max(1);
    }
    if sites.is_empty() {
        return String::new();
    }
    let span = old_string.lines().count().max(1);
    let mut out = String::from(
        " Each site is shown with its neighbours: extend your old_string with ONE adjacent line \
         to make it unique — do NOT re-read the file or re-grep for the text below.",
    );
    // Windows already printed. Two occurrences on the SAME line ("foo foo") both
    // resolve to one line, and neighbouring sites can share context lines; the
    // same block twice reads as two different places and would send the model
    // looking for a distinction that does not exist. Overlap is TRIMMED, not
    // dropped, so a site still gets its own (file-accurate) line number.
    let mut printed_until = 0usize;
    for start in sites {
        let first = start.saturating_sub(AMBIGUOUS_HINT_CONTEXT).max(printed_until);
        let last = (start + span + AMBIGUOUS_HINT_CONTEXT).min(lines.len());
        if last <= first {
            continue;
        }
        printed_until = last;
        let numbered: Vec<String> = lines[first..last].iter().map(|l| (*l).to_string()).collect();
        let block = numbered_window_capped_of(
            &format!("site at line {}", start + 1),
            first + 1,
            &numbered,
            AMBIGUOUS_HINT_BUDGET,
            lines.len(),
        );
        if out.chars().count() + block.chars().count() > AMBIGUOUS_HINT_BUDGET {
            break;
        }
        out.push('\n');
        out.push_str(&block);
    }
    out
}

/// A window of the file's CURRENT text around the place a missing `old_string`
/// was probably taken from, for `edit_file`'s failure message.
///
/// MEASURED: of 25 traced edit failures, 20 sent text the file no longer had
/// (the model was working from a stale copy) and the bare "old_string not found"
/// gave it nothing to work with — 4 answered by re-reading the whole file, and
/// the rest by re-sending the same stale batch, at a median of 2 extra rounds
/// per failure. A small window of the real text costs one call's worth of chars
/// and lets the model fix the string in place.
///
/// Matching is deliberately cheap and local: the first non-blank line of the
/// missing text is compared with every line (whitespace-normalised, then by
/// shared-word ratio) and the best line above the floor is shown with its
/// neighbours under real line numbers. Below the floor the copy the model
/// holds is stale, so no window is printed — a sentence instead names the
/// staleness and points at a cheap `grep`/window read, which is what breaks
/// the measured retry loop (4 failed edits off one pre-edit grep).
pub(super) fn nearest_hint(content: &str, old_string: &str) -> String {
    let probe = match old_string.lines().find(|l| !l.trim().is_empty()) {
        Some(l) => squeeze(l),
        None => return String::new(),
    };
    if probe.is_empty() {
        return String::new();
    }
    let probe_words: Vec<&str> = probe.split_whitespace().collect();
    let lines: Vec<&str> = content.lines().collect();
    let mut best: Option<(f64, usize)> = None;
    for (i, line) in lines.iter().enumerate() {
        let norm = squeeze(line);
        if norm.is_empty() {
            continue;
        }
        let score = if norm == probe {
            1.0
        } else {
            let line_words: Vec<&str> = norm.split_whitespace().collect();
            let shared = probe_words.iter().filter(|w| line_words.contains(w)).count();
            shared as f64 / probe_words.len().max(line_words.len()) as f64
        };
        if score >= NEAREST_HINT_FLOOR && best.is_none_or(|(b, _)| score > b) {
            best = Some((score, i));
        }
    }
    let Some((_, hit)) = best else {
        // No confident match means the string was rebuilt from a stale copy
        // (the pre-edit read/grep still in the context above): pointing at any
        // window would anchor the model to ANOTHER wrong neighbourhood, which
        // is exactly the measured 4-round loop. Steer to the current text
        // instead — one cheap lookup, then the edit lands.
        return " Your copy of this file is STALE — it predates an edit above this turn. \
Do NOT resend this old_string and do NOT reconstruct it from the earlier `read`/`grep` \
result: `grep` for its distinctive token with path= the file (or `read` a narrow window \
with ranges), and build old_string from THAT output."
            .to_string();
    };
    let start = hit.saturating_sub(NEAREST_HINT_CONTEXT);
    let end = (hit + NEAREST_HINT_CONTEXT + 1).min(lines.len());
    let numbered: Vec<String> = lines[start..end].iter().map(|l| (*l).to_string()).collect();
    let window = numbered_window_capped("current text", start + 1, &numbered, NEAREST_HINT_BUDGET);
    format!(
        " The text you sent is not in the file any more — your earlier `read`/`grep` of it is \
out of date now. Copy the exact string from the CURRENT text below \
(do NOT re-read the whole file: a small window covers it):\n{window}"
    )
}

/// Directory listing (one entry per line, subdirs marked with `/`).
pub(super) fn list_dir(abs: &Path, offset: usize, limit: usize) -> Result<String, String> {
    let mut entries: Vec<String> = fs::read_dir(abs)
        .map_err(|e| format!("cannot list directory: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if e.path().is_dir() { format!("{name}/") } else { name }
        })
        .collect();
    entries.sort();
    let total = entries.len();
    let start = offset.saturating_sub(1);
    let page: Vec<String> = entries.into_iter().skip(start).take(limit).collect();
    if page.is_empty() {
        // Same rule as read_window: an empty listing must explain itself.
        return Ok(if total == 0 {
            format!("{} is empty (no entries)", abs.display())
        } else {
            format!(
                "offset {offset} is past the end of {} ({total} entries) — read offset=1",
                abs.display()
            )
        });
    }
    Ok(page.join("\n"))
}

/// Parse `ranges` entries ("path:offset:limit", "start:end", "[start,end]")
/// against an optional single target file — the tolerant parser from read_tool.
pub fn parse_ranges(ranges: &[String], single_target: &str) -> (Vec<(String, usize, usize)>, Vec<String>) {
    let mut jobs = Vec::new();
    let mut bad = Vec::new();
    for spec in ranges {
        let s = spec.trim();
        if s.starts_with('[') {
            // "[start,end]" inclusive window on the single target.
            let pair: Vec<&str> = s
                .trim_start_matches('[')
                .trim_end_matches(']')
                .split(',')
                .map(str::trim)
                .collect();
            if pair.len() == 2 {
                if let (Ok(a), Ok(b)) = (pair[0].parse::<usize>(), pair[1].parse::<usize>()) {
                    if b >= a && !single_target.is_empty() {
                        jobs.push((single_target.to_string(), a, b - a + 1));
                        continue;
                    }
                }
            }
            bad.push(s.to_string());
            continue;
        }
        let parts: Vec<&str> = s.split(':').map(str::trim).collect();
        match parts.len() {
            3 => {
                if let (Ok(o), Ok(l)) = (parts[1].parse::<usize>(), parts[2].parse::<usize>()) {
                    if !parts[0].is_empty() {
                        jobs.push((parts[0].to_string(), o, l));
                        continue;
                    }
                }
                bad.push(s.to_string());
            }
            2 => {
                if let (Ok(a), Ok(b)) = (parts[0].parse::<usize>(), parts[1].parse::<usize>()) {
                    if !single_target.is_empty() {
                        // end >= start: inclusive range; else offset:count.
                        if b >= a {
                            jobs.push((single_target.to_string(), a, b - a + 1));
                        } else {
                            jobs.push((single_target.to_string(), a, b));
                        }
                        continue;
                    }
                }
                bad.push(s.to_string());
            }
            _ => bad.push(s.to_string()),
        }
    }
    (jobs, bad)
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

/// could otherwise use, and the marker keeps the substitution honest.

/// Read a file for VIEWING: a real I/O cause is named, and invalid UTF-8 is
/// shown lossily with a marker instead of refused.
///
/// Same defect as `read_editable_text`: the old one-liner collapsed EACCES, a
/// directory, an I/O error and a genuine encoding mismatch into "binary file",
/// which told the model nothing and cost it a retry round. A read never rewrites
/// the file, so a lossy view is safe — refusing it threw away content the model

pub(super) fn read_viewable_text(target: &Path) -> Result<String, String> {
    let bytes = fs::read(target)
        .map_err(|e| format!("cannot read {}: {e}", target.display()))?;
    match String::from_utf8(bytes) {
        Ok(text) => Ok(text),
        Err(e) => {
            let at = e.utf8_error().valid_up_to();
            let text = String::from_utf8_lossy(e.as_bytes()).into_owned();
            Ok(format!(
                "[note] this file is not valid UTF-8 (first bad byte at offset {at}); the text below \
                 is shown with invalid sequences replaced. Do not edit it with `edit_file` — its \
                 bytes would be rewritten; use `run_terminal` for a byte-exact change.\n{text}"
            ))
        }
    }
}

/// Read a file's current text for an edit, naming the REAL cause when it fails.
///
/// MEASURED on the live traces: the previous one-liner
/// `fs::read_to_string(..).map_err(|_| "binary file (edit skipped)")` reported
/// EVERY failure — permission denied, a directory target, an I/O error mid-turn,
/// or genuinely invalid UTF-8 — as the same 26-char "binary file". Eight batch
/// edits in ONE turn died that way on files that were valid UTF-8 and readable in
/// the same process, so the model could not tell a real encoding problem from a
/// transient one: it re-read the file and re-sent the identical batch, losing 1-2
/// rounds at 65-138K re-sent tokens each. The message now carries the errno, or
/// for a real encoding failure the byte offset of the bad sequence.
///
/// UTF-8 stays enforced (not lossy): an edit rewrites the whole file through a
/// `String`, so a lossy round-trip would corrupt every byte it did not touch.
pub(super) fn read_editable_text(target: &Path) -> Result<String, String> {
    let bytes = fs::read(target)
        .map_err(|e| format!("cannot read {} for editing: {e}", target.display()))?;
    String::from_utf8(bytes).map_err(|e| {
        let at = e.utf8_error().valid_up_to();
        format!(
            "{} is not valid UTF-8 (first bad byte at offset {at}), so it cannot be edited in place — \
             an edit rewrites the whole file and would corrupt the bytes around it. Modify it with \
             `run_terminal` instead.",
            target.display()
        )
    })
}

/// Read a file's current content for diffing before an edit. A missing or
/// unreadable file yields an empty string (a brand-new write_file then diffs
/// as pure additions).
///
/// `permit` is the turn's out-of-workspace grant, the SAME one the writer itself
/// resolves with. Without it a write the user explicitly approved outside the
/// tree snapshotted as `None`, so no diff was ever emitted for it: the chat card
/// said only "Edited" and the Review panel had no hunk to show. Workspace, temp
/// and `~/.codifa` still pass with no permit at all.
pub fn read_pre_edit(root: &str, path: &str, permit: Option<&Value>) -> Option<String> {
    let target = resolve_safe(root, path, false, permit).ok()?;
    fs::read_to_string(target).ok()
}

// ---------------------------------------------------------------------------
// write / edit
// ---------------------------------------------------------------------------
