# Contributing

Thanks for helping out. This file covers setup, the checks CI runs, and what a
good pull request looks like.

## Getting set up

You need Node 22 or newer, tmux and Ruby (for the installer).

```sh
git clone https://github.com/pstaylor-patrick/porcupine.git
cd porcupine
npm ci
cp .env.example .env   # fill in your values; .env is gitignored
ruby install.rb        # among other things, enables the pre-commit hook
```

`install.rb` sets `core.hooksPath` to `scripts/hooks`. If you skip it, run
`git config core.hooksPath scripts/hooks` yourself.

## Checks

Run the same checks CI runs before you open a pull request:

```sh
npm run typecheck && npm run lint && npm test && npm run build
```

CI also runs `npm audit`, gitleaks and a Terraform check (see
[.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Running locally

- `scripts/dev.sh` runs the hub on `127.0.0.1:8787` in dev mode (non-Secure
  cookie, localhost origin allowed). The hub refuses dev mode on a non-loopback
  address.
- `scripts/smoke.sh` is an end-to-end test: it starts a real pi session through
  the hub at `PORCUPINE_ORIGIN`, drives it with `scripts/smoke-client.mjs`, then
  checks the hub cleans up. The hub must be running and the repo built.

## Pre-commit hook

The hook in `scripts/hooks/pre-commit` runs
[gitleaks](https://github.com/gitleaks/gitleaks) on staged changes, using the
binary or Docker. It also blocks staged lines that match any string in
`~/.config/porcupine/denylist` (one per line, `#` for comments). Put your
domain, IP addresses, bucket names and similar there. That file never leaves
your machine.

Do not bypass the hook with `--no-verify`. If it flags a false positive, fix
the allowlist in `.gitleaks.toml` in the same pull request and say why.

## Commits and pull requests

- Keep changes small and focused. One concern per pull request.
- Write commit subjects in the imperative mood ("Add model filter", not
  "Added model filter"), under about 72 characters.
- CI must be green before merge.
- In the description, say what changed and how you tested it (commands run,
  devices or browsers used).
- Never commit `.env`, keys, tokens or deployment-specific details.

## Security issues

Do not open a public issue for a vulnerability. Follow
[SECURITY.md](SECURITY.md) instead.

## Regenerating the hero GIF

`npx -y -p playwright@1.63.0 node web/scripts/hero-gif.mjs` rewrites
`docs/hero.gif` (needs ffmpeg; see the script header for the Chromium install).
