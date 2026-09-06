// import "./logger";
import "./err";
import "./env";
import express, { Request, Response, NextFunction } from "express";
import { Server } from "socket.io";
import http from "node:http";
import expressWs from "express-ws";
import logger from "morgan";
import cors from "cors";
import compression from "compression";
import buildRoute from "@/core";
import u from "@/utils";
import path from "path";
import fs from "fs";
import { startGenerationWorker } from "@/utils/generationWorker";
import jwt from "jsonwebtoken";
import socketInit from "@/socket/index";
import { isEletron } from "@/utils/getPath";
import { ensureThumbnail, ThumbnailSize } from "@/utils/image";

const app = express();
const server = http.createServer(app);

async function checkPermissions() {
  if (!isEletron()) return true;
  const userDataPath = u.getPath();
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.accessSync(userDataPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch (e) {
    const { dialog, app } = require("electron");
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "权限不足",
      message: "应用无法访问数据目录",
      detail: `无法读写以下目录：\n${userDataPath}\n\n请联系管理员授予权限，或以管理员身份运行本程序。`,
      buttons: ["确认退出"],
      defaultId: 0,
    });
    if (response === 0) {
      app.quit();
    }
  }
}

export default async function startServe(randomPort: Boolean = false) {
  await checkPermissions();

  await u.writeVersion();
  const io = new Server(server, { cors: { origin: "*" } });
  socketInit(io);

  if (process.env.NODE_ENV == "dev") await buildRoute();

  expressWs(app);

  app.use(logger("dev"));
  app.use(cors({ origin: "*" }));
  // gzip 压缩（默认 filter 只压 text 类，mp4/图片等已压缩格式自动跳过，
  // 与下方 MinIO 流式响应兼容）。取代原 nginx brotli/gzip_static 的兜底压缩
  app.use(compression());
  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ extended: true, limit: "100mb" }));

  // oss 对象存储：统一经由后端从 MinIO 读取（包括缩略图生成），不让前端/nginx 直连 MinIO
  const OSS_MIME_TYPES: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
  };

  // 静态资源（skills/assets/web）统一从 MinIO 读取，不再依赖本地磁盘挂载
  const STATIC_MIME_TYPES: Record<string, string> = {
    ...OSS_MIME_TYPES,
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
  };
  const staticContentType = (objectKey: string) => STATIC_MIME_TYPES[path.extname(objectKey).toLowerCase()] ?? "application/octet-stream";

  // 静态资源统一改为流式传输：直接把 MinIO 可读流 pipe 给响应，不再把整个文件缓冲进内存；
  // 也不走 res.send(Buffer)，Express 便不会为这些响应自动生成 ETag，避免强校验头干扰 nginx 侧的 gzip 压缩
  const streamOssFile = async (res: Response, objectKey: string, contentType: string) => {
    const { stream, size } = await u.oss.getFileStream(objectKey);
    res.set("Content-Type", contentType);
    res.set("Content-Length", String(size));
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  };

  // 前端静态资源（可选）：WEB_DIST 指向前端构建产物目录时由 Node 直接托管，
  // 免去独立 nginx；未设置（Electron / 纯后端模式）时自动跳过。
  // 必须放在下方 /oss、/skills、/assets 路由之前：前端 hashed 文件
  // （如 /assets/index-xxx.js）优先命中磁盘产物，miss 时再落到 MinIO 路由，
  // 与原 nginx try_files $uri @backend 语义一致
  const webDist = process.env.WEB_DIST;
  if (webDist && fs.existsSync(path.join(webDist, "index.html"))) {
    app.use(
      express.static(webDist, {
        // 与原 nginx 缓存策略对齐：带内容哈希的资源一年强缓存，index.html 协商缓存
        setHeaders(res, filePath) {
          if (filePath.endsWith(`index.html`)) res.setHeader("Cache-Control", "no-cache");
          else if (/-[A-Za-z0-9_-]{6,12}\.(js|mjs|css|woff2?|png|jpe?g|gif|svg|webp|ico)$/.test(filePath))
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        },
      }),
    );
    // SPA fallback：非后端前缀、无扩展名的 GET 请求回退到 index.html。
    // 放在下方鉴权中间件之前，保证浏览器直接刷新前端路由（无 token）不会 401
    app.use((req, res, next) => {
      if (req.method === "GET" && !path.extname(req.path) && !/^\/(api|oss|skills|assets|socket\.io)(\/|$)/.test(req.path)) {
        res.sendFile(path.join(webDist, "index.html"));
        return;
      }
      next();
    });
  }

  app.use("/oss", async (req, res, next) => {
    try {
      const objectKey = req.path;
      const ext = path.extname(objectKey).toLowerCase();
      const contentType = OSS_MIME_TYPES[ext] ?? "application/octet-stream";

      // 如果传参 size，则现场生成/读取缓存缩略图
      if (req.query.size) {
        const size = req.query.size as string;

        // 判断是否为 WIDTHxHEIGHT 格式，如 "200x300"：等比压缩到指定宽高边界
        const dimensMatch = size.match(/^(\d+)x(\d+)$/i);
        // 判断是否为百分比格式，如 "30"、"30%"：等比压缩到原图的指定百分比
        const percentMatch = size.match(/^(\d+(?:\.\d+)?)\s*%?$/);

        let sizeSubDir: string | undefined;
        let sizeOpts: ThumbnailSize | undefined;
        if (dimensMatch) {
          const w = parseInt(dimensMatch[1], 10);
          const h = parseInt(dimensMatch[2], 10);
          sizeSubDir = `${w}x${h}`;
          sizeOpts = { type: "dimensions", width: w, height: h };
        } else if (percentMatch) {
          const pct = parseFloat(percentMatch[1]);
          sizeSubDir = `${percentMatch[1]}p`;
          sizeOpts = { type: "percentage", value: pct };
        }

        if (sizeOpts && sizeSubDir) {
          const base = path.basename(objectKey, ext);
          const dir = path.dirname(objectKey);
          const smallImageKey = `smallImage${dir}/${base}_${sizeSubDir}${ext}`;

          const thumbnail = await ensureThumbnail(objectKey, smallImageKey, sizeOpts);
          if (thumbnail) {
            res.set("Content-Type", contentType);
            res.send(thumbnail);
            return;
          }
          // 缩略图生成失败，降级返回原图
        }
      }

      try {
        await streamOssFile(res, objectKey, contentType);
      } catch {
        res.status(404).end();
        return;
      }
    } catch (e) {
      next(e);
    }
  });
  // skills 静态资源：从 MinIO 读取，只允许图片文件访问，key 与本地相对路径一致（不加前缀）
  app.use("/skills", async (req, res) => {
    if (!/\.(jpe?g|png|gif|webp|svg|ico|bmp)$/i.test(req.path)) {
      res.status(403).end();
      return;
    }
    const objectKey = req.path.replace(/^\/+/, "");
    try {
      await streamOssFile(res, objectKey, staticContentType(objectKey));
    } catch {
      res.status(404).end();
    }
  });

  // assets 静态资源：从 MinIO 读取，key 与本地相对路径一致（不加前缀）
  app.use("/assets", async (req, res) => {
    const objectKey = req.path.replace(/^\/+/, "");
    try {
      await streamOssFile(res, objectKey, staticContentType(objectKey));
    } catch {
      res.status(404).end();
    }
  });

  app.use(async (req, res, next) => {
    const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
    if (!setting) return res.status(444).send({ message: "服务器秘钥未配置，请联系管理员" });
    const { value: tokenKey } = setting;
    // 从 header 或 query 参数获取 token
    const rawToken = req.headers.authorization || (req.query.token as string) || "";
    const token = rawToken.replace("Bearer ", "");
    // 白名单路径
    if (req.path === "/api/login/login" || req.path === "/api/register/register") return next();

    if (!token) return res.status(401).send({ message: "未提供token" });
    try {
      const decoded = jwt.verify(token, tokenKey as string);
      (req as any).user = decoded;
      next();
    } catch (err) {
      return res.status(401).send({ message: "无效的token" });
    }
  });

  const router = await import("@/router");
  await router.default(app);

  // 404 处理
  app.use((_, res, next: NextFunction) => {
    return res.status(404).send({ message: "API 404 Not Found" });
  });

  // 错误处理
  app.use((err: any, _: Request, res: Response, __: NextFunction) => {
    res.locals.message = err.message;
    res.locals.error = err;
    console.error(err);
    res.status(err.status || 500).send(err);
  });

  const port = randomPort ? 0 : 10588;
  return await new Promise((resolve) => {
    server.listen(port, async () => {
      const address = server.address();
      const realPort = typeof address === "string" ? address : address?.port;
      console.log(`[服务启动成功]: http://localhost:${realPort}`);
      startGenerationWorker();
      resolve(realPort);
    });
  });
}

// 支持await关闭
export function closeServe(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server) {
      server.close((err?: Error) => {
        if (err) return reject(err);
        console.log("[服务已关闭]");
        resolve();
      });
    } else {
      resolve();
    }
  });
}

const isElectron = typeof process.versions?.electron !== "undefined";
if (!isElectron) startServe();
