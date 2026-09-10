import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getAssetBoard } from "@/lib/quickVideo/media";

const router = express.Router();

/**
 * 资产中心白板：项目范围内聊天/白板生成的图片与视频索引，分页返回，短期预览/播放地址
 * 按需签发。聊天卡片与白板卡片共用同一份 o_quickVideoMedia 索引，见 media.ts。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    sessionId: z.number().optional(),
    kind: z.enum(["all", "image", "video"]).optional(),
    state: z.enum(["all", "generating", "done", "failed"]).optional(),
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(60).optional(),
  }),
  async (req, res) => {
    const { projectId, sessionId, kind, state, page, pageSize } = req.body;
    const result = await getAssetBoard(projectId, { sessionId, kind, state, page, pageSize });
    res.status(200).send(success(result));
  },
);
