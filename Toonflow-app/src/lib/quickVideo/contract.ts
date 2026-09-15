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

/**
 * QuickVideo 业务错误：带 code 与当前状态版本。
 * REST 层与 Agent 工具层都按 code 分支、把 message 原文转述给用户。
 * 定义在 contract（纯模块）以便确认门内核与单元测试零 DB 依赖地引用；state.ts 转出口。
 */
export class QuickVideoError extends Error {
  public code: string;
  public currentVersion?: number;

  constructor(code: string, message: string, currentVersion?: number) {
    super(message);
    this.code = code;
    this.currentVersion = currentVersion;
  }
}

/** o_agentWorkData.key 的固定值 */
export const QUICK_VIDEO_AGENT_KEY = "quickVideoAgent";

/** 契约版本：状态结构不兼容变更时递增 */
export const QUICK_VIDEO_SCHEMA_VERSION = 1;

/** 项目类型枚举值（o_project.projectType 新增） */
export const QUICK_VIDEO_PROJECT_TYPE = "quick_video";

/** 目标时长（秒），支持 5-60 的正整数秒或 null（自适应） */
export const QUICK_VIDEO_DURATION_MIN = 5;
export const QUICK_VIDEO_DURATION_MAX = 60;
export const QUICK_VIDEO_DURATIONS = [15, 30, 60] as const;
export const quickVideoDurationSchema = z.number().int().min(QUICK_VIDEO_DURATION_MIN).max(QUICK_VIDEO_DURATION_MAX).nullable().default(null);
export type QuickVideoDuration = number | null;

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

/**
 * 跨镜头连续性策略：
 * - last_frame    继承上一镜头尾帧（默认，针对应顺承镜头，ffmpeg抽帧并注入为首帧，像素级连贯）
 * - assets_only   继承人物与道具素材（针对切镜，注入角色/道具参考图并在 Prompt 补充一致性特征词）
 * - independent   独立镜头（前后完全独立）
 */
export const SHOT_CONTINUITY_TYPES = ["last_frame", "assets_only", "independent"] as const;
export type ShotContinuityType = (typeof SHOT_CONTINUITY_TYPES)[number];
export const SHOT_CONTINUITY_LABELS: Record<ShotContinuityType, string> = {
  last_frame: "继承上一镜头尾帧",
  assets_only: "继承人物与道具素材",
  independent: "独立镜头",
};

// ---------------------------------------------------------------------------
// 阶段状态机
// ---------------------------------------------------------------------------

/**
 * 工作台阶段：
 * - collect_brief        收集/打磨简报
 * - brief_confirmed      简报已确认（用户确认门 1）
 * - storyboard_draft     分镜草稿打磨中
 * - storyboard_confirmed 分镜已确认（用户确认门 2），系统回显最终生成参数确认卡片，等待用户确认后开始生成
 * - generating           逐镜头生成图片/视频中
 * - ready_to_assemble    全部镜头生成完毕，可装配时间线
 * - completed            成片导出完成（导出确认门：导出确认后落定）
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
  /** 文生图/首帧视觉描述词（分镜表作为 Prompt 策划板输出，聊天生图/管道生图优先使用） */
  imagePrompt: z.string().max(2000).default("").describe("文生图/首帧提示词（主体、构图、风格、光影的完整视觉描述）"),
  /** 视频动作/运镜描述词（聊天生视频/管道生视频优先使用） */
  videoPrompt: z.string().max(2000).default("").describe("视频提示词（画面动作、运镜、动态变化的完整描述）"),
  continuity: z
    .enum(SHOT_CONTINUITY_TYPES)
    .default("last_frame")
    .describe("跨镜头连续性策略：last_frame=继承上一镜头尾帧 / assets_only=继承人物与道具素材 / independent=独立镜头"),
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
  imagePrompt: z.string().max(2000).default(""),
  videoPrompt: z.string().max(2000).default(""),
  continuity: z.enum(SHOT_CONTINUITY_TYPES).default("last_frame"),
  /** 冻结的首帧引用（含 filePath，生成引擎直接读取）；无人工首帧时为 null，回退用分镜图 imageRef */
  firstFrame: snapshotFirstFrameSchema.nullable().default(null),
});
export type QuickVideoSnapshotShot = z.infer<typeof snapshotShotSchema>;

/**
 * 生成快照：最终生成参数确认通过时冻结（分镜确认回显卡片时预先构建）。
 * 「不可歧义」：记录分镜版本、比例、画风、镜头内容与素材解析结果，生成引擎只读这里。
 * 注意：素材解析结果仅作为生成参考图来源（内部机制），不再要求用户单独确认素材或成本。
 */
export const generationSnapshotSchema = z.object({
  storyboardVersion: z.number().int().min(1).describe("快照对应的分镜版本"),
  targetDuration: quickVideoDurationSchema,
  videoRatio: z.enum(QUICK_VIDEO_RATIOS),
  artStyle: z.string().max(500).default(""),
  shots: z.array(snapshotShotSchema).min(1).max(SHOT_COUNT_MAX),
  materials: z.array(materialItemSchema).max(30).default([]),
});
export type QuickVideoGenerationSnapshot = z.infer<typeof generationSnapshotSchema>;

/**
 * 最终生成参数确认卡片（分镜确认后在聊天流回显）：
 * 仅展示「视频时长 / 整体画风 / 分镜数量 / 分镜摘要」四项，卡片数据在回显时冻结。
 * 若时长或画风未设置，安全回退为自适应时长与自由画风文案。
 * 用户再修改画风、时长或分镜后，服务端重新回显新卡片；旧卡片由前端按
 * 「是否还有更新的卡片」标记为已失效（置灰并提示重新确认）。
 */
export const finalParamsCardSchema = z.object({
  cardId: z.string().min(1).max(64).describe("卡片 ID（card-<时间戳>-<随机>），前端渲染 key 与最新卡判定"),
  storyboardVersion: z.number().int().min(1).describe("回显时的分镜版本"),
  targetDuration: quickVideoDurationSchema,
  artStyle: z.string().max(500).default(""),
  shotCount: z.number().int().min(1).max(SHOT_COUNT_MAX),
  summary: z.string().max(1000).default("").describe("分镜摘要（storyboard.summary）"),
  echoedAt: z.number().int().min(1).describe("回显时间戳"),
  durationText: z.string().max(100).optional().describe("时长文案（未设置时自适应）"),
  artStyleText: z.string().max(500).optional().describe("画风文案（未设置时自由画风）"),
});
export type QuickVideoFinalParamsCard = z.infer<typeof finalParamsCardSchema>;

/** 聊天流内保留的最终参数确认卡片数量上限（超出后淘汰最早的卡片） */
export const FINAL_PARAMS_CARDS_MAX = 5;

/**
 * 组装一张最终生成参数确认卡片（回显时冻结四项展示字段，与实时分镜/配置解耦）。
 * 若时长或画风未设置，安全回退为自适应时长与自由画风文案。
 */
export function buildFinalParamsCard(state: QuickVideoState): QuickVideoFinalParamsCard {
  const durationText = state.targetDuration ? `${state.targetDuration}s` : "自适应";
  const artStyleText = state.artStyle?.trim() ? state.artStyle : "自由画风";
  return {
    cardId: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    storyboardVersion: state.storyboard?.version ?? 1,
    targetDuration: state.targetDuration ?? null,
    artStyle: state.artStyle || "",
    durationText,
    artStyleText,
    shotCount: state.storyboard?.shots.length ?? 0,
    summary: state.storyboard?.summary ?? "",
    echoedAt: Date.now(),
  };
}

/**
 * 回显一张新卡片并淘汰最早的旧卡片（旧卡片由前端按「存在更新的卡片」标记为已失效）。
 * 何时调用（服务端确定性触发，不依赖 Agent 自觉）：
 * - 分镜确认通过时（confirmStage gate=storyboard confirm）
 * - 分镜已确认状态下画风/比例变更后（updateConfig / update_config）
 */
export function echoFinalParamsCard(state: QuickVideoState): QuickVideoFinalParamsCard {
  const card = buildFinalParamsCard(state);
  state.generation.finalParamsCards = [...(state.generation.finalParamsCards ?? []), card].slice(-FINAL_PARAMS_CARDS_MAX);
  return card;
}

/** 生成链路运行态（最终参数确认状态 + 快照 + 运行记录） */
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
  type: z.enum(["crossfade", "none"]).default("crossfade"),
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
  targetDuration: quickVideoDurationSchema,
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
  /** 最近一次生成快照（最终参数确认时冻结；参数变更后重建） */
  snapshot: generationSnapshotSchema.nullable().default(null),
  /** 最终生成参数确认是否已通过（用户点击聊天确认卡片「确认生成」后写入） */
  materialsConfirmed: z.boolean().default(false).describe("最终生成参数确认状态（字段名沿用旧版，仅作内部标识）"),
  materialsConfirmedAt: z.number().nullable().default(null),
  /** 最终生成参数确认卡片（分镜确认/参数变更时回显，最新在末尾；存量状态缺该字段时补空数组） */
  finalParamsCards: z
    .preprocess((v) => (Array.isArray(v) ? v.slice(-FINAL_PARAMS_CARDS_MAX) : []), z.array(finalParamsCardSchema))
    .default([]),
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

/** o_agentWorkData(key=quickVideoAgent).data 的完整结构 */
export const quickVideoStateSchema = z.object({
  schemaVersion: z.literal(QUICK_VIDEO_SCHEMA_VERSION).default(QUICK_VIDEO_SCHEMA_VERSION),
  /** 乐观锁版本号，每次成功写入自增 */
  version: z.number().int().min(1),
  stage: z.enum(QUICK_VIDEO_STAGES),
  targetDuration: quickVideoDurationSchema,
  videoRatio: z.enum(QUICK_VIDEO_RATIOS),
  artStyle: z.string().max(500).default(""),
  /** 配置版本号，修改画风/时长/比例时自增 */
  configVersion: z.number().int().min(0).default(0),
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

/** 递增配置版本号 */
export function bumpConfigVersion(state: QuickVideoState): number {
  state.configVersion = (state.configVersion ?? 0) + 1;
  return state.configVersion;
}

/** 幂等键记录上限，超过后淘汰最早写入的 key */
export const IDEMPOTENCY_MAX_KEYS = 50;

// ---------------------------------------------------------------------------
// 分镜校验规则（propose / confirm 时共用）
// ---------------------------------------------------------------------------

/**
 * 按目标时长推导允许的镜头数量区间：
 * 每个镜头 5-15 秒；targetDuration 为 null（自适应）时，放行 2-12 镜；
 * 否则按目标时长动态推导，尽量向“5 个镜头以上”的产品预期靠拢（时长允许时）。
 */
export function shotCountBounds(targetDuration: QuickVideoDuration): { min: number; max: number } {
  if (targetDuration == null) {
    return { min: 2, max: SHOT_COUNT_MAX };
  }
  const max = Math.max(1, Math.min(SHOT_COUNT_MAX, Math.floor(targetDuration / SHOT_DURATION_MIN)));
  const min = Math.max(1, Math.min(5, Math.floor(targetDuration / SHOT_DURATION_MAX) || 1));
  return { min, max };
}

/**
 * 校验一份分镜是否满足落库/确认条件：
 * - 镜头数量在区间内
 * - targetDuration != null 时：总时长与目标时长误差在 ±20%（且不少于 1 秒差）
 * - targetDuration == null 时：自适应放行 2–12 镜头、成片不超过 60 秒的合理分镜，不抛出 DURATION_NOT_SET 异常
 * 返回错误原因数组；空数组表示通过。
 */
export function validateStoryboard(
  targetDuration: QuickVideoDuration,
  shots: Array<Pick<QuickVideoShot, "id" | "duration"> & Partial<QuickVideoShot>>,
): string[] {
  const errors: string[] = [];
  const { min, max } = shotCountBounds(targetDuration);
  if (shots.length < min || shots.length > max) {
    errors.push(
      targetDuration != null
        ? `镜头数量需在 ${min}-${max} 个之间（目标时长 ${targetDuration} 秒，当前 ${shots.length} 个）`
        : `镜头数量需在 ${min}-${max} 个之间（当前 ${shots.length} 个）`,
    );
  }
  const total = shots.reduce((sum, s) => sum + s.duration, 0);
  if (targetDuration != null) {
    const tolerance = Math.max(3, Math.round(targetDuration * 0.2));
    if (Math.abs(total - targetDuration) > tolerance) {
      errors.push(`镜头总时长 ${total} 秒与目标时长 ${targetDuration} 秒偏差超过 ${tolerance} 秒`);
    }
  } else {
    if (total > 60) {
      errors.push(`自适应模式下成片总时长不得超过 60 秒（当前 ${total} 秒）`);
    }
    if (total < 5) {
      errors.push(`成片总时长至少为 5 秒（当前 ${total} 秒）`);
    }
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

// ---------------------------------------------------------------------------
// 确认门内核（SIY-152：REST confirmStage / retryShot 与 Agent 确认类工具共用同一份判定）
// ---------------------------------------------------------------------------

/**
 * 乐观锁校验：请求持有的版本与服务端当前版本不一致时拒绝。
 * mutateQuickVideoState（权威校验）与 Agent 确认类工具（前置校验）共用，报错文案与按钮链路完全一致。
 */
export function assertExpectedVersion(currentVersion: number, expectedVersion: number | null | undefined): void {
  if (expectedVersion != null && expectedVersion !== currentVersion) {
    throw new QuickVideoError(
      "VERSION_CONFLICT",
      `状态版本冲突：服务端当前版本 ${currentVersion}，请求基于版本 ${expectedVersion}，请刷新后重试`,
      currentVersion,
    );
  }
}

/**
 * gate=brief 预校验：暂无简报 / 阶段不符时抛错，不改动状态。
 * 错误文案与 REST confirmStage 保持逐字一致（Agent 工具的拦截提示与按钮 toast 同语义）。
 */
export function assertBriefGate(state: QuickVideoState, action: "confirm" | "reject"): void {
  if (!state.brief) throw new QuickVideoError("NO_BRIEF", "暂无简报，无法操作", state.version);
  if (action === "confirm") {
    if (!["collect_brief", "storyboard_draft", "brief_confirmed"].includes(state.stage)) {
      throw new QuickVideoError("STAGE_MISMATCH", `当前阶段 ${state.stage} 不允许确认简报`, state.version);
    }
  } else {
    if (state.stage !== "brief_confirmed" && state.stage !== "collect_brief") {
      throw new QuickVideoError("STAGE_MISMATCH", "简报已进入后续流程，请改为直接编辑简报", state.version);
    }
  }
}

/**
 * gate=brief 内核：简报确认 / 返回修改（纯函数）。
 * confirm：collect_brief / storyboard_draft / brief_confirmed -> brief_confirmed（重复确认停留原地，幂等）；
 * reject：brief_confirmed / collect_brief -> collect_brief，确认状态清除。
 */
export function applyBriefGate(state: QuickVideoState, action: "confirm" | "reject"): void {
  assertBriefGate(state, action);
  if (action === "confirm") {
    state.stage = "brief_confirmed";
    state.brief!.confirmed = true;
    state.brief!.confirmedAt = Date.now();
  } else {
    state.stage = "collect_brief";
    state.brief!.confirmed = false;
    state.brief!.confirmedAt = null;
  }
}

/**
 * gate=storyboard 预校验：暂无分镜 / 阶段不符时抛错，不改动状态。
 * confirm 的分镜有效性校验、快照组装与最终参数卡片回显（涉及 DB）由 generate.ts 的
 * applyStoryboardGate 执行，REST 与 Agent 工具共用同一份实现。
 */
export function assertStoryboardGate(state: QuickVideoState, action: "confirm" | "reject"): void {
  if (!state.storyboard) throw new QuickVideoError("NO_STORYBOARD", "暂无分镜，无法操作", state.version);
  if (action === "confirm") {
    if (state.stage !== "storyboard_draft") {
      throw new QuickVideoError("STAGE_MISMATCH", `当前阶段 ${state.stage} 不允许确认分镜`, state.version);
    }
  } else {
    if (state.stage !== "storyboard_confirmed") {
      throw new QuickVideoError("STAGE_MISMATCH", `当前阶段 ${state.stage} 不需要撤销分镜确认`, state.version);
    }
  }
}

/**
 * gate=storyboard reject 内核：撤销确认，分镜回到草稿解锁编辑（纯函数）。
 * 调用方：REST confirmStage 与 Agent 的 reject_storyboard 工具（mutateQuickVideoState 事务内）。
 */
export function applyStoryboardGateReject(state: QuickVideoState): void {
  assertStoryboardGate(state, "reject");
  state.stage = "storyboard_draft";
  state.storyboard!.status = "draft";
  state.storyboard!.confirmedAt = null;
}

// ---------------------------------------------------------------------------
// 失败镜头重试目标解析（SIY-152：与前端「重试全部失败镜头」按钮同口径）
// ---------------------------------------------------------------------------

/** 失败镜头判定：分镜图或视频片段任一生成状态为 failed 即视为失败（与前端 isShotFailed 同口径） */
export function isShotFailed(shot: Pick<QuickVideoShot, "imageState" | "videoState">): boolean {
  return shot.imageState === "failed" || shot.videoState === "failed";
}

/** 重试阶段预校验：仅生成（generating）阶段允许重试；报错文案与 retryQuickVideoShots 权威校验一致 */
export function assertRetryShotStage(state: QuickVideoState): void {
  if (state.stage !== "generating") {
    throw new QuickVideoError("STAGE_MISMATCH", `当前阶段 ${state.stage} 不允许重试，仅生成阶段可重试失败镜头`, state.version);
  }
}

/** 缺省重试目标：全部失败镜头（按播放顺序） */
export function pickFailedShotIds(state: QuickVideoState): string[] {
  return (state.storyboard?.shots ?? []).filter(isShotFailed).map((s) => s.id);
}

/**
 * 重试目标解析（Agent retry_shot 工具前置校验）：
 * - 阶段不符时抛错（文案与 retryQuickVideoShots 的权威校验一致）；
 * - shotIds 缺省为空 = 全部失败镜头；无失败镜头时抛 NO_FAILED_SHOTS；
 * - 显式传入的 shotIds 原样返回，存在性/运行中/已完成校验仍由 retryQuickVideoShots 权威执行。
 */
export function pickRetryShotIds(state: QuickVideoState, shotIds?: string[]): string[] {
  assertRetryShotStage(state);
  if (!shotIds || shotIds.length === 0) {
    const failed = pickFailedShotIds(state);
    if (!failed.length) {
      throw new QuickVideoError("NO_FAILED_SHOTS", "当前没有失败镜头，无需重试", state.version);
    }
    return failed;
  }
  return shotIds;
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

// ---------------------------------------------------------------------------
// 镜头媒体产物访问地址（SIY-147）
// ---------------------------------------------------------------------------

/**
 * 镜头媒体产物访问地址契约：
 * - imageUrl: 镜头生成图访问地址（已完成且生成成功时有值）
 * - videoUrl: 镜头生成视频访问地址（已完成且生成成功时有值）
 * - videoPosterUrl: 视频卡片封面，按优先级依次取：视频专有首帧（绑定的 firstFrame）> 镜头生成图 > null
 * - firstFrameUrl: 人工绑定的首帧缩略图
 */
export const shotMediaUrlsSchema = z.object({
  imageUrl: z.string().nullable(),
  videoUrl: z.string().nullable(),
  videoPosterUrl: z.string().nullable(),
  firstFrameUrl: z.string().nullable(),
});
export type ShotMediaUrls = z.infer<typeof shotMediaUrlsSchema>;

/**
 * 视频封面优先级计算：优先视频专有首帧（绑定的 firstFrame），其次镜头生成图，最后 null
 */
export function resolveVideoPosterUrl(
  firstFrameUrl: string | null | undefined,
  imageUrl: string | null | undefined,
): string | null {
  return firstFrameUrl ?? imageUrl ?? null;
}

// ---------------------------------------------------------------------------
// 聊天"文本 + 图片占位符"多模态语法（SIY-151）
// ---------------------------------------------------------------------------

/** 单轮聊天占位符编号上限（与附件托盘容量一致，位序 1-4） */
export const IMAGE_PLACEHOLDER_MAX = 4;

/** 匹配 ##图1## ~ ##图99##（容许首尾空格）；占位符编号是附件托盘的位序（1 开始） */
export const IMAGE_PLACEHOLDER_RE = /##\s*图\s*(\d{1,2})\s*##/g;

/**
 * 从聊天文本中解析图片占位符编号（去重、升序、截断到上限）。
 * 返回空数组表示本轮消息没有占位符（纯文本生成）。
 */
export function parseImagePlaceholderSlots(text: string | null | undefined): number[] {
  if (!text) return [];
  const slots = new Set<number>();
  for (const match of String(text).matchAll(IMAGE_PLACEHOLDER_RE)) {
    const slot = Number(match[1]);
    if (Number.isInteger(slot) && slot >= 1 && slot <= 99) slots.add(slot);
  }
  return Array.from(slots).sort((a, b) => a - b).slice(0, IMAGE_PLACEHOLDER_MAX);
}

/**
 * 建立"占位符编号 -> mediaId"映射：##图N## 对应附件托盘第 N 张图（references 的第 N-1 项）。
 * 超出托盘容量的编号没有对应媒体，直接丢弃——由调用方决定如何提示用户。
 */
export function resolveSlotReferences(references: number[] | null | undefined, slots: number[]): Record<number, number> {
  const mapping: Record<number, number> = {};
  const refs = (references ?? []).slice(0, IMAGE_PLACEHOLDER_MAX);
  for (const slot of slots) {
    if (slot < 1 || slot > refs.length) continue;
    mapping[slot] = refs[slot - 1];
  }
  return mapping;
}
