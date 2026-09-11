import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getOwnedSession } from "@/lib/quickVideo/session";
import { QuickVideoError } from "@/lib/quickVideo/state";
import { consumePendingConfirmation, startChatShotOp } from "@/lib/quickVideo/shotOps";
import { recordEvent, qvLog } from "@/lib/quickVideo/metrics";

const router = express.Router();

/**
 * 确认聊天流中的镜头视频生成（轻量确认门，SIY-140）：
 * Agent 工具 generate_shot_video 在任务创建前回显确认卡片，用户点击「确认生成」后
 * 前端携带 confirmToken 调用本接口才真正提交异步任务。
 * - 确认令牌一次性消费，10 分钟未确认自动过期（过期后重新发起即可）；
 * - 确认时会按服务端当前分镜重新校验镜头归属（卡片回显到确认之间分镜可能已变化）。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    sessionId: z.number(),
    confirmToken: z.string().min(4).max(64),
  }),
  async (req, res) => {
    const { projectId, sessionId, confirmToken } = req.body;
    try {
      await getOwnedSession(projectId, sessionId);
      const pending = consumePendingConfirmation(confirmToken);
      if (!pending) {
        throw new QuickVideoError("CONFIRM_TOKEN_INVALID", "确认卡片已失效（超时或已确认过），请重新发起视频生成");
      }
      if (pending.projectId !== projectId) {
        throw new QuickVideoError("CONFIRM_PROJECT_MISMATCH", "确认卡片与当前项目不一致，请重新发起视频生成");
      }
      const result = await startChatShotOp({
        projectId,
        sessionId,
        userId: (req as any).user?.id ?? 1,
        action: "generate_shot_video",
        shotRefs: pending.shotRefs,
        instruction: pending.instruction,
        referenceMediaIds: pending.referenceMediaIds,
      });
      recordEvent("shotOpConfirm");
      qvLog("shot_op_confirm", { projectId, opId: result.opId, shots: pending.shotRefs.map((r) => r.shotId) });
      res.status(200).send(success(result));
    } catch (err: any) {
      if (err instanceof QuickVideoError) {
        return res.status(200).send({ code: err.code, message: err.message, currentVersion: err.currentVersion ?? null });
      }
      throw err;
    }
  },
);
