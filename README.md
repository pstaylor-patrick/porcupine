<p align="center"><img src="docs/hero.gif" width="480" alt="Porcupine: a lilac crayon scribble draws in and settles on the porcupine logo"></p>
<h1 align="center">Porcupine</h1>
<p align="center">Drive your pi coding-agent sessions from your phone.</p>
<p align="center">
  <a href="https://github.com/pstaylor-patrick/porcupine/actions/workflows/ci.yml"><img src="https://github.com/pstaylor-patrick/porcupine/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node 22+"></a>
</p>

Porcupine is a small, mobile-first PWA for [pi](https://github.com/earendil-works/pi)
coding-agent sessions. You start sessions in tmux on a machine you own; from a
phone or laptop browser you watch them stream, send prompts, switch models,
answer the agent's questions and stop runs. There is no cloud component.

> [!WARNING]
> A logged-in user can run shell commands on the host through the agent. Read
> [SECURITY.md](SECURITY.md) before exposing porcupine anywhere.

## How it works

```
phone / laptop ──HTTPS──> reverse proxy ──> porcupine-hub ──unix socket──> porcupine (in tmux) ──stdio──> pi --mode rpc
```

- `porcupine` wraps `pi --mode rpc` in a tmux pane and exposes it on a local Unix socket.
- `porcupine-hub` serves the PWA, checks the password and relays each browser to a session.
- Everything stays on your host and private network.

## Requirements

- Linux or macOS host with Node 22+, tmux and Ruby (for the installer)
- A private network between the host and your devices (Tailscale, WireGuard or a LAN)
- HTTPS in front of the hub. Service workers and `Secure` cookies need it;
  [examples/Caddyfile](examples/Caddyfile) shows one way.
- An OpenRouter API key. Anthropic and OpenAI keys are optional. The default model is
  Claude Opus 5.5 when `ANTHROPIC_API_KEY` is set, else DeepSeek V4 Pro, with low thinking.

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
the pre-commit hook and reports missing settings. Rerun it after each pull;
`--no-pi` skips the pi install.

## Configuration

Settings come from the process environment or the env file
(`PORCUPINE_ENV_FILE`, default `~/.config/porcupine/.env`).

| Variable | Default | Purpose |
|---|---|---|
| `PORCUPINE_ORIGIN` | required | URL you open the app at; other WebSocket origins are refused |
| `PORCUPINE_RPC_PASSWORD` | required | Login password |
| `PORCUPINE_COOKIE_SECRET` | required | Cookie signing key, `openssl rand -hex 32` |
| `PORCUPINE_HUB_ADDR` | `127.0.0.1:8787` | Hub listen address; use a Docker bridge IP if the proxy runs in Docker |
| `OPENROUTER_API_KEY` | required | OpenRouter key; serves every model not routed direct |
| `ANTHROPIC_API_KEY` | | Optional; serves Anthropic models from the Anthropic API |
| `OPENAI_API_KEY` | | Optional; serves OpenAI models from the OpenAI API |
| `PORCUPINE_MODEL` | see above | Default model for new sessions, as an OpenRouter-style `vendor/model` id; routed like any other |
| `PORCUPINE_RUNTIME_DIR` | `$XDG_RUNTIME_DIR/porcupine` | Session sockets |

Each model comes from exactly one provider. Anthropic models come only from the
Anthropic API and OpenAI models only from the OpenAI API; without their key they
are hidden, never served through OpenRouter. Every other vendor comes from
OpenRouter.

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and pull request
conventions. Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md), not in public issues.

## License

[MIT](LICENSE)
