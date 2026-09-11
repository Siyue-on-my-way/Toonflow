/**
 * QuickVideo / 单视频快创 —— 聊天按镜头操作（按镜头引用）纯逻辑层
 *
 * 本模块只承载「引用解析、归属校验、阶段放行、提示词拼装」等纯函数，
 * 不 import 任何数据库 / utils 依赖，保证可以在无 MySQL 环境下被
 * scripts/quickvideo-shotref-unit.ts 直接测试（与 modelValidation.ts 同一约定）。
 * 落库与长任务生命周期在 shotOps.ts；Agent 工具在 agents/quickVideoAgent/tools.ts。
 */
import { QuickVideoState, QuickVideoStage, QuickVideoShot } from "./contract";

/** 聊天按镜头操作的三类动作（对应 issue 约定的三类动作工具） */
export const CHAT_SHOT_OP_ACTIONS = ["generate_shot_video", "generate_shot_image", "generate_asset"] as const;
export type ChatShotOpAction = (typeof CHAT_SHOT_OP_ACTIONS)[number];

/** 结构化镜头引用：聊天显示用编号，执行与回写必须用 storyboard 内稳定的 shot.id（即 storyboardId） */
export interface ChatShotRef {
  displayNo: number;
  shotId: string;
}

/** 快捷语法 `##<编号>#`，支持多镜头（##1# ##3#）；编号允许两侧空白，最长 3 位数字 */
export const SHOT_REF_TOKEN_RE = /##\s*(\d{1,3})\s*#/g;

/** 消息文本中是否出现了镜头引用语法（用于判断本轮是否是按镜头操作请求） */
export function hasShotRefTokens(text: string): boolean {
  SHOT_REF_TOKEN_RE.lastIndex = 0;
  return SHOT_REF_TOKEN_RE.test(text);
}

/**
 * 解析文本中的镜头引用编号：
 * - 按出现顺序返回去重后的编号列表；
 * - cleaned 为剥离引用标记后的剩余文本（供 Agent 阅读的用户指令）。
 */
export function parseShotRefTokens(text: string): { displayNos: number[]; cleaned: string } {
  const displayNos: number[] = [];
  let cleaned = text.replace(SHOT_REF_TOKEN_RE, (_raw, num: string) => {
    const n = Number(num);
    if (!displayNos.includes(n)) displayNos.push(n);
    return "";
  });
  // 折叠剥离后残留的多余空白
  cleaned = cleaned.replace(/[ \t]{2,}/g, " ").trim();
  return { displayNos, cleaned };
}

export interface RawShotRefInput {
  displayNo: number;
  /** 客户端若已从分镜表选出，会携带 storyboardId（即 shot.id）；服务端必须核对一致 */
  storyboardId?: string;
}

/**
 * 把原始引用解析为可执行的 shotRefs（纯函数）：
 * - displayNo 按当前分镜的 shot.index 定位；
 * - 编号超出范围 / 分镜不存在 → 该条记入 errors（不中断其它引用）；
 * - 携带的 storyboardId 与当前分镜不一致 → 记入 errors（提示刷新重选，防止错位引用）；
 * - 重复引用只保留第一次出现。
 */
export function resolveShotRefsFromState(
  state: Pick<QuickVideoState, "storyboard"> | null,
  refs: RawShotRefInput[],
): { resolved: ChatShotRef[]; errors: string[] } {
  const errors: string[] = [];
  if (!refs.length) return { resolved: [], errors };

  const shots = state?.storyboard?.shots ?? [];
  if (!shots.length) {
    return { resolved: [], errors: ["当前项目暂无分镜，无法引用镜头；请先确认简报并生成分镜"] };
  }

  const resolved: ChatShotRef[] = [];
  const seen = new Set<number>();
  for (const ref of refs) {
    if (!Number.isInteger(ref.displayNo) || ref.displayNo < 1) {
      errors.push(`镜头引用 ##${ref.displayNo}# 格式非法，请使用 ##编号#（如 ##1#）`);
      continue;
    }
    if (seen.has(ref.displayNo)) continue;
    seen.add(ref.displayNo);

    const shot = shots.find((s) => s.index === ref.displayNo);
    if (!shot) {
      errors.push(`镜头 ##${ref.displayNo}# 不存在，当前分镜共 ${shots.length} 镜（编号 1-${shots.length}）`);
      continue;
    }
    if (ref.storyboardId && ref.storyboardId !== shot.id) {
      errors.push(`镜头 ##${ref.displayNo}# 的引用已过期（分镜已更新），请刷新后重新选择`);
      continue;
    }
    resolved.push({ displayNo: ref.displayNo, shotId: shot.id });
  }
  return { resolved, errors };
}

/** 分镜尚未生成时（collect_brief / brief_confirmed）不允许按镜头生成 */
const SHOT_OP_STAGES: readonly QuickVideoStage[] = ["storyboard_draft", "storyboard_confirmed", "generating", "ready_to_assemble"];

/**
 * 阶段放行：generate_asset 任何阶段都可用（资产库独立于分镜）；
 * 按镜头生成要求分镜已存在（草稿即可，不必等整项目确认门——这正是按镜头操作的轻量价值）。
 * completed 阶段成片已落定，不再支持按镜头重新生成（如需调整请新建项目）。
 */
export function isShotOpStageAllowed(stage: QuickVideoStage, action: ChatShotOpAction): boolean {
  if (action === "generate_asset") return true;
  return SHOT_OP_STAGES.includes(stage);
}

/** 镜头画面要素的视觉一致性描述（与 generate.ts 的素材提示词保持同一措辞） */
function assetConsistencyPart(shot: Pick<QuickVideoShot, "assetRefs">): string {
  if (!shot.assetRefs?.length) return "";
  const label = (type: string) => (type === "role" ? "角色" : type === "scene" ? "场景" : "道具");
  return `画面需保持以下要素的视觉一致性：${shot.assetRefs
    .map((a) => `${label(a.type)}「${a.name}」${a.desc ? `（${a.desc}）` : ""}`)
    .join("；")}`;
}

/**
 * 按镜头生图提示词：分镜表基础文本（非破坏性只读）+ 用户本次补充指令。
 * 补充指令只作为本次渲染的临时覆盖/微调，不回写分镜表结构化字段。
 */
export function buildChatShotImagePrompt(input: {
  artStyle: string;
  videoRatio: string;
  shot: Pick<QuickVideoShot, "description" | "camera" | "assetRefs">;
  instruction?: string;
}): string {
  const parts = [
    input.artStyle ? `整体画面风格：${input.artStyle}` : "",
    `画面比例 ${input.videoRatio}`,
    input.shot.description,
    input.shot.camera ? `景别/运镜：${input.shot.camera}` : "",
    assetConsistencyPart(input.shot),
    input.instruction ? `用户补充要求（优先满足）：${input.instruction}` : "",
    "单幅完整画面，无文字、无水印、无分屏",
  ];
  return parts.filter(Boolean).join("；");
}

/**
 * 按镜头生视频提示词：以参考图（首帧/分镜图）为基准 + 分镜基础文本 + 用户补充指令。
 */
export function buildChatShotVideoPrompt(
  shot: Pick<QuickVideoShot, "description" | "camera" | "dialogue" | "duration">,
  instruction?: string,
): string {
  const parts = [
    `以参考图为首帧，生成 ${shot.duration} 秒的连续镜头`,
    shot.description,
    shot.camera ? `运镜：${shot.camera}` : "",
    shot.dialogue ? `画面人物口型对齐台词：${shot.dialogue}` : "",
    instruction ? `用户补充要求（优先满足）：${instruction}` : "",
    "动作自然连贯，保持人物与环境一致",
  ];
  return parts.filter(Boolean).join("；");
}

/** generate_asset 提示词：按资产类型生成定妆图/空镜图，独立于任何镜头 */
export function buildAssetImagePrompt(input: {
  artStyle: string;
  assetType: "role" | "scene" | "tool";
  name: string;
  description: string;
  instruction?: string;
}): string {
  const label = input.assetType === "role" ? "角色" : input.assetType === "scene" ? "场景" : "道具";
  const parts = [
    input.artStyle ? `整体画面风格：${input.artStyle}` : "",
    `${label}「${input.name}」的定妆图/空镜图`,
    input.description,
    input.instruction ? `用户补充要求（优先满足）：${input.instruction}` : "",
    "构图干净，主体清晰，无文字水印",
  ];
  return parts.filter(Boolean).join("；");
}

/** 校验 generate_asset 的资产类型入参 */
export function parseAssetType(input: string): "role" | "scene" | "tool" {
  if (input === "role" || input === "scene" || input === "tool") return input;
  throw new Error(`资产类型需为 role（角色）/ scene（场景）/ tool（道具）之一，收到：${input}`);
}

// ---------------------------------------------------------------------------
// 聊天操作卡片契约（经 Socket activity 内容下发；前端镜像见 Toonflow-web types/quickVideo.ts）
// ---------------------------------------------------------------------------

export const SHOT_OP_CARD_PHASES = ["confirm", "running", "done", "failed"] as const;
export type ShotOpCardPhase = (typeof SHOT_OP_CARD_PHASES)[number];

/** 卡片内单镜头信息：confirm 阶段为生成计划（含首帧缩略图），running/done/failed 为任务状态 */
export interface ShotOpCardShot {
  shotId: string;
  displayNo: number;
  description: string;
  duration?: number | null;
  /** confirm 阶段展示的首帧/分镜图缩略图（按需签发的短期地址） */
  baseImageUrl?: string | null;
  imageState?: QuickVideoShot["imageState"];
  videoState?: QuickVideoShot["videoState"];
  errorReason?: string | null;
  imageUrl?: string | null;
  videoUrl?: string | null;
  /** generate_asset 产出的资产 id */
  assetId?: number | null;
  mediaId?: number | null;
}

/** 聊天按镜头操作卡片（activity content.data.content）；分镜表仍是媒体结果唯一主存储 */
export interface ShotOpCardPayload {
  cardId: string;
  phase: ShotOpCardPhase;
  action: ChatShotOpAction;
  opId?: string | null;
  /** confirm 阶段的轻量确认令牌；确认后由 /quickVideo/confirmShotOp 消费 */
  confirmToken?: string | null;
  instruction: string;
  errorReason?: string | null;
  shots: ShotOpCardShot[];
  createdAt: number;
}
