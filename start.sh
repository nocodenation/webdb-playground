#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
PGADMIN_TEMPLATES_DIR="${SCRIPT_DIR}/config/pgadmin/templates"
PGADMIN_OUTPUT_DIR="${SCRIPT_DIR}/config/pgadmin"
NGINX_TEMPLATES_DIR="${SCRIPT_DIR}/config/nginx/templates"
NGINX_OUTPUT_DIR="${SCRIPT_DIR}/config/nginx"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: .env file not found at ${ENV_FILE}" >&2
  exit 1
fi

# 1. Stop existing containers
echo "Stopping existing containers..."
"${SCRIPT_DIR}/down.sh"

# 2. Generate API key (updates API_KEY in .env)
echo "Generating API key..."
"${SCRIPT_DIR}/generate_api_key.sh"

sed_inplace() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

# 3. Render a template file by replacing {{ VAR_NAME }} placeholders with .env values
render_template() {
  local content
  content="$(<"$1")"
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    value="${value//\"/}"
    content="${content//\{\{ ${key} \}\}/${value}}"
  done < "$ENV_FILE"
  printf '%s\n' "$content"
}

# 3. Render pgadmin templates
for template in "${PGADMIN_TEMPLATES_DIR}"/*; do
  [[ -f "$template" ]] || continue
  filename="$(basename "$template")"
  outfile="${PGADMIN_OUTPUT_DIR}/${filename}"
  echo "Rendering pgadmin template: ${filename}"
  rm -rf "$outfile"
  render_template "$template" > "$outfile"
done

# 4. Render nginx templates
for template in "${NGINX_TEMPLATES_DIR}"/*; do
  [[ -f "$template" ]] || continue
  filename="$(basename "$template")"
  mkdir -p "$NGINX_OUTPUT_DIR"
  outfile="${NGINX_OUTPUT_DIR}/${filename}"
  echo "Rendering nginx template: ${filename}"
  rm -rf "$outfile"
  render_template "$template" > "$outfile"
  # Replace API_KEY_PLACEHOLDER with API_KEY from .env
  API_KEY="$(grep -E '^API_KEY=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"')"
  sed_inplace "s|API_KEY_PLACEHOLDER|${API_KEY}|g" "${NGINX_OUTPUT_DIR}/${filename}"
done


# 5. Ensure log directories exist and are writable by containers that
#    run as non-root (pgadmin_db, postgrest, nginx workers).
LOGS_DIR="${SCRIPT_DIR}/volumes/logs"
for svc in postgres pgadmin_db pgadmin proxy swagger; do
  mkdir -p "${LOGS_DIR}/${svc}"
  chmod 0777 "${LOGS_DIR}/${svc}"
done

# 6. Ensure shared network exists
docker network inspect nocodenation_playground_network >/dev/null 2>&1 \
  || docker network create nocodenation_playground_network

# 7. Start containers
echo "Starting containers..."
docker compose up -d

echo "pgAdmin is available on:          http://localhost:8100"
echo "REST interface is available on:   http://localhost:8101"
echo "Swagger UI is available on:       http://localhost:8102"
echo "OpenCode is available on:         http://localhost:8103"
echo "Node app is available on:         http://localhost:8104"
