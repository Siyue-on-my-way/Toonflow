import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getOwnedSession, saveSessionModels } from "@/lib/quickVideo/session";
import { QuickVideoError } from "@/lib/quickVideo/state";

const router = express.Router();

/**
 * 保存快创工作台选择的三类模型。
 *
 * 模型偏好按 session 隔离保存（o_quickVideoSession），不写入 Agent 状态版本，
 * 避免用户切换模型时与分镜确认/生成中的乐观锁互相干扰。同时镜像写回 o_project，
 * 作为该项目下新建会话的初始默认值——不影响其他既有会话已保存的偏好。
 * 图片和视频模型会被后续镜头生成链路按 sessionId 直接读取，文本模型供快创 Agent
 * 恢复该会话的默认聊天模型。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    sessionId: z.number(),
    textModel: z.string().max(500),
    imageModel: z.string().max(500),
    videoModel: z.string().max(500),
  }),
  async (req, res) => {
    const { projectId, sessionId, textModel, imageModel, videoModel } = req.body;
    const project = await u.db("o_project").where("id", projectId).select("id", "projectType").first();

    if (!project) return res.status(200).send(error("项目不存在"));
    if (project.projectType !== "quick_video") return res.status(200).send(error("非单视频快创项目"));

    try {
      await getOwnedSession(projectId, sessionId);
    } catch (err) {
      if (err instanceof QuickVideoError) return res.status(200).send(error(err.message));
      throw err;
    }

    const session = await saveSessionModels(projectId, sessionId, { textModel, imageModel, videoModel });
    // 镜像为项目默认值，供后续新建会话继承；不回填其他既有会话
    await u.db("o_project").where("id", projectId).update({ textModel, imageModel, videoModel });
    res.status(200).send(success({ session }));
  },
);

