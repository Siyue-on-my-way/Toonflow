import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import libtvImport from "@/utils/libtvImport";

const router = express.Router();

// 用户自助：「从 LibTV 导入」第二步——回读画布产物节点（图/视频/音频，带缩略 URL 与生成时间；已导入过的标记 imported）
export default router.post(
  "/",
  validateFields({
    projectId: z.string().min(1),
    toonflowProjectId: z.number().optional(),
  }),
  async (req, res) => {
    try {
      const nodes = await libtvImport.getProjectNodes((req as any).user.id, req.body.projectId, req.body.toonflowProjectId);
      res.status(200).send(success(nodes));
    } catch (err: any) {
      res.status(500).send(error(err?.message || "读取画布节点失败"));
    }
  },
);
