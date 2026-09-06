import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { decodeBase64 } from "@/utils/binary";
const router = express.Router();

// 通用文件写入接口：将 base64 数据写入 MinIO 对象存储，返回可访问的文件 URL
export default router.post(
  "/",
  validateFields({
    path: z.string(),
    base64Data: z.string(),
  }),
  async (req, res) => {
    const { path: objectPath, base64Data } = req.body;
    await u.oss.writeFile(objectPath, decodeBase64(base64Data).buffer);
    const url = await u.oss.getFileUrl(objectPath);
    res.status(200).send(success({ path: objectPath, url }));
  },
);
