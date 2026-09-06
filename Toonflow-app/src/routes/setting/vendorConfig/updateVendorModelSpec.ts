import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields, requireRole } from "@/middleware/middleware";
import { vendorModelSchema } from "@/lib/vendorModelSchema";
import u from "@/utils";
import { z } from "zod";
const router = express.Router();

// admin-only：编辑渠道协议目录（Layer1，o_vendorConfig.models）里的一条模型协议。
export default router.post(
  "/",
  requireRole("admin", "只有管理员才能维护渠道协议目录"),
  validateFields({
    id: z.string(),
    modelName: z.string(),
    model: vendorModelSchema,
  }),
  async (req, res) => {
    const { id, modelName, model } = req.body;

    const catalogModels = await u.vendor.getModelList(id);
    const index = catalogModels.findIndex((m: any) => m.modelName === modelName);
    if (index === -1) {
      return res.status(400).send(error(`模型「${modelName}」不存在于协议目录中`));
    }
    if (model.modelName !== modelName && catalogModels.find((m: any) => m.modelName === model.modelName)) {
      return res.status(400).send(error(`模型「${model.modelName}」已存在于协议目录中`));
    }

    catalogModels[index] = model;
    await u.db("o_vendorConfig").where("id", id).update({ models: JSON.stringify(catalogModels) });
    res.status(200).send(success("更新成功"));
  },
);
