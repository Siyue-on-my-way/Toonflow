import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { touchQuickVideoSession } from "@/lib/quickVideo/session";
import { QuickVideoError } from "@/lib/quickVideo/state";

const router = express.Router();

/** 重命名会话标题，或归档/恢复会话；sessionId 必须真实属于该项目，跨项目引用一律拒绝。 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    sessionId: z.number(),
    title: z.string().max(200).optional(),
    status: z.enum(["active", "archived"]).optional(),
  }),
  async (req, res) => {
    const { projectId, sessionId, title, status } = req.body;
    const project = await u.db("o_project").where("id", projectId).select("id", "projectType").first();
    if (!project) return res.status(200).send(error("项目不存在"));
    if (project.projectType !== "quick_video") return res.status(200).send(error("非单视频快创项目"));

    try {
      const session = await touchQuickVideoSession(projectId, sessionId, { title, status });
      res.status(200).send(success({ session }));
    } catch (err: any) {
      if (err instanceof QuickVideoError) return res.status(200).send(error(err.message));
      throw err;
    }
  },
);
