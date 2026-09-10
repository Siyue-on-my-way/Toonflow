/**
 * QuickVideo / 单视频快创 —— 前端数据契约（与后端 src/lib/quickVideo/contract.ts 保持一致）
 */

export const QUICK_VIDEO_DURATIONS = [15, 30, 60] as const;
export type QuickVideoDuration = (typeof QUICK_VIDEO_DURATIONS)[number];

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
    assetRefs: ShotAssetRef[];
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

/** 服务端拒绝写入时的响应结构 */
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
