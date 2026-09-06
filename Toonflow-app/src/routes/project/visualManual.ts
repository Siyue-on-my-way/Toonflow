import express from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getSection } from "@/utils/skillManual";
const router = express.Router();

// 视觉手册
export default router.post(
  "/",
  validateFields({
    type: z.string(),
  }),
  async (req, res) => {
    const { type } = req.body;
    const content = await getSection("art", "chinese_sweet_romance", type);
    if (!content) {
      res.status(404).json(error(`未找到对应的文件: ${type}.md`));
      return;
    }
    res.status(200).send(success(content));
  },
);
