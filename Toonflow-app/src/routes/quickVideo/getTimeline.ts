import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { QuickVideoError, loadQuickVideoState, mutateQuickVideoState } from "@/lib/quickVideo/state";
import { buildSubtitleCues, buildTimelinePlan } from "@/lib/quickVideo/timeline";
import { recordDuration, recordEvent, qvLog } from "@/lib/quickVideo/metrics";

const router = express.Router();

/**
 * 时间线装配查询（SIY-111）：
 * - 按镜头顺序（index）读取已完成的镜头视频结果，推导裁剪/变速/补齐方案（buildTimelinePlan）；
 * - 首次装配把规划落库：o_videoTrack 每镜头一行（复用专业模式轨道表）+ state.generation.timeline 元数据；
 * - 返回时间线规划 + 各镜头视频访问地址 + 字幕时间轴，供前端 WebAV 预览与导出。
 * 仅 ready_to_assemble / completed 阶段可调用；同一分镜版本重复调用幂等（不重复写轨道与状态）。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
  }),
  async (req, res) => {
    const { projectId } = req.body;
    const startedAt = Date.now();
    try {
      const project = await u.db("o_project").where("id", projectId).first();
      if (!project) return res.status(200).send(success(null, "项目不存在"));
      if (project.projectType !== "quick_video") {
        return res.status(200).send(success(null, "非单视频快创项目，请使用专业模式入口"));
      }

      const state = await loadQuickVideoState(projectId);
      if (!state) return res.status(200).send(success(null, "未找到 quickVideoAgent 状态"));
      if (state.stage !== "ready_to_assemble" && state.stage !== "completed") {
        throw new QuickVideoError("SHOTS_NOT_READY", `当前阶段 ${state.stage} 尚未完成全部镜头生成，无法装配时间线`, state.version);
      }
      const shots = state.storyboard?.shots ?? [];
      const notDone = shots.filter((s) => s.videoState !== "done" || !s.videoRef);
      if (!shots.length || notDone.length) {
        throw new QuickVideoError(
          "SHOTS_NOT_READY",
          notDone.length ? `镜头 ${notDone.map((s) => s.id).join("、")} 尚未生成完成` : "暂无镜头，无法装配时间线",
          state.version,
        );
      }

      const timeline = buildTimelinePlan({
        shots: shots.map((s) => ({ id: s.id, index: s.index, duration: s.duration, dialogue: s.dialogue })),
        targetDuration: state.targetDuration,
        videoRatio: state.videoRatio,
        ctaText: state.brief?.cta ?? "",
      });
      const subtitles = buildSubtitleCues(timeline);

      // 首次装配（或分镜版本变化后）落库：o_videoTrack 每镜头一行 + timeline 元数据。
      // 同版本重复调用不写状态，保证轮询下状态版本有界。
      const storyboardVersion = state.storyboard!.version;
      const script = await u.db("o_script").where("projectId", projectId).select("id").first();
      let persisted = false;
      if (state.generation?.timeline?.storyboardVersion !== storyboardVersion) {
        await mutateQuickVideoState(projectId, {}, async (s, trx) => {
          if (s.generation.timeline?.storyboardVersion === storyboardVersion) return;
          if (s.stage !== "ready_to_assemble" && s.stage !== "completed") return; // 竞态保护
          // 该项目的轨道行全部归属快创时间线（快创项目无专业模式轨道），按镜头顺序重建
          const trackIds: number[] = [];
          for (const shot of [...s.storyboard!.shots].sort((a, b) => a.index - b.index)) {
            const maxRow = await trx("o_videoTrack").max("id as maxId").first();
            const trackId = Number(maxRow?.maxId ?? 0) + 1;
            await trx("o_videoTrack").insert({
              id: trackId,
              videoId: 0,
              projectId,
              scriptId: script?.id ?? 0,
              state: "已完成",
              reason: "quickVideo 时间线装配",
              prompt: shot.description,
              selectVideoId: 0,
              duration: shot.duration,
            });
            trackIds.push(trackId);
          }
          s.generation.timeline = {
            storyboardVersion,
            assembledAt: Date.now(),
            clipCount: s.storyboard!.shots.length,
            totalDuration: timeline.totalDuration,
            trackIds,
          };
          persisted = true;
        });
      }

      // 镜头视频访问地址（getMediaUrls 同款签名链路）
      const media: Record<string, { videoUrl: string | null; imageUrl: string | null }> = {};
      await Promise.all(
        shots.map(async (s) => {
          const [videoUrl, imageUrl] = await Promise.all([
            s.videoRef ? u.oss.getFileUrl(s.videoRef).catch(() => null) : Promise.resolve(null),
            s.imageRef ? u.oss.getSmallImageUrl(s.imageRef).catch(() => null) : Promise.resolve(null),
          ]);
          media[s.id] = { videoUrl, imageUrl };
        }),
      );

      recordEvent("timelineAssembled");
      recordDuration("timelineAssembleMs", Date.now() - startedAt);
      qvLog("timeline_assembled", { projectId, storyboardVersion, clipCount: timeline.clips.length, totalDuration: timeline.totalDuration, persisted });

      res.status(200).send(success({ timeline, subtitles, media, ctaText: state.brief?.cta ?? "", exportInfo: state.generation?.exportInfo ?? null }));
    } catch (err: any) {
      if (err instanceof QuickVideoError) {
        return res.status(200).send({ code: err.code, message: err.message, currentVersion: err.currentVersion ?? null });
      }
      throw err;
    }
  },
);
