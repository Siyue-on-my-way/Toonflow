/**
 * QuickVideo / 单视频快创 —— 模型校验的纯函数部分（SIY-132）
 *
 * 与 media.ts 分开：本文件不依赖 db.ts（不引入 MySQL 连接前置校验），可在无数据库环境下
 * 直接单元测试（见 scripts/quickvideo-media-unit.ts）。media.ts 的 validateImageModelKey
 * 负责从 o_vendorConfig 取数后调用这里的纯函数做判定。
 */

export interface VendorModelEntry {
  modelName: string;
  type: string;
  [key: string]: unknown;
}

/**
 * 纯函数：在供应商模型目录 + 全局启用列表中查找并校验一个模型是否可用。
 * enabledNames 为空数组时视为"未收紧启用范围"，放行目录中的任意模型（与
 * generate.ts 的 findFirstAvailableModel 现有约定一致）。
 */
export function pickEnabledModel(
  models: VendorModelEntry[],
  enabledNames: string[],
  modelName: string,
  type: string,
): VendorModelEntry | null {
  const hit = models.find((m) => m.modelName === modelName && m.type === type);
  if (!hit) return null;
  if (enabledNames.length > 0 && !enabledNames.includes(modelName)) return null;
  return hit;
}
