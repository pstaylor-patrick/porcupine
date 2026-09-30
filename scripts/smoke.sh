#!/usr/bin/env bash
# End-to-end smoke: real pi through the hub at https://porcupine.example.com.
# Starts `porcupine --name smoke` in a detached tmux session, runs
# scripts/smoke-client.mjs against it, kills the session and checks the hub
# prunes its socket. Requires the hub to be running (tmux session porcupine-hub)
# and the repo to be built. Exits non-zero on any failed assertion.
set -euo pipefail
cd "$(dirname "$0")/.."
repo="$PWD"

env_file="${PORCUPINE_ENV_FILE:-$HOME/.config/porcupine/.env}"
base_url="${SMOKE_BASE_URL:-https://porcupine.example.com}"
name="smoke"
tmux_session="porcupine-smoke-$$"
runtime_dir="${PORCUPINE_RUNTIME_DIR:-}"
if [ -z "$runtime_dir" ]; then
  if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -w "$XDG_RUNTIME_DIR" ]; then
    runtime_dir="$XDG_RUNTIME_DIR/porcupine"
  else
    runtime_dir="$HOME/.porcupine/run"
  fi
fi

die() { echo "smoke: FAIL $*" >&2; exit 1; }

password_key="PORCUPINE_RPC_PASSWORD"
password="$(grep -E "^${password_key}=" "$env_file" | head -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
[ -n "$password" ] || die "PORCUPINE_RPC_PASSWORD missing from $env_file"

[ -f hub/dist/cli/main.js ] || die "hub not built; run npm run build"
code="$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/api/me")" || die "hub unreachable at $base_url"
[ "$code" = "401" ] || die "expected 401 from $base_url/api/me without a cookie, got $code"

workdir="$(mktemp -d)"
cleanup() {
  tmux kill-session -t "$tmux_session" 2>/dev/null || true
  rm -rf "$workdir"
}
trap cleanup EXIT

tmux new-session -d -s "$tmux_session" -c "$workdir" \
  "PORCUPINE_ENV_FILE='$env_file' node '$repo/hub/dist/cli/main.js' --name $name 2>&1 | tee '$workdir/pane.log'"

# Wait for the CLI to register (metadata file with our name appears).
meta=""
for _ in $(seq 1 60); do
  meta="$(grep -l "\"name\": *\"$name\"" "$runtime_dir"/*.json 2>/dev/null | head -n1 || true)"
  [ -n "$meta" ] && break
  sleep 1
done
[ -n "$meta" ] || { cat "$workdir/pane.log" >&2 || true; die "porcupine --name $name did not register in $runtime_dir"; }
sock="${meta%.json}.sock"
echo "smoke: ok registered $(basename "${meta%.json}")"

out="$workdir/client.out"
if ! SMOKE_BASE_URL="$base_url" SMOKE_PASSWORD="$password" SMOKE_SESSION_NAME="$name" \
  node scripts/smoke-client.mjs | tee "$out"; then
  echo "--- pane log ---" >&2; cat "$workdir/pane.log" >&2 || true
  die "smoke client failed"
fi

# SIGKILL the CLI so the hub has to prune a stale socket, not a clean exit.
cli_pid="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid)' "$meta")"
pi_pid="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).piPid)' "$meta")"
kill -9 "$cli_pid" 2>/dev/null || true
kill "$pi_pid" 2>/dev/null || true
tmux kill-session -t "$tmux_session" 2>/dev/null || true

for _ in $(seq 1 20); do
  [ ! -e "$sock" ] && [ ! -e "$meta" ] && break
  sleep 1
done
[ ! -e "$sock" ] || die "socket $sock not pruned after kill"
[ ! -e "$meta" ] || die "metadata $meta not pruned after kill"
echo "smoke: ok socket pruned after kill"
echo "smoke: PASS"
