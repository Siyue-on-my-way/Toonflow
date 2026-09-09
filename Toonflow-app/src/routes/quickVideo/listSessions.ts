import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { listQuickVideoSessions } from "@/lib/quickVideo/session";

const router = express.Router();

/**
 * 列出项目下的全部会话（含归档），按 updateTime 倒序；一个会话都没有时
 * （存量项目未迁移过）现场补建默认会话。前端进入工作台时先调用本接口，
 * 默认选中列表第一条非归档会话（全部归档时选第一条）。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
  }),
  async (req, res) => {
    const { projectId } = req.body;
    const project = await u.db("o_project").where("id", projectId).select("id", "projectType").first();
    if (!project) return res.status(200).send(error("项目不存在"));
    if (project.projectType !== "quick_video") return res.status(200).send(error("非单视频快创项目"));

    const sessions = await listQuickVideoSessions(projectId);
    res.status(200).send(success({ sessions }));
  },
);
