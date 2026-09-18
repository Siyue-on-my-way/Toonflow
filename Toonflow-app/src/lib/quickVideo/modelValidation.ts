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

// ---------------------------------------------------------------------------
// 能力参数就近降级（SIY-163 Confirm Card 均衡版：聊天图片参数 + 管道参数的服务端硬校验）
//
// 与 snapDurationToTiers 同一原则：用户在常驻控件/确认卡上选择的档位只是"授权"，
// 服务端按模型目录声明的档位做最后校验——声明之外的值就近降级并在回复中说明，
// 绝不把非法值直传供应商；目录未声明（null/空数组）时维持既有默认行为，零变化。
// 视频链路的参数授权由 SIY-161 的确认卡体系负责，本节只覆盖图片与确认卡管道段。
// ---------------------------------------------------------------------------

/** 解析分辨率档位的数值量级："1K"->1000、"2K"->2000、"4K"->4000、"720p"->720、"1080p"->1080；无法解析返回 null */
export function parseResolutionMagnitude(resolution: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(K|k|P|p)?$/.exec(String(resolution ?? "").trim());
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return (m[2] ?? "p").toLowerCase() === "k" ? value * 1000 : value;
}

/**
 * 纯函数：把请求分辨率就近映射到声明档位（按数值量级就近，距离相同取较小档）。
 * 没有声明档位或请求值无法解析时返回 null（调用方按原值/默认值直传，维持既有行为）。
 */
export function snapResolutionToTiers(resolution: string, tiers: string[]): string | null {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  const target = parseResolutionMagnitude(resolution);
  if (target == null) return null;
  const declared = tiers
    .map((t) => ({ t, magnitude: parseResolutionMagnitude(t) }))
    .filter((x): x is { t: string; magnitude: number } => x.magnitude != null)
    .sort((a, b) => a.magnitude - b.magnitude);
  if (!declared.length) return null;
  let best = declared[0];
  for (const item of declared) {
    if (Math.abs(item.magnitude - target) < Math.abs(best.magnitude - target)) best = item;
  }
  return best.t;
}

/** 校验 "w:h" 比例串的形状（1-3 位正整数宽高，容许首尾空格） */
export function isWellFormedRatio(ratio: string): boolean {
  return /^\s*\d{1,3}\s*:\s*\d{1,3}\s*$/.test(String(ratio ?? ""));
}

/** 解析 "w:h" 的宽高比数值（w/h）；形状非法或宽高为 0 时返回 null */
export function parseRatioValue(ratio: string): number | null {
  if (!isWellFormedRatio(ratio)) return null;
  const [w, h] = String(ratio)
    .split(":")
    .map((p) => Number(p.trim()));
  if (!w || !h) return null;
  return w / h;
}

/**
 * 纯函数：把请求比例就近映射到声明档位（按宽高比数值就近，距离相同取数值较小的档）。
 * 没有声明档位或请求值形状非法时返回 null（调用方回落项目比例，维持既有行为）。
 */
export function snapRatioToTiers(ratio: string, tiers: string[]): string | null {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  const target = parseRatioValue(ratio);
  if (target == null) return null;
  const declared = tiers
    .map((t) => ({ t, value: parseRatioValue(t) }))
    .filter((x): x is { t: string; value: number } => x.value != null)
    .sort((a, b) => a.value - b.value);
  if (!declared.length) return null;
  let best = declared[0];
  for (const item of declared) {
    if (Math.abs(item.value - target) < Math.abs(best.value - target)) best = item;
  }
  return best.t;
}

/** 能力参数解析结果：value=最终生效值；adjusted=用户主动选择的值被服务端降级（供回复文案与审计日志，默认值路径不算降级） */
export interface MediaParamResolveResult<T extends string> {
  value: T;
  adjusted: boolean;
}

/** ImageConfig.size 的合法枚举（utils/ai.ts 同款约束，此处独立维护以免循环依赖） */
export const IMAGE_RESOLUTION_TIERS = ["1K", "2K", "4K"] as const;
export type ImageResolutionTier = (typeof IMAGE_RESOLUTION_TIERS)[number];

/**
 * 纯函数：解析聊天/管道图片生成最终采用的分辨率档位。
 * - 目录未声明 resolutionOptions：合法枚举内按原值直传（含 null 时的现行默认 "1K"），枚举外回落 "1K"——行为与改动前完全一致；
 * - 目录已声明：声明内按原值；声明外就近降级（不可解析时取声明最小档），adjusted=true 供回复说明。
 */
export function resolveImageResolution(requested: string | null | undefined, declared: string[] | null): MediaParamResolveResult<ImageResolutionTier> {
  const requestedOrDefault = (requested ?? "1K") as ImageResolutionTier;
  if (!Array.isArray(declared) || declared.length === 0) {
    const value: ImageResolutionTier = (IMAGE_RESOLUTION_TIERS as readonly string[]).includes(requestedOrDefault) ? requestedOrDefault : "1K";
    return { value, adjusted: false };
  }
  if (declared.includes(requestedOrDefault)) return { value: requestedOrDefault, adjusted: false };
  const snapped = snapResolutionToTiers(requestedOrDefault, declared) as ImageResolutionTier | null;
  const value = snapped ?? (declared[0] as ImageResolutionTier);
  return { value, adjusted: requested != null && value !== requestedOrDefault };
}

/**
 * 纯函数：解析聊天图片生成最终采用的画面比例。
 * - 用户选择"跟随项目"（requested=null）：项目比例直传；目录声明了档位且项目比例不在其中时就近降级（adjusted=false，默认值路径不提示）；
 * - 用户自选比例：形状非法回落项目比例；目录声明外就近降级并标记 adjusted。
 */
export function resolveImageRatio(requested: string | null | undefined, projectRatio: string, declared: string[] | null): MediaParamResolveResult<string> {
  const project = isWellFormedRatio(projectRatio) ? projectRatio.trim() : "16:9";
  const pick = (candidate: string): string => {
    if (!Array.isArray(declared) || declared.length === 0) return candidate;
    if (declared.includes(candidate)) return candidate;
    return snapRatioToTiers(candidate, declared) ?? (declared.includes(project) ? project : declared[0]);
  };
  if (!requested) return { value: pick(project), adjusted: false };
  if (!isWellFormedRatio(requested)) return { value: pick(project), adjusted: false };
  const value = pick(requested.trim());
  return { value, adjusted: value !== requested.trim() };
}
