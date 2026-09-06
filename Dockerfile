# ==============================================================================
# Toonflow 单镜像构建（前端 + 后端）
# 构建上下文 = 仓库根目录：  docker build -t toonflow:latest .
# ==============================================================================

# ---------- 阶段 1：构建前端 ----------
FROM node:24-bookworm-slim AS web

WORKDIR /web

ENV npm_config_registry=https://registry.npmmirror.com/
ENV yarn_config_registry=https://registry.npmmirror.com/
# vite 构建内存充足，避免大项目下 node 堆溢出
ENV NODE_OPTIONS=--max-old-space-size=8192

# 先拷贝依赖清单，利用 Docker 层缓存
COPY Toonflow-web/package.json Toonflow-web/yarn.lock ./
RUN yarn install --frozen-lockfile

COPY Toonflow-web/ ./
# 镜像内直接 vite build，不做 vue-tsc 全量类型检查（慢且易 OOM），类型检查留给本地/CI
RUN npx vite build

# ---------- 阶段 2：后端 ----------
FROM node:24-bookworm-slim

WORKDIR /app

# 替换 Debian 源为阿里云镜像源，加速 apt-get
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources

# 安装原生模块所需的构建依赖
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

ENV npm_config_registry=https://registry.npmmirror.com/
ENV yarn_config_registry=https://registry.npmmirror.com/

# 跳过 onnxruntime-node 的 CUDA 二进制下载（从 GitHub 下载，国内极慢）
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip

# 先只拷贝依赖清单，剔除 electron 相关依赖后安装，利用层缓存
COPY Toonflow-app/package.json Toonflow-app/yarn.lock ./
RUN node -e "const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));for(const section of ['dependencies','devDependencies']){if(!pkg[section]) continue;for(const name of ['custom-electron-titlebar','electron','electron-builder','electron-rebuild','electronmon']) delete pkg[section][name];}fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2)+'\n');"
RUN yarn install --frozen-lockfile && yarn cache clean

# 拷贝后端代码并执行生产构建
COPY Toonflow-app/ ./

# 服务端 bundle 必须移出 data/：data/ 运行时会被数据卷覆盖，
# 代码留在 data/ 里会导致升级镜像后仍跑旧代码
RUN yarn build && mkdir -p server && mv data/serve/app.js server/app.js

# 前端构建产物由 Node 直接托管（WEB_DIST 指向该目录）
COPY --from=web /web/dist /app/public

# 数据卷初始化包：默认资源（models/skills/assets/vendor/modelPrompt）随镜像分发，
# 首次启动由 entrypoint 拷入数据卷
RUN mkdir -p /app/data.bundle && cp -r data/* /app/data.bundle/ || true

# 数据卷初始化脚本打进镜像，不再依赖 bind mount
COPY Toonflow-app/docker/entrypoint.sh /app/entrypoint.sh

ENV NODE_ENV=prod
ENV PORT=10588
ENV WEB_DIST=/app/public

EXPOSE 10588

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
CMD ["node", "server/app.js"]
