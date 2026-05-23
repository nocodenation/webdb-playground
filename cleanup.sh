#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PGADMIN_TEMPLATES_DIR="${SCRIPT_DIR}/config/pgadmin/templates"
PGADMIN_OUTPUT_DIR="${SCRIPT_DIR}/config/pgadmin"
NGINX_TEMPLATES_DIR="${SCRIPT_DIR}/config/nginx/templates"
NGINX_OUTPUT_DIR="${SCRIPT_DIR}/config/nginx"

# Remove rendered pgadmin config files
for template in "${PGADMIN_TEMPLATES_DIR}"/*; do
  [[ -f "$template" ]] || continue
  filename="$(basename "$template")"
  rm -rf "${PGADMIN_OUTPUT_DIR}/${filename}"
  echo "Removed: config/pgadmin/${filename}"
done

# Remove rendered nginx config files
for template in "${NGINX_TEMPLATES_DIR}"/*; do
  [[ -f "$template" ]] || continue
  filename="$(basename "$template")"
  rm -rf "${NGINX_OUTPUT_DIR}/${filename}"
  echo "Removed: config/nginx/${filename}"
done
