/**
 * QuickVideo / 单视频快创 —— 前后端共享数据契约与状态机
 *
 * 本文件是 quick_video 模式的唯一数据契约源（前端镜像：Toonflow-web/src/types/quickVideo.ts，两边字段需保持一致）。
 * - Agent 状态统一存放在 o_agentWorkData(key = "quickVideoAgent") 的 data JSON 里，版本化保存。
 * - 所有写入（用户编辑接口 / Agent 工具）必须经过 state.ts 的 mutateQuickVideoState：
 *   服务端 zod 校验 + 阶段白名单 + 乐观锁（expectedVersion）+ 幂等键，禁止直接改库。
 * - 不迁移、不影响现有专业模式（novel / script）的任何链路。
 */
import { z } from "zod";

/** o_agentWorkData.key 的固定值 */
export const QUICK_VIDEO_AGENT_KEY = "quickVideoAgent";

/** 契约版本：状态结构不兼容变更时递增 */
export const QUICK_VIDEO_SCHEMA_VERSION = 1;

/** 项目类型枚举值（o_project.projectType 新增） */
export const QUICK_VIDEO_PROJECT_TYPE = "quick_video";

/** 目标时长（秒），仅支持 15 / 30 / 60 */
export const QUICK_VIDEO_DURATIONS = [15, 30, 60] as const;
export type QuickVideoDuration = (typeof QUICK_VIDEO_DURATIONS)[number];

/** 画面比例 */
export const QUICK_VIDEO_RATIOS = ["16:9", "9:16", "1:1"] as const;
export type QuickVideoRatio = (typeof QUICK_VIDEO_RATIOS)[number];

/** 聊天发送模式：text=普通文本对话，image=受限图片生成工具（SIY-132），video=受限图生视频工具（SIY-134） */
export const QUICK_VIDEO_CHAT_MODES = ["text", "image", "video"] as const;
export type QuickVideoChatMode = (typeof QUICK_VIDEO_CHAT_MODES)[number];

/** 镜头片段时长下限/上限（秒） */
export const SHOT_DURATION_MIN = 5;
export const SHOT_DURATION_MAX = 15;

/** 分镜数量上限 */
export const SHOT_COUNT_MAX = 12;

// ---------------------------------------------------------------------------
// 阶段状态机
// ---------------------------------------------------------------------------

/**
 * 工作台阶段：
 * - collect_brief        收集/打磨简报
 * - brief_confirmed      简报已确认（用户确认门 1）
 * - storyboard_draft     分镜草稿打磨中
 * - storyboard_confirmed 分镜已确认（用户确认门 2），进入素材/成本确认与生成
 * - generating           逐镜头生成图片/视频中
 * - ready_to_assemble    全部镜头生成完毕，可装配时间线
 * - completed            成片导出完成（用户确认门 3：导出确认后落定）
 */
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

/**
 * 合法阶段转移表（服务端唯一放行依据；白名单之外的转移一律拒绝）。
 * 回退仅允许有限的几条：分镜打磨可回简报；已确认分镜可回草稿重提；生成中失败可回已确认重跑。
 */
export const STAGE_TRANSITIONS: Record<QuickVideoStage, QuickVideoStage[]> = {
  collect_brief: ["brief_confirmed"],
  brief_confirmed: ["storyboard_draft", "collect_brief"],
  storyboard_draft: ["storyboard_confirmed", "brief_confirmed"],
  storyboard_confirmed: ["generating", "storyboard_draft"],
  generating: ["ready_to_assemble", "storyboard_confirmed"],
  ready_to_assemble: ["completed", "generating"],
  completed: [],
};

export function canTransitionStage(from: QuickVideoStage, to: QuickVideoStage): boolean {
  return STAGE_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// 镜头生成状态映射
// ---------------------------------------------------------------------------

/**
 * 镜头级生成状态（前后端共享；后续写 o_image / o_video 时按此映射落库）：
 * - pending     未开始
 * - generating  生成中
 * - done        已完成
 * - failed      生成失败（可单镜头重试）
 */
export const SHOT_GEN_STATES = ["pending", "generating", "done", "failed"] as const;
export type ShotGenState = (typeof SHOT_GEN_STATES)[number];

/** ShotGenState -> o_image.state / o_video.state 的既有中文状态值映射 */
export const LEGACY_GEN_STATE_MAP: Record<ShotGenState, string | null> = {
  pending: null,
  generating: "生成中",
  done: "生成完成",
  failed: "生成失败",
};

// ---------------------------------------------------------------------------
// zod 结构定义（服务端校验 + JSON Schema 生成共用）
// ---------------------------------------------------------------------------

export const shotAssetRefSchema = z.object({
  type: z.enum(["role", "scene", "tool"]).describe("资产类型：role=角色 / scene=场景 / tool=道具"),
  name: z.string().min(1).max(60).describe("资产名称"),
  desc: z.string().max(300).default("").describe("资产外观/视觉描述"),
});
export type ShotAssetRef = z.infer<typeof shotAssetRefSchema>;

// ---------------------------------------------------------------------------
// 聊天生图/生视频媒体索引（SIY-132：聊天生图、资产白板与分镜首帧绑定）
// ---------------------------------------------------------------------------

/** 媒体种类：聊天可生成图片（文生图/图生图）与视频（图生视频，SIY-134）；镜头分镜产物也归到白板同一份索引 */
export const QUICK_VIDEO_MEDIA_KINDS = ["image", "video"] as const;
export type QuickVideoMediaKind = (typeof QUICK_VIDEO_MEDIA_KINDS)[number];

/** 媒体生成状态：与 o_image/o_video 的中文状态字段一一对应，见 LEGACY_GEN_STATE_MAP */
export const QUICK_VIDEO_MEDIA_STATES = ["generating", "done", "failed"] as const;
export type QuickVideoMediaState = (typeof QUICK_VIDEO_MEDIA_STATES)[number];

/** 媒体来源：chat=聊天生成，asset_board=白板直接生成，generated=镜头分镜/生成产物，upload=用户上传（暂未开放） */
export const QUICK_VIDEO_MEDIA_SOURCES = ["chat", "asset_board", "generated", "upload"] as const;
export type QuickVideoMediaSource = (typeof QUICK_VIDEO_MEDIA_SOURCES)[number];

/**
 * 前后端共享的稳定媒体引用（MediaRef）。mediaId 是 o_quickVideoMedia.id，是唯一需要在
 * 应用内部复制/粘贴/绑定首帧时传递的稳定标识；url 是接口按需签发的短期预览/播放地址，
 * 不作为持久化依据（见 CLAUDE 任务约束 3、4）。
 */
export const mediaRefSchema = z.object({
  mediaId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  kind: z.enum(QUICK_VIDEO_MEDIA_KINDS),
  assetId: z.number().int().positive().nullable(),
  imageId: z.number().int().positive().nullable(),
  videoId: z.number().int().positive().nullable(),
  state: z.enum(QUICK_VIDEO_MEDIA_STATES),
  model: z.string().max(200).nullable(),
  promptSummary: z.string().max(200).nullable(),
  source: z.enum(QUICK_VIDEO_MEDIA_SOURCES),
  errorReason: z.string().max(1000).nullable(),
  url: z.string().max(1000).nullable().describe("按需签发的短期预览/播放地址，不持久化"),
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
  createTime: z.number().int(),
});
export type MediaRef = z.infer<typeof mediaRefSchema>;

/**
 * 镜头首帧引用：分镜草稿阶段可粘贴/替换/解除；分镜确认后随快照冻结（见 snapshotShotSchema）。
 * 只允许引用 kind=image 且已生成完成的媒体；filePath 只在冻结快照里出现（生成链路直接读取，不再二次查库）。
 */
export const shotFirstFrameSchema = z.object({
  mediaId: z.number().int().positive(),
  assetId: z.number().int().positive(),
  imageId: z.number().int().positive(),
  boundAt: z.number().int(),
});
export type ShotFirstFrame = z.infer<typeof shotFirstFrameSchema>;

/** 冻结进生成快照的首帧引用：额外带 filePath，生成引擎直接读取，不依赖运行时再查库/查权限 */
export const snapshotFirstFrameSchema = shotFirstFrameSchema.extend({
  filePath: z.string().max(500),
});
export type SnapshotFirstFrame = z.infer<typeof snapshotFirstFrameSchema>;

export const quickVideoShotSchema = z.object({
  id: z.string().min(1).max(40).describe("镜头稳定 ID，如 shot-1"),
  index: z.number().int().min(1).describe("镜头序号（1 开始，按播放顺序）"),
  duration: z
    .number()
    .int()
    .min(SHOT_DURATION_MIN)
    .max(SHOT_DURATION_MAX)
    .describe(`镜头时长（秒），${SHOT_DURATION_MIN}-${SHOT_DURATION_MAX} 秒`),
  description: z.string().min(1).max(2000).describe("画面描述（镜头内容、动作、氛围）"),
  dialogue: z.string().max(500).default("").describe("台词/旁白（用作字幕，可为空）"),
  camera: z.string().max(200).default("").describe("景别/运镜（如 全景、缓慢推进）"),
  assetRefs: z.array(shotAssetRefSchema).max(10).default([]).describe("该镜头引用的资产列表"),
  imageState: z.enum(SHOT_GEN_STATES).default("pending").describe("分镜图生成状态"),
  videoState: z.enum(SHOT_GEN_STATES).default("pending").describe("视频片段生成状态"),
  imageRef: z.string().max(500).nullable().default(null).describe("分镜图文件引用（OSS key）"),
  videoRef: z.string().max(500).nullable().default(null).describe("视频片段文件引用（OSS key）"),
  errorReason: z.string().max(1000).nullable().default(null).describe("最近一次生成失败原因"),
  /** 视频生成首帧输入（人工绑定，与 imageRef 分开建模）；未绑定时生成引擎回退用 imageRef */
  firstFrame: shotFirstFrameSchema.nullable().default(null),
});
export type QuickVideoShot = z.infer<typeof quickVideoShotSchema>;

export const quickVideoBriefSchema = z.object({
  theme: z.string().min(1).max(500).describe("主题/核心创意"),
  hook: z.string().max(500).default("").describe("开场钩子"),
  narrative: z.string().max(3000).describe("叙事大纲（按时间线的一段话）"),
  cta: z.string().max(500).default("").describe("结尾/行动号召"),
  keywords: z.array(z.string().min(1).max(60)).max(20).default([]).describe("风格/内容关键词"),
  confirmed: z.boolean().default(false).describe("用户是否已确认该简报"),
  confirmedAt: z.number().nullable().default(null).describe("确认时间戳"),
});
export type QuickVideoBrief = z.infer<typeof quickVideoBriefSchema>;

export const quickVideoStoryboardSchema = z.object({
  version: z.number().int().min(1).describe("分镜版本号，每次 propose 自增"),
  status: z.enum(["draft", "confirmed"]).describe("分镜确认状态"),
  confirmedAt: z.number().nullable().default(null).describe("确认时间戳"),
  summary: z.string().max(1000).default("").describe("本版分镜的整体说明"),
  shots: z.array(quickVideoShotSchema).min(1).max(SHOT_COUNT_MAX).describe("镜头列表（按播放顺序）"),
});
export type QuickVideoStoryboard = z.infer<typeof quickVideoStoryboardSchema>;

// ---------------------------------------------------------------------------
// 素材解析与生成快照（素材/成本确认门）
// ---------------------------------------------------------------------------

/** 素材解析结果项：matched=命中资产库（以已有资产图作为参考），to_generate=需先生成素材图 */
export const materialItemSchema = z.object({
  type: z.enum(["role", "scene", "tool"]).describe("资产类型"),
  name: z.string().min(1).max(60).describe("资产名称"),
  desc: z.string().max(300).default("").describe("资产外观/视觉描述"),
  source: z.enum(["matched", "to_generate"]).describe("解析结果"),
  assetId: z.number().int().nullable().default(null).describe("命中的 o_assets.id"),
  imageId: z.number().int().nullable().default(null).describe("命中的 o_image.id"),
  filePath: z.string().max(500).nullable().default(null).describe("命中资产图的 OSS 路径"),
});
export type QuickVideoMaterialItem = z.infer<typeof materialItemSchema>;

/** 冻结镜头内容（不含生成状态；确认后生成只读取本快照，与实时分镜解耦） */
export const snapshotShotSchema = z.object({
  id: z.string().min(1).max(40),
  index: z.number().int().min(1),
  duration: z.number().int().min(SHOT_DURATION_MIN).max(SHOT_DURATION_MAX),
  description: z.string().min(1).max(2000),
  dialogue: z.string().max(500).default(""),
  camera: z.string().max(200).default(""),
  assetRefs: z.array(shotAssetRefSchema).max(10).default([]),
  /** 冻结的首帧引用（含 filePath，生成引擎直接读取）；无人工首帧时为 null，回退用分镜图 imageRef */
  firstFrame: snapshotFirstFrameSchema.nullable().default(null),
});
export type QuickVideoSnapshotShot = z.infer<typeof snapshotShotSchema>;

/**
 * 素材/成本确认快照：用户通过素材确认门时冻结。
 * 「不可歧义」：记录分镜版本、比例、画风、镜头内容与素材解析结果 + 预估，生成引擎只读这里。
 */
export const generationSnapshotSchema = z.object({
  storyboardVersion: z.number().int().min(1).describe("快照对应的分镜版本"),
  targetDuration: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  videoRatio: z.enum(QUICK_VIDEO_RATIOS),
  artStyle: z.string().max(500).default(""),
  shots: z.array(snapshotShotSchema).min(1).max(SHOT_COUNT_MAX),
  materials: z.array(materialItemSchema).max(30).default([]),
  estimatedImageCount: z.number().int().min(0).default(0).describe("预计图片任务数（分镜图 + 需补生成的素材图）"),
  estimatedVideoCount: z.number().int().min(0).default(0).describe("预计视频任务数"),
  estimatedCostYuan: z.number().min(0).default(0).describe("预估费用（元，粗估值）"),
  estimatedSeconds: z.number().int().min(0).default(0).describe("预估总耗时（秒，粗估值）"),
});
export type QuickVideoGenerationSnapshot = z.infer<typeof generationSnapshotSchema>;

/** 生成链路运行态（素材确认门状态 + 快照 + 运行记录） */
// ---------------------------------------------------------------------------
// 时间线装配与导出（SIY-111）
// ---------------------------------------------------------------------------

/** 相邻镜头间的 crossfade 重叠时长（秒） */
export const TIMELINE_TRANSITION_DURATION_S = 0.5;
/** 压缩上限：镜头总长超出目标时整体加速的倍率上限（超出部分改为按比例裁剪源窗口） */
export const TIMELINE_MAX_SPEED = 1.5;
/** 放慢下限：镜头总长不足目标时整体放慢的倍率下限（不足部分用片尾定版补齐） */
export const TIMELINE_MIN_SPEED = 0.75;

/** 输出分辨率（按画面比例推导，720p 档） */
export const QUICK_VIDEO_DIMENSIONS: Record<QuickVideoRatio, { width: number; height: number }> = {
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "1:1": { width: 960, height: 960 },
};

/** 时间线单镜头片段规划（时间单位均为秒） */
export const timelineClipPlanSchema = z.object({
  shotId: z.string().min(1).max(40),
  index: z.number().int().min(1),
  /** 镜头规划源时长（秒） */
  sourceDuration: z.number().min(SHOT_DURATION_MIN).max(SHOT_DURATION_MAX),
  /** 源视频使用窗口 [trimStart, trimEnd]（秒，不超过源时长） */
  trimStart: z.number().min(0).default(0),
  trimEnd: z.number().min(0),
  /** 播放速率（1 = 原速） */
  playbackRate: z.number().min(0.1).max(4),
  /** 时间线上的起止时间（秒，相邻片段在转场处重叠） */
  start: z.number().min(0),
  end: z.number().min(0),
  /** 字幕文本（台词/旁白，可为空） */
  subtitleText: z.string().max(500).default(""),
});
export type QuickVideoTimelineClipPlan = z.infer<typeof timelineClipPlanSchema>;

export const timelineTransitionSchema = z.object({
  afterShotId: z.string().min(1).max(40).describe("与下一镜头之间的转场，位于该镜头之后"),
  type: z.literal("crossfade"),
  duration: z.number().min(0),
});
export type QuickVideoTimelineTransition = z.infer<typeof timelineTransitionSchema>;

/** 片尾补齐（镜头总长不足目标时）：CTA 定版卡 */
export const timelineTailPadSchema = z.object({
  type: z.literal("endcard"),
  duration: z.number().min(0),
  text: z.string().max(500).default(""),
});
export type QuickVideoTimelineTailPad = z.infer<typeof timelineTailPadSchema>;

/** 时间线装配规划（服务端推导；前端以实际媒体时长为准重新适配） */
export const timelinePlanSchema = z.object({
  targetDuration: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  videoRatio: z.enum(QUICK_VIDEO_RATIOS),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  /** 成片总时长（秒，含片尾补齐） */
  totalDuration: z.number().min(1),
  clips: z.array(timelineClipPlanSchema).min(1).max(SHOT_COUNT_MAX),
  transitions: z.array(timelineTransitionSchema).max(SHOT_COUNT_MAX).default([]),
  tailPad: timelineTailPadSchema.nullable().default(null),
});
export type QuickVideoTimelinePlan = z.infer<typeof timelinePlanSchema>;

/** 装配元数据（state.generation.timeline，记录最近一次装配对应的分镜版本与轨道行） */
export const timelineMetaSchema = z.object({
  storyboardVersion: z.number().int().min(1),
  assembledAt: z.number().int().min(1),
  clipCount: z.number().int().min(1),
  totalDuration: z.number().min(1),
  trackIds: z.array(z.number().int()).default([]),
});
export type QuickVideoTimelineMeta = z.infer<typeof timelineMetaSchema>;

/** 导出结果（state.generation.exportInfo，第三道确认门通过后回写） */
export const quickVideoExportInfoSchema = z.object({
  exportedAt: z.number().int().min(1),
  fileName: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(0),
  durationSeconds: z.number().min(0),
});
export type QuickVideoExportInfo = z.infer<typeof quickVideoExportInfoSchema>;

export const quickVideoGenerationSchema = z.object({
  /** 最近一次素材解析快照（素材确认前可反复刷新） */
  snapshot: generationSnapshotSchema.nullable().default(null),
  materialsConfirmed: z.boolean().default(false).describe("素材/成本确认门是否已通过"),
  materialsConfirmedAt: z.number().nullable().default(null),
  /** 最近一次生成运行 ID */
  runId: z.string().max(64).nullable().default(null),
  startedAt: z.number().nullable().default(null),
  finishedAt: z.number().nullable().default(null),
  /** 运行期产物：需补生成的素材图 名称 -> OSS 路径（生成引擎写入） */
  materialImages: z.record(z.string(), z.string().max(500)).default({}),
  /** 最近一次时间线装配元数据（getTimeline 落库，SIY-111） */
  timeline: timelineMetaSchema.nullable().default(null),
  /** 最近一次导出结果（导出确认门通过后回写，SIY-111） */
  exportInfo: quickVideoExportInfoSchema.nullable().default(null),
});
export type QuickVideoGeneration = z.infer<typeof quickVideoGenerationSchema>;

// 生成引擎常量 ---------------------------------------------------------------

/** 镜头级生成并发数（图片/视频供应商任务） */
export const GENERATION_CONCURRENCY = 2;
/** 单个分镜图任务超时（毫秒） */
export const GENERATION_IMAGE_TIMEOUT_MS = 10 * 60 * 1000;
/** 单个镜头视频任务超时（毫秒） */
export const GENERATION_VIDEO_TIMEOUT_MS = 15 * 60 * 1000;
/** 预估单价（元）：粗略估算仅作展示，实际以供应商计费为准 */
export const ESTIMATE_IMAGE_COST_YUAN = 0.3;
export const ESTIMATE_VIDEO_COST_PER_SECOND_YUAN = 0.5;
/** 预估单任务耗时（秒） */
export const ESTIMATE_IMAGE_SECONDS = 30;
export const ESTIMATE_VIDEO_SECONDS = 90;

/** o_agentWorkData(key=quickVideoAgent).data 的完整结构 */
export const quickVideoStateSchema = z.object({
  schemaVersion: z.literal(QUICK_VIDEO_SCHEMA_VERSION).default(QUICK_VIDEO_SCHEMA_VERSION),
  /** 乐观锁版本号，每次成功写入自增 */
  version: z.number().int().min(1),
  stage: z.enum(QUICK_VIDEO_STAGES),
  targetDuration: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  videoRatio: z.enum(QUICK_VIDEO_RATIOS),
  artStyle: z.string().max(500).default(""),
  /** 创建幂等键（createProject 用，防重复建项目） */
  createIdempotencyKey: z.string().min(8).max(64),
  brief: quickVideoBriefSchema.nullable().default(null),
  storyboard: quickVideoStoryboardSchema.nullable().default(null),
  /** 素材/成本确认门与生成运行态（存量状态行缺该字段时补默认值） */
  generation: z.preprocess((v) => v ?? {}, quickVideoGenerationSchema),
  /** 已确认完成的幂等键记录（key -> 应用时间），写入去重用，最多保留 IDEMPOTENCY_MAX_KEYS 条 */
  appliedKeys: z.record(z.string(), z.number()).default({}),
  /** 最近的聊天时间，用于工作台展示 */
  lastChatAt: z.number().nullable().default(null),
  updateTime: z.number(),
});
export type QuickVideoState = z.infer<typeof quickVideoStateSchema>;

/** 幂等键记录上限，超过后淘汰最早写入的 key */
export const IDEMPOTENCY_MAX_KEYS = 50;

// ---------------------------------------------------------------------------
// 分镜校验规则（propose / confirm 时共用）
// ---------------------------------------------------------------------------

/**
 * 按目标时长推导允许的镜头数量区间：
 * 每个镜头 5-15 秒，故 15 秒目标最多 3 镜、30 秒最多 6 镜、60 秒最多 12 镜；
 * 下限尽量向“5 个镜头以上”的产品预期靠拢（时长允许时）。
 */
export function shotCountBounds(targetDuration: QuickVideoDuration): { min: number; max: number } {
  const max = Math.max(1, Math.min(SHOT_COUNT_MAX, Math.floor(targetDuration / SHOT_DURATION_MIN)));
  const min = Math.max(1, Math.min(5, Math.floor(targetDuration / SHOT_DURATION_MAX) || 1));
  return { min, max };
}

/**
 * 校验一份分镜是否满足落库/确认条件：
 * - 镜头数量在区间内
 * - 总时长与目标时长误差在 ±20%（且不少于 1 秒差）
 * 返回错误原因数组；空数组表示通过。
 */
export function validateStoryboard(targetDuration: QuickVideoDuration, shots: QuickVideoShot[]): string[] {
  const errors: string[] = [];
  const { min, max } = shotCountBounds(targetDuration);
  if (shots.length < min || shots.length > max) {
    errors.push(`镜头数量需在 ${min}-${max} 个之间（目标时长 ${targetDuration} 秒，当前 ${shots.length} 个）`);
  }
  const total = shots.reduce((sum, s) => sum + s.duration, 0);
  const tolerance = Math.max(3, Math.round(targetDuration * 0.2));
  if (Math.abs(total - targetDuration) > tolerance) {
    errors.push(`镜头总时长 ${total} 秒与目标时长 ${targetDuration} 秒偏差超过 ${tolerance} 秒`);
  }
  const ids = new Set<string>();
  shots.forEach((shot, i) => {
    if (ids.has(shot.id)) errors.push(`镜头 ID 重复：${shot.id}`);
    ids.add(shot.id);
    if (shot.duration < SHOT_DURATION_MIN || shot.duration > SHOT_DURATION_MAX) {
      errors.push(`镜头 ${i + 1} 时长需在 ${SHOT_DURATION_MIN}-${SHOT_DURATION_MAX} 秒`);
    }
  });
  return errors;
}

/**
 * 按素材解析结果与分镜推导预估（图片任务数 / 视频任务数 / 费用 / 耗时）。
 * 图片任务 = 分镜图 + 需补生成的素材图；视频任务 = 每个镜头一条。
 */
export function computeGenerationEstimate(shots: { duration: number }[], materials: QuickVideoMaterialItem[]) {
  const toGenerateCount = materials.filter((m) => m.source === "to_generate").length;
  const imageCount = shots.length + toGenerateCount;
  const videoCount = shots.length;
  const totalVideoSeconds = shots.reduce((sum, s) => sum + s.duration, 0);
  const estimatedCostYuan = Math.round((imageCount * ESTIMATE_IMAGE_COST_YUAN + totalVideoSeconds * ESTIMATE_VIDEO_COST_PER_SECOND_YUAN) * 100) / 100;
  const estimatedSeconds = imageCount * ESTIMATE_IMAGE_SECONDS + totalVideoSeconds * ESTIMATE_VIDEO_SECONDS;
  return { estimatedImageCount: imageCount, estimatedVideoCount: videoCount, estimatedCostYuan, estimatedSeconds };
}

// ---------------------------------------------------------------------------
// 幂等键辅助
// ---------------------------------------------------------------------------

/** 记录幂等键；已存在则返回 false（表示重复写入，应跳过） */
export function recordIdempotencyKey(state: QuickVideoState, key: string): boolean {
  if (!key) return true; // 未提供幂等键时放行（与旧行为兼容）
  if (state.appliedKeys[key] != null) return false;
  const next: Record<string, number> = { ...state.appliedKeys, [key]: Date.now() };
  const keys = Object.keys(next);
  if (keys.length > IDEMPOTENCY_MAX_KEYS) {
    keys.sort((a, b) => next[a] - next[b]);
    for (const k of keys.slice(0, keys.length - IDEMPOTENCY_MAX_KEYS)) delete next[k];
  }
  state.appliedKeys = next;
  return true;
}

// ---------------------------------------------------------------------------
// 会话隔离键（SIY-128）
// ---------------------------------------------------------------------------

/**
 * 会话隔离键：Agent 记忆表 isolationKey 与 Socket 隔离统一使用该格式。
 * 纯函数，不依赖数据库，供后端与单元测试直接引用。
 */
export function buildSessionIsolationKey(projectId: number, sessionId: number): string {
  return `${projectId}:quickVideoAgent:${sessionId}`;
}

/** 达到这个用户消息轮次（第 N 条用户消息）时触发一次智能标题生成 */
export const TITLE_GENERATION_TRIGGER_COUNT = 5;

const DEFAULT_SESSION_TITLE = "默认会话";

/** 新会话默认标题："<项目名称>-session<序号>"；项目名称缺失时退化为固定的默认会话文案 */
export function buildDefaultSessionTitle(projectName: string | null | undefined, sequence: number): string {
  const name = projectName?.trim();
  return name ? `${name}-session${sequence}` : DEFAULT_SESSION_TITLE;
}
