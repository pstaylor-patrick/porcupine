#!/usr/bin/env bash
# Put the porcupine CLI on PATH (per user, no global npm install).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
[ -x "$root/hub/dist/cli/main.js" ] || (cd "$root" && npm run build)
mkdir -p "$HOME/.local/bin"
ln -sf "$root/hub/dist/cli/main.js" "$HOME/.local/bin/porcupine"
echo "linked $HOME/.local/bin/porcupine -> $root/hub/dist/cli/main.js"
