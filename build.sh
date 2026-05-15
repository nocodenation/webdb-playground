#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_TAG="webdb-playground-opencode:latest"
CONTEXT="${SCRIPT_DIR}/config/opencode"

# Drop any existing image so the build is forced from scratch
docker image rm "$IMAGE_TAG" >/dev/null 2>&1 || true

echo "Building ${IMAGE_TAG} from ${CONTEXT}..."
docker build --no-cache -t "$IMAGE_TAG" "$CONTEXT"

echo "Done."
