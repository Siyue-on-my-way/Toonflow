import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { QUICK_VIDEO_RATIOS, echoFinalParamsCard } from "@/lib/quickVideo/contract";
import { buildSnapshot, applySnapshotToState } from "@/lib/quickVideo/generate";
import { QuickVideoError, mutateQuickVideoState } from "@/lib/quickVideo/state";

const router = express.Router();

/**
 * 编辑快创项目基础配置（标题/画风/比例/目标时长/简介）。
 * 乐观锁保护；目标时长在分镜确认后禁止修改（需先撤销确认），防止已确认分镜与目标脱钩。
 * 分镜已确认状态下修改画风/比例：旧最终参数确认立即失效，并重建快照、重新回显确认卡片。
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
      targetDuration: z.union([z.literal(15), z.literal(30), z.literal(60)]).optional(),
      intro: z.string().max(2000).optional(),
    }),
  }),
  async (req, res) => {
    const { projectId, expectedVersion, idempotencyKey, patch } = req.body;

    try {
      const result = await mutateQuickVideoState(projectId, { expectedVersion, idempotencyKey }, async (state, trx) => {
        const targetDurationChanged = patch.targetDuration != null && patch.targetDuration !== state.targetDuration;
        const visualConfigChanged =
          (patch.artStyle != null && patch.artStyle !== state.artStyle) ||
          (patch.videoRatio != null && patch.videoRatio !== state.videoRatio);
        const generationConfigChanged = targetDurationChanged || visualConfigChanged;

        if (targetDurationChanged && state.storyboard?.status === "confirmed") {
          throw new QuickVideoError("FORBIDDEN", "分镜已确认，不允许修改目标时长；请先撤销分镜确认");
        }
        if (generationConfigChanged && ["generating", "ready_to_assemble", "completed"].includes(state.stage)) {
          throw new QuickVideoError("FORBIDDEN", "生成已开始，不能再修改目标时长、画风或比例；如需调整请新建项目");
        }
        if (patch.targetDuration != null) state.targetDuration = patch.targetDuration;
        if (patch.videoRatio != null) state.videoRatio = patch.videoRatio;
        if (patch.artStyle != null) state.artStyle = patch.artStyle;

        // 目标/视觉配置会进入生成快照和提示词。配置变化后丢弃旧快照并使确认状态失效，
        // 让下一次确认按新配置重建，避免沿用旧画风或比例。
        if (generationConfigChanged) {
          state.generation.snapshot = null;
          state.generation.materialsConfirmed = false;
          state.generation.materialsConfirmedAt = null;
          state.generation.materialImages = {};
          state.generation.timeline = null;
          state.generation.exportInfo = null;
          // 分镜已确认时同步重建快照并重新回显最终参数确认卡片（旧卡片随之失效），
          // 引导用户按新参数重新确认后再开始生成
          if (state.stage === "storyboard_confirmed") {
            const { materials, snapshotShots } = await buildSnapshot(projectId, state);
            applySnapshotToState(state, state.storyboard!.version, snapshotShots, materials);
            echoFinalParamsCard(state);
          }
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
