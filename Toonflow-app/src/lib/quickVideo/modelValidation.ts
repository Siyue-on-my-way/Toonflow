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

/**
 * 纯函数：检查视频模型是否原生支持文本生视频（mode 包含 "text"）
 */
export function isVideoModelSupportingText(model: VendorModelEntry | null | undefined): boolean {
  if (!model) return false;
  const modes = Array.isArray(model.mode) ? (model.mode as unknown[]) : [];
  return modes.includes("text");
}

/**
 * 纯函数：检查视频模型是否支持单图/首帧模式（未声明 mode 或 mode 包含 "singleImage"）
 */
export function isVideoModelSupportingSingleImage(model: VendorModelEntry | null | undefined): boolean {
  if (!model) return true;
  const modes = Array.isArray(model.mode) ? (model.mode as unknown[]) : null;
  if (!modes) return true;
  return modes.includes("singleImage");
}

/**
 * 纯函数：从模型目录的 durationResolutionMap 提取全部声明的时长档位。
 * -1 是部分模型（如 Seedance）的「自适应时长」哨兵值，不参与就近取整；
 * 结果去重并升序，供 snapDurationToTiers 与 generate_video 工具参数说明使用（SIY-154 P2）。
 */
export function collectDurationTiers(durationResolutionMap: { duration: number[] }[]): number[] {
  const tiers = new Set<number>();
  for (const entry of durationResolutionMap ?? []) {
    for (const d of entry?.duration ?? []) {
      if (typeof d === "number" && Number.isFinite(d) && d > 0) tiers.add(d);
    }
  }
  return Array.from(tiers).sort((a, b) => a - b);
}

/**
 * 纯函数：把请求时长就近映射到声明档位（7s -> 5s/10s），距离相同取较小档位；
 * 没有声明档位（空数组）时返回 null，调用方按原时长直传（维持既有行为）。
 */
export function snapDurationToTiers(duration: number, tiers: number[]): number | null {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  let best = tiers[0];
  for (const tier of tiers) {
    if (Math.abs(tier - duration) < Math.abs(best - duration)) best = tier;
  }
  return best;
}
