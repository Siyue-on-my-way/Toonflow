import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { snapshotMetrics } from "@/lib/quickVideo/metrics";

const router = express.Router();

/**
 * 快创链路指标查询（SIY-111）：进程内装配/导出/镜头生成的计数、耗时与失败率。
 * 指标随进程生命周期累计，用于观测与排查；不改任何业务状态。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number().optional(),
  }),
  async (_req, res) => {
    res.status(200).send(success(snapshotMetrics()));
  },
);
