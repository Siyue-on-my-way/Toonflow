import u from "@/utils";
import { vendors } from "@/vendors";

export function writeCode(id: string | number, tsCode: string) {
  // No-op: We no longer write code to the filesystem
}

export function getCode(id: string): string {
  // No-op: We no longer read code from the filesystem
  return "";
}

export async function getModelList(id: string): Promise<Array<any>> {
  const models = await u.db("o_vendorConfig").where("id", id).select("models").first();
  if (!models || !models.models) return [];
  
  // 数据库中存储的是用户自定义的模型列表（可能包括被删除的基本模型）
  // 我们不再将代码中的基本模型强制合并进去，而是完全以数据库中的为准
  // 这样用户就可以删除任何模型了
  return JSON.parse(models.models);
}

export function getVendor(id: string) {
  const vendorModule = vendors[id];
  if (!vendorModule) return null;
  return vendorModule.vendor;
}

export function getVendorModule(id: string) {
  return vendors[id];
}

// 渠道 Key / 已启用模型现在是全局配置（仅 admin 可写，参见 SIY-65）：直接存在 o_vendorConfig 上，
// 不再区分是哪个账号在读/写，所有用户共享同一份。

// 某个渠道全局启用的模型名列表
export async function getEnabledModelNames(vendorId: string): Promise<string[]> {
  const row = await u.db("o_vendorConfig").where("id", vendorId).first();
  if (!row?.enabledModels) return [];
  try {
    return JSON.parse(row.enabledModels);
  } catch {
    return [];
  }
}

// 覆写某个渠道全局启用的模型名列表
export async function setEnabledModelNames(vendorId: string, modelNames: string[]) {
  await u.db("o_vendorConfig").where("id", vendorId).update({ enabledModels: JSON.stringify(modelNames) });
}

