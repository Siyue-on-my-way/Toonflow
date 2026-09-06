import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields, requireRole } from "@/middleware/middleware";
import u from "@/utils";
import { z } from "zod";
const router = express.Router();

// admin-only：从渠道协议目录（Layer1，o_vendorConfig.models）里删除一条模型协议。
// 顺带把该模型从全局已启用列表（Layer2，o_vendorConfig.enabledModels）里摘掉，避免留下指向已删除协议的脏引用。
export default router.post(
  "/",
  requireRole("admin", "只有管理员才能维护渠道协议目录"),
  validateFields({
    id: z.string(),
    modelName: z.string(),
  }),
  async (req, res) => {
    const { id, modelName } = req.body;

    const catalogModels = await u.vendor.getModelList(id);
    const updatedModels = catalogModels.filter((m: any) => m.modelName !== modelName);
    if (updatedModels.length === catalogModels.length) {
      return res.status(400).send(error(`模型「${modelName}」不存在于协议目录中`));
    }

    await u.db("o_vendorConfig").where("id", id).update({ models: JSON.stringify(updatedModels) });

    const enabledModels = await u.vendor.getEnabledModelNames(id);
    if (enabledModels.includes(modelName)) {
      await u.vendor.setEnabledModelNames(
        id,
        enabledModels.filter((m) => m !== modelName),
      );
    }

    res.status(200).send(success("删除成功"));
  },
);
