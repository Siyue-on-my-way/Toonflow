/**
 * QuickVideo / 单视频快创 —— 前端数据契约（与后端 src/lib/quickVideo/contract.ts 保持一致）
 */

export const QUICK_VIDEO_DURATIONS = [15, 30, 60] as const;
export type QuickVideoDuration = number | null;

export const QUICK_VIDEO_RATIOS = ["16:9", "9:16", "1:1"] as const;
export type QuickVideoRatio = (typeof QUICK_VIDEO_RATIOS)[number];

export const QUICK_VIDEO_STAGES = [
  "collect_brief",
  "brief_confirmed",
  "storyboard_draft",
  "storyboard_confirmed",
  "generating",
  "ready_to_assemble",
  "completed",
] as const;
export type QuickVideoStage = (typeof QUICK_VIDEO_STAGES)[number];

export type ShotGenState = "pending" | "generating" | "done" | "failed";

export interface ShotAssetRef {
  type: "role" | "scene" | "tool";
  name: string;
  desc: string;
}

// ---------------------------------------------------------------------------
// 聊天生图/资产白板/首帧绑定（与后端 src/lib/quickVideo/contract.ts + media.ts 保持一致，SIY-132）
// ---------------------------------------------------------------------------

export const QUICK_VIDEO_MEDIA_KINDS = ["image", "video"] as const;
export type QuickVideoMediaKind = (typeof QUICK_VIDEO_MEDIA_KINDS)[number];

export type QuickVideoMediaState = "generating" | "done" | "failed";
export type QuickVideoMediaSource = "chat" | "asset_board" | "generated" | "upload";

/** 稳定媒体引用：应用内部复制/粘贴/绑定首帧只传递 mediaId，url 是接口按需签发的短期预览地址 */
export interface MediaRef {
  mediaId: number;
  projectId: number;
  kind: QuickVideoMediaKind;
  assetId: number | null;
  imageId: number | null;
  videoId: number | null;
  state: QuickVideoMediaState;
  model: string | null;
  promptSummary: string | null;
  source: QuickVideoMediaSource;
  errorReason: string | null;
  url: string | null;
  width?: number | null;
  height?: number | null;
  createTime: number;
}

/** 聊天图片/视频内容块携带的扩展元数据（ChatBaseContent.ext），与后端 resTool.image 一致 */
export interface ChatMediaExt {
  mediaId: number;
  assetId: number | null;
  imageId: number | null;
  videoId?: number | null;
  kind: QuickVideoMediaKind;
  model: string | null;
  promptSummary: string | null;
  state: QuickVideoMediaState;
  source: QuickVideoMediaSource;
  errorReason?: string | null;
}

/** 镜头首帧引用：分镜草稿阶段可粘贴/替换/解除；确认后随快照冻结 */
export interface ShotFirstFrame {
  mediaId: number;
  assetId: number;
  imageId: number;
  boundAt: number;
}

export type QuickVideoChatMode = "text" | "image" | "video";

/** 跨镜头连续性策略：last_frame=继承上一镜头尾帧 / assets_only=继承人物与道具素材 / independent=独立镜头 */
export const SHOT_CONTINUITY_TYPES = ["last_frame", "assets_only", "independent"] as const;
export type ShotContinuityType = (typeof SHOT_CONTINUITY_TYPES)[number];
export const SHOT_CONTINUITY_LABELS: Record<ShotContinuityType, string> = {
  last_frame: "继承上一镜头尾帧",
  assets_only: "继承人物与道具素材",
  independent: "独立镜头",
};

export interface QuickVideoShot {
  id: string;
  index: number;
  duration: number;
  description: string;
  dialogue: string;
  camera: string;
  /** 文生图/首帧提示词（分镜表策划板输出，一键填入聊天窗生图） */
  imagePrompt: string;
  /** 视频动作/运镜提示词（一键填入聊天窗生视频） */
  videoPrompt: string;
  assetRefs: ShotAssetRef[];
  continuity?: ShotContinuityType;
  imageState: ShotGenState;
  videoState: ShotGenState;
  imageRef: string | null;
  videoRef: string | null;
  errorReason: string | null;
  firstFrame: ShotFirstFrame | null;
}

/** 镜头产物访问地址（与后端 getMediaUrls 返回的 ShotMediaUrls 保持一致，SIY-147 增加 videoPosterUrl） */
export interface QuickVideoShotMediaUrls {
  imageUrl: string | null;
  videoUrl: string | null;
  videoPosterUrl: string | null;
  firstFrameUrl: string | null;
}

export interface QuickVideoBrief {
  theme: string;
  hook: string;
  narrative: string;
  cta: string;
  keywords: string[];
  confirmed: boolean;
  confirmedAt: number | null;
}

export interface QuickVideoStoryboard {
  version: number;
  status: "draft" | "confirmed";
  confirmedAt: number | null;
  summary: string;
  shots: QuickVideoShot[];
}

export interface QuickVideoMaterialItem {
  type: "role" | "scene" | "tool";
  name: string;
  desc: string;
  source: "matched" | "to_generate";
  assetId: number | null;
  imageId: number | null;
  filePath: string | null;
}

export interface QuickVideoGenerationSnapshot {
  storyboardVersion: number;
  targetDuration: QuickVideoDuration;
  videoRatio: QuickVideoRatio;
  artStyle: string;
  shots: {
    id: string;
    index: number;
    duration: number;
    description: string;
    dialogue: string;
    camera: string;
    imagePrompt?: string;
    videoPrompt?: string;
    assetRefs: ShotAssetRef[];
    continuity?: ShotContinuityType;
    firstFrame: (ShotFirstFrame & { filePath: string }) | null;
  }[];
  materials: QuickVideoMaterialItem[];
  /** 逐镜头图片分辨率档位（确认时落定；null=存量快照，生成回落 1K） */
  imageResolution: "1K" | "2K" | "4K" | null;
}

/**
 * 最终生成参数确认卡片（分镜确认后在聊天流回显，仅展示四项）。
 * 参数（时长/画风/分镜内容）变更后服务端重新回显新卡片，旧卡片由前端标记为已失效。
 */
/** 确认卡高级区的管道级参数授权（SIY-163；与后端 finalParamsPipelineSchema 保持一致） */
export interface QuickVideoFinalParamsPipeline {
  imageResolution: "inherit" | "1K" | "2K" | "4K";
}

export interface QuickVideoFinalParamsCard {
  cardId: string;
  storyboardVersion: number;
  targetDuration: QuickVideoDuration;
  artStyle: string;
  shotCount: number;
  summary: string;
  echoedAt: number;
  durationText?: string;
  artStyleText?: string;
  /** 管道级参数（沿用上次设置）；旧卡片无该字段，前端隐藏高级区 */
  pipeline?: QuickVideoFinalParamsPipeline;
}

// ---------------------------------------------------------------------------
// 聊天模型参数确认卡（与后端 src/lib/quickVideo/contract.ts 保持一致，SIY-161）
// ---------------------------------------------------------------------------

export type VideoParamFieldType = "select" | "slider" | "switch" | "number";

/** 参数来源：llm=LLM 预填 / user=用户修改 / system=系统默认 / preference=会话偏好记忆 */
export type VideoParamSource = "llm" | "user" | "system" | "preference";

export interface VideoParamFieldOption {
  value: string | number;
  label: string;
  /** 守门可视化：置灰不可选（如无引用图时的首帧模式） */
  disabled?: boolean;
  /** 置灰/警示说明 */
  hint?: string;
  /** 有引用图时纯文生模式的降权展示（可选但需显式选择） */
  deemphasized?: boolean;
}

export interface VideoParamField {
  key: string;
  label: string;
  type: VideoParamFieldType;
  value: string | number | boolean | null;
  options?: VideoParamFieldOption[];
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  /** true 时渲染进高级折叠区 */
  advanced: boolean;
  source: VideoParamSource;
  /** 档位说明（resolutionNote/durationAutoNote/costNote 等） */
  note?: string;
}

/** 聊天模型参数确认卡（request_video_params 回显；状态由前端按状态机最新数据判定） */
export interface QuickVideoVideoParamsCard {
  cardId: string;
  modelKey: string;
  modelName: string;
  sessionId: number;
  status: "pending" | "confirmed";
  createdAt: number;
  confirmedAt: number | null;
  prompt: string;
  promptSource: VideoParamSource;
  referenceMediaIds: number[];
  fields: VideoParamField[];
}

export type VideoParamsCardConfirmEdits = Record<string, string | number | boolean>;

export interface QuickVideoGeneration {
  snapshot: QuickVideoGenerationSnapshot | null;
  /** 最终生成参数确认状态（字段名沿用旧版，仅作内部标识） */
  materialsConfirmed: boolean;
  materialsConfirmedAt: number | null;
  /** 最终生成参数确认卡片（最新在末尾） */
  finalParamsCards: QuickVideoFinalParamsCard[];
  /** 聊天模型参数确认卡（最新在末尾，SIY-161） */
  videoParamsCards?: QuickVideoVideoParamsCard[];
  runId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  materialImages: Record<string, string>;
  /** 最近一次时间线装配元数据（SIY-111） */
  timeline: QuickVideoTimelineMeta | null;
  /** 最近一次导出结果（SIY-111） */
  exportInfo: QuickVideoExportInfo | null;
}

// ---------------------------------------------------------------------------
// 时间线装配与导出（与后端 src/lib/quickVideo/contract.ts 保持一致）
// ---------------------------------------------------------------------------

export const TIMELINE_TRANSITION_DURATION_S = 0.5;
export const TIMELINE_MAX_SPEED = 1.5;
export const TIMELINE_MIN_SPEED = 0.75;

export const QUICK_VIDEO_DIMENSIONS: Record<QuickVideoRatio, { width: number; height: number }> = {
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "1:1": { width: 960, height: 960 },
};

export interface QuickVideoTimelineClipPlan {
  shotId: string;
  index: number;
  sourceDuration: number;
  trimStart: number;
  trimEnd: number;
  playbackRate: number;
  start: number;
  end: number;
  subtitleText: string;
}

export interface QuickVideoTimelineTransition {
  afterShotId: string;
  /** crossfade=叠化转场；none=无缝顺承（时长为 0，不设透明度动画），与后端契约一致 */
  type: "crossfade" | "none";
  duration: number;
}

export interface QuickVideoTimelineTailPad {
  type: "endcard";
  duration: number;
  text: string;
}

export interface QuickVideoTimelinePlan {
  targetDuration: QuickVideoDuration;
  videoRatio: QuickVideoRatio;
  width: number;
  height: number;
  totalDuration: number;
  clips: QuickVideoTimelineClipPlan[];
  transitions: QuickVideoTimelineTransition[];
  tailPad: QuickVideoTimelineTailPad | null;
}

export interface QuickVideoTimelineMeta {
  storyboardVersion: number;
  assembledAt: number;
  clipCount: number;
  totalDuration: number;
  trackIds: number[];
}

export interface QuickVideoExportInfo {
  exportedAt: number;
  fileName: string;
  sizeBytes: number;
  durationSeconds: number;
}

export interface QuickVideoState {
  schemaVersion: number;
  version: number;
  stage: QuickVideoStage;
  targetDuration: QuickVideoDuration;
  videoRatio: QuickVideoRatio;
  artStyle: string;
  configVersion?: number;
  createIdempotencyKey: string;
  brief: QuickVideoBrief | null;
  storyboard: QuickVideoStoryboard | null;
  generation: QuickVideoGeneration;
  appliedKeys: Record<string, number>;
  lastChatAt: number | null;
  updateTime: number;
}

export interface QuickVideoWorkbench {
  project: {
    id: number;
    name: string;
    intro: string;
    artStyle: string | null;
    videoRatio: string | null;
    projectType: string;
  } | null;
  script: { id: number; name: string; content: string } | null;
  state: QuickVideoState | null;
  shotBounds: { min: number; max: number } | null;
}

/** 工作台可编辑的项目基础配置（与 /quickVideo/updateConfig 的 patch 对齐）。 */
export interface QuickVideoConfigPatch {
  name?: string;
  artStyle?: string;
  videoRatio?: QuickVideoRatio;
  targetDuration?: QuickVideoDuration;
  intro?: string;
}

export interface QuickVideoReject {
  code: string;
  message: string;
  currentVersion: number | null;
}

// ---------------------------------------------------------------------------
// 会话（session，与后端 src/lib/quickVideo/session.ts 保持一致，SIY-128）
// ---------------------------------------------------------------------------

export type QuickVideoSessionStatus = "active" | "archived";
export type QuickVideoSessionTitleStatus = "idle" | "running" | "done" | "failed";

export interface QuickVideoSession {
  id: number;
  projectId: number;
  title: string | null;
  status: QuickVideoSessionStatus;
  textModel: string | null;
  imageModel: string | null;
  videoModel: string | null;
  /** 会话级图片参数偏好 JSON 串（SIY-163），parseQuickVideoImageParams 解析 */
  imageParams: string | null;
  sequence: number | null;
  userMessageCount: number | null;
  titleStatus: QuickVideoSessionTitleStatus | null;
  createTime: number;
  updateTime: number;
}

// ---------------------------------------------------------------------------
// 聊天驱动 UI 动作协议（与后端 src/lib/quickVideo/contract.ts 保持一致，SIY-153）
// 助手消息 ext.actions 携带白名单动作，前端执行器按白名单派发；动作元数据是消息的
// 展示层附属信息，不写入 o_agentWorkData 状态机，不改变任何确认门与阶段流转。
// ---------------------------------------------------------------------------

/** 右侧面板 key（与 views/quickVideo/index.vue 的 activePanel 一致） */
export const QUICK_VIDEO_PANELS = ["brief", "storyboard", "assets", "preview"] as const;
export type QuickVideoPanel = (typeof QUICK_VIDEO_PANELS)[number];

/** 白名单动作类型：白名单之外的动作元数据一律忽略（console.warn，不报错、不中断聊天流） */
export const QUICK_VIDEO_UI_ACTION_TYPES = ["switch_panel", "open_export_confirm", "focus_shot"] as const;
export type QuickVideoUiActionType = (typeof QUICK_VIDEO_UI_ACTION_TYPES)[number];

/** 单条助手消息最多附带的动作数（超出部分被拒绝） */
export const QUICK_VIDEO_UI_ACTIONS_MAX = 3;

/** 动作元数据：switch_panel 需 panel；focus_shot 需 shotId（如 shot-2）；open_export_confirm 无附加参数 */
export interface QuickVideoUiAction {
  type: QuickVideoUiActionType;
  panel?: QuickVideoPanel;
  shotId?: string;
}

// ---------------------------------------------------------------------------
// 会话级图片参数偏好（与后端 src/lib/quickVideo/session.ts 保持一致，SIY-163。
// 视频参数由 SIY-161 的 VideoParamsPreference 确认卡体系负责，此处只覆盖图片侧）
// ---------------------------------------------------------------------------

export interface QuickVideoImageParams {
  /** 图片分辨率档位（1K/2K/4K）；缺省走既有默认 */
  resolution?: string;
  /** 画面比例模式：project=跟随项目（默认）；custom=使用 ratio 字段 */
  ratioMode?: "project" | "custom";
  /** ratioMode=custom 时的自定义比例（"w:h"） */
  ratio?: string;
}

/** 宽松解析会话里保存的图片参数 JSON：非对象/未知字段一律剔除，绝不抛错（坏数据等价于未设置） */
export function parseQuickVideoImageParams(raw: string | null | undefined): QuickVideoImageParams {
  const empty: QuickVideoImageParams = {};
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return empty;
    const out: QuickVideoImageParams = {};
    if (typeof parsed.resolution === "string" && parsed.resolution) out.resolution = parsed.resolution;
    if (parsed.ratioMode === "project" || parsed.ratioMode === "custom") out.ratioMode = parsed.ratioMode;
    if (typeof parsed.ratio === "string" && parsed.ratio) out.ratio = parsed.ratio;
    return out;
  } catch {
    return empty;
  }
}
