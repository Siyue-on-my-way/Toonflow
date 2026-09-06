#!/usr/bin/env bash
# ============================================================
# Toonflow 启动脚本（单镜像 = 前端 + 后端，Node 直接托管静态资源）
# MySQL / MinIO 暂复用旧栈容器（Toonflow-app/docker），确保其在线
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

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

# 3. 构建并启动
docker compose up -d --build

docker compose ps
echo "[start] 完成。访问 http://127.0.0.1:$(grep -E '^HOST_PORT=' .env | cut -d= -f2)/"
echo "[start] 查看日志: docker compose logs -f toonflow"
