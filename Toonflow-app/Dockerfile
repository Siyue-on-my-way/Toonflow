FROM node:24-bookworm-slim

WORKDIR /app

# 替换 Debian 源为阿里云镜像源，加速 apt-get
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources

# 安装原生模块所需的构建依赖
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# 设置 npm 和 yarn 的淘宝镜像源
ENV npm_config_registry=https://registry.npmmirror.com/
ENV yarn_config_registry=https://registry.npmmirror.com/

# 跳过 onnxruntime-node 的 CUDA 二进制下载（从 GitHub 下载，国内极慢）
# 该 App 不需要 GPU 推理，CPU 版本已随包内置，此项可安全跳过
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip

# 【优化核心】1. 先只拷贝 package.json 和 yarn.lock
COPY package.json yarn.lock ./

# 【优化核心】2. 剔除不需要的 electron 依赖
RUN node -e "const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));for(const section of ['dependencies','devDependencies']){if(!pkg[section]) continue;for(const name of ['custom-electron-titlebar','electron','electron-builder','electron-rebuild','electronmon']) delete pkg[section][name];}fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2)+'\n');"

# 【优化核心】3. 安装依赖。
# 只要 package.json 和 yarn.lock 不变，Docker 就会直接使用这一层的缓存，
# 以后修改代码就不需要重新安装依赖了！
RUN yarn install --frozen-lockfile && \
    yarn cache clean

# 4. 最后拷贝项目代码
COPY . .

# 5. 准备数据卷初始化目录
RUN mkdir -p /app/data.bundle && cp -r data/* /app/data.bundle/ || true

ENV NODE_ENV=dev
ENV PORT=10588

EXPOSE 10588

CMD ["yarn", "dev"]
