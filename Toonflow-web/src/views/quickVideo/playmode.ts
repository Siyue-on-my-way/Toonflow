/**
 * 创作类型 × 模型能力玩法（SIY-165 多级上拉选择器）：
 * 输入区第一层「创作类型」（智能 Agent/图片生成/视频生成，预留音乐/音频/数字人/动作模仿档位），
 * 第三层「能力玩法」由所选模型的 mode 元数据驱动（禁止按模型名特判）：
 *   text → 文生视频/文生图；singleImage → 首帧图生视频；startEndRequired → 首尾帧；
 *   组合声明（如 imageReference:9+videoReference:3+audioReference:3）→ 全能参考；
 *   multiReference → 图片编辑。
 * 守门规则随玩法动态判定：图片恒可作为生成引用；视频/音频引用仅在「全能参考」玩法下放行
 * （兑现 SIY-164 备案的 videoReference 通道；生成参数中的 videoUrls/audioUrls 接线属下期）。
 */

export type QuickVideoPlaymodeId =
  | "auto"
  | "text"
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "omniReference"
  | `omniReference:${number}`
  | "imageEdit";

/** 组合声明里的引用类型（与 vendor.ts 的 imageReference/videoReference/audioReference 对齐） */
export type PlaymodeRefType = "imageReference" | "videoReference" | "audioReference";

export interface PlaymodeOption {
  id: QuickVideoPlaymodeId;
  /** i18n key：workbench.quickVideo.playmode.<labelKey> */
  labelKey: string;
  /** 原始 mode 声明（确认卡 input mode 字段值：字符串原样，数组 JSON 序列化） */
  rawMode: string | string[];
  /** 组合声明解析出的引用上限（全能参考：图9/视频3/音频3） */
  refs?: { type: PlaymodeRefType; count: number }[];
}

const SIMPLE_PLAYMODE_LABELS: Record<string, string> = {
  text: "textGen",
  singleImage: "firstFrame",
  startEndRequired: "startEnd",
  endFrameOptional: "firstFrameTailOptional",
  startFrameOptional: "firstFrameOptional",
};

/** 从模型目录 mode 声明解析玩法选项（畸形声明静默跳过；声明顺序即展示顺序）。
 *  组合模式 id 唯一化：首个为 omniReference，后续加序号后缀（omniReference:2…）——
 *  同一模型可声明多个组合（如图9 / 视频3 / 图9+视频3+音频3），同名会让菜单项无法区分。 */
export function parsePlaymodeOptions(modes: unknown): PlaymodeOption[] {
  const list = Array.isArray(modes) ? modes : [];
  const result: PlaymodeOption[] = [];
  let omniIndex = 0;
  for (const m of list) {
    if (typeof m === "string") {
      const labelKey = SIMPLE_PLAYMODE_LABELS[m];
      if (labelKey) result.push({ id: m as QuickVideoPlaymodeId, labelKey, rawMode: m });
    } else if (Array.isArray(m)) {
      const refs: { type: PlaymodeRefType; count: number }[] = [];
      for (const ref of m) {
        const match = String(ref).match(/^(videoReference|imageReference|audioReference):(\d+)$/);
        if (match) refs.push({ type: match[1] as PlaymodeRefType, count: Number(match[2]) });
      }
      if (refs.length) {
        omniIndex += 1;
        const id = omniIndex === 1 ? "omniReference" : `omniReference:${omniIndex}`;
        result.push({ id: id as QuickVideoPlaymodeId, labelKey: "omniReference", rawMode: m.map(String), refs });
      }
    }
  }
  return result;
}

/** 是否为组合参考类玩法（含唯一化后缀的 omniReference:N） */
export function isOmniReferenceId(id: QuickVideoPlaymodeId): boolean {
  return id === "omniReference" || id.startsWith("omniReference:");
}

/** 玩法 raw 声明 → 确认卡 input mode 字段值（mode 字段 value = JSON.stringify(mode.raw)） */
export function playmodeRawModeValue(option: PlaymodeOption): string {
  return JSON.stringify(option.rawMode);
}

/** 玩法声明的某类素材引用上限（未声明该类型则 0；图片在所有玩法下至少按既有上限放行） */
export function playmodeRefCap(option: PlaymodeOption | null, kind: "image" | "video" | "audio"): number {
  if (!option) return 0;
  const type = kind === "image" ? "imageReference" : kind === "video" ? "videoReference" : "audioReference";
  return option.refs?.find((r) => r.type === type)?.count ?? 0;
}

/**
 * 守门：当前玩法是否允许某类素材作为生成引用。
 * 图片恒放行（首帧/参考图/图生图的通用消费方）；视频/音频仅在「全能参考」类玩法放行；
 * 「智能 Agent 模式」维持 SIY-164 口径（仅图片），生成意图由 Agent 意图判定。
 */
export function playmodeAllowsKind(playmodeId: QuickVideoPlaymodeId, kind: "image" | "video" | "audio"): boolean {
  if (kind === "image") return true;
  return isOmniReferenceId(playmodeId);
}

export interface CollectReferencesResult {
  /** 去重后的引用 mediaId 列表（保序） */
  referenceIds: number[];
  /** 因玩法不允许被拦截丢弃的引用数量 */
  droppedCount: number;
  /** 各类型入列数量（托盘徽标/回显用） */
  kindCounts: { image: number; video: number; audio: number; unknown: number };
}

/** 发送前兜底：按玩法守门收集引用（去重保序），被拦截的引用计数供 toast 提示；未知类型始终拦截 */
export function collectReferenceIdsByPlaymode(
  candidates: Array<{ kind?: string; mediaId: number } | null | undefined>,
  playmodeId: QuickVideoPlaymodeId,
): CollectReferencesResult {
  const referenceIds: number[] = [];
  let droppedCount = 0;
  const kindCounts = { image: 0, video: 0, audio: 0, unknown: 0 };
  for (const ref of candidates) {
    if (!ref) continue;
    const kind = ref.kind === "image" || ref.kind === "video" || ref.kind === "audio" ? ref.kind : null;
    if (!kind || !playmodeAllowsKind(playmodeId, kind)) {
      droppedCount += 1;
      continue;
    }
    kindCounts[kind] += 1;
    if (!referenceIds.includes(ref.mediaId)) referenceIds.push(ref.mediaId);
  }
  return { referenceIds, droppedCount, kindCounts };
}
