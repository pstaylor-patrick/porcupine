# Security

Porcupine gives whoever logs in a coding agent with shell access to the host.
Treat the password like an SSH key.

## Deployment model

- Run the hub on a private network (Tailscale, WireGuard, a LAN). Do not expose
  it to the public internet; the login page is the only barrier.
- Serve it over HTTPS. The session cookie is `Secure`, `HttpOnly` and
  `SameSite=Strict`, and WebSocket upgrades are refused unless their `Origin`
  matches `PORCUPINE_ORIGIN`.
- Keep secrets in `~/.config/porcupine/.env` (mode 600), outside the repo.
  The hub strips `PORCUPINE_RPC_PASSWORD` and `PORCUPINE_COOKIE_SECRET` from
  the environment pi runs in.
- Login attempts are rate limited per client IP. `X-Forwarded-For` is only
  trusted from loopback and Docker bridge addresses.

## Guardrails in this repo

- `.gitignore` excludes `.env*`, Terraform state, `backend.hcl` and `terraform.tfvars`.
- `scripts/hooks/pre-commit` runs gitleaks on staged changes, plus an optional
  personal denylist (see the README). `ruby install.rb` enables it.
- CI runs gitleaks over the full history, `npm audit` for production
  dependencies, and Dependabot keeps npm, Actions and Terraform providers current.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting (Security tab, "Report a
vulnerability") rather than a public issue.
