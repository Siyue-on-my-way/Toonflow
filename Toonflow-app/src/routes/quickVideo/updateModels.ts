import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

/**
 * 保存快创工作台选择的三类模型。
 *
 * 模型偏好属于项目配置，不写入 Agent 状态版本，避免用户切换模型时
 * 与分镜确认/生成中的乐观锁互相干扰。图片和视频模型会被后续镜头
 * 生成链路直接读取，文本模型供快创 Agent 恢复默认聊天模型。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    textModel: z.string().max(500),
    imageModel: z.string().max(500),
    videoModel: z.string().max(500),
  }),
  async (req, res) => {
    const { projectId, textModel, imageModel, videoModel } = req.body;
    const project = await u.db("o_project").where("id", projectId).select("id", "projectType").first();

    if (!project) return res.status(200).send(error("项目不存在"));
    if (project.projectType !== "quick_video") return res.status(200).send(error("非单视频快创项目"));

    await u.db("o_project").where("id", projectId).update({ textModel, imageModel, videoModel });
    const updatedProject = await u.db("o_project").where("id", projectId).first();
    res.status(200).send(success({ project: updatedProject }));
  },
);

