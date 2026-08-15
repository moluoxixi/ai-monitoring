#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer only runs on macOS." >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(dirname "$SCRIPT_DIR")

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Opening the official Xcode Command Line Tools installer..."
  xcode-select --install
  echo "Complete the Apple installer, then run this command again." >&2
  exit 1
fi

cd "$PROJECT_ROOT"
echo "Xcode Command Line Tools are installed."
node scripts/check-desktop-prerequisites.mjs
