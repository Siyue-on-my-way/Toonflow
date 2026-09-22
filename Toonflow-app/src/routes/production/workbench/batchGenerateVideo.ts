import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import pLimit from "p-limit";
import { ReferenceList } from "@/utils/ai";
const router = express.Router();

type Type = "imageReference" | "startImage" | "endImage" | "videoReference" | "audioReference";
interface UploadItem {
  fileType: "image" | "video" | "audio";
  type: Type;
  sources?: "assets" | "storyboard";
  id?: number;
  src?: string;
  label?: string;
  prompt?: string;
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackData: z.array(
      z.object({
        uploadData: z.array(
          z.object({
            id: z.number(),
            sources: z.string(),
          }),
        ),
        trackId: z.number(),
        prompt: z.string(),
        duration: z.number(),
      }),
    ),
    model: z.string(),
    mode: z.string(),
    resolution: z.string(),
    audio: z.boolean().optional(),
    aspectRatio: z.string().optional(),
    quality: z.enum(["std", "pro"]).default("std"),
  }),
  async (req, res) => {
    const { scriptId, projectId, trackData, model, resolution, audio, mode, aspectRatio, quality } = req.body;

    let modeData = [];
    if (Array.isArray(mode)) {
    } else if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
      try {
        modeData = JSON.parse(mode);
      } catch (e) {}
    }

    // 获取生成视频比例
    const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();

    // 为每个 track 预处理数据并插入数据库，返回任务列表
    const tasks = await Promise.all(
      (trackData as { uploadData: { id: number; sources: string }[]; trackId: number; prompt: string; duration: number }[]).map(async (track) => {
        const { uploadData, trackId, prompt, duration } = track;

        // 查询出图片数据
        const images = await Promise.all(
          uploadData.map(async (item) => {
            if (item.sources === "storyboard") {
              const filePath = await u.db("o_storyboard").where("id", item.id).select("filePath").first();
              return { path: filePath?.filePath, sources: "storyBoard" };
            }
            if (item.sources === "assets") {
              const filePath = await u
                .db("o_assets")
                .where("o_assets.id", item.id)
                .leftJoin("o_image", "o_assets.imageId", "o_image.id")
                .select("o_image.filePath", "o_image.type")
                .first();
              return { path: filePath?.filePath, sources: filePath.type };
            }
          }),
        );

        const videoPath = `/${projectId}/video/${uuidv4()}.mp4`;
        const [videoId] = await u.db("o_video").insert({
          filePath: videoPath,
          time: Date.now(),
          state: "生成中",
          scriptId,
          projectId,
          videoTrackId: trackId,
        });

        return { videoId, videoPath, prompt, duration, images, trackId };
      }),
    );

    res.status(200).send(success(tasks.map((t) => ({ videoId: t.videoId, trackId: t.trackId }))));
    // 并发上限（SIY-172 审查 P1-7）：每个任务收尾时下载+base64 瞬时驻留 ≈3.7× 文件大小，
    // 全量并发下批量收尾叠加会打爆单容器内存；限 3 路在途，任务本身仍是后台异步不阻塞响应
    const limit = pLimit(3);
    for (const { videoId, videoPath, prompt, duration, images } of tasks) {
      const base64 = await Promise.all(
        images.map(async (item) => {
          if (!item) return null;
          return { base64: await u.oss.getImageBase64(item.path), type: item.sources == "audio" ? "audio" : "image" };
        }),
      );
      const relatedObjects = { projectId, videoId, scriptId, type: "视频" };
      const aiVideo = u.Ai.Video(model, (req as any).user.id);
      limit(() =>
        aiVideo
          .run(
            {
              prompt,
              referenceList: base64.filter(Boolean) as ReferenceList[],
              mode: modeData.length > 0 ? modeData : mode,
              duration,
              aspectRatio: aspectRatio || ratio?.videoRatio || "16:9",
              resolution,
              audio,
              quality,
            },
            {
              projectId,
              taskClass: "视频生成",
              describe: "根据提示词生成视频",
              relatedObjects: JSON.stringify(relatedObjects),
            },
          )
          .then(async () => await aiVideo.save(videoPath))
          .then(async () => await u.db("o_video").where("id", videoId).update({ state: "生成成功" }))
          .catch(async (error: any) => {
            await u
              .db("o_video")
              .where("id", videoId)
              .update({
                state: "生成失败",
                errorReason: u.error(error).message,
              });
          }),
      );
    }
  },
);
