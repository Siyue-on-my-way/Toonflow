import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { createQuickVideoSession } from "@/lib/quickVideo/session";

const router = express.Router();

/** 新建一个会话；文本/图片/视频模型偏好从项目当前配置继承一次，之后各会话独立编辑。 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    title: z.string().max(200).optional(),
  }),
  async (req, res) => {
    const { projectId, title } = req.body;
    const project = await u.db("o_project").where("id", projectId).select("id", "projectType").first();
    if (!project) return res.status(200).send(error("项目不存在"));
    if (project.projectType !== "quick_video") return res.status(200).send(error("非单视频快创项目"));

    const session = await createQuickVideoSession(projectId, { title });
    res.status(200).send(success({ session }));
  },
);
