#!/usr/bin/env bash
# ============================================================
# Toonflow 启动脚本（单镜像 = 前端 + 后端，Node 直接托管静态资源）
# MySQL / MinIO 暂复用旧栈容器（Toonflow-app/docker），确保其在线
# ============================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_DIR="$REPO_DIR/docker"
cd "$COMPOSE_DIR"

BUILD=false
BUILD_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --build)
      BUILD=true
      ;;
    --no-cache)
      BUILD=true
      BUILD_ARGS+=(--no-cache)
      ;;
    --restart-only)
      BUILD=false
      ;;
    --help|-h)
      echo "Usage: $0 [--build] [--no-cache] [--restart-only]"
      exit 0
      ;;
    *)
      echo "[start] 未知参数：$arg" >&2
      exit 2
      ;;
  esac
done

DOCKER_BUILD_LOCK_FILE="${DOCKER_BUILD_LOCK_FILE:-/tmp/multica-docker-build.lock}"
DOCKER_HOUSEKEEPING_SCRIPT="${DOCKER_HOUSEKEEPING_SCRIPT:-/mnt/a-opensource-tools/multica/scripts/docker-housekeeping.sh}"

run_locked_build() {
  command -v flock >/dev/null 2>&1 || {
    echo "[start] 未找到 flock，拒绝在没有构建锁的情况下执行 Docker 构建。" >&2
    exit 1
  }
  mkdir -p -- "$(dirname -- "$DOCKER_BUILD_LOCK_FILE")"
  (
    exec 9>"$DOCKER_BUILD_LOCK_FILE"
    flock 9
    docker compose build "${BUILD_ARGS[@]}"
  )
}

run_housekeeping() {
  if [ -x "$DOCKER_HOUSEKEEPING_SCRIPT" ]; then
    "$DOCKER_HOUSEKEEPING_SCRIPT"
  else
    echo "[start] 警告：统一 Docker 清理脚本不存在，跳过：$DOCKER_HOUSEKEEPING_SCRIPT" >&2
  fi
}

# 1. .env 缺失时从模板生成（含密钥需人工填写，生成后直接退出）
if [ ! -f .env ]; then
  cp .env.example .env
  echo "[start] .env 不存在，已从 .env.example 生成；请修改数据库/密钥配置后重新执行"
  exit 1
fi

# 2. 复用的旧栈 mysql/minio 若被停掉则拉起（容器已删除时给出警告）
for c in toonflow-mysql toonflow-minio; do
  if ! docker ps --format '{{.Names}}' | grep -qx "$c"; then
    docker start "$c" 2>/dev/null \
      || echo "[start] 警告：容器 $c 不存在，数据库/对象存储不可用将导致应用启动失败"
  fi
done

# 3. 按需构建并启动；普通启动直接复用已有镜像
if [ "$BUILD" = true ]; then
  echo "[start] 使用共享构建锁构建镜像..."
  run_locked_build
else
  echo "[start] 跳过镜像构建，复用已有镜像..."
fi

docker compose up -d

if [ "$BUILD" = true ]; then
  run_housekeeping
fi

docker compose ps
echo "[start] 完成。访问 http://127.0.0.1:$(grep -E '^HOST_PORT=' .env | cut -d= -f2)/"
echo "[start] 查看日志: docker compose logs -f toonflow"
