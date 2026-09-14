import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { loadQuickVideoState } from "@/lib/quickVideo/state";
import { getImageFilePath } from "@/lib/quickVideo/media";
import { ShotMediaUrls, resolveVideoPosterUrl } from "@/lib/quickVideo/contract";

export type { ShotMediaUrls };

const router = express.Router();

/**
 * 镜头产物访问地址：读取快照回写后的 imageRef/videoRef，以及草稿阶段人工绑定的首帧引用，
 * 返回 shotId -> ShotMediaUrls 映射（OSS 直链/代理链）。
 * 前端在存在已完成镜头或已绑定首帧时按需调用，避免轮询聚合查询反复签地址；
 * 预览地址不落库（不写入 o_agentWorkData），过期/加载失败时由前端重新调用本接口获取。
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
    const media: Record<string, ShotMediaUrls> = {};

    await Promise.all(
      shots
        .filter((s) => s.imageRef || s.videoRef || s.firstFrame)
        .map(async (s) => {
          const [imageUrl, videoUrl, firstFrameUrl] = await Promise.all([
            s.imageRef ? u.oss.getSmallImageUrl(s.imageRef).catch(() => null) : Promise.resolve(null),
            s.videoRef ? u.oss.getFileUrl(s.videoRef).catch(() => null) : Promise.resolve(null),
            s.firstFrame ? resolveFirstFrameUrl(s.firstFrame.imageId) : Promise.resolve(null),
          ]);
          // 封面优先级：视频专有首帧（绑定的 firstFrame）> 镜头生成图 > null。
          // o_video 未存视频抽帧海报，绑定的首帧即视频生成输入，是当前可用的"视频专有首帧"。
          const videoPosterUrl = resolveVideoPosterUrl(firstFrameUrl, imageUrl);
          media[s.id] = { imageUrl, videoUrl, videoPosterUrl, firstFrameUrl };
        }),
    );

    res.status(200).send(success({ media }));
  },
);

async function resolveFirstFrameUrl(imageId: number): Promise<string | null> {
  try {
    const filePath = await getImageFilePath(imageId);
    return filePath ? await u.oss.getSmallImageUrl(filePath) : null;
  } catch {
    return null;
  }
}
