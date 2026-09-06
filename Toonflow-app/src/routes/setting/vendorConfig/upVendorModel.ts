import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields, requireRole } from "@/middleware/middleware";
import { vendorModelSchema } from "@/lib/vendorModelSchema";
import u from "@/utils";
import { z } from "zod";
const router = express.Router();

export default router.post(
  "/",
  requireRole("admin", "只有管理员才能修改模型启用状态"),
  validateFields({
    id: z.string(),
    modelName: z.string(),
    model: vendorModelSchema,
  }),
  async (req, res) => {
    const { id, modelName, model } = req.body;
    const newModelName = model.modelName;

    const catalogModels = await u.vendor.getModelList(id);
    if (!catalogModels.find((m: any) => m.modelName === newModelName)) {
      return res.status(400).send(error(`模型「${newModelName}」尚未在渠道协议目录中定义，请联系管理员先添加该模型协议`));
    }

    const enabledModels = await u.vendor.getEnabledModelNames(id);
    if (!enabledModels.includes(modelName)) {
      return res.status(400).send(error(`模型「${modelName}」尚未启用，无法编辑，请先启用`));
    }

    const updatedModels = enabledModels.filter((m) => m !== modelName);
    if (!updatedModels.includes(newModelName)) updatedModels.push(newModelName);
    await u.vendor.setEnabledModelNames(id, updatedModels);
    res.status(200).send(success("更新成功"));
  },
);
