# Porcupine

A small, mobile-first PWA for driving [pi](https://github.com/earendil-works/pi)
coding-agent sessions from your phone or laptop. You start sessions in tmux on
a machine you own; porcupine lets you watch them stream, send prompts, switch
models, answer the agent's questions and stop runs from a browser.

```
phone / laptop ──HTTPS──> reverse proxy ──> porcupine-hub ──unix socket──> porcupine (in tmux) ──stdio──> pi --mode rpc
```

- `porcupine` wraps `pi --mode rpc` in a tmux pane and exposes it on a local Unix socket.
- `porcupine-hub` serves the PWA, checks the password and relays each browser to a session.
- Everything stays on your host and private network. There is no cloud component.

See [SECURITY.md](SECURITY.md) before exposing it anywhere: a logged-in user can
run shell commands on the host through the agent.

## Requirements

- Linux or macOS host with Node 22+, tmux and Ruby (for the installer)
- A private network between the host and your devices (Tailscale, WireGuard or a LAN)
- HTTPS in front of the hub. Service workers and `Secure` cookies need it;
  [examples/Caddyfile](examples/Caddyfile) shows one way.
- A model provider key pi can use. The default model is
  `vercel-ai-gateway` / `anthropic/claude-opus-5.5` with low thinking.

## Install

```sh
git clone https://github.com/pstaylor-patrick/porcupine.git
cd porcupine
mkdir -p ~/.config/porcupine && cp .env.example ~/.config/porcupine/.env && chmod 600 ~/.config/porcupine/.env
$EDITOR ~/.config/porcupine/.env   # PORCUPINE_ORIGIN, password, cookie secret, provider key
ruby install.rb
```

`install.rb` checks prerequisites, builds, installs the pinned pi under
`~/.local`, links `porcupine` and `porcupine-hub` into `~/.local/bin`, enables
the repo's pre-commit hook and reports which settings are missing. Rerun it
after each pull. `--no-pi` skips the pi install.

## Configuration

Settings come from the process environment or the env file
(`PORCUPINE_ENV_FILE`, default `~/.config/porcupine/.env`).

| Variable | Default | Purpose |
|---|---|---|
| `PORCUPINE_ORIGIN` | required | URL you open the app at; other WebSocket origins are refused |
| `PORCUPINE_RPC_PASSWORD` | required | Login password |
| `PORCUPINE_COOKIE_SECRET` | required | Cookie signing key, `openssl rand -hex 32` |
| `PORCUPINE_HUB_ADDR` | `127.0.0.1:8787` | Hub listen address; use a Docker bridge IP if the proxy runs in Docker |
| `VERCEL_AI_GATEWAY_API_KEY` | | Passed to pi as `AI_GATEWAY_API_KEY` |
| `PORCUPINE_RUNTIME_DIR` | `$XDG_RUNTIME_DIR/porcupine` | Session sockets |

## Run

Start the hub once, in its own tmux session:

```sh
tmux new-session -d -s porcupine-hub porcupine-hub
```

Then start a named session in any repo you want pi to work in:

```sh
tmux new-session -s myrepo -c ~/code/myrepo 'porcupine --name myrepo'
```

It appears in the app's sidebar. Without `--name` the name is the tmux
`session:window`, else the folder name. Arguments after `--` go to pi, e.g.
`porcupine --name x -- --model anthropic/claude-sonnet-5.5 --thinking high`.
Ctrl-C in the pane ends the session; a reboot clears them all.

## Optional: DNS and TLS on AWS

`infra/` is a Terraform example for a public hostname that points at a private
IP, with an IAM user scoped to the DNS-01 TXT record Caddy needs for Let's
Encrypt. Copy `infra/backend.hcl.example` and `infra/terraform.tfvars.example`
to their untracked names, then:

```sh
scripts/tf.sh init && scripts/tf.sh plan -out=tfplan && scripts/tf.sh apply tfplan
scripts/caddy-keys.sh   # writes the IAM access key to ~/.config/porcupine/caddy.env
```

## Development

```sh
npm ci
npm run typecheck && npm run lint && npm test && npm run build
scripts/dev.sh          # hub on localhost in dev mode
scripts/smoke.sh        # end-to-end against a running hub and real pi
```

### Keeping your details out of commits

The pre-commit hook runs [gitleaks](https://github.com/gitleaks/gitleaks) on
staged changes (the binary, or Docker if it is not installed). To also block
strings specific to your deployment, such as your domain or network addresses,
list them one per line in `~/.config/porcupine/denylist`. That file stays on
your machine.

## Logs

- Hub: `tmux attach -t porcupine-hub` (logins, relay errors).
- Sessions: each `porcupine` pane (registration, runs, pi stderr).

## Rotating secrets

- Cookie secret: replace `PORCUPINE_COOKIE_SECRET`, restart the hub. Every browser is logged out.
- Password: change `PORCUPINE_RPC_PASSWORD`, restart the hub.
- DNS-01 key: `scripts/caddy-keys.sh`, restart the proxy, then delete the old key with `aws iam delete-access-key`.

## License

[MIT](LICENSE)
