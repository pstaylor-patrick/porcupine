#!/usr/bin/env bash
# Create an access key for the Caddy DNS-01 IAM user and write it to the
# secrets dir (never the repo). Rotation: delete the old key, rerun, restart Caddy.
set -euo pipefail

user="porcupine-caddy-dns01"
profile="${AWS_PROFILE:-personal}"
out="${PORCUPINE_CADDY_ENV:-$HOME/1-areas/pst/porcupine/secrets/caddy.env}"

count="$(aws iam list-access-keys --user-name "$user" --profile "$profile" \
  --query 'length(AccessKeyMetadata)' --output text)"
if [[ "$count" -ge 2 ]]; then
  echo "$user already has 2 access keys. Delete the old one first:" >&2
  echo "  aws iam list-access-keys --user-name $user --profile $profile" >&2
  echo "  aws iam delete-access-key --user-name $user --access-key-id <id> --profile $profile" >&2
  exit 1
fi

mkdir -p "$(dirname "$out")"
chmod 700 "$(dirname "$out")"
umask 077
read -r key_id secret < <(aws iam create-access-key --user-name "$user" --profile "$profile" \
  --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)

tmp="$(mktemp "$out.XXXXXX")"
printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\nAWS_REGION=us-east-1\n' "$key_id" "$secret" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$out"
echo "wrote $out (key $key_id)"
