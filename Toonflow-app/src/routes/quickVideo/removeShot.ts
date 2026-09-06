import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { QuickVideoError, mutateQuickVideoState } from "@/lib/quickVideo/state";
import { ensureStoryboardEditable, findShot, reindexShots } from "@/lib/quickVideo/shots";

const router = express.Router();

/** 用户删除单个镜头（仅草稿状态允许；删除后剩余镜头重新排序） */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    expectedVersion: z.number().int().min(1),
    idempotencyKey: z.string().min(8).max(64),
    shotId: z.string().min(1).max(40),
  }),
  async (req, res) => {
    const { projectId, expectedVersion, idempotencyKey, shotId } = req.body;
    try {
      const result = await mutateQuickVideoState(projectId, { expectedVersion, idempotencyKey }, (state) => {
        ensureStoryboardEditable(state);
        findShot(state, shotId);
        state.storyboard!.shots = state.storyboard!.shots.filter((s) => s.id !== shotId);
        if (!state.storyboard!.shots.length) {
          throw new QuickVideoError("SHOT_LAST_ONE", "至少保留一个镜头", state.version);
        }
        reindexShots(state);
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
