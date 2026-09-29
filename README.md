# Porcupine

A mobile-first, password-protected PWA at https://porcupine.example.com for driving
Pi RPC sessions started by hand in tmux on the VM. It is served from the VM and
reachable only over the tailnet.

## Prerequisites

- Node 22 LTS (per-user install, not system packages)
- pi 0.99.1 under `~/.local` (`scripts/install-pi.sh`)
- Docker (for Caddy and Terraform)
- The VM, laptop and phone on the same tailnet
- Secrets in `~/.config/porcupine/.env` (never committed)

## Development

```sh
npm ci
npm run typecheck && npm run lint && npm test && npm run build
```
