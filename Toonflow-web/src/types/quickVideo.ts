/**
 * QuickVideo / 单视频快创 —— 前端数据契约（与后端 src/lib/quickVideo/contract.ts 保持一致）
 */

/**
 * 目标时长（秒）：5-60 的正整数秒（SIY-138 对话式配置），与后端 src/lib/quickVideo/contract.ts 一致。
 * 旧版 15/30/60 三档是其子集，存量项目读回无需转换。
 */
export const QUICK_VIDEO_DURATION_MIN = 5;
export const QUICK_VIDEO_DURATION_MAX = 60;
export type QuickVideoDuration = number;

/** 生成确认状态：none=无 pending=待用户确认 confirmed=已确认（生成已/将启动） */
export type QuickVideoConfirmationStatus = "none" | "pending" | "confirmed";

/** 待确认生成快照（生成确认门，SIY-138） */
export interface QuickVideoPendingSnapshot {
  configVersion: number;
  targetDuration: number;
  artStyle: string;
  videoRatio: QuickVideoRatio;
  storyboardVersion: number;
  shotCount: number;
  totalDuration: number;
  shotSummaries: { index: number; duration: number; description: string }[];
  estimatedImageCount: number;
  estimatedVideoCount: number;
  estimatedCostYuan: number;
  requestedAt: number;
}

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

export interface QuickVideoShot {
  id: string;
  index: number;
  duration: number;
  description: string;
  dialogue: string;
  camera: string;
  assetRefs: ShotAssetRef[];
  imageState: ShotGenState;
  videoState: ShotGenState;
  imageRef: string | null;
  videoRef: string | null;
  errorReason: string | null;
  firstFrame: ShotFirstFrame | null;
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
  targetDuration: number;
  videoRatio: QuickVideoRatio;
  artStyle: string;
  shots: {
    id: string;
    index: number;
    duration: number;
    description: string;
    dialogue: string;
    camera: string;
    assetRefs: ShotAssetRef[];
    firstFrame: (ShotFirstFrame & { filePath: string }) | null;
  }[];
  materials: QuickVideoMaterialItem[];
  estimatedImageCount: number;
  estimatedVideoCount: number;
  estimatedCostYuan: number;
  estimatedSeconds: number;
}

export interface QuickVideoGeneration {
  snapshot: QuickVideoGenerationSnapshot | null;
  materialsConfirmed: boolean;
  materialsConfirmedAt: number | null;
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
  type: "crossfade";
  duration: number;
}

export interface QuickVideoTimelineTailPad {
  type: "endcard";
  duration: number;
  text: string;
}

export interface QuickVideoTimelinePlan {
  targetDuration: number;
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
  /** 目标时长（秒）：对话式配置，允许未设置（null）；存量项目为 15/30/60 */
  targetDuration: QuickVideoDuration | null;
  videoRatio: QuickVideoRatio;
  /** 画风：空串=未设置 */
  artStyle: string;
  /** 配置版本号：画风/时长/比例或分镜内容每次变更 +1（SIY-138） */
  configVersion: number;
  pendingSnapshot: QuickVideoPendingSnapshot | null;
  confirmationStatus: QuickVideoConfirmationStatus;
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
  targetDuration?: number;
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
  sequence: number | null;
  userMessageCount: number | null;
  titleStatus: QuickVideoSessionTitleStatus | null;
  createTime: number;
  updateTime: number;
}
