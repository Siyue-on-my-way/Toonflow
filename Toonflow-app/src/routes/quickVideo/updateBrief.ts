import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { QuickVideoError, mutateQuickVideoState } from "@/lib/quickVideo/state";
import { quickVideoBriefSchema } from "@/lib/quickVideo/contract";

const router = express.Router();

/**
 * 用户编辑简报（工作台右侧产物编辑，或聊天中用户手动修正）。
 * 阶段白名单：collect_brief / brief_confirmed / storyboard_draft 允许编辑；
 * 任何编辑都会把简报置回未确认（用户需重新过确认门）。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    expectedVersion: z.number().int().min(1),
    idempotencyKey: z.string().min(8).max(64),
    brief: quickVideoBriefSchema,
  }),
  async (req, res) => {
    const { projectId, expectedVersion, idempotencyKey, brief } = req.body;

    try {
      const result = await mutateQuickVideoState(projectId, { expectedVersion, idempotencyKey }, (state) => {
        if (!["collect_brief", "brief_confirmed", "storyboard_draft"].includes(state.stage)) {
          throw new QuickVideoError("STAGE_FORBIDDEN", `当前阶段 ${state.stage} 不允许编辑简报`, state.version);
        }
        state.brief = {
          theme: brief.theme,
          hook: brief.hook ?? "",
          narrative: brief.narrative,
          cta: brief.cta ?? "",
          keywords: brief.keywords ?? [],
          confirmed: false,
          confirmedAt: null,
        };
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
