#!/bin/bash
# Installs the latest Dominote release into /Applications.
# Usage: curl -fsSL https://raw.githubusercontent.com/dominik-hurcik/dominote-mac/main/install.sh | bash
#
# Files downloaded with curl do not get the macOS quarantine flag,
# so Gatekeeper does not block this unsigned build.
set -euo pipefail

REPO="dominik-hurcik/dominote-mac"
URL="https://github.com/$REPO/releases/latest/download/Dominote.app.zip"
APP="/Applications/Dominote.app"

if [ "$(uname)" != "Darwin" ]; then
  echo "Dominote only runs on macOS." >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading Dominote..."
curl -fL --progress-bar "$URL" -o "$tmp/Dominote.app.zip"
ditto -x -k "$tmp/Dominote.app.zip" "$tmp"
if [ ! -d "$tmp/Dominote.app" ]; then
  echo "The download did not contain Dominote.app." >&2
  exit 1
fi

# Close a running copy so it can be replaced. Notes are saved to disk as you type.
osascript -e 'quit app "Dominote"' >/dev/null 2>&1 || true

SUDO=""
[ -w /Applications ] || SUDO="sudo"
$SUDO rm -rf "$APP"
$SUDO ditto "$tmp/Dominote.app" "$APP"
$SUDO xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "Installed to $APP"
open "$APP"
