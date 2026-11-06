
/// One line of the merged edit script: ` ` kept, `-` deleted, `+` added.
/// `a` / `b` are how many OLD / NEW lines precede this op (for hunk headers).
pub(super) struct DiffOp<'a> {
    tag: char,
    text: &'a str,
    a: usize,
    b: usize,
}

/// Myers O(ND) shortest edit script between two line slices: marks which lines
/// of `a` are deleted and which of `b` are added. Returns false (marks
/// untouched) when the edit distance passes the cap, so a pathological pair of
/// huge, unrelated files costs bounded time/memory and the caller falls back.
pub(super) fn myers_marks(a: &[&str], b: &[&str], del: &mut [bool], add: &mut [bool]) -> bool {
    const MAX_D: isize = 1500;
    let n = a.len() as isize;
    let m = b.len() as isize;
    let limit = (n + m).min(MAX_D);
    let off = limit + 1;
    let mut v = vec![0isize; (2 * limit + 3) as usize];
    // trace[d] = the V frontier BEFORE round d, only diagonals -d..=d.
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let mut found: Option<isize> = None;
    'search: for d in 0..=limit {
        trace.push(v[(off - d) as usize..=(off + d) as usize].to_vec());
        let mut k = -d;
        while k <= d {
            let idx = (off + k) as usize;
            let mut x = if k == -d || (k != d && v[idx - 1] < v[idx + 1]) {
                v[idx + 1]
            } else {
                v[idx - 1] + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[idx] = x;
            if x >= n && y >= m {
                found = Some(d);
                break 'search;
            }
            k += 2;
        }
    }
    let Some(dd) = found else {
        return false;
    };
    let (mut x, mut y) = (n, m);
    for d in (1..=dd).rev() {
        let vd = &trace[d as usize];
        let get = |kk: isize| vd[(kk + d) as usize];
        let k = x - y;
        let prev_k = if k == -d || (k != d && get(k - 1) < get(k + 1)) {
            k + 1
        } else {
            k - 1
        };
        let prev_x = get(prev_k);
        let prev_y = prev_x - prev_k;
        // Walk back along the diagonal (kept lines) to just after the edit.
        while x > prev_x && y > prev_y {
            x -= 1;
            y -= 1;
        }
        if x == prev_x {
            add[prev_y as usize] = true; // moved down: an insertion
        } else {
            del[prev_x as usize] = true; // moved right: a deletion
        }
        x = prev_x;
        y = prev_y;
    }
    true
}

/// Deleted-flags for `a` and added-flags for `b`. A pure insert/delete needs no
/// search; when the search is capped, everything in the span counts as changed
/// (the old behaviour) rather than hanging on a giant rewrite.
pub(super) fn line_marks(a: &[&str], b: &[&str]) -> (Vec<bool>, Vec<bool>) {
    let mut del = vec![false; a.len()];
    let mut add = vec![false; b.len()];
    if a.is_empty() || b.is_empty() || !myers_marks(a, b, &mut del, &mut add) {
        del.iter_mut().for_each(|f| *f = true);
        add.iter_mut().for_each(|f| *f = true);
    }
    (del, add)
}

/// Unified diff (`--- a/…` / `+++ b/…`) shaped like `git diff`: a real
/// line-level diff (Myers), split into hunks with 3 context lines. Only lines
/// that truly changed are `-`/`+`, so the +N/-M counters the UI derives from it
/// match `git diff --numstat` instead of counting the whole span between the
/// first and last edit (a 5-line change in a 130-line file used to read
/// +122/-110).
pub fn unified_diff(path: &str, old: &str, new: &str) -> String {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let mut pre = 0usize;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0usize;
    while suf < a.len() - pre
        && suf < b.len() - pre
        && a[a.len() - 1 - suf] == b[b.len() - 1 - suf]
    {
        suf += 1;
    }
    if pre == a.len() && pre == b.len() {
        return String::new(); // identical content
    }
    const CTX: usize = 3;

    // Merged edit script: kept prefix, the diffed middle, kept suffix.
    let (del, add) = line_marks(&a[pre..a.len() - suf], &b[pre..b.len() - suf]);
    let mut ops: Vec<DiffOp> = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (0usize, 0usize);
    for _ in 0..pre {
        ops.push(DiffOp { tag: ' ', text: a[i], a: i, b: j });
        i += 1;
        j += 1;
    }
    let (mut p, mut q) = (0usize, 0usize);
    while p < del.len() || q < add.len() {
        if p < del.len() && del[p] {
            ops.push(DiffOp { tag: '-', text: a[i], a: i, b: j });
            i += 1;
            p += 1;
        } else if q < add.len() && add[q] {
            ops.push(DiffOp { tag: '+', text: b[j], a: i, b: j });
            j += 1;
            q += 1;
        } else if p < del.len() && q < add.len() {
            ops.push(DiffOp { tag: ' ', text: a[i], a: i, b: j });
            i += 1;
            j += 1;
            p += 1;
            q += 1;
        } else {
            break;
        }
    }
    for _ in 0..suf {
        ops.push(DiffOp { tag: ' ', text: a[i], a: i, b: j });
        i += 1;
        j += 1;
    }

    // Group changes into hunks: two changes share a hunk when the unchanged gap
    // between them fits inside both their context windows.
    let changed: Vec<usize> = ops
        .iter()
        .enumerate()
        .filter(|(_, o)| o.tag != ' ')
        .map(|(n, _)| n)
        .collect();
    let mut out = format!("--- a/{path}\n+++ b/{path}\n");
    let mut s = 0usize;
    while s < changed.len() {
        let mut e = s;
        while e + 1 < changed.len() && changed[e + 1] - changed[e] <= 2 * CTX + 1 {
            e += 1;
        }
        let lo = changed[s].saturating_sub(CTX);
        let hi = (changed[e] + CTX).min(ops.len() - 1);
        let hunk = &ops[lo..=hi];
        let old_len = hunk.iter().filter(|o| o.tag != '+').count();
        let new_len = hunk.iter().filter(|o| o.tag != '-').count();
        // git convention: an empty side points at the line BEFORE the hunk.
        let old_start = if old_len == 0 { hunk[0].a } else { hunk[0].a + 1 };
        let new_start = if new_len == 0 { hunk[0].b } else { hunk[0].b + 1 };
        out.push_str(&format!(
            "@@ -{old_start},{old_len} +{new_start},{new_len} @@\n"
        ));
        for o in hunk {
            out.push(o.tag);
            out.push_str(o.text);
            out.push('\n');
        }
        s = e + 1;
    }
    out
}

