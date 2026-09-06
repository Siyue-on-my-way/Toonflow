import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
const router = express.Router();

export default router.post("/", async (req, res) => {
  const data = await u.db("o_vendorConfig").select("*");

  const list = (
    await Promise.all(
      data.map(async (item) => {
        const vendor = u.vendor.getVendor(item.id!);
        if (!vendor) {
          await u.db("o_vendorConfig").where("id", item.id).delete();
          return null
        };

        const catalogModels = await u.vendor.getModelList(item.id!);

        const rawInputValues = JSON.parse(item.inputValues ?? "{}");
        const decryptedInputValues = { ...rawInputValues };
        for (const key in decryptedInputValues) {
          if (key.toLowerCase().includes("key") || key.toLowerCase().includes("secret") || key.toLowerCase().includes("token")) {
            decryptedInputValues[key] = u.crypto.decrypt(decryptedInputValues[key]);
          }
        }

        const enabledModelNames = await u.vendor.getEnabledModelNames(item.id!);

        return {
          ...item,
          inputValues: decryptedInputValues,
          models: catalogModels.filter((m: any) => enabledModelNames.includes(m.modelName)),
          // 渠道协议目录（Layer1）里声明的全部模型，未按启用状态过滤，
          // 供前端"选择要启用的模型"弹窗展示尚未启用的目录条目
          catalogModels,
          enable: item.enable ?? 0,
          code: "", // Code is now static, no need to send it
          description: vendor.description ?? "",
          inputs: vendor.inputs,
          author: vendor.author,
          name: vendor.name,
          version: vendor.version ?? "1.0",
        };
      }),
    )
  ).filter((i) => Boolean(i));

  list.sort((a, b) => (a!.id === "toonflow" ? -1 : b!.id === "toonflow" ? 1 : 0));
  res.status(200).send(success(list));
});


