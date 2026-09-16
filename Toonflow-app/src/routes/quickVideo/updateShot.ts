import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { shotAssetRefSchema, SHOT_CONTINUITY_TYPES } from "@/lib/quickVideo/contract";
import { QuickVideoError, mutateQuickVideoState } from "@/lib/quickVideo/state";
import { ensureStoryboardEditable, findShot, normalizeShotDuration } from "@/lib/quickVideo/shots";

const router = express.Router();

/** 文本类字段：允许在分镜已确认乃至装配/成片阶段随时修改（不影响已生成媒体） */
const TEXT_PATCH_KEYS = ["description", "dialogue", "camera", "imagePrompt", "videoPrompt"];
const TEXT_EDIT_STAGES = ["storyboard_draft", "storyboard_confirmed", "ready_to_assemble", "completed"];

/**
 * 用户编辑单个镜头。
 * patch 走白名单字段（description/dialogue/camera/duration/assetRefs/continuity/imagePrompt/videoPrompt），
 * 镜头 id / index / 生成状态不允许通过本接口修改。
 * 编辑门槛（SIY-137 审核反馈）：文本类字段（描述/台词/运镜/双提示词）在分镜已确认乃至装配/成片阶段
 * 也可随时修改——已生成的图片/视频不受影响，时间线重新装配时将采用新台词字幕，分镜版本递增使旧的
 * 最终参数确认卡片自动置灰；结构性字段（时长/资产/连续性）会改变生成管道输入假设，仍仅限草稿阶段。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    expectedVersion: z.number().int().min(1),
    idempotencyKey: z.string().min(8).max(64),
    shotId: z.string().min(1).max(40),
    patch: z.object({
      description: z.string().min(1).max(2000).optional(),
      dialogue: z.string().max(500).optional(),
      camera: z.string().max(200).optional(),
      duration: z.number().int().min(5).max(15).optional(),
      assetRefs: z.array(shotAssetRefSchema).max(10).optional(),
      continuity: z.enum(SHOT_CONTINUITY_TYPES).optional(),
      imagePrompt: z.string().max(2000).optional(),
      videoPrompt: z.string().max(2000).optional(),
    }),
  }),
  async (req, res) => {
    const { projectId, expectedVersion, idempotencyKey, shotId, patch } = req.body;
    try {
      const result = await mutateQuickVideoState(projectId, { expectedVersion, idempotencyKey }, (state) => {
        if (!state.storyboard) throw new QuickVideoError("NO_STORYBOARD", "暂无分镜，请先确认简报后由 Agent 生成或提交分镜", state.version);
        const patchKeys = Object.keys(patch);
        const isTextOnly = patchKeys.length > 0 && patchKeys.every((k) => TEXT_PATCH_KEYS.includes(k));
        if (!isTextOnly) {
          // 结构性修改（时长/资产/连续性）：仍仅限草稿阶段
          ensureStoryboardEditable(state);
        } else if (!TEXT_EDIT_STAGES.includes(state.stage)) {
          throw new QuickVideoError("STAGE_FORBIDDEN", `当前阶段 ${state.stage} 不允许修改镜头文本（生成进行中，请等整批结束后再改）`, state.version);
        } else if (state.stage !== "storyboard_draft") {
          // 已确认后的文本修改：递增分镜版本，旧的最终参数确认卡片自动置灰；下次生成按最新分镜冻结快照
          state.storyboard.version += 1;
        }
        const shot = findShot(state, shotId);
        if (patch.description != null) shot.description = patch.description;
        if (patch.dialogue != null) shot.dialogue = patch.dialogue;
        if (patch.camera != null) shot.camera = patch.camera;
        if (patch.duration != null) shot.duration = normalizeShotDuration(patch.duration);
        if (patch.assetRefs != null) shot.assetRefs = patch.assetRefs;
        if (patch.continuity != null) shot.continuity = patch.continuity;
        if (patch.imagePrompt != null) shot.imagePrompt = patch.imagePrompt;
        if (patch.videoPrompt != null) shot.videoPrompt = patch.videoPrompt;
      });
      res.status(200).send(success({ state: result.state, idempotentHit: result.idempotentHit }));
    } catch (err: any) {
      if (err instanceof QuickVideoError) {
        return res.status(200).send({ code: err.code, message: err.message, currentVersion: err.currentVersion ?? null });
      }
      throw err;
    }
  },
);
