# docker/nginx — 旧反向代理配置（保留备查）

当前单镜像方案由 Node 直接托管前端构建产物与 API，**不再使用 nginx**，
本目录仅保留旧栈的反代配置，供将来需要时（如 TLS 终结、多实例负载均衡）参考：

- `nginx.conf` —— 全局配置（含 brotli 模块）
- `default.conf` —— 站点配置（静态缓存策略 / Socket.IO 升级 / API 反代）

启用时需配合 `nginx-brotli.Dockerfile`（在 `Toonflow-app/docker/`），并在
`docker-compose.yml` 增加对应 service。
