#!/bin/bash
set -e

COMPOSE_DIR="$(cd "$(dirname "$0")/docker" && pwd)"

echo "===> 停止并移除容器..."
docker-compose -f "$COMPOSE_DIR/docker-compose.yaml" down

echo "===> 清理空悬镜像、网络和空卷..."
docker image prune -f
docker network prune -f
docker volume prune -f

echo "===> 服务已停止。"
