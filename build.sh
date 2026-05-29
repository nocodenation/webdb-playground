#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

build_image() {
  local tag="$1"
  local context="$2"
  docker image rm "$tag" >/dev/null 2>&1 || true
  echo "Building ${tag} from ${context}..."
  docker build --no-cache -t "$tag" "$context"
}

build_image "webdb-playground/opencode:latest" "${SCRIPT_DIR}/config/opencode"
build_image "webdb-playground/bun-runner:latest" "${SCRIPT_DIR}/config/bun_runner"

echo "Done."
