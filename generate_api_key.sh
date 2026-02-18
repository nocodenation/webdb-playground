#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: .env file not found at ${ENV_FILE}" >&2
  exit 1
fi

POSTGREST_JWT_SECTET="$(grep -E '^POSTGREST_JWT_SECTET=' "$ENV_FILE" | cut -d'=' -f2-)"

if [[ -z "$POSTGREST_JWT_SECTET" ]]; then
  echo "Error: POSTGREST_JWT_SECTET is not set in .env" >&2
  exit 1
fi

base64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

header=$(printf '{"alg":"HS256","typ":"JWT"}' | base64url)
payload=$(printf '{"role":"api_user"}' | base64url)
signature=$(printf '%s.%s' "$header" "$payload" \
  | openssl dgst -sha256 -hmac "$POSTGREST_JWT_SECTET" -binary \
  | base64url)

token="${header}.${payload}.${signature}"

# Update API_KEY in .env
if grep -q '^API_KEY=' "$ENV_FILE"; then
  sed -i '' "s|^API_KEY=.*|API_KEY=\"${token}\"|" "$ENV_FILE"
else
  echo "API_KEY=\"${token}\"" >> "$ENV_FILE"
fi

echo "$token"
