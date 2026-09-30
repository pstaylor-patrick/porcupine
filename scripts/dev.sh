#!/usr/bin/env bash
# Runs the hub on localhost in dev mode (non-Secure cookie, localhost origin allowed).
# Not for production: the hub refuses dev mode on a non-loopback address.
set -euo pipefail
cd "$(dirname "$0")/.."
export PORCUPINE_DEV=1
export PORCUPINE_HUB_ADDR="${PORCUPINE_HUB_ADDR:-127.0.0.1:8787}"
if [ ! -f hub/dist/server/main.js ] || [ "${PORCUPINE_SKIP_BUILD:-0}" != "1" ]; then
  npm run build >/dev/null
fi
exec node hub/dist/server/main.js
