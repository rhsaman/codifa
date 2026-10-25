#!/usr/bin/env bash
#
# One-double-click installer for Codifa on macOS.
#
# Why this exists: Codifa is not signed with an Apple Developer ID, so macOS
# Gatekeeper quarantines the downloaded disk image and refuses to open the app
# with "damaged and can't be opened" or "Apple could not verify...". Clearing
# that quarantine flag needs a shell command, so the user would otherwise have
# to open Terminal — which is exactly what this script removes.
#
# It downloads the release DMG, verifies the app's code signature, clears the
# quarantine attribute and installs into /Applications. Every step is printed
# so the user can read what happened.
#
# Usage:
#   bash install-macos.sh [version]
#
#   version  Optional release tag to install (e.g. v1.7.0). Defaults to the
#            latest published release.
#
# Note: the project currently publishes an Apple Silicon (arm64) DMG only, so
# this script refuses to run on Intel Macs instead of installing a binary that
# cannot execute.

set -euo pipefail

REPO="rhsaman/codifa"
APP_NAME="Codifa"
MIN_MACOS_MAJOR=11

usage() {
  sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- preconditions ----------------------------------------------------------

[[ "$(uname -s)" == "Darwin" ]] || die "this installer is for macOS only."

case "${1:-}" in
  -h|--help) usage 0 ;;
  "")        VERSION="" ;;
  -*)        die "unknown option '$1' (try --help)." ;;
  *)         VERSION="$1" ;;
esac

for tool in curl hdiutil ditto codesign; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' is missing; it ships with macOS."
done

os_major="$(sw_vers -productVersion | cut -d. -f1)"
(( os_major >= MIN_MACOS_MAJOR )) || die "macOS ${MIN_MACOS_MAJOR}+ is required (found $(sw_vers -productVersion))."

# Only an arm64 build is published today (see the header). Failing loudly here
# beats installing a binary that the CPU cannot run.
if [[ "$(uname -m)" != "arm64" ]]; then
  die "this release ships an Apple Silicon (arm64) build only, and this Mac is $(uname -m).
       Track Intel support at https://github.com/${REPO}/issues"
fi

if [[ -n "$VERSION" ]]; then
  RELEASE_BASE="https://github.com/${REPO}/releases/download/${VERSION}"
  api_url="https://api.github.com/repos/${REPO}/releases/tags/${VERSION}"
else
  RELEASE_BASE="https://github.com/${REPO}/releases/latest/download"
  api_url="https://api.github.com/repos/${REPO}/releases/latest"
fi

# --- locate the DMG ---------------------------------------------------------

# The bundler names its macOS disk images "Codifa-<version>-arm64.dmg"; the
# version comes from package.json at build time, so it is read from the release
# API instead of being hard-coded here.
log "Finding the ${APP_NAME} release…"
release_json="$(curl -fsSL "$api_url")" \
  || die "could not reach GitHub. Check your connection and try again."

dmg_name="$(printf '%s' "$release_json" \
  | grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*-arm64\.dmg"' \
  | head -n1 \
  | sed 's/.*"\([^"]*\)"$/\1/')"

if [[ -z "$dmg_name" ]]; then
  die "no arm64 DMG in that release. Assets found: $(printf '%s' "$release_json" | grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/' | tr '\n' ' ')"
fi

version_label="$(printf '%s' "$release_json" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed 's/.*"\([^"]*\)"$/\1/')"
log "Installing ${APP_NAME} ${version_label:-} (arm64) — ${dmg_name}"

# --- download into a private temp dir ---------------------------------------

workdir="$(mktemp -d "${TMPDIR:-/tmp}/codifa-install.XXXXXX")"
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT

dmg_path="${workdir}/${dmg_name}"
log "Downloading…"
curl -fL --progress-bar -o "$dmg_path" "${RELEASE_BASE}/${dmg_name}" \
  || die "download failed."

# --- mount, verify, copy, unmount -------------------------------------------

mountpoint="$(hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "${workdir}/mnt" \
  | sed -n 's/.*\(\/Volumes\/.*\)$/\1/p' | tail -n1)"
[[ -n "$mountpoint" && -d "$mountpoint" ]] || die "could not mount the disk image."

# The DMG must be detached on every exit path, including a verification failure.
detach() { hdiutil detach "$mountpoint" -quiet 2>/dev/null || true; }
trap 'detach; cleanup' EXIT

src_app="${mountpoint}/${APP_NAME}.app"
[[ -d "$src_app" ]] || die "${APP_NAME}.app is not in the disk image."

# There is no published checksum file, so the code signature is verified
# instead: it proves the bundle is intact and internally consistent, which is
# the same guarantee macOS itself enforces before running it. An ad-hoc signed
# bundle reports "Signature=adhoc", which is expected and not an error.
log "Verifying the code signature…"
if ! codesign --verify --deep --strict "$src_app" 2>"${workdir}/codesign.err"; then
  warn "signature verification failed:"
  sed 's/^/  /' "${workdir}/codesign.err" >&2
  die "refusing to install a bundle whose signature does not verify."
fi
sig_line="$(codesign -dvvv "$src_app" 2>&1 | grep -E '^(Authority|Signature)=' | head -n1 || true)"
log "  ${sig_line:-signed}"

# --- install ----------------------------------------------------------------

dest="/Applications/${APP_NAME}.app"
if [[ -e "$dest" ]]; then
  old_version="$(defaults read "${dest}/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo '?')"
  log "Replacing the installed ${APP_NAME} ${old_version}…"
fi

log "Installing to ${dest}…"
if [[ -w /Applications ]]; then
  rm -rf "$dest"
  ditto "$src_app" "$dest"
else
  # /Applications is group-writable for admin users on a stock macOS, but not
  # always — fall back to sudo rather than failing on a permission error.
  sudo rm -rf "$dest"
  sudo ditto "$src_app" "$dest"
fi

detach
trap cleanup EXIT

# --- clear quarantine -------------------------------------------------------

# Recursive on purpose: the flag is set on the DMG and inherited by every file
# copied out of it, so the bundle and its nested binaries all have to be
# cleared or the app is still refused at launch.
log "Clearing the Gatekeeper quarantine flag…"
xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true

# --- report -----------------------------------------------------------------

log "Installed ${APP_NAME} ${version_label:-} → ${dest}"
echo
echo "  Open it from Launchpad, Spotlight, or:"
echo "      open -a \"${APP_NAME}\""
echo
echo "  ${APP_NAME} is not notarized by Apple, so on first launch macOS may ask"
echo "  for microphone and screen-recording access — grant those in"
echo "  System Settings → Privacy & Security. This script already removed the"
echo "  'damaged' block that stops the app from opening at all."
