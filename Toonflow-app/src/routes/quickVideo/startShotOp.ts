import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getOwnedSession } from "@/lib/quickVideo/session";
import { QuickVideoError } from "@/lib/quickVideo/state";
import { resolveShotRefsFromState } from "@/lib/quickVideo/shotRef";
import { loadQuickVideoState } from "@/lib/quickVideo/state";
import { startChatShotOp } from "@/lib/quickVideo/shotOps";
import { recordEvent, qvLog } from "@/lib/quickVideo/metrics";

const router = express.Router();

/**
 * 聊天按镜头操作：直接启动一次按镜头生成（图片/视频）。
 * 用于聊天结果卡片上的「单镜头重试」「重新生成」等显式重试动作——这类动作用户已经
 * 在聊天卡片里确认过一次意图，不再重复轻量确认门；首次视频触发的确认门在
 * Agent 工具 generate_shot_video 的确认卡片（confirmShotOp）上完成。
 * - sessionId 必须真实属于该项目（模型偏好与状态留痕按会话定位）；
 * - shotRefs 以服务端当前分镜为准重新解析（displayNo -> storyboardId），跨项目/过期引用直接拒绝。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    sessionId: z.number(),
    action: z.enum(["generate_shot_image", "generate_shot_video"]),
    shotRefs: z
      .array(
        z.object({
          displayNo: z.number().int().min(1).max(99),
          storyboardId: z.string().min(1).max(40).optional(),
        }),
      )
      .min(1)
      .max(12),
    instruction: z.string().max(1000).optional(),
  }),
  async (req, res) => {
    const { projectId, sessionId, action, shotRefs, instruction } = req.body;
    try {
      await getOwnedSession(projectId, sessionId);
      const state = await loadQuickVideoState(projectId);
      const { resolved, errors } = resolveShotRefsFromState(state, shotRefs);
      if (!resolved.length) {
        throw new QuickVideoError("SHOT_REF_INVALID", errors.join("；") || "未识别到有效镜头引用", state?.version);
      }
      const result = await startChatShotOp({
        projectId,
        sessionId,
        userId: (req as any).user?.id ?? 1,
        action,
        shotRefs: resolved,
        instruction,
      });
      recordEvent("shotOpStart");
      qvLog("shot_op_api", { projectId, opId: result.opId, action, shots: resolved.map((r) => r.shotId) });
      res.status(200).send(success(result));
    } catch (err: any) {
      if (err instanceof QuickVideoError) {
        return res.status(200).send({ code: err.code, message: err.message, currentVersion: err.currentVersion ?? null });
      }
      throw err;
    }
  },
);
