import express from "express";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { decodeBase64, extensionFromMime } from "@/utils/binary";
const router = express.Router();

// 文件上传（支持图片、音频、视频）
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    base64Data: z.string(),
  }),
  async (req, res) => {
    const { base64Data, projectId, scriptId } = req.body;
    const decoded = decodeBase64(base64Data);
    const ext = extensionFromMime(decoded.mimeType);
    if (!["jpeg", "jpg", "png"].includes(ext)) {
      return res.status(400).send(error("不支持的文件类型"));
    }
    const savePath = `/${projectId}/imageFlow/${scriptId}/${uuid()}.${ext}`;

    await u.oss.writeFile(savePath, decoded.buffer);
    const url = await u.oss.getSmallImageUrl(savePath);
    res.status(200).send(success(url));
  },
);
