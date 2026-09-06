# toonflow 前端静态资源服务器：Debian nginx + brotli 模块
# 用发行版自带的 libnginx-mod-http-brotli-* 包，免去编译（本机到 GitHub/Alpine CDN 的网络很慢）：
#   - ngx_http_brotli_static_module ：直接下发构建期预压缩好的 .br 文件（零 CPU 开销）
#   - ngx_http_brotli_filter_module ：对没有预压缩产物的响应做动态 brotli 兜底
FROM debian:bookworm-slim

# apt 走阿里云镜像（deb.debian.org / security.debian.org 都换掉）
RUN sed -i 's@deb.debian.org@mirrors.aliyun.com@g; s@security.debian.org@mirrors.aliyun.com@g' \
      /etc/apt/sources.list.d/debian.sources 2>/dev/null \
  || sed -i 's@deb.debian.org@mirrors.aliyun.com@g; s@security.debian.org@mirrors.aliyun.com@g' /etc/apt/sources.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
       nginx \
       libnginx-mod-http-brotli-filter \
       libnginx-mod-http-brotli-static \
       ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf /dev/stdout /var/log/nginx/access.log \
  && ln -sf /dev/stderr /var/log/nginx/error.log

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
