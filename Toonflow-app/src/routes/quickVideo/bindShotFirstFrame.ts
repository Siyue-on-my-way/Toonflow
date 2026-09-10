import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { QuickVideoError, mutateQuickVideoState } from "@/lib/quickVideo/state";
import { ensureStoryboardEditable, findShot } from "@/lib/quickVideo/shots";
import { resolveMediaForFirstFrame } from "@/lib/quickVideo/media";

const router = express.Router();

/**
 * 绑定/替换/解除镜头首帧（SIY-132）。mediaId 为 null 表示解除；非 null 时校验该媒体
 * 属于当前项目、类型为图片、已生成完成后绑定。仅 storyboard_draft 草稿阶段可编辑；
 * 分镜确认后随快照冻结（见 resolveAssets.ts / confirmStage.ts 的 buildSnapshot 调用链）。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    expectedVersion: z.number().int().min(1),
    idempotencyKey: z.string().min(8).max(64),
    shotId: z.string().min(1).max(40),
    mediaId: z.number().int().positive().nullable(),
  }),
  async (req, res) => {
    const { projectId, expectedVersion, idempotencyKey, shotId, mediaId } = req.body;
    try {
      const result = await mutateQuickVideoState(projectId, { expectedVersion, idempotencyKey }, async (state) => {
        ensureStoryboardEditable(state);
        const shot = findShot(state, shotId);
        if (mediaId == null) {
          shot.firstFrame = null;
        } else {
          const { assetId, imageId } = await resolveMediaForFirstFrame(projectId, mediaId);
          shot.firstFrame = { mediaId, assetId, imageId, boundAt: Date.now() };
        }
        // 首帧变化后旧快照可能仍是同一个 storyboard.version（撤销分镜确认时版本不变），
        // needResolve 只按版本号判断会命中旧快照、悄悄丢掉刚绑定的首帧；这里强制下一次
        // 素材解析/确认门重建快照，保证生成引擎读到的是最新首帧。
        state.generation.snapshot = null;
        state.generation.materialsConfirmed = false;
        state.generation.materialsConfirmedAt = null;
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
