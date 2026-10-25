#!/usr/bin/env bash
#
# Export the local macOS code-signing identity as a base64 PKCS#12, ready to be
# pasted into the GitHub secret APPLE_CERTIFICATE.
#
# Why: macOS TCC keys a permission to the signing identity of the binary, not to
# its name or path. A bundle signed ad-hoc gets a fresh per-build cdhash, so
# Screen Recording is re-asked (or silently denied) after every rebuild. Signing
# with a stable identity — this one, locally and in CI — is the fix.
#
# The output is piped to the clipboard by default and NEVER written to disk in
# the repo, because it contains a private key. Keep the password you pass here in
# the GitHub secret APPLE_CERTIFICATE_PASSWORD; it is not recoverable.
#
# Usage:
#   scripts/export-signing-cert.sh                 # prompts for a password
#   CERT_PASSWORD=... scripts/export-signing-cert.sh
#
# The identity name (not its SHA-1 hash) is used everywhere so a renewed
# certificate with the same name keeps working without touching any config.

set -euo pipefail

IDENTITY="${CERT_IDENTITY:-Coder Dev Signing}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: this exports a macOS keychain identity and only runs on macOS" >&2
  exit 1
fi

if ! security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
  echo "error: no codesigning identity named '$IDENTITY' in the keychain." >&2
  echo "       Run 'security find-identity -v -p codesigning' to list what exists," >&2
  echo "       or pass CERT_IDENTITY=<name>." >&2
  exit 1
fi

if [[ -z "${CERT_PASSWORD:-}" ]]; then
  # -s hides the input; the value is used to encrypt the .p12, and the same
  # value must go into the APPLE_CERTIFICATE_PASSWORD secret.
  read -r -s -p "Password to protect the exported .p12: " CERT_PASSWORD
  echo
  if [[ -z "$CERT_PASSWORD" ]]; then
    echo "error: an empty password cannot protect the export" >&2
    exit 1
  fi
fi

# mktemp keeps the intermediate file out of the working tree; the trap removes
# it even when the export or the base64 step fails.
TMP_P12="$(mktemp -t codifa-signing-cert)"
trap 'rm -f "$TMP_P12"' EXIT

security export \
  -t identities \
  -f pkcs12 \
  -P "$CERT_PASSWORD" \
  -o "$TMP_P12" \
  "$IDENTITY"

if [[ ! -s "$TMP_P12" ]]; then
  echo "error: the keychain export produced no data for '$IDENTITY'" >&2
  exit 1
fi

BASE64_P12="$(base64 -i "$TMP_P12")"

if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$BASE64_P12" | pbcopy
  echo "Exported '$IDENTITY' and copied the base64 PKCS#12 to the clipboard."
  echo
  echo "Set these two GitHub repository secrets:"
  echo "  APPLE_CERTIFICATE           <- paste the clipboard (single line, no wrapping)"
  echo "  APPLE_CERTIFICATE_PASSWORD  <- the password you just typed"
  echo
  echo "Then re-run the Release workflow. For a real Developer ID (needed for"
  echo "notarization) also set APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD"
  echo "and APPLE_TEAM_ID."
else
  printf '%s\n' "$BASE64_P12"
fi
