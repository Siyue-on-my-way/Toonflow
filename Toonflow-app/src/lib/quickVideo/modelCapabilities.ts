/**
 * QuickVideo 生成链路的模型能力判断。
 *
 * 供应商目录的顺序不代表模型适合当前输入：例如仅支持参考图的模型
 * 不能处理 assetRefs 为空的镜头。把判断提取成纯函数，生成层和单元测试
 * 共用同一套规则，避免再次退化为“取目录第一项”。
 */

export interface QuickVideoImageModelCandidate {
  modelName: string;
  type?: string;
  mode?: unknown;
  minReferenceImages?: number;
  maxReferenceImages?: number;
}

export interface QuickVideoVideoModelCandidate {
  modelName: string;
  type?: string;
  mode?: unknown;
}

export interface QuickVideoImageInputRequirements {
  /** 至少一个镜头没有参考图，需要文生图能力。 */
  needsText: boolean;
  /** 至少一个镜头有参考图，需要图生图/参考图能力。 */
  needsReference: boolean;
  /** 有参考图镜头中最少的引用数量。 */
  minReferenceImages: number;
  /** 有参考图镜头中最多的引用数量。 */
  maxReferenceImages: number;
}

export interface QuickVideoImageInputOptions {
  /** 快创还会为缺失资产生成素材图，该调用没有参考图，需要文生图能力。 */
  needsTextForMaterialGeneration?: boolean;
}

function stringModes(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function hasMode(value: unknown, mode: string): boolean {
  return stringModes(value).includes(mode);
}

/** 从冻结分镜快照推导本次图片生成所需的能力。 */
export function getQuickVideoImageInputRequirements(
  shots?: ReadonlyArray<{ assetRefs?: ReadonlyArray<unknown> | null }>,
  options: QuickVideoImageInputOptions = {},
): QuickVideoImageInputRequirements {
  const counts = (shots ?? []).map((shot) => (Array.isArray(shot.assetRefs) ? shot.assetRefs.length : 0));
  // 没有快照时按最保守的无参考图场景选择，避免误选参考图专用模型。
  if (!counts.length) {
    return { needsText: true, needsReference: false, minReferenceImages: 0, maxReferenceImages: 0 };
  }

  const referencedCounts = counts.filter((count) => count > 0);
  return {
    needsText: counts.some((count) => count === 0) || !!options.needsTextForMaterialGeneration,
    needsReference: referencedCounts.length > 0,
    minReferenceImages: referencedCounts.length ? Math.min(...referencedCounts) : 0,
    maxReferenceImages: referencedCounts.length ? Math.max(...referencedCounts) : 0,
  };
}

/** 判断图片模型能否覆盖本次快创的所有镜头输入。 */
export function supportsQuickVideoImageInput(
  model: QuickVideoImageModelCandidate,
  requirements: QuickVideoImageInputRequirements,
): boolean {
  if (model.type && model.type !== "image") return false;
  if (requirements.needsText && !hasMode(model.mode, "text")) return false;
  if (
    requirements.needsReference &&
    !hasMode(model.mode, "singleImage") &&
    !hasMode(model.mode, "multiReference")
  ) {
    return false;
  }

  const min = Number(model.minReferenceImages ?? 0);
  const max = Number(model.maxReferenceImages ?? 0);
  if (requirements.needsReference && Number.isFinite(min) && min > requirements.minReferenceImages) return false;
  if (requirements.needsReference && Number.isFinite(max) && max > 0 && max < requirements.maxReferenceImages) return false;
  // `singleImage` is a one-reference capability. A model that does not also
  // advertise `multiReference` cannot cover a shot where QuickVideo sends
  // multiple asset references (the pipeline caps the actual request at four).
  if (
    requirements.needsReference &&
    requirements.maxReferenceImages > 1 &&
    hasMode(model.mode, "singleImage") &&
    !hasMode(model.mode, "multiReference")
  ) {
    return false;
  }
  return true;
}

/** 从候选目录中选出第一个能覆盖当前输入的图片模型。 */
export function selectQuickVideoImageModel<T extends QuickVideoImageModelCandidate>(
  models: readonly T[],
  requirements: QuickVideoImageInputRequirements,
): T | undefined {
  return models.find((model) => supportsQuickVideoImageInput(model, requirements));
}

/** 快创视频以生成的分镜图作为首帧，必须支持单图生视频。 */
export function supportsQuickVideoVideoInput(model: QuickVideoVideoModelCandidate): boolean {
  return (!model.type || model.type === "video") && hasMode(model.mode, "singleImage");
}

/** 从候选目录中选出第一个支持分镜图首帧的视频模型。 */
export function selectQuickVideoVideoModel<T extends QuickVideoVideoModelCandidate>(
  models: readonly T[],
): T | undefined {
  return models.find((model) => supportsQuickVideoVideoInput(model));
}
