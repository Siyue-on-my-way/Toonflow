import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { resolveMaterialsSnapshot } from "@/lib/quickVideo/generate";
import { QuickVideoError } from "@/lib/quickVideo/state";

const router = express.Router();

/**
 * 素材解析：按分镜 assetRefs 匹配项目资产库（命中则复用已有资产图作为参考），
 * 生成素材清单并写入未确认快照（最终参数确认时冻结）。
 * 历史兼容保留：新流程下快照由分镜确认/最终参数确认自动构建，前端不再单独调用本接口；
 * 素材解析结果仅作为生成参考图来源，不再向用户展示素材/成本确认清单。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    expectedVersion: z.number().int().min(1),
    idempotencyKey: z.string().min(8).max(64),
  }),
  async (req, res) => {
    const { projectId, expectedVersion, idempotencyKey } = req.body;
    try {
      const result = await resolveMaterialsSnapshot(projectId, { expectedVersion, idempotencyKey });
      res.status(200).send(
        success({
          state: result.state,
          materials: result.materials,
          idempotentHit: result.idempotentHit,
        }),
      );
    } catch (err: any) {
      if (err instanceof QuickVideoError) {
        return res.status(200).send({ code: err.code, message: err.message, currentVersion: err.currentVersion ?? null });
      }
      throw err;
    }
  },
);
