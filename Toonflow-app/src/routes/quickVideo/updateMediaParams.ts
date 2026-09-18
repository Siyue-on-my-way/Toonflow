import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getOwnedSession, saveSessionImageParams, QuickVideoImageParams } from "@/lib/quickVideo/session";
import { QuickVideoError } from "@/lib/quickVideo/state";

const router = express.Router();

const imageParamsSchema = z.object({
  resolution: z.enum(["1K", "2K", "4K"]).optional(),
  ratioMode: z.enum(["project", "custom"]).optional(),
  ratio: z
    .string()
    .regex(/^\s*\d{1,3}\s*:\s*\d{1,3}\s*$/, "比例需为 w:h 形式（如 16:9）")
    .optional(),
});

/**
 * 保存快创会话级图片参数偏好（SIY-163 Confirm Card 均衡版）：
 * 聊天输入框常驻参数控件（图片分辨率/比例）的选择按 session 隔离保存，
 * 聊天生图链路在服务端读取并按模型目录声明就近降级——LLM 与前端都不经手最终数值。
 * 与模型偏好（updateModels）/视频参数偏好（SIY-161）同约定：按 session 隔离、
 * 不写入 Agent 状态版本、不镜像项目。保存时只做形状校验；档位是否被所选模型
 * 支持在使用时按目录声明校验（模型可后改）。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    sessionId: z.number(),
    imageParams: imageParamsSchema.nullable().optional(),
  }),
  async (req, res) => {
    const { projectId, sessionId, imageParams } = req.body;
    const project = await u.db("o_project").where("id", projectId).select("id", "projectType").first();
    if (!project) return res.status(200).send(error("项目不存在"));
    if (project.projectType !== "quick_video") return res.status(200).send(error("非单视频快创项目"));

    try {
      await saveSessionImageParams(projectId, sessionId, (imageParams as QuickVideoImageParams | null) ?? null);
      const session = await getOwnedSession(projectId, sessionId);
      res.status(200).send(success({ session }));
    } catch (err: any) {
      if (err instanceof QuickVideoError) return res.status(200).send(error(err.message));
      throw err;
    }
  },
);
