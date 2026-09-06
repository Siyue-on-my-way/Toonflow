import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
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
    base64Data: z.string(),
    type: z.string().optional().default("clip"),
    name: z.string(),
  }),
  async (req, res) => {
    const { base64Data, projectId, type = "clip", name } = req.body;
    const decoded = decodeBase64(base64Data);
    const ext = extensionFromMime(decoded.mimeType);
    const savePath = `/${projectId}/assets/${uuid()}.${ext}`;

    await u.oss.writeFile(savePath, decoded.buffer);
    const [id] = await u.db("o_assets").insert({
      type: type,
      projectId: projectId,
      name,
      startTime: Date.now(),
    });
    const [imageId] = await u.db("o_image").insert({
      filePath: savePath,
      type,
      assetsId: id,
      state: "已完成",
    });
    await u.db("o_assets").where("id", id).update({
      imageId: imageId,
    });
    res.status(200).send(success("上传成功"));
  },
);
