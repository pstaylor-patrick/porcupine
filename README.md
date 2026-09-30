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
