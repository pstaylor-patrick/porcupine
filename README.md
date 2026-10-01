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
- An OpenRouter API key. Anthropic and OpenAI keys are optional.

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

Audio and video attachments are transcribed locally by whisper.cpp; nothing is
sent to a cloud speech service. `ruby install.rb --whisper` clones whisper.cpp
at a pinned tag into `~/.local/src/whisper.cpp`, builds `whisper-cli` into
`~/.local/bin` (it needs git, cmake and a C++ compiler; apt: `build-essential
cmake`, or cmake is installed per user with pipx) and downloads the ggml base
model to `~/.local/share/porcupine/whisper/ggml-base.bin`. Without the flag the
installer offers the step when whisper is missing, and every run ends with a
`whisper:` status line. `PORCUPINE_WHISPER_MODEL` picks another model, either a
name such as `small` (resolved to `ggml-small.bin` in that directory) or an
absolute path to a `.bin`; `PORCUPINE_WHISPER_BIN` points at a different
`whisper-cli` binary.

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
| `PORCUPINE_MODEL` | | Overrides the default model for new sessions, as a `vendor/model` id; routed like any other |
| `PORCUPINE_RUNTIME_DIR` | `$XDG_RUNTIME_DIR/porcupine` | Session sockets |
| `PORCUPINE_AUTOCOMPACT_TOKENS` | `250000` | Compact a session once its context reaches this many tokens; `off` disables it |
| `PORCUPINE_AUTOCOMPACT_FALLBACK_PCT` | `80` | For models whose context window is at or below the token threshold, compact at this percent of the window instead |
| `PORCUPINE_CONFIRM_USD` | `0.5` | Attachment cost estimate that asks before spending |
| `PORCUPINE_CONFIRM_MINUTES` | `10` | Audio or video length that asks before transcribing |
| `PORCUPINE_VAPID_SUBJECT` | `mailto:porcupine@localhost` | Contact sent to Web Push services |
| `PORCUPINE_CF_BIN` | `~/.claude/cf/bin` | cf scripts used by the merge-mode picker |
| `PORCUPINE_RUBY` | `ruby` | Ruby used to run those scripts |
| `PORCUPINE_PI_BIN` | `pi` | pi binary for sessions and subagents |
| `PORCUPINE_WHISPER_BIN`, `PORCUPINE_WHISPER_MODEL` | | whisper.cpp binary and model, see Install |

### Data files

| Path | Contents |
|---|---|
| `${XDG_CONFIG_HOME:-~/.config}/porcupine/.env` | Settings and keys (never commit it) |
| `${XDG_CONFIG_HOME:-~/.config}/porcupine/vapid.json` | Web Push keys, mode 0600 |
| `${XDG_DATA_HOME:-~/.local/share}/porcupine/usage.jsonl` | Append-only usage ledger, one row per model response |
| `${XDG_DATA_HOME:-~/.local/share}/porcupine/budgets.json` | Budgets edited in Settings |
| `${XDG_DATA_HOME:-~/.local/share}/porcupine/budget-state.json` | Which 80%/100% warnings already fired this period |
| `${XDG_DATA_HOME:-~/.local/share}/porcupine/backfill.done` | Marker: the one-time usage backfill from `~/.pi/agent/sessions` ran |
| `${XDG_DATA_HOME:-~/.local/share}/porcupine/push-subscriptions.json` | Web Push subscriptions |
| `${XDG_DATA_HOME:-~/.local/share}/porcupine/uploads/` | Attachments, kept 30 days |

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
`porcupine --name x -- --thinking high`.
Each pane logs the model it starts on, and the app shows the current model in
settings. Ctrl-C in the pane ends the session; a reboot clears them all.

## Attachments

The "+" button left of the message box attaches files. Nothing happens to them
until you press Send: then each file uploads to the hub host, is preprocessed
there, and the message goes to pi with a list of absolute paths it opens with
its read tool. Up to 10 files per message, 2 GB each.

| Kind | What the hub produces |
|---|---|
| Images (png, jpeg, gif, webp, bmp; HEIC converted to png) | the file itself; pi sends it to vision models and skips it for text-only ones (the chip warns) |
| PDF | `text.txt` from pdftotext, plus a png for each page with no text |
| Audio (any `audio/*`, m4a, mp3, wav, ogg, opus, aac, flac, amr, caf) | `transcript.txt` from local whisper.cpp |
| Video (any `video/*`, mp4, mov, webm, mkv, m4v) | `transcript.txt` of the audio track and one frame every 10 s, at most 60 |
| Text, JSON, Markdown, CSV | the file itself |

Transcription needs whisper.cpp (`ruby install.rb --whisper`, see Install).
Without it audio and video chips warn, and processing reports a per-file error
in the message instead of dropping the file; video still gets its frames.

Before any processing the app estimates the cost at the selected model's input
price. When the estimate is over $0.50 or any audio or video runs longer than
10 minutes, a card asks twice (Continue, then Spend) before anything is spent;
Cancel keeps the message and the files. `PORCUPINE_CONFIRM_USD` and
`PORCUPINE_CONFIRM_MINUTES` change those thresholds.

Files are kept under `~/.local/share/porcupine/uploads/<session>/` (or
`$XDG_DATA_HOME/porcupine/uploads`) and deleted after 30 days, checked at hub
start and daily.

## Notifications and background agents

The sidebar marks each session as running (pulsing dot), unread (solid dot: it finished while nobody was looking at it), or waiting for input (`?`). Opening a session marks it read.

Settings > Notifications turns on Web Push for the current device. You get a notification when an agent finishes or an extension dialog (ask_user_question, a hook confirm) is waiting in a session you are not looking at, and when a budget crosses 80% or 100%. Tapping it opens that session.

- **iPhone and iPad:** Web Push only works when Porcupine is installed to the home screen (Share > Add to Home Screen) and opened from that icon. In a Safari tab the toggle stays unavailable.
- The hub generates VAPID keys once into `${XDG_CONFIG_HOME:-~/.config}/porcupine/vapid.json` (mode 0600). Keep that file: replacing it invalidates every subscription. Set `PORCUPINE_VAPID_SUBJECT` (for example `mailto:you@example.com`) to change the contact sent to push services; the default is `mailto:porcupine@localhost`.
- Subscriptions live in `${XDG_DATA_HOME:-~/.local/share}/porcupine/push-subscriptions.json`; ones the push service reports gone (404/410) are dropped.
- Sessions are still started from a terminal; there is no spawn button.

## Usage and budgets

Every model response is recorded with its tokens and pi's cost estimate.
Settings > Usage shows this month's spend per provider with a per-model
breakdown and a daily chart; the session sheet shows the session's tokens,
cost and context use. Settings > Budgets sets a monthly cap per direct
provider, or a prepaid balance for OpenRouter (whose live key balance is shown
when available). Crossing 80% or 100% shows a banner and sends a push
notification; prompts are never blocked.

## Session sheet

- **Context:** a meter of the context window, the auto-compact threshold for
  this session (a number of tokens, Off, or empty for the default; sent as
  `/autocompact`), and Compact now.
- **History:** the conversation tree. Fork here starts a new branch from a
  message you sent and puts that message back in the box to edit. Clone copies
  the current branch into a new session file, Switch opens another session file
  by path, and Rename names the session.
- **Merge mode (cf):** see below.

When a provider error triggers pi's automatic retry, a banner shows the attempt
with a Stop retrying button.

Type `/` in the message box for a list of the session's commands (extension
commands, skills and prompt templates); arrows move, Tab or Enter completes,
Esc closes it.

## Change fabric (cf) bridge

cf is a first-class citizen; porcupine has no permission system of its own.

- **Hooks:** the claude-hooks extension runs the hooks from
  `~/.claude/settings.json` with Claude Code semantics: SessionStart,
  UserPromptSubmit (output is added as context), PreToolUse (pi tools map to
  Bash, Edit, Write and Read; exit code 2 or a deny/block decision blocks the
  call, "ask" opens a confirm in the app), PostToolUse and Stop. A hook that
  times out (60 s by default) or fails otherwise lets the call through with a
  notice.
- **Merge mode:** the session sheet reads and sets the session's cf merge mode
  through cf's own scripts. New sessions start in cf's default.
- **Skills:** every `~/.claude/skills/<name>/SKILL.md`, cf's included, is a
  `/<name>` command. Claude-Code-only tools are mapped: AskUserQuestion to
  ask_user_question, Agent to the subagent tool; Workflow is not supported and
  the model is told so.

Subagents and loops run under the parent session's cf session id, so they
inherit its merge mode.

## Loops

`/loop 5m <prompt>` sends the prompt every 5 minutes (`30s`, `1h` also work);
`/loop <prompt>` lets the model pick each delay with its `schedule_next` tool
and end the loop with `stop_loop`; `/loop stop` ends it. A tick that lands
while the agent is busy is queued as a follow-up. The loop shows in the status
panel above the message box, survives `--continue`, and stops when the pane
exits.

## Subagents

The `subagent` tool runs tasks in separate pi processes, one at a time, in
parallel, or as a chain that passes each result to the next. Agents are defined
as Markdown files in `~/.pi/agent/agents/`; a general-purpose agent is built
in. Child models follow the same routing rules as the app, children get only
the provider key they need, and each child's progress, output and cost appear
as a collapsible block under the tool call in the parent transcript. A child
cannot ask you questions; it is told to decide for itself.

## Plan mode and todos

`/plan` toggles plan mode: edit and write tools are off and bash only runs
read-only commands. When the model writes a numbered `Plan:`, the app asks
whether to execute it, and progress shows in the status panel as steps are
marked done. `/plan-todos` lists the steps. Separately, the model can keep a
todo list with the `todo` tool; open items show in the status panel and
`/todos` lists them. Both are vendored from pi's MIT examples.

Extension changes reach a running session when it is restarted with
`porcupine -- --continue`.

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
