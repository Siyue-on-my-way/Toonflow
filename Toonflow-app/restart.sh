#!/bin/bash
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_DIR="$APP_DIR/docker"
WEB_DIR="$APP_DIR/Toonflow-web"
HOST_URL="http://8.148.26.166:2280"

if [ -d "$WEB_DIR" ]; then
  echo "===> 构建前端页面 (Toonflow-web)..."
  (cd "$WEB_DIR" && NODE_OPTIONS="--max-old-space-size=6144" yarn build-only)

  echo "===> 预压缩静态资源 (brotli/gzip)..."
  node "$APP_DIR/docker/scripts/compress_dist.mjs" "$WEB_DIR/dist"
else
  echo "===> 未找到 Toonflow-web 目录（$WEB_DIR），跳过前端构建"
fi

echo "===> 构建镜像..."
docker-compose -f "$COMPOSE_DIR/docker-compose.yaml" build

echo "===> 停止并移除旧容器..."
docker-compose -f "$COMPOSE_DIR/docker-compose.yaml" down

echo "===> 清理空悬镜像、网络和空卷..."
docker image prune -f
docker network prune -f
docker volume prune -f

echo "===> 启动服务..."
docker-compose -f "$COMPOSE_DIR/docker-compose.yaml" up -d

echo "===> 等待服务就绪..."
sleep 3

echo "===> 启动日志（最近 50 行）："
docker-compose -f "$COMPOSE_DIR/docker-compose.yaml" logs --tail=50

echo ""
echo "=============================="
echo "  服务已启动：$HOST_URL"
echo "=============================="
