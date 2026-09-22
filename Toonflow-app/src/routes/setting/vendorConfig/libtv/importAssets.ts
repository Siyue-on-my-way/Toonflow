import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import libtvImport from "@/utils/libtvImport";

const router = express.Router();

// 用户自助：「从 LibTV 导入」第三步——勾选导入。一次性收编：下载产物存进 Toonflow 素材库（MinIO + o_assets），
// remark 打「来源: LibTV」标；只读不写回 LibTV，也不回读生成历史/积分。
export default router.post(
  "/",
  validateFields({
    projectId: z.string().min(1),
    toonflowProjectId: z.number(),
    nodeKeys: z.array(z.string().min(1)).min(1).max(200),
  }),
  async (req, res) => {
    try {
      await libtvImport.assertProjectOwnership((req as any).user.id, req.body.toonflowProjectId);
      const result = await libtvImport.importNodes((req as any).user.id, req.body.toonflowProjectId, req.body.projectId, req.body.nodeKeys);
      res.status(200).send(success(result));
    } catch (err: any) {
      res.status(500).send(error(err?.message || "导入失败"));
    }
  },
);
