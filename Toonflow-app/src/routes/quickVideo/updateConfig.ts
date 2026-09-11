import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { QUICK_VIDEO_RATIOS, bumpConfigVersion, quickVideoDurationSchema } from "@/lib/quickVideo/contract";
import { QuickVideoError, mutateQuickVideoState } from "@/lib/quickVideo/state";

const router = express.Router();

/**
 * 编辑快创项目基础配置（标题/画风/比例/目标时长/简介）。
 * 乐观锁保护；目标时长在分镜确认后禁止修改（需先撤销确认），防止已确认分镜与目标脱钩。
 * SIY-138：目标时长放宽为 5-60 的正整数秒；画风/时长/比例每次变更严格递增 configVersion
 * 并使待确认快照失效；生成启动后执行态参数锁定。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    expectedVersion: z.number().int().min(1),
    idempotencyKey: z.string().min(8).max(64),
    patch: z.object({
      name: z.string().min(1).max(100).optional(),
      artStyle: z.string().max(500).optional(),
      videoRatio: z.enum(QUICK_VIDEO_RATIOS).optional(),
      targetDuration: quickVideoDurationSchema.optional(),
      intro: z.string().max(2000).optional(),
    }),
  }),
  async (req, res) => {
    const { projectId, expectedVersion, idempotencyKey, patch } = req.body;

    try {
      const result = await mutateQuickVideoState(projectId, { expectedVersion, idempotencyKey }, async (state, trx) => {
        const targetDurationChanged = patch.targetDuration != null && patch.targetDuration !== state.targetDuration;
        const visualConfigChanged =
          (patch.artStyle != null && patch.artStyle !== (state.artStyle ?? "")) ||
          (patch.videoRatio != null && patch.videoRatio !== state.videoRatio);
        const generationConfigChanged = targetDurationChanged || visualConfigChanged;

        if (targetDurationChanged && state.storyboard?.status === "confirmed") {
          throw new QuickVideoError("FORBIDDEN", "分镜已确认，不允许修改目标时长；请先撤销分镜确认");
        }
        if (generationConfigChanged && ["generating", "ready_to_assemble", "completed"].includes(state.stage)) {
          throw new QuickVideoError("FORBIDDEN", "生成已开始，生成参数已锁定；当前生成完成或新建项目后才能再调整目标时长、画风或比例");
        }
        if (patch.targetDuration != null) state.targetDuration = patch.targetDuration;
        if (patch.videoRatio != null) state.videoRatio = patch.videoRatio;
        if (patch.artStyle != null) state.artStyle = patch.artStyle;

        // 目标/视觉配置会进入素材解析和生成提示词。配置变化必须递增 configVersion：
        // 同时丢弃旧快照与待确认生成摘要，让下一次素材解析/生成确认按新配置重建。
        if (generationConfigChanged) {
          bumpConfigVersion(state);
          state.generation.snapshot = null;
          state.generation.materialsConfirmed = false;
          state.generation.materialsConfirmedAt = null;
          state.generation.materialImages = {};
          state.generation.timeline = null;
          state.generation.exportInfo = null;
        }

        // o_project 与状态同事务更新，保证列表数据一致
        const projectPatch: Record<string, any> = {};
        if (patch.name != null) projectPatch.name = patch.name;
        if (patch.artStyle != null) projectPatch.artStyle = patch.artStyle;
        if (patch.videoRatio != null) projectPatch.videoRatio = patch.videoRatio;
        if (patch.intro != null) projectPatch.intro = patch.intro;
        if (Object.keys(projectPatch).length) {
          await trx("o_project").where("id", projectId).update(projectPatch);
        }
      });

      const project = await u.db("o_project").where("id", projectId).first();
      res.status(200).send(success({ state: result.state, idempotentHit: result.idempotentHit, project }));
    } catch (err: any) {
      if (err instanceof QuickVideoError) {
        return res.status(200).send({ code: err.code, message: err.message, currentVersion: err.currentVersion ?? null });
      }
      throw err;
    }
  },
);
