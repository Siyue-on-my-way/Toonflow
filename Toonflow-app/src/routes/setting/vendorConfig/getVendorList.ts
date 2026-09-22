import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
const router = express.Router();

/** 敏感输入项判定：与加密落库（updateVendorInputs）同一条 key 规则，另认协议目录声明的 password 型 */
function isSensitiveKey(key: string, inputType?: string): boolean {
  if (inputType === "password") return true;
  const k = key.toLowerCase();
  return k.includes("key") || k.includes("secret") || k.includes("token");
}

export default router.post("/", async (req, res) => {
  // 安全修复（SIY-172 审查 P0-1）：渠道密钥（含 LibTV credentialsToken=整个账号凭据）
  // 之前解密后原样返回给任意登录用户，开放注册下等于零门槛提权。现对非 admin 统一返回掩码。
  // admin 保持原行为：设置页表单需要回显明文、失焦全量回存（掩码写回协议需另行改造）。
  const caller = await u.db("o_user").where("id", (req as any).user?.id).first();
  const isAdmin = caller?.role === "admin";

  const data = await u.db("o_vendorConfig").select("*");

  const list = (
    await Promise.all(
      data.map(async (item) => {
        const vendor = u.vendor.getVendor(item.id!);
        if (!vendor) {
          // 读接口不做破坏性清理（SIY-172 审查发现）：残留行只跳过，由管理员显式删除
          return null;
        }

        const catalogModels = await u.vendor.getModelList(item.id!);

        const rawInputValues = JSON.parse(item.inputValues ?? "{}");
        const decryptedInputValues = { ...rawInputValues };
        for (const key in decryptedInputValues) {
          const inputType = vendor.inputs?.find((i: any) => i.key === key)?.type;
          if (isSensitiveKey(key, inputType)) {
            decryptedInputValues[key] = isAdmin ? u.crypto.decrypt(decryptedInputValues[key]) : "********";
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


