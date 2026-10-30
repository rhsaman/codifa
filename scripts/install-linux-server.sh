#!/usr/bin/env bash
#
# One-command installer for the Codifa SERVER build on Linux.
#
# Codifa normally ships as a desktop app (.deb / .rpm / AppImage). This script
# installs the server build instead — the same binary without a desktop
# installer, for a machine you drive from a browser with `codifa serve`.
#
# It downloads `codifa-server-x86_64-unknown-linux-gnu.zip` from the release,
# unpacks it under $PREFIX/lib/codifa-server and symlinks the binary into
# $PREFIX/bin, so `codifa` lands on your PATH. Every step is printed so you can
# read what happened. Re-running it upgrades in place.
#
# Usage:
#   bash install-linux-server.sh [version]
#
#   version  Optional release tag to install (e.g. v2.0.1). Defaults to the
#            latest published release.
#
# Environment:
#   PREFIX   Install prefix (default: $HOME/.local). For a system-wide install
#            every user can run:
#              curl -fsSL .../install-linux-server.sh | sudo PREFIX=/usr/local bash
#
# The server binary is the desktop binary, so it still links the GTK 3 /
# WebKitGTK 4.1 stack; the script warns when those libraries are missing and
# names the packages per distro.

set -euo pipefail

REPO="rhsaman/codifa"
BIN_NAME="codifa"

usage() {
  # The header above is the help text: print it up to the first blank line.
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- arguments ---------------------------------------------------------------
#
# Parsed before the platform check so `--help` works anywhere (reading the
# guide is not installing it).
case "${1:-}" in
  -h|--help) usage 0 ;;
  "")        VERSION="" ;;
  -*)        die "unknown option '$1' (try --help)." ;;
  *)         VERSION="$1" ;;
esac

# --- preconditions ----------------------------------------------------------

[[ "$(uname -s)" == "Linux" ]] || die "this installer is for Linux only."

PREFIX="${PREFIX:-$HOME/.local}"

# A relative prefix would make the symlink point nowhere once the shell moves.
[[ "$PREFIX" == /* ]] || die "PREFIX must be an absolute path (got '$PREFIX')."

for tool in curl; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' is missing; install it first."
done

# One of these unpacks the zip; checked up front so the download is not wasted.
if ! command -v unzip >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
  die "neither 'unzip' nor 'python3' is available to unpack the archive."
fi

# The release only carries an x86_64 server zip: the other architectures have a
# desktop bundle (aarch64 has no server asset at all yet), so fail loudly here
# instead of downloading a zip that does not exist.
case "$(uname -m)" in
  x86_64|amd64) ZIP_ARCH="x86_64-unknown-linux-gnu" ;;
  aarch64|arm64)
    die "no aarch64 server build is published; run 'cargo build --release' from a checkout instead."
    ;;
  *) die "unsupported CPU '$(uname -m)'; the published server build is x86_64." ;;
esac

# --- locate the release asset -----------------------------------------------

if [[ -n "$VERSION" ]]; then
  RELEASE_BASE="https://github.com/${REPO}/releases/download/${VERSION}"
  api_url="https://api.github.com/repos/${REPO}/releases/tags/${VERSION}"
else
  RELEASE_BASE="https://github.com/${REPO}/releases/latest/download"
  api_url="https://api.github.com/repos/${REPO}/releases/latest"
fi

# The asset name carries the target triple, not the version, so there is nothing
# to hard-code here.
asset_name="codifa-server-${ZIP_ARCH}.zip"

# The asset URL is version-independent (`latest/download/<name>`), so the
# download itself needs no API call — the unauthenticated GitHub API is limited
# to 60 requests/hour per IP, which shared NATs and CI runners do hit. The API
# is consulted only for the version label and a better error message: when it
# fails, the output gets thinner, never the install.
version_label=""
assets_hint=""
# Best-effort: a rate-limited or offline API only costs the version label and
# the richer error message, so its stderr stays quiet.
if release_json="$(curl -fsSL "$api_url" 2>/dev/null)"; then
  version_label="$(printf '%s' "$release_json" \
    | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 \
    | sed 's/.*"\([^"]*\)"$/\1/')"
  assets_hint="$(printf '%s' "$release_json" \
    | grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | sed 's/.*"\([^"]*\)"$/\1/' | tr '\n' ' ')"
fi

# The tag is only known when the API answered; without it, name what we install.
label="${version_label:-${VERSION:-latest}}"

log "Installing ${BIN_NAME} server ${label} — ${asset_name}"

# --- download and unpack ----------------------------------------------------

workdir="$(mktemp -d "${TMPDIR:-/tmp}/codifa-server-install.XXXXXX")"
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT

zip_path="${workdir}/${asset_name}"
log "Downloading…"
if ! curl -fL --progress-bar -o "$zip_path" "${RELEASE_BASE}/${asset_name}"; then
  if [[ -n "$assets_hint" ]]; then
    die "download failed; ${asset_name} is not in that release. Assets found: ${assets_hint}"
  fi
  die "download failed. Check the tag and your connection."
fi

staging="${workdir}/unpacked"
mkdir -p "$staging"
log "Unpacking…"
if command -v unzip >/dev/null 2>&1; then
  unzip -q -o "$zip_path" -d "$staging" || die "could not unpack ${asset_name}."
elif command -v python3 >/dev/null 2>&1; then
  # Servers do not always carry unzip; python3 is the next best bet.
  python3 -m zipfile -e "$zip_path" "$staging" || die "could not unpack ${asset_name}."
else
  die "neither 'unzip' nor 'python3' is available to unpack the archive."
fi

local_bin="${staging}/${BIN_NAME}"
[[ -f "$local_bin" ]] || die "${BIN_NAME} is not in ${asset_name}."

# A truncated download still unpacks into SOMETHING, so check the payload looks
# like a Linux executable before it replaces a working install.
head -c 4 "$local_bin" | od -An -tx1 | tr -d ' \n' | grep -q '^7f454c46' \
  || die "${local_bin} is not an ELF binary; the download looks corrupt."

# --- install ----------------------------------------------------------------

libdir="${PREFIX}/lib/codifa-server"
bindir="${PREFIX}/bin"

log "Installing to ${libdir}…"
mkdir -p "$libdir" "$bindir"

# Replace, never merge: a stale file from an older build would still be reachable
# through the symlink otherwise.
install -m 0755 "$local_bin" "${libdir}/${BIN_NAME}"
if [[ -f "${staging}/SERVER.md" ]]; then
  install -m 0644 "${staging}/SERVER.md" "${libdir}/SERVER.md"
fi

link="${bindir}/${BIN_NAME}"
ln -sfn "${libdir}/${BIN_NAME}" "$link"
log "Linked ${link} → ${libdir}/${BIN_NAME}"

# --- runtime libraries ------------------------------------------------------

# The server binary is the desktop binary, so the GTK/WebKit stack is still a
# link-time dependency; a headless box without it cannot start. Detection is
# best-effort (the sonames differ across distros), hence a warning with the
# package names rather than a hard failure.
if command -v ldconfig >/dev/null 2>&1; then
  missing=()
  for lib in libwebkit2gtk-4.1.so.0 libgtk-3.so.0; do
    ldconfig -p 2>/dev/null | grep -q "$lib" || missing+=("$lib")
  done
  if (( ${#missing[@]} > 0 )); then
    warn "missing runtime libraries: ${missing[*]}"
    echo "  Debian/Ubuntu: sudo apt-get install -y libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1" >&2
    echo "  Fedora:        sudo dnf install -y webkit2gtk4.1 gtk3 libappindicator-gtk3" >&2
    echo "  Arch:          sudo pacman -S --needed webkit2gtk-4.1 gtk3 libayatana-appindicator" >&2
  fi
fi

# --- report -----------------------------------------------------------------

case ":$PATH:" in
  *":${bindir}:"*) ;;
  *)
    warn "${bindir} is not on your PATH."
    echo "  Add it, e.g. for bash:  echo 'export PATH=\"${bindir}:\$PATH\"' >> ~/.bashrc" >&2
    ;;
esac

log "Installed ${BIN_NAME} ${label} → ${link}"
echo
echo "  Start the server (it prints the access URL with its token):"
echo "      ${BIN_NAME} serve --host 0.0.0.0 --port 8787"
echo
echo "  Run it in the background / stop it:"
echo "      ${BIN_NAME} serve --daemon"
echo "      ${BIN_NAME} stop"
echo
echo "  Keep the token private — the server runs commands on this machine. Put a"
echo "  public deployment behind TLS. Docs:"
echo "      https://github.com/${REPO}#-server-mode-use-it-from-a-browser"
echo
echo "  Offline notes shipped with this build: ${libdir}/SERVER.md"
