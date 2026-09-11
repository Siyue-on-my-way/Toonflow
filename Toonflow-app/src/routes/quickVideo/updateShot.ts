import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { bumpConfigVersion, shotAssetRefSchema } from "@/lib/quickVideo/contract";
import { QuickVideoError, mutateQuickVideoState } from "@/lib/quickVideo/state";
import { ensureStoryboardEditable, findShot, normalizeShotDuration } from "@/lib/quickVideo/shots";

const router = express.Router();

/**
 * 用户编辑单个镜头（仅草稿状态允许）。
 * patch 走白名单字段（description/dialogue/camera/duration/assetRefs），
 * 镜头 id / index / 生成状态不允许通过本接口修改。
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
    }),
  }),
  async (req, res) => {
    const { projectId, expectedVersion, idempotencyKey, shotId, patch } = req.body;
    try {
      const result = await mutateQuickVideoState(projectId, { expectedVersion, idempotencyKey }, (state) => {
        ensureStoryboardEditable(state);
        const shot = findShot(state, shotId);
        if (patch.description != null) shot.description = patch.description;
        if (patch.dialogue != null) shot.dialogue = patch.dialogue;
        if (patch.camera != null) shot.camera = patch.camera;
        if (patch.duration != null) shot.duration = normalizeShotDuration(patch.duration);
        if (patch.assetRefs != null) shot.assetRefs = patch.assetRefs;
        bumpConfigVersion(state);
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
