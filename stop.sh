#!/usr/bin/env bash
# 只停新栈应用；旧栈 toonflow-mysql / toonflow-minio 继续运行（数据仍被其引用）
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR/docker"
docker compose down
