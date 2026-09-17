/**
 * QuickVideo / 单视频快创 —— 聊天模型参数确认卡（SIY-161）
 *
 * 方案C：卡片 = 模型元数据投影 + LLM 预填 + 用户授权。
 * - buildVideoParamsCard：把 o_vendorConfig.models 的视频模型条目（vendorModelSchema 校验过的协议目录）
 *   投影成卡片字段，禁止按模型名特判；未声明的参数不出现在卡片上。
 * - validateVideoParamsAgainstCatalog：确认提交后的硬校验（前端校验可被绕过，服务端为准）。
 * - applyVideoParamsEdits：合并用户修改并标记来源，禁止黑箱合并。
 * 纯函数 + 唯一的 DB 依赖点是调用方传入的目录条目，可零依赖单元测试。
 */
import {
  ChatVideoParams,
  QuickVideoVideoParamsCard,
  VideoParamField,
  VideoParamsPreference,
} from "./contract";
import { QuickVideoError } from "./contract";
import { VendorModelEntry, collectDurationTiers } from "./modelValidation";

/** 模型目录条目的输入模式（字符串简单模式） */
type SimpleMode = "singleImage" | "startEndRequired" | "endFrameOptional" | "startFrameOptional" | "text";

/** 解析后的输入模式声明：simple=字符串模式；multi=数组组合（如 imageReference:9） */
interface DeclaredMode {
  kind: SimpleMode | "multiReference";
  raw: string | string[];
  refs: { type: string; count: number }[];
}

/** 从目录 mode 声明解析出全部输入模式（畸形声明静默跳过，目录经 vendorModelSchema 校验过通常合法） */
export function parseDeclaredModes(entry: VendorModelEntry): DeclaredMode[] {
  const modes = Array.isArray(entry.mode) ? (entry.mode as unknown[]) : [];
  const result: DeclaredMode[] = [];
  for (const m of modes) {
    if (typeof m === "string") {
      result.push({ kind: m as SimpleMode, raw: m, refs: [] });
    } else if (Array.isArray(m)) {
      const refs: { type: string; count: number }[] = [];
      for (const ref of m) {
        const match = String(ref).match(/^(videoReference|imageReference|audioReference):(\d+)$/);
        if (match) refs.push({ type: match[1], count: Number(match[2]) });
      }
      if (refs.length) result.push({ kind: "multiReference", raw: m as string[], refs });
    }
  }
  return result;
}

/** 模式展示名（与设置页测试面板同口径） */
export function declaredModeLabel(mode: DeclaredMode): string {
  switch (mode.kind) {
    case "text":
      return "文生视频";
    case "singleImage":
      return "首帧图生视频";
    case "startEndRequired":
      return "首尾帧（必填）";
    case "endFrameOptional":
      return "首帧 + 可选尾帧";
    case "startFrameOptional":
      return "可选首帧 + 尾帧";
    case "multiReference":
      return `参考图模式（${mode.refs.map((r) => `${r.type === "imageReference" ? "图" : r.type === "videoReference" ? "视频" : "音频"}×${r.count}`).join(" + ")}）`;
  }
}

/** 该模式需要几张图片（聊天链路只产图片参考） */
export function declaredModeImageCount(mode: DeclaredMode): number {
  switch (mode.kind) {
    case "singleImage":
      return 1;
    case "startEndRequired":
      return 2;
    case "endFrameOptional":
    case "startFrameOptional":
      return 1;
    case "multiReference":
      // 数组声明是"至多 N 个参考"的上限语义；聊天链路至少 1 张图即可进入该模式
      return mode.refs.some((r) => r.type === "imageReference") ? 1 : 0;
    default:
      return 0;
  }
}

/** 目录声明里与聊天链路相关的分辨率档位（跨 duration 组去重，"default" 占位不出）；
 *  仅一个固定档位时返回单元素数组（调用方据此决定是否出控件） */
export function collectResolutionOptions(entry: VendorModelEntry): string[] {
  const map = Array.isArray(entry.durationResolutionMap) ? (entry.durationResolutionMap as any[]) : [];
  const seen = new Set<string>();
  for (const group of map) for (const r of group?.resolution ?? []) seen.add(String(r));
  const list = [...seen];
  return list.length === 1 && list[0] === "default" ? [] : list;
}

/** 目录声明的全部离散时长取值（含 -1 自动档，升序，-1 在最前）；与 collectDurationTiers 的区别是不剔除 -1 */
function collectDeclaredDurations(entry: VendorModelEntry): number[] {
  const map = Array.isArray(entry.durationResolutionMap) ? (entry.durationResolutionMap as any[]) : [];
  const seen = new Set<number>();
  for (const group of map) {
    for (const d of group?.duration ?? []) {
      if (typeof d === "number" && Number.isFinite(d)) seen.add(d);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

/** 连续时长区间（durationContinuous 时取第一组 [min, max]） */
export function collectContinuousDurationRange(entry: VendorModelEntry): { min: number; max: number } | null {
  if (!entry.durationContinuous) return null;
  const map = Array.isArray(entry.durationResolutionMap) ? (entry.durationResolutionMap as any[]) : [];
  const list = [...((map[0]?.duration as number[]) ?? [])].sort((a, b) => a - b);
  if (!list.length) return null;
  return { min: list[0], max: list[list.length - 1] };
}

/** 目录元数据声明的说明文案（resolutionNote/durationAutoNote/costNote，供应商参数演进同步点） */
function entryNote(entry: VendorModelEntry, key: "resolutionNote" | "durationAutoNote" | "costNote"): string | undefined {
  const value = (entry as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export interface BuildVideoParamsCardOptions {
  cardId: string;
  modelKey: string;
  modelName: string;
  sessionId: number;
  /** LLM 从聊天意图预填的提示词 */
  prompt: string;
  /** 卡片创建时冻结的参考图（三级解析结果） */
  referenceMediaIds: number[];
  /** LLM 意图提取的时长倾向（仅是初值建议） */
  durationHint?: number;
  /** 本会话上次确认的参数（预填 + 来源标记 preference） */
  preference?: VideoParamsPreference | null;
  /** 项目画面比例（系统兜底值） */
  projectRatio: string;
}

/**
 * 把模型目录条目投影成参数确认卡。
 * 字段清单完全由元数据驱动：mode（必出）、时长（离散档位/连续区间）、比例、画质档、分辨率、
 * controls 声明的高级开关；未声明的参数一律不出现。一级保留核心项（输入模式/时长/比例/画质或分辨率/
 * 音频），其余进高级折叠区。
 */
export function buildVideoParamsCard(entry: VendorModelEntry, opts: BuildVideoParamsCardOptions): QuickVideoVideoParamsCard {
  const pref = opts.preference && opts.preference.modelKey === opts.modelKey ? opts.preference : null;
  const prefParams = pref?.params ?? {};
  const fields: VideoParamField[] = [];

  // ---- 输入模式（核心项，必出）：守门规则可视化在选项上 ----
  const declared = parseDeclaredModes(entry);
  const refCount = opts.referenceMediaIds.length;
  const hasTextMode = declared.some((m) => m.kind === "text");
  const modeOptions = declared.map((mode) => {
    const needImages = declaredModeImageCount(mode);
    // 无引用图：所有以图为条件的模式不可选（守门：无图禁首帧）；仅声明图输入的模型
    // （如 Kling O1）不在此列——确认后由生成内核走概念首帧链式生成，字段随说明保留
    if (refCount === 0 && needImages > 0 && hasTextMode) {
      return { value: JSON.stringify(mode.raw), label: declaredModeLabel(mode), disabled: true, hint: "先在聊天框附带图片后再选择该模式" };
    }
    // 有引用图但张数不足（如首尾帧需要 2 张）
    if (refCount > 0 && needImages > refCount && mode.kind !== "multiReference") {
      return { value: JSON.stringify(mode.raw), label: declaredModeLabel(mode), disabled: true, hint: `该模式需要 ${needImages} 张图片，本轮只附带 ${refCount} 张` };
    }
    // 有引用图时的纯文生模式：可选但降权展示，需用户显式选择（守门：有图默认带图，不静默弃图）
    if (refCount > 0 && mode.kind === "text") {
      return { value: JSON.stringify(mode.raw), label: declaredModeLabel(mode), deemphasized: true, hint: "将不使用你本轮附带的图片" };
    }
    return { value: JSON.stringify(mode.raw), label: declaredModeLabel(mode) };
  });
  // 默认模式：有引用图时选第一个图片模式（有图自动带图）；无引用图选文生视频；
  // 模型未声明文生视频（图输入专属）时保留其图输入模式，生成内核会自动走概念首帧链
  const defaultMode =
    declared.find((m) => refCount > 0 && declaredModeImageCount(m) > 0 && declaredModeImageCount(m) <= refCount) ??
    declared.find((m) => m.kind === "text") ??
    declared[0];
  const modeValue = typeof prefParams.mode === "string" && modeOptions.some((o) => o.value === prefParams.mode && !o.disabled)
    ? prefParams.mode
    : defaultMode
      ? JSON.stringify(defaultMode.raw)
      : modeOptions[0]?.value ?? "";
  const conceptFrameNote = refCount === 0 && !hasTextMode ? "未附带图片：确认后系统将自动生成概念首帧图并以其为首帧生成" : undefined;
  fields.push({
    key: "mode",
    label: "输入模式",
    type: "select",
    value: modeValue,
    options: modeOptions,
    required: true,
    advanced: false,
    source: prefParams.mode != null && prefParams.mode === modeValue && pref ? "preference" : refCount > 0 ? "llm" : "system",
    note: conceptFrameNote ?? (refCount > 0 ? `已自动带上你本轮附带的 ${refCount} 张图片（可在下方预览）` : undefined),
  });

  // ---- 时长（核心项）：离散档位下拉（含 -1 自动档）或连续区间滑条 ----
  const declaredDurations = collectDeclaredDurations(entry);
  const positiveTiers = declaredDurations.filter((d) => d > 0);
  const continuous = collectContinuousDurationRange(entry);
  const autoNote = entryNote(entry, "durationAutoNote");
  if (continuous) {
    const prefDuration = typeof prefParams.duration === "number" ? prefParams.duration : undefined;
    const llmDuration = opts.durationHint != null ? Math.min(continuous.max, Math.max(continuous.min, opts.durationHint)) : undefined;
    const duration = prefDuration ?? llmDuration ?? Math.min(5, continuous.max);
    fields.push({
      key: "duration",
      label: "时长（秒）",
      type: "slider",
      value: duration,
      min: continuous.min,
      max: continuous.max,
      step: 0.5,
      advanced: false,
      source: prefDuration != null ? "preference" : llmDuration != null ? "llm" : "system",
    });
  } else if (declaredDurations.length) {
    const prefDuration = typeof prefParams.duration === "number" ? prefParams.duration : undefined;
    const llmDuration = opts.durationHint != null ? snapToTiers(opts.durationHint, positiveTiers) : undefined;
    const duration = prefDuration ?? llmDuration ?? (declaredDurations.includes(5) ? 5 : positiveTiers[0] ?? declaredDurations[0]);
    fields.push({
      key: "duration",
      label: "时长（秒）",
      type: "select",
      value: duration,
      options: declaredDurations.map((d) => ({
        value: d,
        label: d === -1 ? "自动" : `${d}s`,
        hint: d === -1 ? autoNote : undefined,
      })),
      advanced: false,
      source: prefDuration != null ? "preference" : llmDuration != null ? "llm" : "system",
    });
  }

  // ---- 画面比例（核心项，模型声明了档位才出；未声明时由项目默认兜底） ----
  const ratioOptions = Array.isArray(entry.aspectRatioOptions) ? (entry.aspectRatioOptions as { value: string; label: string }[]) : [];
  if (ratioOptions.length) {
    const prefRatio = typeof prefParams.aspectRatio === "string" ? prefParams.aspectRatio : undefined;
    const fallback = ratioOptions.some((o) => o.value === opts.projectRatio) ? opts.projectRatio : ratioOptions[0].value;
    const ratio = prefRatio ?? fallback;
    fields.push({
      key: "aspectRatio",
      label: "画面比例",
      type: "select",
      value: ratio,
      options: ratioOptions.map((o) => ({ value: o.value, label: o.label })),
      advanced: false,
      source: prefRatio != null ? "preference" : "system",
    });
  }

  // ---- 画质档（核心项，如 Kling O1 的 std/pro；各档位存在价格差异，costNote 由元数据提供） ----
  const qualityOptions = Array.isArray(entry.qualityOptions) ? (entry.qualityOptions as string[]) : [];
  if (qualityOptions.length) {
    const prefQuality = typeof prefParams.quality === "string" ? prefParams.quality : undefined;
    const quality = prefQuality ?? qualityOptions[0];
    fields.push({
      key: "quality",
      label: "画质档",
      type: "select",
      value: quality,
      options: qualityOptions.map((q) => ({ value: q, label: q === "std" ? "标准（std）" : "高清（pro）" })),
      advanced: false,
      source: prefQuality != null ? "preference" : "system",
      note: entryNote(entry, "costNote"),
    });
  }

  // ---- 分辨率（核心项，如 seedance 的 480p-4k）；仅一个固定档位时不是可选项，不出控件 ----
  const resolutionOptions = collectResolutionOptions(entry);
  if (resolutionOptions.length > 1) {
    const prefResolution = typeof prefParams.resolution === "string" ? prefParams.resolution : undefined;
    const resolution = prefResolution ?? (resolutionOptions.includes("720p") ? "720p" : resolutionOptions[0]);
    fields.push({
      key: "resolution",
      label: "分辨率",
      type: "select",
      value: resolution,
      options: resolutionOptions.map((r) => ({ value: r, label: r })),
      advanced: false,
      source: prefResolution != null ? "preference" : "system",
      note: entryNote(entry, "resolutionNote"),
    });
  }

  // ---- 高级开关（controls 元数据声明驱动，渲染进折叠区） ----
  const controls = Array.isArray(entry.controls) ? (entry.controls as string[]) : [];
  if (controls.includes("generateAudio")) {
    const prefAudio = typeof prefParams.generateAudio === "boolean" ? prefParams.generateAudio : undefined;
    fields.push({
      key: "generateAudio",
      label: "自动生成音频",
      type: "switch",
      value: prefAudio ?? true,
      advanced: false,
      source: prefAudio != null ? "preference" : "system",
    });
  }
  if (controls.includes("returnLastFrame")) {
    const prefValue = typeof prefParams.returnLastFrame === "boolean" ? prefParams.returnLastFrame : undefined;
    fields.push({
      key: "returnLastFrame",
      label: "返回尾帧图片",
      type: "switch",
      value: prefValue ?? false,
      advanced: true,
      source: prefValue != null ? "preference" : "system",
    });
  }
  if (controls.includes("realPersonMode")) {
    const prefValue = typeof prefParams.realPersonMode === "boolean" ? prefParams.realPersonMode : undefined;
    fields.push({
      key: "realPersonMode",
      label: "真人模式",
      type: "switch",
      value: prefValue ?? false,
      advanced: true,
      source: prefValue != null ? "preference" : "system",
      note: "开启后图片/视频/音频参考会自动转为资产，提升真人素材生成效果",
    });
  }
  if (controls.includes("seed")) {
    const prefSeed = typeof prefParams.seed === "number" ? prefParams.seed : undefined;
    fields.push({
      key: "seed",
      label: "随机种子",
      type: "number",
      value: prefSeed ?? null,
      min: -1,
      max: 2147483647,
      step: 1,
      advanced: true,
      source: prefSeed != null ? "preference" : "system",
      note: "留空为随机；-1 表示自动",
    });
  }

  return {
    cardId: opts.cardId,
    modelKey: opts.modelKey,
    modelName: opts.modelName,
    sessionId: opts.sessionId,
    status: "pending",
    createdAt: Date.now(),
    confirmedAt: null,
    prompt: opts.prompt,
    promptSource: "llm",
    referenceMediaIds: opts.referenceMediaIds,
    fields,
  };
}

/** 时长就近取整（与 snapDurationToTiers 同口径；-1 自动档不参与） */
function snapToTiers(duration: number, tiers: number[]): number {
  const positive = tiers.filter((t) => t > 0);
  if (!positive.length) return duration;
  let best = positive[0];
  for (const tier of positive) {
    if (Math.abs(tier - duration) < Math.abs(best - duration)) best = tier;
  }
  return best;
}

/** 从卡片字段提取当前参数值（确认提交/校验共用） */
export function cardFieldsToParams(card: QuickVideoVideoParamsCard): ChatVideoParams {
  const params: ChatVideoParams = {};
  for (const field of card.fields) {
    if (field.value == null || field.value === "") continue;
    switch (field.key) {
      case "mode":
        params.mode = String(field.value);
        break;
      case "duration":
        params.duration = Number(field.value);
        break;
      case "aspectRatio":
        params.aspectRatio = String(field.value);
        break;
      case "quality":
        params.quality = field.value === "pro" ? "pro" : "std";
        break;
      case "resolution":
        params.resolution = String(field.value);
        break;
      case "generateAudio":
      case "returnLastFrame":
      case "realPersonMode":
        (params as Record<string, unknown>)[field.key] = Boolean(field.value);
        break;
      case "seed":
        params.seed = Number(field.value);
        break;
    }
  }
  return params;
}

/**
 * 确认提交的硬校验：params 必须与模型目录声明精确匹配（字段与所选模型元数据精确匹配，
 * 无多余或缺失字段；前端校验可被绕过，服务端为准）。校验失败抛 QuickVideoError("VIDEO_PARAMS_INVALID")。
 */
export function validateVideoParamsAgainstCatalog(
  entry: VendorModelEntry,
  params: ChatVideoParams,
  referenceCount: number,
  prompt?: string,
): ChatVideoParams {
  const invalid = (message: string): QuickVideoError => new QuickVideoError("VIDEO_PARAMS_INVALID", message);

  // ---- 输入模式：必须命中目录声明之一，且与参考图数量一致 ----
  const declared = parseDeclaredModes(entry);
  const hasTextMode = declared.some((m) => m.kind === "text");
  if (!params.mode) throw invalid("缺少输入模式参数");
  const mode = declared.find((m) => JSON.stringify(m.raw) === params.mode);
  if (!mode) {
    throw invalid(`输入模式与模型能力不匹配：所选模型未声明该模式，请在参数卡上重新选择`);
  }
  const needImages = declaredModeImageCount(mode);
  if (needImages > 0 && referenceCount === 0 && hasTextMode) {
    // 例外：模型未声明文生视频（图输入专属，如 Kling O1）时放行——生成内核会自动
    // 生成概念首帧图并以其为首帧生成（卡片模式字段有说明），不算参数错配
    throw invalid("所选输入模式需要参考图片，但本次没有任何引用图；请先在聊天框附带图片或改选文生视频模式");
  }

  // ---- 时长：离散档位（含 -1 自动）或连续区间 ----
  const declaredDurations = collectDeclaredDurations(entry);
  const continuous = collectContinuousDurationRange(entry);
  if (typeof params.duration === "number") {
    if (continuous) {
      if (params.duration < continuous.min || params.duration > continuous.max) {
        throw invalid(`时长 ${params.duration}s 超出模型声明的连续区间 ${continuous.min}-${continuous.max}s`);
      }
    } else if (declaredDurations.length && !declaredDurations.includes(params.duration)) {
      throw invalid(
        `时长 ${params.duration}s 不在模型声明档位（${declaredDurations.map((t) => (t === -1 ? "自动" : `${t}s`)).join("、")}）内`,
      );
    }
  }

  // ---- 比例：命中声明档位（未声明档位的模型不校验，沿用项目默认） ----
  const ratioOptions = Array.isArray(entry.aspectRatioOptions) ? (entry.aspectRatioOptions as { value: string }[]) : [];
  if (ratioOptions.length && params.aspectRatio != null && !ratioOptions.some((o) => o.value === params.aspectRatio)) {
    throw invalid(`画面比例 ${params.aspectRatio} 不在模型声明档位（${ratioOptions.map((o) => o.value).join("、")}）内`);
  }

  // ---- 画质档 ----
  const qualityOptions = Array.isArray(entry.qualityOptions) ? (entry.qualityOptions as string[]) : [];
  if (qualityOptions.length && params.quality != null && !qualityOptions.includes(params.quality)) {
    throw invalid(`画质档 ${params.quality} 不在模型声明档位（${qualityOptions.join("、")}）内`);
  }

  // ---- 分辨率 ----
  const resolutionOptions = collectResolutionOptions(entry);
  if (resolutionOptions.length && params.resolution != null && !resolutionOptions.includes(params.resolution)) {
    throw invalid(`分辨率 ${params.resolution} 不在模型声明档位（${resolutionOptions.join("、")}）内`);
  }

  // ---- 高级开关：未在 controls 声明的开关一律拒绝（元数据即物理能力） ----
  const controls = Array.isArray(entry.controls) ? (entry.controls as string[]) : [];
  for (const key of ["generateAudio", "returnLastFrame", "realPersonMode", "seed"] as const) {
    if (params[key] === undefined) continue;
    if (!controls.includes(key)) {
      throw invalid(`参数「${key}」不是所选模型声明的能力，已拒绝透传`);
    }
  }
  if (params.seed != null && (!Number.isInteger(params.seed) || params.seed < -1 || params.seed > 2147483647)) {
    throw invalid("seed 必须是 -1 ~ 2147483647 之间的整数");
  }

  // ---- 提示词：必填与字数区间（prompt 随卡片携带，不在 ChatVideoParams 里） ----
  const promptRequired = (entry as Record<string, unknown>).promptRequired === true;
  const range = (entry as Record<string, unknown>).promptLengthRange;
  if (promptRequired && !prompt?.trim()) {
    throw invalid("该模型要求提示词必填，请在参数卡上补充生成提示词");
  }
  if (Array.isArray(range) && prompt && prompt.trim()) {
    const [min, max] = range as number[];
    if (prompt.length < min || prompt.length > max) {
      throw invalid(`提示词长度需在 ${min}-${max} 字之间，当前 ${prompt.length} 字`);
    }
  }
  return params;
}

/**
 * 合并用户在卡片上的修改：只接受卡片已有字段的取值（白名单），来源标记改为 user。
 * edits 的取值类型与字段类型不符时抛错（前端可被绕过，这里兜底）。
 */
export function applyVideoParamsEdits(card: QuickVideoVideoParamsCard, edits: Record<string, unknown>, promptEdit?: string): QuickVideoVideoParamsCard {
  const updated: QuickVideoVideoParamsCard = {
    ...card,
    fields: card.fields.map((field) => ({ ...field, options: field.options ? [...field.options] : undefined })),
  };
  for (const [key, rawValue] of Object.entries(edits ?? {})) {
    const field = updated.fields.find((f) => f.key === key);
    if (!field) continue; // 非卡片字段直接忽略（无多余字段原则）
    let value: string | number | boolean;
    if (field.type === "switch") {
      if (typeof rawValue !== "boolean") throw new QuickVideoError("VIDEO_PARAMS_INVALID", `参数「${field.label}」需要布尔值`);
      value = rawValue;
    } else if (field.type === "number") {
      const num = Number(rawValue);
      if (!Number.isFinite(num)) throw new QuickVideoError("VIDEO_PARAMS_INVALID", `参数「${field.label}」需要数字`);
      if (field.min != null && num < field.min) throw new QuickVideoError("VIDEO_PARAMS_INVALID", `参数「${field.label}」不能小于 ${field.min}`);
      if (field.max != null && num > field.max) throw new QuickVideoError("VIDEO_PARAMS_INVALID", `参数「${field.label}」不能大于 ${field.max}`);
      value = num;
    } else if (field.type === "slider") {
      const num = Number(rawValue);
      if (!Number.isFinite(num)) throw new QuickVideoError("VIDEO_PARAMS_INVALID", `参数「${field.label}」需要数字`);
      if (field.min != null && num < field.min) throw new QuickVideoError("VIDEO_PARAMS_INVALID", `参数「${field.label}」不能小于 ${field.min}`);
      if (field.max != null && num > field.max) throw new QuickVideoError("VIDEO_PARAMS_INVALID", `参数「${field.label}」不能大于 ${field.max}`);
      value = num;
    } else {
      // select：值必须命中该字段的选项（含被置灰的选项——置灰是引导，服务端不重复校验图片数，
      // 图片数一致性由 validateVideoParamsAgainstCatalog 按最终参考图数量统一守门）
      const strValue = String(rawValue);
      const option = field.options?.find((o) => String(o.value) === strValue);
      if (!option) throw new QuickVideoError("VIDEO_PARAMS_INVALID", `参数「${field.label}」的取值不在可选项内`);
      if (option.disabled) throw new QuickVideoError("VIDEO_PARAMS_INVALID", `参数「${field.label}」当前不可选：${option.hint ?? "该选项已被守门规则禁用"}`);
      value = option.value;
    }
    field.value = value;
    field.source = "user";
  }
  if (typeof promptEdit === "string") {
    updated.prompt = promptEdit.slice(0, 4000);
    updated.promptSource = "user";
  }
  return updated;
}

/**
 * 会话参数偏好决策：本模型存在「不再询问」偏好且未要求重新询问时，直接按偏好参数生成（不弹卡）。
 * 纯函数，偏好过期/模型不匹配时返回 null（回落到弹卡）。
 */
export function resolveSkipAskPreference(
  preference: VideoParamsPreference | null | undefined,
  modelKey: string,
  forceAsk: boolean,
): VideoParamsPreference | null {
  if (forceAsk) return null;
  if (!preference || preference.modelKey !== modelKey) return null;
  return preference.skipAsk ? preference : null;
}

/** 用户要求恢复参数确认（不再沿用）的确定性短语（服务端兜底，不依赖 LLM 判断） */
export function matchesResetAskPreference(text: string | null | undefined): boolean {
  if (!text) return false;
  return /(重新(询问|弹出|显示)?(参数|确认卡)|恢复参数确认|每次都(要)?问|别再(自动|沿用)|不要沿用)/.test(text);
}
