import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 新增项目
export default router.post(
  "/",
  validateFields({
    projectType: z.string(),
    textModel: z.string().optional(),
    name: z.string(),
    intro: z.string(),
    type: z.string(),
    artStyle: z.string(),
    directorManual: z.string(),
    videoRatio: z.string(),
    imageModel: z.string(),
    videoModel: z.string(),
    imageQuality: z.string(),
    mode: z.string(),
  }),
  async (req, res) => {
    const { projectType, textModel = "", name, intro, type, directorManual, artStyle, videoRatio, imageModel, videoModel, imageQuality, mode } = req.body;

    const maxRow = await u.db("o_project").max("id as maxId").first();
    const id = Number(maxRow?.maxId ?? 0) + 1;

    await u.db("o_project").insert({
      id,
      projectType,
      textModel,
      name,
      intro,
      type,
      artStyle,
      videoRatio,
      directorManual,
      userId: 1,
      imageModel,
      videoModel,
      createTime: Date.now(),
      imageQuality,
      mode,
    });

    res.status(200).send(success({ message: "新增项目成功" }));
  },
);
