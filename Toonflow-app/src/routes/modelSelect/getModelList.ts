import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    type: z.enum(["text", "image", "video", "all"]),
  }),
  async (req, res) => {
    const { type } = req.body;
    const dataList = await u.db("o_vendorConfig").select("id").where("enable", 1);
    if (!dataList || dataList.length === 0) {
      return res.status(404).send({ error: "模型未找到" });
    }
    const modelList = await Promise.all(
      dataList.map(async (i) => {
        const [models, enabledModelNames, vendorConfig] = await Promise.all([
          u.vendor.getModelList(i.id!),
          u.vendor.getEnabledModelNames(i.id!),
          u.db("o_vendorConfig").where("id", i.id!).select("inputValues").first(),
        ]);
        const enabled = new Set(enabledModelNames);
        const configured = !!vendorConfig?.inputValues && vendorConfig.inputValues !== "{}";
        return models
          .filter((model: { modelName: string }) => enabled.has(model.modelName))
          .map((model: any) => ({
            ...model,
            configured,
            available: configured,
            disabledReason: configured ? undefined : "请先配置该供应商的 Key",
          }));
      }),
    );
    const result = await Promise.all(
      dataList.map(async (data, index) => {
        const vendorData = await u.vendor.getVendor(data.id!);
        const models = modelList[index];
        const filtered =
          type === "all"
            ? models.filter((item: { type: string }) => item.type !== "video")
            : models.filter((item: { type: string }) => item.type === type);
        return filtered.map((item: { name: string; modelName: string; type: string; configured?: boolean; available?: boolean; disabledReason?: string }) => ({
          id: data.id,
          label: item.name,
          value: item.modelName,
          type: item.type,
          name: vendorData.name,
          configured: item.configured,
          available: item.available,
          disabledReason: item.disabledReason,
        }));
      }),
    );
    res.status(200).send(success(result.flat()));
  },
);
