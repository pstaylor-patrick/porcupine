#!/usr/bin/env bash
# Run Terraform for infra/ in a pinned container with the host's AWS SSO cache.
# Usage: scripts/tf.sh init | plan -out=tfplan | apply tfplan | ...
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="hashicorp/terraform:1.10.5@sha256:679ac5e095bf550bc726742cd12efa6050f0913080df479fdabfeb202953af28"

tailnet_ip="$(tailscale ip -4)"
tty_flags=(-i)
[[ -t 0 && -t 1 ]] && tty_flags=(-it)

exec docker run --rm "${tty_flags[@]}" \
  --user "$(id -u):$(id -g)" \
  -e HOME=/home/tf \
  -v "$repo_root/infra:/work" -w /work \
  -v "$HOME/.aws:/home/tf/.aws" \
  -e AWS_PROFILE=personal \
  -e TF_VAR_tailnet_ipv4="$tailnet_ip" \
  -e TF_IN_AUTOMATION=1 \
  "$image" "$@"
