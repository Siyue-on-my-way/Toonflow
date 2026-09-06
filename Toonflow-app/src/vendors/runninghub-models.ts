/**
 * RunningHub 模型请求规格 DSL + 通用解释器
 *
 * RunningHub 没有统一的模型 API 契约：每个模型的 endpoint 路径、字段命名、枚举取值、
 * 字段类型都可能不一样。这个文件把"每个模型的请求体怎么拼"从 runninghub.ts 的
 * if/else 分支里拆出来，变成一张模型规格表：新增模型只需要加一条 RunningHubModelSpec，
 * 不需要改 buildRunningHubRequestBody 本身（除非该模型的字段结构 DSL 覆盖不到，
 * 那种情况走 rawExtra 兜底）。
 */

import type { ImageModel, VideoModel } from "@/types/vendor";

export type RunningHubCast = "int" | "float" | "string" | "bool";

export interface RunningHubFieldSpec {
  /** 请求体里的字段名 */
  target: string;
  /** 从内部 ImageConfig/VideoConfig 上取哪个字段 */
  from: string;
  /** 取到的值为空（undefined/null）时使用的默认值；不设置则该字段直接不出现在请求体里 */
  default?: any;
  /** 类型转换 */
  cast?: RunningHubCast;
  /** 枚举值映射，比如短格式 aspectRatio 转长格式；映射为 undefined 表示不发送该字段 */
  enumMap?: Record<string, string | undefined>;
  /** 缺失时立即拒绝；可选字段不要设置该属性 */
  required?: boolean;
  /** 完成类型转换后校验的合法值 */
  allowed?: any[];
  /** 字符串最小长度；仅在字段实际传入时校验 */
  minLength?: number;
  /** 字符串最大长度；仅在字段实际传入时校验 */
  maxLength?: number;
}

export interface RunningHubNamedSlotsImageInput {
  /** 固定几个具名字段，比如 firstImageUrl/lastImageUrl */
  mode: "namedSlots";
  slots: string[];
  /** 至少需要几张图片，默认 0（不校验） */
  required?: number;
  requiredError?: string;
  /** 最多允许几张图片，用于防止把多图误传给单图模型 */
  maxImages?: number;
  /** 单张图片允许的最大字节数 */
  maxImageBytes?: number;
  /** 内部图片是 base64；调用前需上传到 RunningHub 并替换为 download_url */
  uploadImages?: boolean;
}

export interface RunningHubArrayImageInput {
  /** 塞进一个数组字段，比如 imageUrls */
  mode: "array";
  arrayField: string;
  /** 最多塞几张，默认不限制 */
  max?: number;
  /** 至少需要几张图片，默认 0（不校验） */
  required?: number;
  requiredError?: string;
  /** 单张图片允许的最大字节数 */
  maxImageBytes?: number;
  /** 内部图片是 base64；调用前需上传到 RunningHub 并替换为 download_url */
  uploadImages?: boolean;
}

export type RunningHubImageInput = RunningHubNamedSlotsImageInput | RunningHubArrayImageInput;

export interface RunningHubModelSpec {
  modelName: string;
  /** 完整请求路径，不靠 modelName + 固定 action 拼接推导 */
  endpoint: string;
  type: "image" | "video";
  fields?: RunningHubFieldSpec[];
  imageInput?: RunningHubImageInput;
  /** 该模型固定写死的字段 */
  constants?: Record<string, any>;
  /** 根据内部配置动态映射字段，undefined 表示不发送 */
  dynamicFields?: RunningHubFieldSpec[];
  /** DSL 覆盖不到的奇怪字段结构（如 multiPrompt、elementList）的兜底透传 */
  rawExtra?: Record<string, any>;
  /** 该模型只支持某个 mode（比如纯文生视频），不满足则报错 */
  requiresMode?: string;
  requiresModeError?: string;
  /** Prompt 长度限制（字符数），在实际传入时校验 */
  promptLength?: { min: number; max: number };
  /** 合法比例枚举；为空则不校验 */
  allowedAspectRatios?: string[];
  /** 合法分辨率枚举（小写）；为空则不校验 */
  allowedResolutions?: string[];
  /** 带参考图时的独立请求路径（如图生图）；未设置则复用 endpoint */
  imageEndpoint?: string;
  /** 按生成模式要求的最少参考帧数（mode -> 最少张数），请求发出前校验 */
  requiredFramesByMode?: Record<string, number>;
  /** 多模态视频能力（Seedance 系列）：图片/视频/音频参考分流与上限，按规格判断而非模型名分支 */
  multimodalReferences?: {
    maxImages: number;
    maxVideos: number;
    maxAudios: number;
    /** 音频必须至少搭配一张图片或一段视频 */
    requireVisual: boolean;
  };
}

function castRunningHubValue(value: any, cast?: RunningHubCast): any {
  switch (cast) {
    case "int":
      return parseInt(String(value), 10);
    case "float":
      return Number(value);
    case "string":
      return String(value);
    case "bool":
      return Boolean(value);
    default:
      return value;
  }
}

/**
 * 通用解释器：读 spec + 内部配置 + 已解析好的图片引用列表，拼出发给 RunningHub 的请求体。
 * submitTask/queryTask 不受影响，这里只负责"怎么拼请求体"这一层。
 */
export function buildRunningHubRequestBody(
  spec: RunningHubModelSpec,
  config: Record<string, any>,
  imageRefs: Array<string | undefined>,
): Record<string, any> {
  if (spec.requiresMode) {
    const modes: any[] = config.mode ?? [];
    if (!modes.includes(spec.requiresMode)) {
      throw new Error(spec.requiresModeError || `模型 ${spec.modelName} 不支持当前生成模式`);
    }
  }

  if (spec.requiredFramesByMode) {
    const modes: string[] = Array.isArray(config.mode)
      ? config.mode
      : typeof config.mode === "string" && config.mode
        ? [config.mode]
        : [];
    const need = modes.reduce((max, m) => Math.max(max, spec.requiredFramesByMode![m] ?? 0), 0);
    const provided = imageRefs.filter((ref): ref is string => Boolean(ref)).length;
    if (need > 0 && provided < need) {
      throw new Error(`当前生成模式需要提供 ${need} 张帧图片，实际收到 ${provided} 张`);
    }
  }

  if (spec.promptLength) {
    const prompt = String(config.prompt ?? "");
    if (prompt.length < spec.promptLength.min || prompt.length > spec.promptLength.max) {
      throw new Error(`Prompt 长度必须在 ${spec.promptLength.min}-${spec.promptLength.max} 个字符之间`);
    }
  }

  if (
    spec.allowedAspectRatios?.length &&
    config.aspectRatio &&
    !spec.allowedAspectRatios.includes(String(config.aspectRatio))
  ) {
    throw new Error(`不支持的图像比例: ${config.aspectRatio}`);
  }

  if (
    spec.allowedResolutions?.length &&
    config.size &&
    !spec.allowedResolutions.includes(String(config.size).toLowerCase())
  ) {
    throw new Error(`不支持的图像分辨率: ${config.size}`);
  }

  const body: Record<string, any> = {};

  for (const field of spec.fields ?? []) {
    let value = config[field.from];
    if (value === undefined || value === null || value === "") {
      if (field.required) throw new Error(`参数「${field.target}」不能为空`);
      if (field.default === undefined) continue;
      value = field.default;
    }
    if (field.enumMap && Object.prototype.hasOwnProperty.call(field.enumMap, String(value))) {
      value = field.enumMap[String(value)];
    }
    if (value === undefined || value === null) continue;
    if (field.cast) value = castRunningHubValue(value, field.cast);
    if (field.allowed && !field.allowed.some((item) => item === value)) {
      throw new Error(`参数「${field.target}」仅支持：${field.allowed.map(String).join("、")}`);
    }
    if (typeof value === "string") {
      if (field.minLength !== undefined && value.length < field.minLength) {
        throw new Error(`参数「${field.target}」至少需要 ${field.minLength} 个字符`);
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        throw new Error(`参数「${field.target}」最多支持 ${field.maxLength} 个字符`);
      }
    }
    body[field.target] = value;
  }

  if (spec.imageInput) {
    const input = spec.imageInput;
    const required = input.required ?? 0;
    if (imageRefs.length < required) {
      throw new Error(input.requiredError || `${spec.modelName} 需要至少 ${required} 张参考图片`);
    }
    if (input.mode === "namedSlots" && input.maxImages !== undefined && imageRefs.length > input.maxImages) {
      throw new Error(`${spec.modelName} 最多支持 ${input.maxImages} 张参考图片`);
    }
    if (input.maxImageBytes !== undefined) {
      for (const ref of imageRefs) {
        const encoded = ref?.split(",", 2).pop() ?? "";
        const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
        const bytes = Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
        if (bytes > input.maxImageBytes) {
          throw new Error(`${spec.modelName} 的参考图片不能超过 ${Math.floor(input.maxImageBytes / 1024 / 1024)} MB`);
        }
      }
    }
    if (input.mode === "namedSlots") {
      input.slots.forEach((slot, i) => {
        if (imageRefs[i]) body[slot] = imageRefs[i];
      });
    } else {
      const max = input.max ?? imageRefs.length;
      const refs = imageRefs.filter((ref): ref is string => Boolean(ref)).slice(0, max);
      // 没有参考图时不下发空数组，避免干扰纯文生请求
      if (refs.length) body[input.arrayField] = refs;
    }
  }

  if (spec.constants) Object.assign(body, spec.constants);
  for (const field of spec.dynamicFields ?? []) {
    let value = config[field.from];
    if (value === undefined || value === null || value === "") {
      if (field.required) throw new Error(`参数「${field.target}」不能为空`);
      if (field.default === undefined) continue;
      value = field.default;
    }
    if (field.enumMap && Object.prototype.hasOwnProperty.call(field.enumMap, String(value))) {
      value = field.enumMap[String(value)];
    }
    if (value === undefined || value === null) continue;
    if (field.cast) value = castRunningHubValue(value, field.cast);
    if (field.allowed && !field.allowed.some((item) => item === value)) {
      throw new Error(`参数「${field.target}」仅支持：${field.allowed.map(String).join("、")}`);
    }
    body[field.target] = value;
  }

  if (spec.rawExtra) Object.assign(body, spec.rawExtra);

  return body;
}

export const RUNNINGHUB_MODEL_SPECS: RunningHubModelSpec[] = [
  // ================
  // 图像模型
  // ================
  {
    modelName: "rhart-image-n-g31-flash",
    endpoint: "rhart-image-n-g31-flash/image-to-image",
    type: "image",
    fields: [
      { target: "prompt", from: "prompt" },
      { target: "aspectRatio", from: "aspectRatio" },
      { target: "resolution", from: "size", enumMap: { "1K": "1k", "2K": "2k", "4K": "4k" } },
    ],
    imageInput: {
      mode: "array",
      arrayField: "imageUrls",
      max: 10,
      required: 1,
      requiredError: "图生图模式需要提供参考图片",
    },
  },
  {
    modelName: "rhart-image-n-pro/edit",
    endpoint: "rhart-image-n-pro/edit",
    type: "image",
    fields: [
      { target: "prompt", from: "prompt", required: true, maxLength: 20000 },
      {
        target: "aspectRatio",
        from: "aspectRatio",
        // 自适应比例不发送 aspectRatio 字段
        enumMap: { auto: undefined },
        allowed: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"],
      },
      { target: "resolution", from: "size", required: true, enumMap: { "1K": "1k", "2K": "2k", "4K": "4k" }, allowed: ["1k", "2k", "4k"] },
    ],
    imageInput: {
      mode: "array",
      arrayField: "imageUrls",
      max: 10,
      required: 1,
      requiredError: "Nano Banana Pro 需要提供至少 1 张参考图片",
      maxImageBytes: 10 * 1024 * 1024,
      uploadImages: true,
    },
  },
  {
    modelName: "rhart-image-g-2",
    endpoint: "rhart-image-g-2/text-to-image",
    // GPT Image 的图生图走独立 endpoint（docs/runninghub-api/gpt-image-2.0-conomy.md）
    imageEndpoint: "rhart-image-g-2/image-to-image",
    type: "image",
    fields: [
      { target: "prompt", from: "prompt" },
      { target: "aspectRatio", from: "aspectRatio" },
      { target: "resolution", from: "size", enumMap: { "1K": "1k", "2K": "2k", "4K": "4k" } },
    ],
    promptLength: { min: 1, max: 20000 },
    allowedAspectRatios: [
      "1:1", "3:2", "2:3", "5:4", "4:5", "16:9", "9:16", "21:9",
      "3:4", "4:3", "9:21", "1:2", "2:1", "1:3", "3:1",
    ],
    allowedResolutions: ["1k", "2k", "4k"],
    imageInput: { mode: "array", arrayField: "imageUrls", max: 10, maxImageBytes: 50 * 1024 * 1024 },
  },

  // ================
  // 视频模型
  // ================
  {
    modelName: "kling-video-o3-pro",
    endpoint: "kling-video-o3-pro/text-to-video",
    type: "video",
    requiresMode: "text",
    requiresModeError: "该模型仅支持文生视频模式",
    fields: [
      { target: "prompt", from: "prompt" },
      { target: "aspectRatio", from: "aspectRatio" },
      { target: "duration", from: "duration", cast: "string" },
      { target: "sound", from: "audio", cast: "bool", default: false },
    ],
    constants: { multiShot: false, shotType: "customize" },
  },
  {
    modelName: "kling-v3.0-pro",
    endpoint: "kling-v3.0-pro/image-to-video",
    type: "video",
    fields: [
      { target: "prompt", from: "prompt" },
      { target: "aspectRatio", from: "aspectRatio" },
      { target: "duration", from: "duration", cast: "string" },
      { target: "sound", from: "audio", cast: "bool", default: false },
    ],
    imageInput: {
      mode: "namedSlots",
      slots: ["firstImageUrl", "lastImageUrl"],
      required: 1,
      requiredError: "图生视频模式需要提供参考图片",
    },
    constants: { cfgScale: 0.5, multiShot: false, shotType: "customize" },
  },
  // 三段式 endpoint，无法靠 modelName + 固定 action 拼接推导
  {
    modelName: "rhart-video/minimax-h3-oss/fl2va",
    endpoint: "rhart-video/minimax-h3-oss/fl2va",
    type: "video",
    fields: [
      { target: "prompt", from: "prompt" },
      {
        target: "aspectRatio",
        from: "aspectRatio",
        enumMap: {
          "1:1": "1:1 (Square)",
          "2:3": "2:3 (Portrait Photo)",
          "3:2": "3:2 (Photo)",
          "3:4": "3:4 (Portrait Standard)",
          "4:3": "4:3 (Standard)",
          "9:16": "9:16 (Portrait Widescreen)",
          "16:9": "16:9 (Widescreen)",
          "21:9": "21:9 (Ultrawide)",
        },
      },
      { target: "duration", from: "duration", cast: "float" },
    ],
    imageInput: { mode: "namedSlots", slots: ["firstFrameUrl", "lastFrameUrl"] },
    // H3 单端点智能适配输入模态：帧缺失时会静默退回文生视频，因此必填帧要在请求发出前拦截。
    requiredFramesByMode: {
      startEndRequired: 2,
      startFrameOptional: 1,
      endFrameOptional: 1,
    },
  },
  {
    modelName: "rhart-video-v3.1-fast",
    endpoint: "rhart-video-v3.1-fast/image-to-video",
    type: "video",
    fields: [
      { target: "prompt", from: "prompt" },
      { target: "aspectRatio", from: "aspectRatio" },
      { target: "duration", from: "duration", cast: "string" },
      { target: "resolution", from: "resolution" },
    ],
    imageInput: {
      mode: "array",
      arrayField: "imageUrls",
      max: 3,
      required: 1,
      requiredError: "图生视频模式需要提供参考图片",
    },
  },
  {
    modelName: "kling-video-o1/image-to-video",
    endpoint: "kling-video-o1/image-to-video",
    type: "video",
    requiresMode: "singleImage",
    requiresModeError: "Kling O1 仅支持单图生视频模式",
    fields: [
      { target: "prompt", from: "prompt", minLength: 5, maxLength: 2000 },
      { target: "aspectRatio", from: "aspectRatio", required: true, allowed: ["1:1", "9:16", "16:9"] },
      { target: "duration", from: "duration", required: true, allowed: ["5", "10"], cast: "string" },
      { target: "mode", from: "quality", required: true, allowed: ["std", "pro"] },
    ],
    imageInput: {
      mode: "namedSlots",
      slots: ["firstImageUrl"],
      required: 1,
      requiredError: "Kling O1 需要提供一张首图",
      maxImages: 1,
      maxImageBytes: 20 * 1024 * 1024,
      uploadImages: true,
    },
  },
  {
    modelName: "seedance-2.0-fast",
    endpoint: "rhart-video/sparkvideo-2.0-fast/multimodal-video",
    type: "video",
    fields: [
      { target: "prompt", from: "prompt", required: true, minLength: 1, maxLength: 20480 },
      { target: "resolution", from: "resolution", required: true, allowed: ["480p", "720p", "1080p", "2k", "4k"] },
      { target: "duration", from: "duration", required: true, cast: "string", allowed: ["-1", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"] },
      { target: "ratio", from: "aspectRatio", allowed: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"] },
    ],
    dynamicFields: [
      { target: "imageUrls", from: "imageUrls" },
      { target: "videoUrls", from: "videoUrls" },
      { target: "audioUrls", from: "audioUrls" },
      { target: "generateAudio", from: "generateAudio", cast: "bool" },
      { target: "returnLastFrame", from: "returnLastFrame", cast: "bool" },
      { target: "seed", from: "seed", cast: "int" },
    ],
    allowedAspectRatios: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
    allowedResolutions: ["480p", "720p", "1080p", "2k", "4k"],
    multimodalReferences: { maxImages: 9, maxVideos: 3, maxAudios: 3, requireVisual: true },
  },
  {
    modelName: "seedance-2.0-mini",
    endpoint: "rhart-video/sparkvideo-2.0-mini/multimodal-video",
    type: "video",
    fields: [
      { target: "prompt", from: "prompt", required: true, minLength: 1, maxLength: 20480 },
      { target: "resolution", from: "resolution", required: true, allowed: ["480p", "720p", "1080p", "2k", "4k"] },
      { target: "duration", from: "duration", required: true, cast: "string", allowed: ["-1", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"] },
      { target: "ratio", from: "aspectRatio", allowed: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"] },
    ],
    dynamicFields: [
      { target: "imageUrls", from: "imageUrls" },
      { target: "videoUrls", from: "videoUrls" },
      { target: "audioUrls", from: "audioUrls" },
      { target: "generateAudio", from: "generateAudio", cast: "bool" },
      { target: "returnLastFrame", from: "returnLastFrame", cast: "bool" },
      { target: "seed", from: "seed", cast: "int" },
    ],
    allowedAspectRatios: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
    allowedResolutions: ["480p", "720p", "1080p", "2k", "4k"],
    multimodalReferences: { maxImages: 9, maxVideos: 3, maxAudios: 3, requireVisual: true },
  },
];

export function findRunningHubModelSpec(
  modelName: string,
  type: "image" | "video",
): RunningHubModelSpec | undefined {
  return RUNNINGHUB_MODEL_SPECS.find((s) => s.modelName === modelName && s.type === type);
}

export const NANO_BANANA_PRO_VENDOR_MODEL: ImageModel = {
  name: "图像编辑 (Nano Banana Pro)",
  modelName: "rhart-image-n-pro/edit",
  type: "image",
  mode: ["singleImage", "multiReference"],
  minReferenceImages: 1,
  maxReferenceImages: 10,
  aspectRatioOptions: [
    { value: "auto", label: "自适应" },
    { value: "1:1", label: "1:1" },
    { value: "16:9", label: "16:9" },
    { value: "9:16", label: "9:16" },
    { value: "4:3", label: "4:3" },
    { value: "3:4", label: "3:4" },
    { value: "3:2", label: "3:2" },
    { value: "2:3", label: "2:3" },
    { value: "5:4", label: "5:4" },
    { value: "4:5", label: "4:5" },
    { value: "21:9", label: "21:9" },
  ],
};

export const KLING_O1_VENDOR_MODEL: VideoModel = {
  name: "图生视频 (Kling O1)",
  modelName: "kling-video-o1/image-to-video",
  type: "video",
  mode: ["singleImage"],
  audio: false,
  durationResolutionMap: [{ duration: [5, 10], resolution: ["default"] }],
  aspectRatioOptions: [
    { value: "1:1", label: "1:1" },
    { value: "9:16", label: "9:16" },
    { value: "16:9", label: "16:9" },
  ],
  qualityOptions: ["std", "pro"],
  promptLengthRange: [5, 2000],
};
