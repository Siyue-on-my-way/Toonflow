import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { SHOT_COUNT_MAX, shotAssetRefSchema } from "@/lib/quickVideo/contract";
import { QuickVideoError, mutateQuickVideoState } from "@/lib/quickVideo/state";
import { ensureStoryboardEditable, nextShotId, reindexShots } from "@/lib/quickVideo/shots";

const router = express.Router();

/** 用户在分镜表中手动新增一个镜头（仅草稿状态允许） */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    expectedVersion: z.number().int().min(1),
    idempotencyKey: z.string().min(8).max(64),
    shot: z.object({
      duration: z.number().int().min(5).max(15),
      description: z.string().min(1).max(2000),
      dialogue: z.string().max(500).optional().default(""),
      camera: z.string().max(200).optional().default(""),
      assetRefs: z.array(shotAssetRefSchema).max(10).optional().default([]),
    }),
  }),
  async (req, res) => {
    const { projectId, expectedVersion, idempotencyKey, shot } = req.body;
    try {
      const result = await mutateQuickVideoState(projectId, { expectedVersion, idempotencyKey }, (state) => {
        ensureStoryboardEditable(state);
        if ((state.storyboard?.shots.length ?? 0) >= SHOT_COUNT_MAX) {
          throw new QuickVideoError("SHOT_COUNT_EXCEEDED", `镜头数量已达上限 ${SHOT_COUNT_MAX}`, state.version);
        }
        state.storyboard!.shots.push({
          id: nextShotId(state),
          index: (state.storyboard?.shots.length ?? 0) + 1,
          duration: shot.duration,
          description: shot.description,
          dialogue: shot.dialogue ?? "",
          camera: shot.camera ?? "",
          assetRefs: shot.assetRefs ?? [],
          imageState: "pending",
          videoState: "pending",
          imageRef: null,
          videoRef: null,
          errorReason: null,
          imageErrorReason: null,
          videoErrorReason: null,
        });
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
