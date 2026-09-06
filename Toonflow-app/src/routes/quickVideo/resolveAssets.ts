import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { resolveMaterialsSnapshot } from "@/lib/quickVideo/generate";
import { QuickVideoError } from "@/lib/quickVideo/state";

const router = express.Router();

/**
 * 素材解析：按分镜 assetRefs 匹配项目资产库（命中则复用已有资产图作为参考），
 * 生成素材清单与费用/耗时预估，写入未确认快照（素材确认门确认后冻结）。
 * 预估为服务端推导的粗略值，仅作展示参考。
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
          estimate: result.estimate,
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
