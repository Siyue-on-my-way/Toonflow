import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { decodeBase64, extensionFromMime } from "@/utils/binary";
const router = express.Router();

// 新增资产
export default router.post(
  "/",
  validateFields({
    name: z.string(),
    describe: z.string(),
    projectId: z.number(),
    assetsItem: z.array(
      z.object({
        base64: z.string(),
        prompt: z.string(),
        describe: z.string(),
        name: z.string(),
      }),
    ),
  }),
  async (req, res) => {
    const { name, describe, projectId, assetsItem } = req.body;
    await Promise.all(
      assetsItem.map(async (i: { src?: string; base64: string; prompt: string }) => {
        if (i.base64) {
          const decoded = decodeBase64(i.base64, "音频");
          const ext = extensionFromMime(decoded.mimeType, "mp3");
          const savePath = `/${projectId}/assets/audio/${u.uuid()}.${ext}`;
          await u.oss.writeFile(savePath, decoded.buffer);
          i.src = savePath;
        }
      }),
    );

    const [id] = await u.db("o_assets").insert({
      name,
      describe,
      type: "audio",
      projectId,
      startTime: Date.now(),
    });
    for (const item of assetsItem) {
      const [assetsId] = await u.db("o_assets").insert({
        prompt: item.prompt,
        assetsId: id,
        type: "audio",
        describe: item.describe,
        name: item.name,
        projectId,
        startTime: Date.now(),
      });
      const [imageId] = await u.db("o_image").insert({
        filePath: item.src,
        type: "audio",
        assetsId,
        state: "已完成",
      });
      await u.db("o_assets").where("id", assetsId).update({
        imageId,
      });
    }

    res.status(200).send(success({ message: "新增资产成功" }));
  },
);
