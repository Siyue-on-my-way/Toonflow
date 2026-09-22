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
        let configured = !!vendorConfig?.inputValues && vendorConfig.inputValues !== "{}";
        // 用户自助绑定渠道（LibTV）：无需渠道全局 Key，未绑定时也保持可选——
        // 选中后前端就地弹绑定浮层（手机号验证码/粘贴凭据），生成链路再做绑定校验兜底。
        // 若在这里置灰，用户永远点不了 LibTV 模型，绑定入口就断了（SIY-172 用户实测反馈）。
        if (i.id === "libtv") {
          configured = true;
        }
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
        return filtered.map(
          (item: { name: string; modelName: string; type: string; mode?: unknown; configured?: boolean; available?: boolean; disabledReason?: string }) => ({
            id: data.id,
            label: item.name,
            value: item.modelName,
            type: item.type,
            // 扁平化的输入模式声明（如 singleImage/text），供前端做图生视频等场景的模型选择引导（SIY-154 P3）
            modes: Array.isArray(item.mode)
              ? item.mode.flatMap((m: unknown) => (typeof m === "string" ? [m] : []))
              : [],
            name: vendorData.name,
            configured: item.configured,
            available: item.available,
            disabledReason: item.disabledReason,
          }),
        );
      }),
    );
    res.status(200).send(success(result.flat()));
  },
);
