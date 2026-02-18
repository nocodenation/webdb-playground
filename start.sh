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
"${SCRIPT_DIR}/stop.sh"

# 2. Generate API key (updates API_KEY in .env)
echo "Generating API key..."
"${SCRIPT_DIR}/generate_api_key.sh"

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
  echo "Rendering pgadmin template: ${filename}"
  render_template "$template" > "${PGADMIN_OUTPUT_DIR}/${filename}"
done

# 4. Render nginx templates
for template in "${NGINX_TEMPLATES_DIR}"/*; do
  [[ -f "$template" ]] || continue
  filename="$(basename "$template")"
  echo "Rendering nginx template: ${filename}"
  mkdir -p "$NGINX_OUTPUT_DIR"
  render_template "$template" > "${NGINX_OUTPUT_DIR}/${filename}"
  # Replace API_KEY_PLACEHOLDER with API_KEY from .env
  API_KEY="$(grep -E '^API_KEY=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"')"
  sed -i '' "s|API_KEY_PLACEHOLDER|${API_KEY}|g" "${NGINX_OUTPUT_DIR}/${filename}"
done


# 5. Ensure shared network exists
docker network inspect nocodenation_playground_network >/dev/null 2>&1 \
  || docker network create nocodenation_playground_network

# 6. Start containers
echo "Starting containers..."
docker compose up -d
