import express from "express";
import path from "node:path";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
const router = express.Router();

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

// 通用文件读取接口：从 MinIO 对象存储读取文件，以原始二进制返回
// 大文件（视频等）建议直接走 nginx -> MinIO 的静态地址，该接口用于需要经过后端鉴权/中转的场景
export default router.post(
  "/",
  validateFields({
    path: z.string(),
  }),
  async (req, res) => {
    const { path: objectPath } = req.body;
    const data = await u.oss.getFile(objectPath);
    const ext = path.extname(objectPath).toLowerCase();
    res.set("Content-Type", MIME_TYPES[ext] ?? "application/octet-stream");
    res.status(200).send(data);
  },
);
