import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { loadQuickVideoState } from "@/lib/quickVideo/state";

const router = express.Router();

/**
 * 镜头产物访问地址：读取快照回写后的 imageRef/videoRef，
 * 返回 shotId -> { imageUrl, videoUrl } 映射（OSS 直链/代理链）。
 * 前端在存在已完成镜头时按需调用，避免轮询聚合查询反复签地址。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
  }),
  async (req, res) => {
    const { projectId } = req.body;
    const state = await loadQuickVideoState(projectId);
    const shots = state?.storyboard?.shots ?? [];
    const media: Record<string, { imageUrl: string | null; videoUrl: string | null }> = {};

    await Promise.all(
      shots
        .filter((s) => s.imageRef || s.videoRef)
        .map(async (s) => {
          const [imageUrl, videoUrl] = await Promise.all([
            s.imageRef ? u.oss.getSmallImageUrl(s.imageRef).catch(() => null) : Promise.resolve(null),
            s.videoRef ? u.oss.getFileUrl(s.videoRef).catch(() => null) : Promise.resolve(null),
          ]);
          media[s.id] = { imageUrl, videoUrl };
        }),
    );

    res.status(200).send(success({ media }));
  },
);
