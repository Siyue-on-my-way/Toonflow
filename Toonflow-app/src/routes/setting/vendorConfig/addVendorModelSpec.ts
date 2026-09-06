import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields, requireRole } from "@/middleware/middleware";
import { vendorModelSchema } from "@/lib/vendorModelSchema";
import u from "@/utils";
import { z } from "zod";
const router = express.Router();

// admin-only：往渠道协议目录（Layer1，o_vendorConfig.models）新增一条模型协议。
export default router.post(
  "/",
  requireRole("admin", "只有管理员才能维护渠道协议目录"),
  validateFields({
    id: z.string(),
    model: vendorModelSchema,
  }),
  async (req, res) => {
    const { id, model } = req.body;

    const vendor = u.vendor.getVendor(id);
    if (!vendor) return res.status(400).send(error("渠道不存在"));

    const catalogModels = await u.vendor.getModelList(id);
    if (catalogModels.find((m: any) => m.modelName === model.modelName)) {
      return res.status(400).send(error(`模型「${model.modelName}」已存在于协议目录中`));
    }

    catalogModels.push(model);
    await u.db("o_vendorConfig").where("id", id).update({ models: JSON.stringify(catalogModels) });
    res.status(200).send(success("添加成功"));
  },
);
