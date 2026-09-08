#!/usr/bin/env bash
# Compatibility entrypoint for the monorepo deployment layout.
# The canonical compose file lives at ../docker/docker-compose.yml; keeping
# this wrapper in the backend directory preserves the documented restart.sh
# command without starting the obsolete MySQL/MinIO/nginx stack.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec "$REPO_DIR/start.sh" "$@"
