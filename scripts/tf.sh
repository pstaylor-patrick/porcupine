#!/usr/bin/env bash
# Run Terraform for infra/ in a pinned container with the host's AWS config.
# Usage: scripts/tf.sh init | plan -out=tfplan | apply tfplan | ...
# Needs infra/backend.hcl and infra/terraform.tfvars (copy the .example files).
# The record's IP is PORCUPINE_HOST_IP, else this host's Tailscale IPv4.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="hashicorp/terraform:1.10.5@sha256:679ac5e095bf550bc726742cd12efa6050f0913080df479fdabfeb202953af28"

for f in backend.hcl terraform.tfvars; do
  [[ -f "$repo_root/infra/$f" ]] || { echo "missing infra/$f; copy infra/$f.example and fill it in" >&2; exit 1; }
done
host_ip="${PORCUPINE_HOST_IP:-$(tailscale ip -4 2>/dev/null || true)}"
[[ -n "$host_ip" ]] || { echo "set PORCUPINE_HOST_IP to the hub host's private IPv4" >&2; exit 1; }

args=("$@")
[[ "${1:-}" == "init" ]] && args+=(-backend-config=backend.hcl)

tty_flags=(-i)
[[ -t 0 && -t 1 ]] && tty_flags=(-it)

exec docker run --rm "${tty_flags[@]}" \
  --user "$(id -u):$(id -g)" \
  -e HOME=/home/tf \
  -v "$repo_root/infra:/work" -w /work \
  -v "$HOME/.aws:/home/tf/.aws" \
  -e AWS_PROFILE="${AWS_PROFILE:-default}" \
  -e TF_VAR_host_ipv4="$host_ip" \
  -e TF_IN_AUTOMATION=1 \
  "$image" "${args[@]}"
