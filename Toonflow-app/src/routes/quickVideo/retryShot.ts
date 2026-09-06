import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { retryQuickVideoShots } from "@/lib/quickVideo/generate";
import { QuickVideoError } from "@/lib/quickVideo/state";
import { recordEvent, qvLog } from "@/lib/quickVideo/metrics";

const router = express.Router();

/**
 * 单镜头失败重试：重置指定镜头未成功部分的生成状态并单独重建任务。
 * - 仅生成（generating）阶段可用；
 * - 已成功（图/视频均 done）的镜头不可重试，其余镜头任务不受影响；
 * - 支持一次传多个失败镜头（前端「重试全部失败镜头」）。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    shotIds: z.array(z.string().min(1).max(40)).min(1).max(12),
  }),
  async (req, res) => {
    const { projectId, shotIds } = req.body;
    try {
      const result = await retryQuickVideoShots(projectId, (req as any).user?.id ?? 1, shotIds);
      recordEvent("shotRetry");
      qvLog("shots_retry", { projectId, shotIds: result.retried });
      res.status(200).send(success({ state: result.state, retried: result.retried }));
    } catch (err: any) {
      if (err instanceof QuickVideoError) {
        return res.status(200).send({ code: err.code, message: err.message, currentVersion: err.currentVersion ?? null });
      }
      throw err;
    }
  },
);
