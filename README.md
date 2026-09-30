# Porcupine

A mobile-first, password-protected PWA at https://porcupine.pstaylor.net for driving
Pi RPC sessions started by hand in tmux on the VM. It is served from the VM and
reachable only over the tailnet.

## Prerequisites

- Node 22 LTS (per-user install, not system packages)
- pi 0.99.1 under `~/.local` (`scripts/install-pi.sh`)
- Docker (for Terraform). TLS is served by the shared Caddy edge in ~/stack/caddy (site file sites/porcupine.caddy, route53 DNS-01); the hub must listen on the docker0 gateway: PORCUPINE_HUB_ADDR=172.17.0.1:8787
- The VM, laptop and phone on the same tailnet
- Secrets in `~/1-areas/pst/porcupine/secrets/.env` (never committed)

## Development

```sh
npm ci
npm run typecheck && npm run lint && npm test && npm run build
```

## Runbook

### Start order

1. Hub, in the tmux session `porcupine-hub`:
   ```sh
   tmux new-session -d -s porcupine-hub
   tmux send-keys -t porcupine-hub 'cd ~/code/pstaylor-patrick/porcupine && npm run build && PORCUPINE_HUB_ADDR=172.17.0.1:8787 node hub/dist/server/main.js' Enter
   ```
   After a rebuild, restart it in the same session (Ctrl-C, then rerun the command).
2. TLS: the shared Caddy edge in `~/stack/caddy` already proxies porcupine.pstaylor.net
   (sites/porcupine.caddy) to 172.17.0.1:8787. Porcupine does not start or edit it.
3. Sessions: in each repo's tmux pane run `porcupine [--name x] [pi args]`
   (or `node ~/code/pstaylor-patrick/porcupine/hub/dist/cli/main.js`). The pane prints logs only.

### Smoke test

```sh
npm run build && scripts/smoke.sh
```

It starts `porcupine --name smoke` in a temporary tmux session, logs in through
https://porcupine.pstaylor.net, lists and attaches, runs get_state,
get_available_models, set_thinking_level, a real prompt to agent_settled (the reply
must not be an error), new_session, a reattach with `since`, then SIGKILLs the CLI
and checks the hub prunes its socket. Any failed assertion exits non-zero.

### Logs

- Hub: `tmux attach -t porcupine-hub` (login failures and relay errors are logged there).
- Sessions: the tmux pane running `porcupine` (registered, hub connected, run started and settled, `pi:` stderr).
- TLS and certificates: the shared Caddy edge's logs in `~/stack/caddy`.
- Runtime files: `$XDG_RUNTIME_DIR/porcupine` (or `~/.porcupine/run`), one `.sock` and `.json` per session.

### Rotating secrets

- Cookie secret: replace `PORCUPINE_COOKIE_SECRET` in the secrets `.env` with the output of
  `openssl rand -hex 32` and restart the hub. Every browser is logged out.
- Password: change `PORCUPINE_RPC_PASSWORD` and restart the hub.
- IAM DNS-01 key (only if the IAM user is still used): run `scripts/caddy-keys.sh`, update the
  consumer, then delete the old key with `aws iam delete-access-key --profile personal`.

### After a VM restart

- Pi sessions are gone; their stale `.sock`/`.json` files are pruned by the hub on start.
- The shared Caddy edge comes back through Docker's restart policy.
- The hub does not restart itself: recreate the `porcupine-hub` tmux session (step 1),
  then start `porcupine` in each repo pane again.
