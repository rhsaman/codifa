use super::*;

/// Layouts a Chromium build may use under a root: [dir-fragment, binary].
///
/// Chrome-for-Testing names its macOS binary `Google Chrome for Testing` inside
/// `Google Chrome for Testing.app`; on Windows the same build is
/// `chrome-win64/chrome.exe` (the `.exe` suffix is added per-platform below),
/// on Linux `chrome-linux64/chrome`. A Playwright Chromium uses `Chromium`
/// (mac) / `chrome` (linux); the headless shell ships `chrome-headless-shell`.
/// Every fragment is tried under each matching build dir, so one list covers
/// all of them.
pub(super) const BROWSER_LAYOUTS: &[(&str, &str)] = &[
    ("chrome-mac-arm64", "Google Chrome for Testing"),
    ("chrome-mac-x64", "Google Chrome for Testing"),
    // The full-chrome zip for macOS unpacks the .app at the TOP LEVEL (next
    // to ABOUT/resources) with no wrapper dir — the "" fragment probes the
    // build dir itself, which is what the installer's rename produces.
    ("", "Google Chrome for Testing"),
    ("chrome-win64", "chrome"),
    ("chrome-linux64", "chrome"),
    ("chrome-linux", "chrome"),
    ("chrome-mac", "Chromium"),
    ("chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
    ("chrome-headless-shell-mac-x64", "chrome-headless-shell"),
    ("chrome-headless-shell-win64", "chrome-headless-shell"),
    ("chrome-headless-shell-linux64", "chrome-headless-shell"),
];

/// Directories that look like an installed Chromium under `root`, best first.
///
/// Sorted by the build number embedded in the name (`chromium-1223`,
/// `chrome-headless-shell-140.0.7339.82`) rather than lexicographically, so
/// "newest first" survives the three-digit → four-digit rollover that made the
/// old `sort().reverse()` pick an older build.
pub(super) fn candidate_dirs(root: &std::path::Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .map(|n| {
                        let n = n.to_string_lossy();
                        n.starts_with("chromium")
                            || n.starts_with("chrome-headless-shell")
                            || n.starts_with("chrome-for-testing")
                    })
                    .unwrap_or(false)
        })
        .collect();
    dirs.sort_by(|a, b| build_rank(a).cmp(&build_rank(b)));
    dirs.reverse();
    dirs
}

/// The FIRST numeric component of a build directory name, for newest-first
/// ordering (`chrome-headless-shell-140.0.7339.82` → 140, `chromium-1223` →
/// 1223). The leading number is the build's own revision/major, which is the
/// only component that orders builds; the trailing ones are build metadata (the
/// patch component of two different majors says nothing). Names without a
/// number rank lowest so they never win.
pub(crate) fn build_rank(dir: &std::path::Path) -> u64 {
    dir.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
        .split(['-', '.'])
        .find_map(|part| part.parse::<u64>().ok())
        .unwrap_or(0)
}

/// Every build-dir + layout probe under `root`, as exact candidate paths.
/// Shared by `chromium_candidates` (which walks the app's browser roots) and
/// `make_executable` (which must find the binary INSIDE the just-unpacked
/// build — `find_chromium` cannot be used there: until the exec bit is set and
/// the layout is right, it still resolves to the previous install).
pub(super) fn binaries_under(root: &std::path::Path) -> Vec<PathBuf> {
    let exe = if cfg!(windows) { ".exe" } else { "" };
    let mut out = Vec::new();
    for dir in candidate_dirs(root) {
        for (fragment, binary) in BROWSER_LAYOUTS {
            if cfg!(target_os = "macos") {
                out.push(
                    dir.join(fragment)
                        .join(format!("{binary}.app/Contents/MacOS/{binary}")),
                );
            }
            out.push(dir.join(fragment).join(format!("{binary}{exe}")));
            // A flat unpack (the installer's own layout): <dir>/<binary>.
            out.push(dir.join(format!("{binary}{exe}")));
        }
    }
    out
}

/// Every bundled-Chromium binary the app may use, newest build first.
///
/// Deliberately EXCLUDES the system browsers. Running the automation browser
/// out of `/Applications/Google Chrome.app` gave the headless instance the same
/// bundle id (`com.google.Chrome`) as the user's real Chrome: it registered
/// with LaunchServices, spawned Chrome's own crashpad handler and GoogleUpdater
/// against the user's profile, and fought the real Chrome over the display
/// (`CVDisplayLinkCreateWithCGDisplay failed` on repeat). The user's everyday
/// browser froze while the app was open. So: either the app has its own
/// Chromium build (bundled here, or installed by the one-click flow), or the
/// browser feature reports itself as unavailable — it never hijacks the user's
/// browser. Installing Chromium is a deliberate, one-click action instead.
pub(super) fn chromium_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in browser_roots() {
        out.extend(binaries_under(&root));
    }
    out
}

/// First bundled Chromium that actually exists on disk.
pub(super) fn find_chromium() -> Option<PathBuf> {
    chromium_candidates().into_iter().find(|p| p.is_file())
}

/// True when no usable automation browser is installed. Kept as its own
/// function so the sidecar can offer the one-click install instead of failing
/// with an error the user cannot act on.
pub fn is_available() -> bool {
    find_chromium().is_some()
}

