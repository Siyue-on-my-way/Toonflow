import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { QuickVideoError } from "@/lib/quickVideo/state";
import { requestGenerationConfirm, confirmGeneration, cancelGenerationConfirm } from "@/lib/quickVideo/confirmGate";
import { getOwnedSession } from "@/lib/quickVideo/session";
import { recordEvent, qvLog } from "@/lib/quickVideo/metrics";

const router = express.Router();

/**
 * 生成确认门（SIY-138）：确认卡片与自然语言「确认/开始生成」的统一服务端入口。
 * - request：分镜确认后用户要求生成时，组装含 configVersion/时长/画风/分镜摘要的
 *   待确认快照（pendingSnapshot），供前端展示结构化确认卡片。
 * - confirm：校验传入 configVersion 与服务端最新值一致后，冻结素材快照并启动
 *   逐镜头生成；不一致则阻断并提示重新确认。
 * - cancel：返回修改，清空待确认快照。
 * 在用户明确确认（confirm 通过）之前，本接口绝不创建任何素材生成任务。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    sessionId: z.number(),
    action: z.enum(["request", "confirm", "cancel"]),
    idempotencyKey: z.string().min(8).max(64),
    /** confirm 时携带用户确认所见的配置版本；与服务端最新 configVersion 不一致时阻断 */
    configVersion: z.number().int().min(0).optional(),
  }),
  async (req, res) => {
    const { projectId, sessionId, action, idempotencyKey, configVersion } = req.body;
    try {
      await getOwnedSession(projectId, sessionId);
    } catch (err) {
      if (err instanceof QuickVideoError) return res.status(200).send(error(err.message));
      throw err;
    }

    try {
      if (action === "request") {
        const result = await requestGenerationConfirm(projectId, { idempotencyKey, sessionId });
        return res.status(200).send(success({ state: result.state, pendingSnapshot: result.pendingSnapshot, idempotentHit: result.idempotentHit }));
      }

      if (action === "confirm") {
        const result = await confirmGeneration(projectId, { idempotencyKey, sessionId, configVersion, userId: (req as any).user?.id ?? 1 });
        if (result.started) {
          recordEvent("generationConfirmed");
          qvLog("generation_confirmed", { projectId, configVersion: configVersion ?? null, runId: result.runId });
        }
        // confirmGeneration 内部已通过 loadQuickVideoState 拿不到最新态（启动后状态仍在变），
        // 返回前重取一次给前端渲染
        const { loadQuickVideoState } = await import("@/lib/quickVideo/state");
        const state = await loadQuickVideoState(projectId);
        return res.status(200).send(success({ state, ...result }));
      }

      // cancel
      const result = await cancelGenerationConfirm(projectId, { idempotencyKey, sessionId });
      return res.status(200).send(success({ state: result.state, idempotentHit: result.idempotentHit }));
    } catch (err: any) {
      if (err instanceof QuickVideoError) {
        return res.status(200).send({ code: err.code, message: err.message, currentVersion: err.currentVersion ?? null });
      }
      throw err;
    }
  },
);
