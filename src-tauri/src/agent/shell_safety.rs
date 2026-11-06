use super::*;

/// True when a shell command would CHANGE the workspace (write into a file,
/// in-place edit, git/package-manager write). Only Build mode may mutate, so a
/// read-only mode must not get around the tool gate through `run_terminal`:
/// `echo x > src/app.ts` writes a file without ever calling `write_file`, and a
/// Plan turn whose terminal is "inspection only" could otherwise rewrite the
/// tree from the shell.
pub(super) fn is_mutating_command(cmd: &str) -> bool {
    is_mutating_depth(cmd, 0)
}

pub(super) fn is_mutating_depth(cmd: &str, depth: usize) -> bool {
    let mut scrubbed = cmd.to_lowercase();
    // `2>&1` / `>&2` duplicate a descriptor — they create no file, so they are
    // stripped first or every redirected build/test would look like a write.
    for fd in ["2>&1", ">&1", ">&2", "&>1", "&>2"] {
        scrubbed = scrubbed.replace(fd, " ");
    }
    // A redirection into a file is the plainest write there is — but only when
    // the target is a file. `2>/dev/null` on an inspection command is a read.
    if redirects_to_a_file(&scrubbed) {
        return true;
    }

    // Commands whose whole job is to write somewhere.
    const MUTATORS: [&str; 17] = [
        "rm", "rmdir", "mv", "cp", "ln", "touch", "mkdir", "truncate", "dd", "tee",
        "chmod", "chown", "patch", "unlink", "shred", "mkfifo", "install",
    ];

    // Every pipeline/chain segment is inspected, and `xargs` is followed into
    // its argument: `ls | xargs rm` writes even though `ls` does not.
    scrubbed.split([';', '|', '&', '\n']).any(|seg| {
        let words: Vec<&str> = seg.split_whitespace().collect();
        let Some(first) = words.first() else {
            return false;
        };
        // Strip a leading path so `/bin/rm` is caught as well.
        let cmd = first.rsplit('/').next().unwrap_or(first);
        let args = &words[1..];
        if MUTATORS.contains(&cmd) {
            return true;
        }
        if cmd == "xargs" && args.iter().any(|w| MUTATORS.contains(w)) {
            return true;
        }
        // An interpreter one-liner writes any file it likes without ever naming
        // a mutating binary (`node -e "fs.writeFileSync(...)"`), so its eval
        // form is refused while the turn may not write. A plain run stays
        // allowed — `node --version`, `python script.py`, `npm test`.
        if cmd == "eval" {
            return true;
        }
        let eval_flags: &[&str] = match cmd {
            "sh" | "bash" | "zsh" | "dash" | "ksh" => &["-c"],
            "node" | "deno" | "bun" => &["-e", "--eval", "-p", "--print"],
            "python" | "python3" | "ruby" | "perl" | "osascript" => &["-e", "-c"],
            _ => &[],
        };
        if args.iter().any(|w| eval_flags.contains(w)) {
            // The payload IS code the shell will run, so it is only as writable
            // as its contents: decide from the payload itself (bounded depth).
            // MEASURED (mvrvau0r r1): a read-only turn's login-PATH probe
            // (`/bin/zsh -l -c 'echo -n $PATH'`) was refused wholesale and burned
            // a round. Only the POSIX shells parse reliably; interpreters whose
            // payloads can write without any shell token (`python -c "open('a',
            // 'w')"`, `node -e fs.writeFileSync`) stay refused wholesale.
            if matches!(cmd, "sh" | "bash" | "zsh" | "dash" | "ksh") {
                if depth >= 3 {
                    return true;
                }
                if let Some(pos) = args.iter().position(|w| eval_flags.contains(w)) {
                    // The payload is EVERYTHING after the flag (a quoted
                    // `sh -c 'rm -rf src'` arrives as three whitespace-split
                    // words); rejoin it and strip the quote wrapper before the
                    // recursive gate.
                    let payload = args[pos + 1..]
                        .join(" ")
                        .trim_matches(['\'', '"'])
                        .to_string();
                    if !payload.trim().is_empty() {
                        return is_mutating_depth(&payload, depth + 1);
                    }
                }
            }
            return true;
        }
        // In-place editors: `sed -i`, `sed -i.bak`, `perl -pi`/`-pni` (the flag
        // is often BUNDLED, so `-pi` never starts with `-i`), and `find
        // -delete` / `-exec`. Only sed/perl get the bundled-`i` rule: `find
        // -iname` also contains an `i` but only reads.
        if matches!(cmd, "sed" | "perl")
            && args.iter().any(|w| {
                *w == "--in-place"
                    || w.starts_with("--in-place")
                    || (w.starts_with('-')
                        && !w.starts_with("--")
                        && w[1..].contains('i'))
            })
        {
            return true;
        }
        if cmd == "awk" && args.iter().any(|w| *w == "-i") {
            return true;
        }
        if cmd == "find" && args.iter().any(|w| *w == "-delete" || *w == "-exec") {
            return true;
        }
        // Otherwise-read-only tools with write-y subcommands (git index,
        // package manifests, lockfiles).
        let blocked: &[&str] = match cmd {
            "git" => &[
                "add", "commit", "apply", "checkout", "restore", "reset", "clean", "stash",
                "merge", "rebase", "tag", "push", "switch", "cherry-pick", "init", "rm",
            ],
            "npm" | "pnpm" | "yarn" => &[
                "install", "i", "ci", "add", "remove", "rm", "uninstall", "update",
                "upgrade", "link", "publish", "init",
            ],
            "pip" | "pip3" => &["install", "uninstall", "download"],
            "cargo" => &["add", "install", "remove", "update", "fix", "clean", "new", "init"],
            "go" => &["get", "install", "mod", "generate"],
            "brew" => &["install", "uninstall", "upgrade", "update", "tap"],
            "apt" | "apt-get" => &["install", "remove", "upgrade", "update"],
            _ => &[],
        };
        if !blocked.is_empty() && args.iter().any(|w| blocked.contains(w)) {
            return true;
        }
        // Formatters rewrite in place, but their `--check` form only reports.
        let check_only = args.iter().any(|w| *w == "--check" || *w == "-c");
        if !check_only {
            let formats = cmd == "fmt"
                || (matches!(cmd, "cargo" | "eslint" | "prettier" | "ruff" | "black")
                    && args
                        .iter()
                        .any(|w| *w == "fmt" || *w == "--fix" || *w == "--write"));
            if formats {
                return true;
            }
        }
        false
    })
}

/// The path-like tokens a shell command names.
///
/// A token counts as a path when it is absolute, home-relative, or contains a
/// separator. A BARE name never does: it always resolves inside the workspace, so
/// skipping it costs nothing and keeps flags, versions and URLs out.
///
/// Used by the search gate (can the native tools serve this?) and by the access
/// gate (does this reach outside every allowed root?). The command is NOT
/// lowercased here — a path is case-sensitive on this platform, unlike the
/// verb-matching `shell_statements` applies.
/// True when a shell token is a regex/glob fragment that cannot be a filename.
///
/// `shell_targets` splits a command line on whitespace, so the pattern operand
/// of a `grep`/`sed`/`rg` lands in the path set. A path may contain `[` or `*`
/// only in exotic names; a bracket CLASS, a quote, or a regex operator never
/// appears in one, and every false ask measured on the corpus carried one.
pub(super) fn looks_like_pattern(t: &str) -> bool {
    let body = t.strip_prefix('/').unwrap_or(t);
    t.contains(['[', ']', '\\', '\'', '"', '*'])
        || t.contains("//")
        || t.ends_with(',')
        || body.chars().any(|c| matches!(c, '^' | '$' | '+' | '?' | '|' | '(' | ')'))
}

/// Split `cmd` on `delims` at TOP LEVEL only: a delimiter inside single or
/// double quotes belongs to the argument, not to the command line.
///
/// MEASURED on a live turn: `awk 'NR>=1 { ... } END { print NR }'` was shredded
/// on the `;` INSIDE its quoted program, one fragment became a bare `~` (awk's
/// match operator), and the access gate read that as the home directory — so it
/// asked the user for permission on `/Users/<user>`, the PARENT of the very
/// workspace the agent was already working in.
pub(super) fn split_unquoted(cmd: &str, delims: &[char]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in cmd.chars() {
        if escaped {
            cur.push(ch);
            escaped = false;
            continue;
        }
        // Inside single quotes a backslash is literal, matching shell rules.
        if ch == '\\' && quote != Some('\'') {
            cur.push(ch);
            escaped = true;
            continue;
        }
        match quote {
            Some(q) if ch == q => {
                quote = None;
                cur.push(ch);
            }
            Some(_) => cur.push(ch),
            None => {
                if ch == '\'' || ch == '"' {
                    quote = Some(ch);
                    cur.push(ch);
                } else if delims.contains(&ch) {
                    out.push(std::mem::take(&mut cur));
                } else {
                    cur.push(ch);
                }
            }
        }
    }
    out.push(cur);
    out
}

pub(super) fn shell_targets(cmd: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for st in split_unquoted(cmd, &[';', '&', '|', '\n']) {
        for w in split_unquoted(&st, &[' ', '\t']) {
            if w.starts_with('-') {
                continue;
            }
            let t = w.trim_matches(['"', '\'', '(', ')', '`']);
            if t.is_empty() || t.contains('=') {
                continue;
            }
            // A word that still holds whitespace was a QUOTED argument. It is a
            // path only when it spells an absolute or home path outright
            // (`"/Users/me/my file.txt"`) — that must stay gated, since a
            // quoted target is still a target. A program or a sed script
            // (`awk '… ; …'`, `sed 's/a b/c/'`) is an instruction the command
            // interprets, never a filename.
            if t.chars().any(char::is_whitespace) && !(t.starts_with('/') || t.starts_with("~/")) {
                continue;
            }
            // A bare `~` is never a home reference — home is written `~/…`.
            // awk and sed use `~` as an operator, and reading it as $HOME sent
            // the gate to the workspace's parent directory.
            if t == "~" {
                continue;
            }
            let pathy = t.starts_with('/') || t.starts_with('~') || t.contains('/');
            // MEASURED on the live traces: 5 fake "paths" per corpus reached
            // the access gate and asked for a directory that cannot exist —
            // regex fragments like `/[Cc]hromium` or `/forkChat/,/^PASS\`.
            // They parse out of a shell line but are not filenames: a real
            // path never carries a bracket class, a quote or a regex operator.
            if !pathy || looks_like_pattern(t) {
                continue;
            }
            if !out.iter().any(|q| q == t) {
                out.push(t.to_string());
            }
        }
    }
    out
}

/// True when a shell command tries to SEARCH for files with a search engine
/// (find/grep/rg/fd/locate/tree/glob) **for something the native tools can
/// already reach**.
/// The main agent reads and greps files its step already NAMED but does not go
/// looking for files it does not know about — that discovery runs inside the
/// explore sub-agent, whose report the main agent works from.
///
/// Shell SEARCH stays refused for a WORKSPACE target: the terminal is the
/// measurement/build verb (`ls`, `du`, `df`, `ps`, builds, tests, git), and a
/// `find`/`rg` one-liner duplicates `grep` while producing an unnumbered,
/// uncapped dump.
///
/// A search that names a path OUTSIDE the workspace is a different animal: every
/// native lookup is scoped to the workspace, so the terminal is the ONLY tool
/// that can answer it. Refusing it was a false refusal — the model re-asked with
/// `grep`, that failed on the same path, and one answer was billed twice
/// (MEASURED: 14 of 33 traced refusals named such a path).
///
/// `ls` is deliberately NOT in the list: listing a directory (and measuring it
/// with `du`/`df`) reads what the caller already knows about, it is not a
/// search, and a read-only mode must be able to see the disk. The user's rule
/// is that every READ works everywhere and only APPLYING a change needs Build.
pub(super) fn is_file_search_command(cmd: &str, root: &str) -> bool {
    // A search that FILTERS another command's output is not file discovery:
    // `cargo test | grep -E "^(error|test result)"` inspects a build the model
    // just ran, and refusing it forced a second, bigger command plus an extra
    // round trip. Only a search that OWNS its own input — the first pipeline
    // stage — is the delegated case.
    //
    // THE gate refuses only when a scope touches the workspace. The OLD loop
    // had two billing bugs, both live in traces: (1) an early `return false`
    // on the first out-of-tree token let `rg foo src/ > /tmp/o` escape the
    // gate and search the workspace freely; (2) a quote-blind split read the
    // tokens of a quoted PATTERN (`grep -n "fn a\|fn b" file`) as path scopes,
    // so a grep on ~/.codifa’s plugin sources was refused as a workspace
    // search (mvqksnvw run59) — the same shell call the native `grep` then
    // could not answer either.
    const SEARCH_VERBS: [&str; 7] = ["find", "fd", "locate", "tree", "glob", "grep", "rg"];
    // grep-family takes [flags] PATTERN [PATH…]; find/tree take PATHS first.
    const PATTERNED: [&str; 5] = ["grep", "rg", "fd", "locate", "glob"];
    let mut base = root.to_string();
    let mut has_ws_scope = false;
    let mut implied_ws = false;
    for stage in shell_stages(cmd) {
        if !stage.owns_input {
            continue;
        }
        // prefix pass: assignments / `export` vanish, `cd` moves the base
        let mut idx = 0;
        while idx < stage.words.len() {
            let w = stage.words[idx].as_str();
            if w == "export" {
                idx += 1;
                continue;
            }
            if w == "cd" {
                if let Some(d) = stage.words.get(idx + 1) {
                    base = cd_base(&base, d);
                }
                idx += 2;
                continue;
            }
            if is_shell_assignment(w) {
                idx += 1;
                continue;
            }
            break;
        }
        let Some(verb) = stage.words.get(idx) else {
            continue;
        };
        if !SEARCH_VERBS.contains(&verb.as_str()) {
            continue;
        }
        let patterned = PATTERNED.contains(&verb.as_str());
        let mut saw_pathish = false;
        let mut stage_ws = false;
        let mut skipped_pattern = false;
        let mut after_first_flag = false;
        // sed/awk/gawk take a PROGRAM as their first non-flag argument — not a
        // pattern, not a scope. Its slashes/braces (`'s/…/…/'`, `'{print}'`)
        // used to be read as a path fragment and drag the scanner into the
        // workspace while its REAL file argument sat outside (traced:
        // mvrv45fv r29 `sed 's/x//g' /tmp/win.log | grep …`). Skip it here so
        // the loop below starts at the first FILE argument.
        let mut start = idx + 1;
        if matches!(verb.as_str(), "sed" | "awk" | "gawk") {
            while start < stage.words.len() && stage.words[start].starts_with('-') {
                start += 1;
            }
            if start < stage.words.len() {
                start += 1; // the program text itself
            }
        }
        for w in &stage.words[start..] {
            if w.starts_with('-') {
                after_first_flag = true;
                continue;
            }
            // A bare number right after a flag is that flag's value (`-A 40`,
            // `-maxdepth 2`), never a scope. A number NOT after a flag is an
            // ordinary token — for grep-family that is the PATTERN itself
            // (`grep 404 /elsewhere/x`), so it must fall through to the
            // pattern-consumption branch below, not silently vanish.
            if after_first_flag && w.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            if patterned {
                if !skipped_pattern {
                    skipped_pattern = true; // the PATTERN, not a scope
                    continue;
                }
            } else if after_first_flag {
                // find/tree: everything after the first flag is an expression
                continue;
            }
            saw_pathish = true;
            let abs = resolve_scope(&base, w);
            if abs.is_empty() {
                // A program fragment or unexpanded variable ($D/mod.rs, "{a,b}",
                // a quoted "$f") — not a path token: it invents no scope, so it
                // must not count as a workspace scope EITHER. MEASURED
                // (mvrv45fv r29): a `grep … $D/src/Windows/…` over the cargo
                // registry was refused as a workspace search (3+ retry rounds)
                // because unexpanded tokens fell through to the implied-CWD
                // branch. Skipping it WITHOUT marking a workspace hit keeps
                // both sides honest: no invented scope, and such a stage is
                // still judged by its REAL tokens below.
                continue;
            }
            if always_allowed_target(&abs) {
                // ~/.codifa, /tmp and /dev sit outside the workspace, where no
                // native lookup answers — refusing these burns a round with no
                // cheaper substitute (traced: greps over traces/, logs and
                // plugin trees). "Allowed elsewhere" is not a workspace scope.
                // A variable-prefixed FILE arg (`"$P/Cargo.toml"`) resolves
                // empty above and already skips a workspace hit; nothing more
                // is needed here.
                continue;
            }
            if crate::tools::is_inside_root(root, &abs) {
                stage_ws = true;
            }
        }
        if stage_ws {
            has_ws_scope = true;
        }
        // grep-family with no path token searches the CWD, which run_terminal
        // spawns at the workspace root — an implied workspace scope. ONLY the
        // stage that OWNS its input can imply one: a middle/last pipeline stage
        // (`perl … | grep -nE x | head`) filters another command's stream —
        // the same exemption `cargo test | grep` gets at the top of this gate
        // (traced: mvrv45fv r31, mvrvau0r r1).
        if patterned && !saw_pathish && stage.owns_input {
            implied_ws = true;
        }
    }
    has_ws_scope || implied_ws
}

/// One pipeline stage of a shell string, tokenised quote-aware: statements
/// split on `;`/`&`/newline and stages on `|` — never inside quotes — and
/// redirect tokens (`2>/dev/null`, `> out`, `<<EOF`) are dropped so a search
/// cannot hide behind plumbing, nor be refused because of it.
pub(super) struct ShellStage {
    owns_input: bool,
    words: Vec<String>,
}

pub(super) fn shell_stages(cmd: &str) -> Vec<ShellStage> {
    fn flush(out: &mut Vec<ShellStage>, words: &mut Vec<String>, tok: &mut String, owns: bool) {
        if !tok.is_empty() {
            words.push(std::mem::take(tok));
        }
        if !words.is_empty() {
            out.push(ShellStage {
                owns_input: owns,
                words: std::mem::take(words),
            });
        }
    }
    let mut out: Vec<ShellStage> = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut tok = String::new();
    let mut owns = true;
    let mut quote: Option<char> = None;
    let mut chars = cmd.chars().peekable();
    while let Some(c) = chars.next() {
        // A backslash escapes the NEXT character outside quotes (`Application\
        // Support`, `foo\ bar.rs`): the pair names ONE path token. Without this
        // the space split the token and the orphan half (`support`) resolved as
        // a RELATIVE path inside the workspace — refusing a find over ~/Library
        // that the workspace has nothing to do with (mvrxj97c r21).
        if c == '\\' && quote.is_none() {
            if let Some(&n) = chars.peek() {
                if n == ' ' || n == '\\' || n == '$' {
                    tok.push(n);
                    chars.next();
                    continue;
                }
            }
        }
        match c {
            '\'' | '"' if quote.is_none() || quote == Some(c) => {
                quote = if quote.is_none() { Some(c) } else { None };
                tok.push(c);
            }
            ';' | '&' | '\n' if quote.is_none() => {
                flush(&mut out, &mut words, &mut tok, owns);
                owns = true;
            }
            '|' if quote.is_none() => {
                flush(&mut out, &mut words, &mut tok, owns);
                owns = false;
            }
            ' ' | '\t' if quote.is_none() => {
                if !tok.is_empty() {
                    words.push(std::mem::take(&mut tok));
                }
            }
            _ => tok.push(c),
        }
    }
    flush(&mut out, &mut words, &mut tok, owns);
    // Redirect plumbing is DROPPED, as the doc comment has always claimed:
    // `2>/dev/null` is an fd shim that names no file the command reads, and
    // `> /tmp/o` / `<<EOF` are writes heredocs the mutation gate owns — none
    // of them is a search scope or a read target. Leaving them in tokenised
    // every unquoted `2>/dev/null` as a BARE token that resolved INSIDE the
    // workspace (the file does not exist) and refused 19 traced lookups
    // (7 files, one day). Unquoted `> f` survives as its own token and is
    // filtered by the same rule; `<<'PY'` still arrives as one token.
    for st in out.iter_mut() {
        st.words.retain(|w| {
            let unq = w.trim_matches(['"', '\'']);
            // a heredoc INTRODUCER is plumbing itself (its body is a separate
            // statement via newlines); a bare `>`/`>>` operator is plumbing;
            // `N>target` is an fd shim; `target>…` never happens bare.
            !(unq.contains("<<")
                || unq == ">"
                || unq == ">>"
                || (unq.starts_with(['1', '2']) && unq.contains('>')))
        });
    }
    out
}

/// `VAR=value` prefix token, as `strip_shell_prefix` judges them.
pub(super) fn is_shell_assignment(w: &str) -> bool {
    !w.is_empty()
        && w.contains('=')
        && !w.starts_with('=')
        && w.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '=')
}

/// The user's home folder, for `~` expansion.
///
/// `$HOME` is a Unix convention: on Windows it is usually UNSET (the variable
/// there is `USERPROFILE`), so reading it directly made every `~/…` expand to a
/// leading-slash path that exists on no machine. `dirs::home_dir()` answers the
/// same question portably, and `$HOME` stays the first choice because a shell
/// command's `~` follows the variable it would actually see.
pub(super) fn home_dir_str() -> String {
    if let Ok(h) = std::env::var("HOME") {
        if !h.is_empty() {
            return h;
        }
    }
    dirs::home_dir()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Resolve a `cd` argument against the running base, `~`-aware.
pub(super) fn cd_base(base: &str, d: &str) -> String {
    let d = d.trim_matches(['"', '\'']);
    let home = home_dir_str();
    if d.starts_with('/') {
        d.to_string()
    } else if d == "~" {
        home
    } else if let Some(rest) = d.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else if d.starts_with('$') {
        // An unresolved env-var cd: keep the base — judging its children
        // against a guessed path would invent scopes that do not exist.
        base.to_string()
    } else {
        format!("{}/{}", base.trim_end_matches('/'), d)
    }
}

/// Resolve a search-scope token against the running base, `~`-aware. An
/// EMPTY result means "not a path token at all" — an awk/sed program fragment
/// (`'{print'`) or an unexpanded shell variable must not invent a scope.
pub(super) fn resolve_scope(base: &str, t: &str) -> String {
    let t = t.trim_matches(['"', '\'', '(', ')', '`']);
    if t.is_empty() || t.starts_with('$') || t.starts_with('{') || t.starts_with('%') {
        return String::new();
    }
    let home = home_dir_str();
    if t.starts_with('/') {
        t.to_string()
    } else if t == "~" {
        home
    } else if let Some(rest) = t.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        format!("{}/{}", base.trim_end_matches('/'), t)
    }
}

/// The commands a shell string actually RUNS, normalised.
///
/// `/`;`/`&`/newline split statements, and only a statement's FIRST pipeline
/// stage owns files — a later stage just filters the previous command's output
/// (`cargo test 2>&1 | grep -E "test result"` inspects a build, not the tree).
/// The leading `cd … &&` / `export …;` noise is stripped from each statement.
///
/// MEASURED: 63% of traced `run_terminal` calls arrive as `cd <path> && …`, so a
/// gate that reads only the first WORD of the raw string lets `cd x && grep -rn …`
/// through — the exact shell search it exists to refuse.
pub(super) fn shell_statements(cmd: &str) -> Vec<String> {
    cmd.to_lowercase()
        .split([';', '&', '\n'])
        .map(|st| {
            let owned = st.split('|').next().unwrap_or_default().trim();
            strip_shell_prefix(owned).trim().to_string()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

/// Drop the prefix noise every real command carries: `cd … && `, `export …; `
/// and bare `VAR=value ` assignments, repeated as often as they nest.
pub(super) fn strip_shell_prefix(seg: &str) -> &str {
    let mut t = seg.trim();
    loop {
        if let Some(rest) = t.strip_prefix("cd ") {
            let cut = rest
                .find("&&")
                .map(|i| (i, 2))
                .or_else(|| rest.find(';').map(|i| (i, 1)));
            match cut {
                Some((i, n)) if !rest[i + n..].trim().is_empty() => {
                    t = rest[i + n..].trim();
                    continue;
                }
                _ => return t,
            }
        }
        if let Some(rest) = t.strip_prefix("export ") {
            match rest.find(';') {
                Some(i) if !rest[i + 1..].trim().is_empty() => {
                    t = rest[i + 1..].trim();
                    continue;
                }
                _ => return t,
            }
        }
        let word = t.split_whitespace().next().unwrap_or_default();
        let assignment = !word.is_empty()
            && word.contains('=')
            && !word.starts_with('=')
            && word
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && word
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '=');
        if assignment && !t[word.len()..].trim().is_empty() {
            t = t[word.len()..].trim_start();
            continue;
        }
        return t;
    }
}

/// Verbs whose whole job is to PRINT a file's contents.
pub(super) const DUMPER_VERBS: [&str; 14] = [
    "cat", "bat", "tac", "nl", "head", "tail", "less", "more", "xxd", "od", "strings",
    "sed", "awk", "gawk",
];

/// True when the command's whole job is to print a file's contents.
///
/// The main agent owns `read`, which a result budget bounds and which accepts
/// several files in ONE call; `cat`/`sed -n` die on a redirect, cannot batch, and
/// spend a whole round-trip on the same window `read` returns directly.
pub(super) fn is_file_dump_command(cmd: &str) -> bool {
    shell_statements(cmd).iter().any(|st| {
        let verb = st.split_whitespace().next().unwrap_or_default();
        // `sed -i` REWRITES the file; that is the mutation gate's business.
        DUMPER_VERBS.contains(&verb) && !st.contains(" -i")
    })
}

/// True when the command prints a file that lives INSIDE the workspace.
///
/// Only that case is refused: reading a log under `/tmp`, a build artifact or
/// anything else out of tree stays a terminal job, because `read` is scoped to
/// the workspace. A `cd <dir>` statement moves the base, so the same relative
/// target is judged in the directory it is really read from.
pub(super) fn workspace_file_read(cmd: &str, root: &str) -> bool {
    // The SAME quote-aware stages the search gate uses. shell_statements split
    // on every `;` — including one inside a sed program (`sed 's/[0-9;]*m//g'`)
    // — and judged the program TEXT a file target, refusing `sed … /tmp/x.log`
    // as a workspace dump (mvrv45fv r29Today). Stages drop redirect plumbing
    // and keep statements intact, so the dumper scan below sees real words.
    let mut base = root.to_string();
    for stage in shell_stages(cmd) {
        let words = &stage.words;
        let Some(verb) = words.first() else { continue };
        if verb == "cd" {
            if let Some(dir) = words.get(1) {
                base = cd_base(&base, dir);
            }
            continue;
        }
        if !DUMPER_VERBS.contains(&verb.as_str()) || stage.words.iter().any(|w| w == "-i") {
            continue;
        }
        // sed/awk/gawk take a program as their FIRST non-flag argument; without
        // this skip a bare `sed -n 5p` (stdin read) would judge the program
        // text the read target and invent a workspace file.
        let mut args: Vec<&String> = words[1..].iter().collect();
        if matches!(verb.as_str(), "sed" | "awk" | "gawk") {
            while args.first().is_some_and(|w| w.starts_with('-')) {
                args.remove(0);
            }
            if !args.is_empty() {
                args.remove(0); // the program text
            }
        }
        // Stages already dropped `2>/dev/null`, bare `>`/`>>` operators and
        // heredoc introducers; a surviving write redirect (attached form
        // `>out` on a non-fd token) makes this the mutation gate's business.
        if words.iter().any(|w| {
            w.contains('>') && !(w.starts_with('1') || w.starts_with('2'))
        }) {
            continue;
        }
        let Some(target) = args.last() else { continue };
        let target = target.trim_matches(['"', '\'']);
        // An UNRESOLVED VARIABLE ($B, ${B}, $HOME/…) names no file the gate can
        // judge: it was once resolved RELATIVELY into "<ws>/$B", a path that
        // exists only inside the gate, and every traced `B=<ws path>; strings
        // $B | grep …` was billed a false dump refusal (mvrxj97c r15/r21 — six
        // retries of the same probe on the NEW build). A variable target is
        // unprovable either way, so the gate stays silent; the assignment pass
        // above (B=…) could inline it, but only exactly and only here.
        if target.is_empty() || target.starts_with('-') || target.starts_with('$') {
            continue;
        }
        let abs = if target.starts_with('/') || target.starts_with('~') {
            target.to_string()
        } else {
            format!("{}/{target}", base.trim_end_matches('/'))
        };
        // The SAME resolver the native tools use: a lexical `starts_with` on the
        // raw argv judged `<root>/~/.config/x` as inside the workspace, so an
        // out-of-tree read was refused as a "workspace file dump" — a false
        // refusal the native `read` then failed on for the very same path.
        if !always_allowed_target(&abs) && crate::tools::is_inside_root(root, &abs) {
            return true;
        }
    }
    false
}

/// Areas the terminal may read without any shim: codifa's own config tree
/// (plugins, skills, traces — the plugin workflows live here and no native
/// tool can reach them) and the OS temp areas. The read and search shields
/// exist to route WORKSPACE lookups to the cheaper native tools; both are
/// pointless outside the workspace, where those tools cannot answer anyway.
pub(super) fn always_allowed_target(abs: &str) -> bool {
    // shell_statements lowercases its statements, so every comparison here is
    // case-folded: on a case-insensitive APFS root `/Users/saman/.codifa`
    // arrived as `/users/saman/.codifa` and strayed past an exact match.
    let a = abs.trim_matches(['"', '\'']).to_lowercase();
    if a.starts_with("/dev/") {
        return true;
    }
    for p in ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"] {
        if a == p || a.starts_with(&format!("{p}/")) {
            return true;
        }
    }
    let home = home_dir_str().to_lowercase();
    let a = if let Some(rest) = a.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        a
    };
    // A bare `~` (no trailing separator) is the home folder itself.
    if a == "~" && !home.is_empty() {
        return true;
    }
    if let Ok(tmp) = std::env::temp_dir().canonicalize() {
        let t = tmp.to_string_lossy().to_lowercase();
        if !t.is_empty() && (a == t || a.starts_with(&format!("{t}/"))) {
            return true;
        }
    }
    let cfg = format!("{home}/.codifa");
    if a == cfg || a.starts_with(&format!("{cfg}/")) {
        return true;
    }
    // The app's own data root (~/Library/Application Support/com.codifa.app by
    // default) — same class of trusted home as ~/.codifa: schedules, terminal
    // logs, data-root.json. Traced: reads of them got billed as workspace
    // dump/search refusals and burned rounds on the app's OWN files.
    if let Some(app_root) = crate::state::current_data_root() {
        let ap = app_root.to_string_lossy().to_lowercase();
        let ap = ap.trim_end_matches('/').to_string();
        if !ap.is_empty() && (a == ap || a.starts_with(&format!("{ap}/"))) {
            return true;
        }
    }
    false
}

/// True when a `run_terminal` command is a pure READ: it neither writes, nor
/// searches the tree, nor dumps a workspace file.
///
/// Only such a command may share its round with other lookups; anything else
/// keeps its own round so a read is never reordered before the write it needs.
pub(super) fn is_shell_read_only(cmd: &str, root: &str) -> bool {
    !is_mutating_command(cmd)
        && !is_file_search_command(cmd, root)
        && !workspace_file_read(cmd, root)
}

