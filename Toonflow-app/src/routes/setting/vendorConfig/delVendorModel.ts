import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields, requireRole } from "@/middleware/middleware";
import u from "@/utils";
import { z } from "zod";
const router = express.Router();

export default router.post(
  "/",
  requireRole("admin", "只有管理员才能停用模型"),
  validateFields({
    id: z.string(),
    modelName: z.string(),
  }),
  async (req, res) => {
    const { id, modelName } = req.body;

    const enabledModels = await u.vendor.getEnabledModelNames(id);
    const updatedModels = enabledModels.filter((m) => m !== modelName);
    await u.vendor.setEnabledModelNames(id, updatedModels);
    res.status(200).send(success("更新成功"));
  },
);
