import { tool, jsonSchema, Tool } from "ai";
import { z } from "zod";
import u from "@/utils";
import ResTool from "@/socket/resTool";
import { loadQuickVideoState, mutateQuickVideoState, QuickVideoError } from "@/lib/quickVideo/state";
import {
  QuickVideoShot,
  QuickVideoRatio,
  QUICK_VIDEO_RATIOS,
  SHOT_DURATION_MAX,
  SHOT_DURATION_MIN,
  shotAssetRefSchema,
  shotCountBounds,
  validateStoryboard,
  echoFinalParamsCard,
  SHOT_CONTINUITY_TYPES,
  ShotContinuityType,
  applyBriefGate,
  assertBriefGate,
  assertStoryboardGate,
  pickRetryShotIds,
} from "@/lib/quickVideo/contract";
import { findShot, nextShotId, normalizeShotDuration, reindexShots } from "@/lib/quickVideo/shots";
import {
  applyStoryboardGate,
  retryQuickVideoShots,
  startQuickVideoGeneration,
  buildSnapshot,
  applySnapshotToState,
  assertVideoSupportsSingleImage,
  castAspectRatio,
} from "@/lib/quickVideo/generate";
import {
  createChatMedia,
  markChatMediaDone,
  markChatMediaFailed,
  resolveMediaImageBase64,
  resolveMediaForFirstFrame,
  resolveVideoStartEndMode,
  videoModelSupportsTextToVideo,
} from "@/lib/quickVideo/media";

/**
 * QuickVideoAgent 受限工具层。
 * Agent 对工作台状态的唯一写入口：全部走 mutateQuickVideoState（服务端 zod 契约校验 + 阶段白名单 + 事务 + 幂等键）。
 * 简报/分镜确认门可由 Agent 按用户聊天指令代为推进（confirm_brief / reject_brief / confirm_storyboard /
 * reject_storyboard，SIY-152），复用 REST confirmStage 的同一份门内核，报错文案与按钮 toast 同语义；
 * 生成启动由 generate_shots 在用户聊天明确要求时自动通过确认门（SIY-151），导出确认仍是用户专属操作。
 */

interface ToolConfig {
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  sessionId: number;
  /** 服务端已校验过的图片模型 key；未提供时 generate_image 工具不对 Agent 暴露 */
  imageModel?: string;
  /** 服务端已校验过的视频模型 key；未提供时 generate_video 工具不对 Agent 暴露（SIY-134） */
  videoModel?: string;
  /** 用户选中的引用媒体 mediaId 列表（图生图/图生视频参考） */
  references?: number[];
  /** 占位符编号 -> mediaId 映射（##图N## = 托盘第 N 张图），由 socket 层按用户消息解析（SIY-151） */
  slotReferences?: Record<number, number>;
  /** 用户本轮消息中出现的占位符编号（升序去重）；未指定引用时的确定性回退依据 */
  placeholderSlots?: number[];
}

/** 按占位符编号解析引用媒体；编号无效（没有对应媒体）时返回 null */
function resolveSlotMediaId(toolConfig: ToolConfig, slot: number): number | null {
  return toolConfig.slotReferences?.[slot] ?? null;
}

/** 工具内统一错误转文本，避免 Agent 因异常中断 */
function describeError(err: unknown): string {
  if (err instanceof QuickVideoError) return `[${err.code}] ${err.message}`;
  return u.error(err as Error).message;
}

/** 工具执行期间流式输出思考过程 */
async function withThinking<T>(msg: ReturnType<ResTool["newMessage"]>, title: string, fn: () => Promise<T>): Promise<T> {
  const thinking = msg.thinking(title);
  try {
    const result = await fn();
    thinking.complete();
    return result;
  } catch (err) {
    thinking.appendText(`\n失败：${describeError(err)}`);
    thinking.updateTitle(`${title}（失败）`);
    thinking.complete();
    throw err;
  }
}

export default (toolConfig: ToolConfig) => {
  const { msg, sessionId } = toolConfig;
  const projectId = Number(toolConfig.resTool.data.projectId);
  const userId = Number(toolConfig.resTool.data.userId ?? 0) || 1;

  const tools: Record<string, Tool> = {
    get_state: tool({
      description: "获取当前快创工作台的完整状态：阶段、目标时长、简报、分镜（含每个镜头的生成状态）、最终生成参数确认状态。写操作前必须先调用本工具确认前置条件。",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
      execute: async () => {
        const state = await loadQuickVideoState(projectId);
        if (!state) return "未找到工作台状态";
        return JSON.stringify(
          {
            version: state.version,
            configVersion: state.configVersion ?? 0,
            stage: state.stage,
            targetDuration: state.targetDuration,
            videoRatio: state.videoRatio,
            artStyle: state.artStyle,
            shotBounds: shotCountBounds(state.targetDuration),
            brief: state.brief,
            storyboard: state.storyboard,
            finalParams: {
              confirmed: state.generation?.materialsConfirmed ?? false,
              latestCard: state.generation?.finalParamsCards?.slice(-1)[0] ?? null,
            },
          },
          null,
          2,
        );
      },
    }),

    update_config: tool({
      description:
        "修改单视频项目基础配置（标题、画风、画面比例、目标时长、简介）。写入前可调用 get_state 确认当前状态。支持接收 5-60 秒整数时长或 null 自适应时长、自定义画风，调用后写入状态机并递增 configVersion。目标时长在分镜已确认后不可修改，需先提醒用户撤销分镜确认。分镜已确认时修改画风或比例，系统会自动使旧确认失效并重新回显最终参数确认卡片；修改目标时长后应按新的镜头数量区间和总时长约束重新打磨分镜。",
      inputSchema: jsonSchema<{
        name?: string;
        artStyle?: string;
        videoRatio?: "16:9" | "9:16" | "1:1";
        targetDuration?: number | null;
        intro?: string;
      }>(
        z
          .object({
            name: z.string().min(1).max(100).optional().describe("项目标题"),
            artStyle: z.string().max(500).optional().describe("画风"),
            videoRatio: z.enum(QUICK_VIDEO_RATIOS).optional().describe("画面比例"),
            targetDuration: z.number().int().min(5).max(60).nullable().optional().describe("目标时长（秒，5-60秒整数，或传 null 表示自适应）"),
            intro: z.string().max(2000).optional().describe("项目简介"),
          })
          .toJSONSchema(),
      ),
      execute: async (input, options) => {
        const { toolCallId } = options as { toolCallId: string };
        return withThinking(msg, "正在更新项目配置...", async () => {
          if (!Object.keys(input).length) throw new QuickVideoError("INVALID_CONFIG", "至少提供一项需要修改的配置");

          const { state, idempotentHit } = await mutateQuickVideoState(
            projectId,
            { idempotencyKey: `tool:update_config:${toolCallId}` },
            async (s, trx) => {
              const targetDurationChanged = input.targetDuration !== undefined && input.targetDuration !== s.targetDuration;
              const visualConfigChanged =
                (input.artStyle !== undefined && input.artStyle !== s.artStyle) ||
                (input.videoRatio !== undefined && input.videoRatio !== s.videoRatio);
              const generationConfigChanged = targetDurationChanged || visualConfigChanged;

              if (targetDurationChanged && s.storyboard?.status === "confirmed") {
                throw new QuickVideoError("FORBIDDEN", "分镜已确认，不允许修改目标时长；请先让用户撤销分镜确认", s.version);
              }
              if (generationConfigChanged && ["generating", "ready_to_assemble", "completed"].includes(s.stage)) {
                throw new QuickVideoError("FORBIDDEN", "生成已开始，不能再修改目标时长、画风或比例；如需调整请新建项目", s.version);
              }
              if (input.targetDuration !== undefined) s.targetDuration = input.targetDuration;
              if (input.videoRatio !== undefined) s.videoRatio = input.videoRatio;
              if (input.artStyle !== undefined) s.artStyle = input.artStyle;
              s.configVersion = (s.configVersion ?? 0) + 1;

              if (generationConfigChanged) {
                s.generation.snapshot = null;
                s.generation.materialsConfirmed = false;
                s.generation.materialsConfirmedAt = null;
                s.generation.materialImages = {};
                s.generation.timeline = null;
                s.generation.exportInfo = null;
                // 分镜已确认时同步重建快照并重新回显最终参数确认卡片（旧卡片随之失效）
                if (s.stage === "storyboard_confirmed") {
                  const { materials, snapshotShots } = await buildSnapshot(projectId, s);
                  applySnapshotToState(s, s.storyboard!.version, snapshotShots, materials);
                  echoFinalParamsCard(s);
                }
              }

              const projectPatch: Record<string, string> = {};
              if (input.name != null) projectPatch.name = input.name;
              if (input.artStyle != null) projectPatch.artStyle = input.artStyle;
              if (input.videoRatio != null) projectPatch.videoRatio = input.videoRatio;
              if (input.intro != null) projectPatch.intro = input.intro;
              if (Object.keys(projectPatch).length) await trx("o_project").where("id", projectId).update(projectPatch);
            },
          );

          if (idempotentHit) return "该次项目配置更新已应用过（幂等命中），未重复写入。";
          const durationHint = input.targetDuration !== undefined
            ? (state.targetDuration != null ? `目标时长已更新为 ${state.targetDuration} 秒` : "目标时长已设置为自适应")
            : "项目配置已更新";
          const storyboardHint = input.targetDuration !== undefined && state.storyboard ? "请根据新目标时长重新打磨当前分镜。" : "";
          const visualHint = input.artStyle !== undefined || input.videoRatio !== undefined ? "系统已重新回显最终参数确认卡片，请提醒用户按新参数重新确认后再开始生成。" : "";
          return `${durationHint}（配置版本 configVersion=${state.configVersion}，状态版本 ${state.version}）。${storyboardHint}${visualHint}`;
        }).catch((err) => `更新项目配置失败：${describeError(err)}`);
      },
    }),

    save_brief: tool({
      description:
        "保存/更新结构化简报（主题、开场钩子、叙事大纲、结尾CTA、关键词）。仅在 collect_brief / brief_confirmed / storyboard_draft 阶段可用；保存后简报回到未确认状态，需用户重新确认。",
      inputSchema: jsonSchema<{
        theme: string;
        hook: string;
        narrative: string;
        cta: string;
        keywords: string[];
      }>(
        z
          .object({
            theme: z.string().min(1).max(500).describe("主题/核心创意"),
            hook: z.string().max(500).describe("开场钩子（前3秒抓住观众）"),
            narrative: z.string().min(1).max(3000).describe("叙事大纲，按时间线的一段话"),
            cta: z.string().max(500).describe("结尾/行动号召"),
            keywords: z.array(z.string().min(1).max(60)).max(20).describe("风格/内容关键词"),
          })
          .toJSONSchema(),
      ),
      execute: async (input, options) => {
        const { toolCallId } = options as { toolCallId: string };
        return withThinking(msg, "正在保存简报...", async () => {
          const { state, idempotentHit } = await mutateQuickVideoState(
            projectId,
            { idempotencyKey: `tool:save_brief:${toolCallId}`, sessionId },
            (s) => {
              if (!["collect_brief", "brief_confirmed", "storyboard_draft"].includes(s.stage)) {
                throw new QuickVideoError("STAGE_FORBIDDEN", `当前阶段 ${s.stage} 不允许修改简报`, s.version);
              }
              s.brief = {
                theme: input.theme,
                hook: input.hook ?? "",
                narrative: input.narrative,
                cta: input.cta ?? "",
                keywords: input.keywords ?? [],
                confirmed: false,
                confirmedAt: null,
              };
            },
          );
          return idempotentHit
            ? "该次简报保存已应用过（幂等命中），未重复写入。"
            : `简报已保存（状态版本 ${state.version}）。请向用户复述简报要点，并提醒用户在右侧面板确认简报后再进入分镜环节。`;
        }).catch((err) => `保存简报失败：${describeError(err)}`);
      },
    }),

    propose_storyboard: tool({
      description:
        "提交一版完整分镜（替换式）：5-12 个镜头、每镜 5-15 秒、总时长贴近目标时长。前置条件：简报已存在且简报已确认（用户在确认门确认过）。每个镜头必须输出高质量的 imagePrompt（文生图/首帧视觉描述词）与 videoPrompt（视频动作/运镜描述词），它们是用户在分镜表一键填入聊天窗生成的直接依据。提交后分镜为草稿，用户可在右侧面板继续打磨。",
      inputSchema: jsonSchema<{
        summary: string;
        shots: { duration: number; description: string; dialogue: string; camera: string; imagePrompt: string; videoPrompt: string; continuity?: "last_frame" | "assets_only" | "independent" }[];
      }>(
        z
          .object({
            summary: z.string().max(1000).describe("本版分镜的整体说明（一句话）"),
            shots: z
              .array(
                z.object({
                  duration: z.number().int().min(SHOT_DURATION_MIN).max(SHOT_DURATION_MAX).describe(`镜头时长（秒），${SHOT_DURATION_MIN}-${SHOT_DURATION_MAX}`),
                  description: z.string().min(1).max(2000).describe("画面描述（镜头内容、动作、氛围）"),
                  dialogue: z.string().max(500).describe("台词/旁白（用作字幕，可为空字符串）"),
                  camera: z.string().max(200).describe("景别/运镜（如 全景、缓慢推进）"),
                  imagePrompt: z.string().min(1).max(2000).describe("文生图/首帧提示词：具体到主体外观、动作姿态、构图景别、环境氛围、光影与画风关键词的完整画面描述，可直接用于文生图"),
                  videoPrompt: z.string().min(1).max(2000).describe("视频提示词：以该镜头画面为起点的动作与动态变化描述，包含主体动作、镜头运动（推拉摇移）、时长节奏，可直接用于图生视频"),
                  continuity: z
                    .enum(SHOT_CONTINUITY_TYPES)
                    .optional()
                    .default("last_frame")
                    .describe("跨镜头连续性策略：last_frame=继承上一镜头尾帧（默认） / assets_only=继承人物与道具素材 / independent=独立镜头"),
                }),
              )
              .min(1)
              .max(12)
              .describe("镜头列表，按播放顺序"),
          })
          .toJSONSchema(),
      ),
      execute: async (input, options) => {
        const { toolCallId } = options as { toolCallId: string };
        return withThinking(msg, "正在提交分镜...", async () => {
          // 预校验给出可读错误（事务内还会做权威校验）
          const current = await loadQuickVideoState(projectId);
          if (!current) throw new QuickVideoError("STATE_NOT_FOUND", "未找到工作台状态", undefined);
          const bounds = shotCountBounds(current.targetDuration);
          if (input.shots.length < bounds.min || input.shots.length > bounds.max) {
            throw new QuickVideoError(
              "STORYBOARD_INVALID",
              `镜头数量需在 ${bounds.min}-${bounds.max} 个之间（目标时长 ${current.targetDuration} 秒），当前 ${input.shots.length} 个`,
              current.version,
            );
          }

          const { state, idempotentHit } = await mutateQuickVideoState(
            projectId,
            { idempotencyKey: `tool:propose_storyboard:${toolCallId}`, sessionId },
            (s) => {
              if (!s.brief) throw new QuickVideoError("NO_BRIEF", "请先用 save_brief 保存简报", s.version);
              if (!["brief_confirmed", "storyboard_draft"].includes(s.stage)) {
                if (s.stage === "collect_brief") {
                  throw new QuickVideoError("BRIEF_NOT_CONFIRMED", "简报尚未经用户确认，请提醒用户在右侧面板确认简报后再生成分镜", s.version);
                }
                throw new QuickVideoError("STAGE_FORBIDDEN", `当前阶段 ${s.stage} 不允许提交分镜`, s.version);
              }
              if (s.storyboard?.status === "confirmed") {
                throw new QuickVideoError("STORYBOARD_LOCKED", "分镜已确认锁定，如需重提请先让用户撤销确认", s.version);
              }

              const shots: QuickVideoShot[] = input.shots.map((shot, i) => ({
                id: `shot-${i + 1}`,
                index: i + 1,
                duration: normalizeShotDuration(shot.duration),
                description: shot.description,
                dialogue: shot.dialogue ?? "",
                camera: shot.camera ?? "",
                imagePrompt: shot.imagePrompt ?? "",
                videoPrompt: shot.videoPrompt ?? "",
                assetRefs: [],
                continuity: (shot as any).continuity ?? "last_frame",
                imageState: "pending",
                videoState: "pending",
                imageRef: null,
                videoRef: null,
                errorReason: null,
                firstFrame: null,
              }));
              const errors = validateStoryboard(s.targetDuration, shots);
              if (errors.length) throw new QuickVideoError("STORYBOARD_INVALID", errors.join("；"), s.version);

              // 首次提交：brief_confirmed -> storyboard_draft（白名单转移）；重复提交保持在 storyboard_draft
              if (s.stage === "brief_confirmed") s.stage = "storyboard_draft";
              s.storyboard = {
                version: (s.storyboard?.version ?? 0) + 1,
                status: "draft",
                confirmedAt: null,
                summary: input.summary ?? "",
                shots,
              };
            },
          );
          if (idempotentHit) return "该次分镜提交已应用过（幂等命中），未重复写入。";
          const total = input.shots.reduce((sum, s) => sum + s.duration, 0);
          return `分镜 v${state.storyboard?.version} 已提交（${input.shots.length} 个镜头，总时长 ${total} 秒）。请向用户概述每镜内容，并提醒用户在右侧面板确认分镜。`;
        }).catch((err) => `提交分镜失败：${describeError(err)}`);
      },
    }),

    update_shot: tool({
      description: "修改单个草稿镜头的字段（画面描述/台词/运镜/时长/资产/连续性策略/生图与生视频提示词）。仅分镜草稿状态可用；镜头 id 与顺序不可改。",
      inputSchema: jsonSchema<{
        shotId: string;
        description?: string;
        dialogue?: string;
        camera?: string;
        duration?: number;
        imagePrompt?: string;
        videoPrompt?: string;
        continuity?: "last_frame" | "assets_only" | "independent";
      }>(
        z
          .object({
            shotId: z.string().min(1).max(40).describe("镜头 ID（如 shot-2）"),
            description: z.string().min(1).max(2000).optional().describe("新的画面描述"),
            dialogue: z.string().max(500).optional().describe("新的台词/旁白"),
            camera: z.string().max(200).optional().describe("新的景别/运镜"),
            duration: z.number().int().min(SHOT_DURATION_MIN).max(SHOT_DURATION_MAX).optional().describe("新的镜头时长（秒）"),
            imagePrompt: z.string().max(2000).optional().describe("新的文生图/首帧提示词（具体视觉描述）"),
            videoPrompt: z.string().max(2000).optional().describe("新的视频提示词（动作/运镜/动态描述）"),
            continuity: z
              .enum(SHOT_CONTINUITY_TYPES)
              .optional()
              .describe("新的跨镜头连续性策略：last_frame=继承上一镜头尾帧 / assets_only=继承人物与道具素材 / independent=独立镜头"),
          })
          .toJSONSchema(),
      ),
      execute: async (input, options) => {
        const { toolCallId } = options as { toolCallId: string };
        return withThinking(msg, `正在修改镜头 ${input.shotId}...`, async () => {
          const { state, idempotentHit } = await mutateQuickVideoState(
            projectId,
            { idempotencyKey: `tool:update_shot:${toolCallId}`, sessionId },
            (s) => {
              if (!s.storyboard || s.storyboard.status !== "draft") {
                throw new QuickVideoError("STORYBOARD_LOCKED", "分镜不存在或已确认锁定，不允许修改镜头", s.version);
              }
              if (s.stage !== "storyboard_draft") {
                throw new QuickVideoError("STAGE_FORBIDDEN", `当前阶段 ${s.stage} 不允许修改镜头`, s.version);
              }
              const shot = findShot(s, input.shotId);
              if (input.description != null) shot.description = input.description;
              if (input.dialogue != null) shot.dialogue = input.dialogue;
              if (input.camera != null) shot.camera = input.camera;
              if (input.duration != null) shot.duration = normalizeShotDuration(input.duration);
              if (input.imagePrompt != null) shot.imagePrompt = input.imagePrompt;
              if (input.videoPrompt != null) shot.videoPrompt = input.videoPrompt;
              if (input.continuity != null) shot.continuity = input.continuity;
            },
          );
          return idempotentHit
            ? "该次镜头修改已应用过（幂等命中），未重复写入。"
            : `镜头 ${input.shotId} 已更新（状态版本 ${state.version}）。`;
        }).catch((err) => `修改镜头失败：${describeError(err)}`);
      },
    }),

    add_shot: tool({
      description: "在分镜草稿末尾追加一个镜头（需给出 imagePrompt/videoPrompt 双提示词）。",
      inputSchema: jsonSchema<{ duration: number; description: string; dialogue: string; camera: string; imagePrompt?: string; videoPrompt?: string; continuity?: "last_frame" | "assets_only" | "independent" }>(
        z
          .object({
            duration: z.number().int().min(SHOT_DURATION_MIN).max(SHOT_DURATION_MAX).describe(`镜头时长（秒）`),
            description: z.string().min(1).max(2000).describe("画面描述"),
            dialogue: z.string().max(500).describe("台词/旁白，可为空字符串"),
            camera: z.string().max(200).describe("景别/运镜"),
            imagePrompt: z.string().max(2000).optional().describe("文生图/首帧提示词（具体视觉描述，建议填写）"),
            videoPrompt: z.string().max(2000).optional().describe("视频提示词（动作/运镜/动态描述，建议填写）"),
            continuity: z
              .enum(SHOT_CONTINUITY_TYPES)
              .optional()
              .default("last_frame")
              .describe("跨镜头连续性策略：last_frame=继承上一镜头尾帧（默认） / assets_only=继承人物与道具素材 / independent=独立镜头"),
          })
          .toJSONSchema(),
      ),
      execute: async (input, options) => {
        const { toolCallId } = options as { toolCallId: string };
        return withThinking(msg, "正在追加镜头...", async () => {
          const { state, idempotentHit } = await mutateQuickVideoState(
            projectId,
            { idempotencyKey: `tool:add_shot:${toolCallId}`, sessionId },
            (s) => {
              if (!s.storyboard || s.storyboard.status !== "draft") {
                throw new QuickVideoError("STORYBOARD_LOCKED", "分镜不存在或已确认锁定，不允许追加镜头", s.version);
              }
              if (s.stage !== "storyboard_draft") {
                throw new QuickVideoError("STAGE_FORBIDDEN", `当前阶段 ${s.stage} 不允许追加镜头`, s.version);
              }
              if (s.storyboard.shots.length >= 12) {
                throw new QuickVideoError("SHOT_COUNT_EXCEEDED", "镜头数量已达上限 12 个", s.version);
              }
              s.storyboard.shots.push({
                id: nextShotId(s),
                index: s.storyboard.shots.length + 1,
                duration: normalizeShotDuration(input.duration),
                description: input.description,
                dialogue: input.dialogue ?? "",
                camera: input.camera ?? "",
                imagePrompt: input.imagePrompt ?? "",
                videoPrompt: input.videoPrompt ?? "",
                assetRefs: [],
                continuity: input.continuity ?? "last_frame",
                imageState: "pending",
                videoState: "pending",
                imageRef: null,
                videoRef: null,
                errorReason: null,
                firstFrame: null,
              });
              reindexShots(s);
            },
          );
          return idempotentHit ? "该次追加已应用过（幂等命中）。" : `镜头已追加（状态版本 ${state.version}）。`;
        }).catch((err) => `追加镜头失败：${describeError(err)}`);
      },
    }),

    remove_shot: tool({
      description: "从分镜草稿中删除一个镜头（至少保留一个）。",
      inputSchema: jsonSchema<{ shotId: string }>(
        z.object({ shotId: z.string().min(1).max(40).describe("镜头 ID（如 shot-3）") }).toJSONSchema(),
      ),
      execute: async (input, options) => {
        const { toolCallId } = options as { toolCallId: string };
        return withThinking(msg, `正在删除镜头 ${input.shotId}...`, async () => {
          const { state, idempotentHit } = await mutateQuickVideoState(
            projectId,
            { idempotencyKey: `tool:remove_shot:${toolCallId}`, sessionId },
            (s) => {
              if (!s.storyboard || s.storyboard.status !== "draft") {
                throw new QuickVideoError("STORYBOARD_LOCKED", "分镜不存在或已确认锁定，不允许删除镜头", s.version);
              }
              if (s.stage !== "storyboard_draft") {
                throw new QuickVideoError("STAGE_FORBIDDEN", `当前阶段 ${s.stage} 不允许删除镜头`, s.version);
              }
              findShot(s, input.shotId);
              if (s.storyboard.shots.length <= 1) {
                throw new QuickVideoError("SHOT_LAST_ONE", "至少保留一个镜头", s.version);
              }
              s.storyboard.shots = s.storyboard.shots.filter((x) => x.id !== input.shotId);
              reindexShots(s);
            },
          );
          return idempotentHit ? "该次删除已应用过（幂等命中）。" : `镜头 ${input.shotId} 已删除（状态版本 ${state.version}）。`;
        }).catch((err) => `删除镜头失败：${describeError(err)}`);
      },
    }),

    bind_asset: tool({
      description: "为某个镜头绑定资产引用（角色/场景/道具，含视觉描述），用于后续生成提示词。仅分镜草稿状态可用。",
      inputSchema: jsonSchema<{ shotId: string; assets: { type: "role" | "scene" | "tool"; name: string; desc: string }[] }>(
        z
          .object({
            shotId: z.string().min(1).max(40).describe("镜头 ID（如 shot-1）"),
            assets: z.array(shotAssetRefSchema).min(1).max(10).describe("要绑定到该镜头的资产列表"),
          })
          .toJSONSchema(),
      ),
      execute: async (input, options) => {
        const { toolCallId } = options as { toolCallId: string };
        return withThinking(msg, `正在为镜头 ${input.shotId} 绑定资产...`, async () => {
          const { state, idempotentHit } = await mutateQuickVideoState(
            projectId,
            { idempotencyKey: `tool:bind_asset:${toolCallId}`, sessionId },
            (s) => {
              if (!s.storyboard || s.storyboard.status !== "draft") {
                throw new QuickVideoError("STORYBOARD_LOCKED", "分镜不存在或已确认锁定，不允许绑定资产", s.version);
              }
              if (s.stage !== "storyboard_draft") {
                throw new QuickVideoError("STAGE_FORBIDDEN", `当前阶段 ${s.stage} 不允许绑定资产`, s.version);
              }
              const shot = findShot(s, input.shotId);
              // 按 type+name 去重合并，保留已有绑定
              const merged = new Map(shot.assetRefs.map((a) => [`${a.type}:${a.name}`, a] as const));
              for (const asset of input.assets) {
                merged.set(`${asset.type}:${asset.name}`, { type: asset.type, name: asset.name, desc: asset.desc ?? "" });
              }
              shot.assetRefs = Array.from(merged.values()).slice(0, 10);
            },
          );
          return idempotentHit ? "该次绑定已应用过（幂等命中）。" : `镜头 ${input.shotId} 资产绑定已更新（状态版本 ${state.version}）。`;
        }).catch((err) => `绑定资产失败：${describeError(err)}`);
      },
    }),

    bind_shot_first_frame: tool({
      description:
        "把一张图片绑定为某个草稿镜头的首帧（图生视频起点）。优先用占位符编号：用户说「镜头1：##图1##」时传 slot=1（服务端已把 ##图1## 映射到对应图片）；仅在用户给出明确 mediaId 时才用 mediaId 参数。仅分镜草稿状态可用。",
      inputSchema: jsonSchema<{ shotId: string; slot?: number; mediaId?: number }>(
        z
          .object({
            shotId: z.string().min(1).max(40).describe("镜头 ID（如 shot-1）"),
            slot: z.number().int().min(1).max(4).optional().describe("占位符编号：##图N## 中的 N（推荐，服务端负责映射到真实媒体）"),
            mediaId: z.number().int().positive().optional().describe("图片 mediaId（仅当用户消息中明确给出时使用，不要凭空编造）"),
          })
          .toJSONSchema(),
      ),
      execute: async (input, options) => {
        const { toolCallId } = options as { toolCallId: string };
        return withThinking(msg, `正在为镜头 ${input.shotId} 绑定首帧...`, async () => {
          const mediaId = input.slot != null ? resolveSlotMediaId(toolConfig, input.slot) : (input.mediaId ?? null);
          if (mediaId == null) {
            const reason =
              input.slot != null
                ? `占位符 ##图${input.slot}## 没有对应的引用图片：请提醒用户先把图片粘贴/上传到聊天框附件托盘，或直接选中一张图片后再发送`
                : "缺少首帧图片：请提醒用户在聊天框附件托盘放入图片（用 ##图1## 等占位符引用），或选中一张图片后发送";
            throw new QuickVideoError("MEDIA_NOT_FOUND", reason);
          }

          const { state, idempotentHit } = await mutateQuickVideoState(
            projectId,
            { idempotencyKey: `tool:bind_first_frame:${toolCallId}`, sessionId },
            async (s) => {
              if (!s.storyboard || s.storyboard.status !== "draft") {
                throw new QuickVideoError("STORYBOARD_LOCKED", "分镜不存在或已确认锁定，不允许绑定首帧", s.version);
              }
              if (s.stage !== "storyboard_draft") {
                throw new QuickVideoError("STAGE_FORBIDDEN", `当前阶段 ${s.stage} 不允许绑定首帧`, s.version);
              }
              const shot = findShot(s, input.shotId);
              const { assetId, imageId } = await resolveMediaForFirstFrame(projectId, mediaId);
              shot.firstFrame = { mediaId, assetId, imageId, boundAt: Date.now() };
              // 与 REST bindShotFirstFrame 一致：首帧变化后强制下一次生成重建快照
              s.generation.snapshot = null;
              s.generation.materialsConfirmed = false;
              s.generation.materialsConfirmedAt = null;
            },
          );
          return idempotentHit
            ? "该次首帧绑定已应用过（幂等命中）。"
            : `镜头 ${input.shotId} 首帧已绑定成功（mediaId ${mediaId}，状态版本 ${state.version}）。`;
        }).catch((err) => `绑定首帧失败：${describeError(err)}`);
      },
    }),

    // ---------------------------------------------------------------------------
    // 确认类工具（SIY-152）：聊天确认 = 点按钮确认。
    // 统一模式：先读状态（无副作用）→ 幂等键预检 → 阶段前置校验（复用 lib 门内核，
    // 拦截文案与按钮 toast 同语义）→ 以当前 state.version 为 expectedVersion、
    // tool:<toolName>:<toolCallId> 为幂等键，在事务内执行与 REST confirmStage 相同的内核。
    // ---------------------------------------------------------------------------

    confirm_brief: tool({
      description:
        "确认简报（等同右侧面板「确认简报」按钮）：用户在聊天中明确说「确认简报」「简报没问题」等时调用。确认后简报进入已确认状态，随后即可提交分镜。不在可确认阶段（如已开始生成）时会被服务端拦截并返回原因。",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
      execute: async (_input, options) => {
        const { toolCallId } = options as { toolCallId: string };
        const idempotencyKey = `tool:confirm_brief:${toolCallId}`;
        return withThinking(msg, "正在确认简报...", async () => {
          const current = await loadQuickVideoState(projectId);
          if (!current) return "未找到工作台状态，请先创建 quick_video 项目。";
          if (current.appliedKeys[idempotencyKey] != null) {
            return "该次简报确认已应用过（幂等命中），未重复写入。";
          }
          if (!current.brief) {
            return "当前还没有简报可确认：请先让我把你的创意整理成结构化简报（save_brief），确认内容后再确认简报。";
          }
          try {
            assertBriefGate(current, "confirm");
          } catch (err) {
            if (err instanceof QuickVideoError && err.code === "STAGE_MISMATCH") {
              return `现在不能确认简报：${err.message}。如需调整分镜或生成内容，直接告诉我即可。`;
            }
            throw err;
          }
          const { state, idempotentHit } = await mutateQuickVideoState(
            projectId,
            { expectedVersion: current.version, idempotencyKey, sessionId },
            (s) => applyBriefGate(s, "confirm"),
          );
          if (idempotentHit) return "该次简报确认已应用过（幂等命中），未重复写入。";
          const storyboardHint = state.storyboard
            ? "当前已有一版分镜，如需继续打磨分镜，请让我基于最新简报重新提交一版分镜。"
            : "接下来我会根据简报与目标时长设计分镜，你也可以直接告诉我想调整的内容。";
          return `好的，已为您确认简报（状态版本 ${state.version}）。${storyboardHint}`;
        }).catch((err) => `确认简报失败：${describeError(err)}`);
      },
    }),

    reject_brief: tool({
      description:
        "简报返回修改（等同右侧简报「返回修改」按钮）：用户在简报已确认后说「返回修改」「简报要改」等时调用，简报退回未确认状态。仅在简报收集/简报已确认阶段可用；分镜打磨阶段想改简报请直接修改简报内容（save_brief），不要调用本工具。",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
      execute: async (_input, options) => {
        const { toolCallId } = options as { toolCallId: string };
        const idempotencyKey = `tool:reject_brief:${toolCallId}`;
        return withThinking(msg, "正在退回简报...", async () => {
          const current = await loadQuickVideoState(projectId);
          if (!current) return "未找到工作台状态，请先创建 quick_video 项目。";
          if (current.appliedKeys[idempotencyKey] != null) {
            return "该次简报退回已应用过（幂等命中），未重复写入。";
          }
          if (!current.brief) {
            return "当前还没有简报，无需退回：请直接告诉我你的创意，我来整理成简报。";
          }
          try {
            assertBriefGate(current, "reject");
          } catch (err) {
            if (err instanceof QuickVideoError && err.code === "STAGE_MISMATCH") {
              return `现在不能退回简报：${err.message}。你可以直接告诉我要改的简报内容，我会更新并请你重新确认。`;
            }
            throw err;
          }
          const { state, idempotentHit } = await mutateQuickVideoState(
            projectId,
            { expectedVersion: current.version, idempotencyKey, sessionId },
            (s) => applyBriefGate(s, "reject"),
          );
          if (idempotentHit) return "该次简报退回已应用过（幂等命中），未重复写入。";
          return `好的，简报已退回收集阶段，确认状态已清除（状态版本 ${state.version}）。请告诉我要调整简报的哪些内容，我来更新后请你重新确认。`;
        }).catch((err) => `退回简报失败：${describeError(err)}`);
      },
    }),

    confirm_storyboard: tool({
      description:
        "确认分镜（等同右侧面板「确认分镜」按钮）：用户在聊天中明确说「确认分镜」「分镜就这样定」等时调用。服务端校验镜头数量与总时长，通过后锁定分镜、冻结生成参数快照，并在聊天流自动回显最终参数确认卡片。仅分镜草稿阶段可用。",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
      execute: async (_input, options) => {
        const { toolCallId } = options as { toolCallId: string };
        const idempotencyKey = `tool:confirm_storyboard:${toolCallId}`;
        return withThinking(msg, "正在确认分镜...", async () => {
          const current = await loadQuickVideoState(projectId);
          if (!current) return "未找到工作台状态，请先创建 quick_video 项目。";
          if (current.appliedKeys[idempotencyKey] != null) {
            return "该次分镜确认已应用过（幂等命中），未重复写入。";
          }
          if (!current.storyboard) {
            return "当前还没有分镜可确认：请先让我提交一版完整分镜（propose_storyboard）。";
          }
          try {
            assertStoryboardGate(current, "confirm");
          } catch (err) {
            if (err instanceof QuickVideoError && err.code === "STAGE_MISMATCH") {
              return `现在不能确认分镜：${err.message}。分镜只能草稿状态确认；若已确认后想调整，请说「返回修改」，我来撤销确认。`;
            }
            throw err;
          }
          // 预校验分镜有效性，把可修复的原因直接给到 Agent（权威校验在事务内同款内核再做一次）
          const errors = validateStoryboard(current.targetDuration, current.storyboard.shots);
          if (errors.length) {
            return `分镜还未达到确认条件：${errors.join("；")}。请让我先调整分镜（镜头数量或每镜时长），调整好后再确认。`;
          }
          const { state, idempotentHit } = await mutateQuickVideoState(
            projectId,
            { expectedVersion: current.version, idempotencyKey, sessionId },
            (s) => applyStoryboardGate(projectId, s, "confirm"),
          );
          if (idempotentHit) return "该次分镜确认已应用过（幂等命中），未重复写入。";
          const shots = state.storyboard!.shots;
          const total = shots.reduce((sum, s) => sum + s.duration, 0);
          return `好的，分镜 v${state.storyboard!.version} 已为您确认（${shots.length} 个镜头，总时长 ${total} 秒，状态版本 ${state.version}）。系统已在聊天流回显最终生成参数确认卡片：时长、画风、分镜数量确认无误后回复「开始生成」，我就启动逐镜头生成管道；想调整分镜就说「返回修改」。`;
        }).catch((err) => `确认分镜失败：${describeError(err)}`);
      },
    }),

    reject_storyboard: tool({
      description:
        "撤销分镜确认/分镜返回修改（等同最终参数卡片「返回修改」按钮）：用户在分镜已确认后说「返回修改」「撤销分镜确认」等时调用，分镜回到草稿状态解锁编辑。仅分镜已确认阶段可用。",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
      execute: async (_input, options) => {
        const { toolCallId } = options as { toolCallId: string };
        const idempotencyKey = `tool:reject_storyboard:${toolCallId}`;
        return withThinking(msg, "正在撤销分镜确认...", async () => {
          const current = await loadQuickVideoState(projectId);
          if (!current) return "未找到工作台状态，请先创建 quick_video 项目。";
          if (current.appliedKeys[idempotencyKey] != null) {
            return "该次撤销分镜确认已应用过（幂等命中），未重复写入。";
          }
          if (!current.storyboard) {
            return "当前还没有分镜，无需撤销确认：请先让我提交一版完整分镜（propose_storyboard）。";
          }
          try {
            assertStoryboardGate(current, "reject");
          } catch (err) {
            if (err instanceof QuickVideoError && err.code === "STAGE_MISMATCH") {
              const hint = current.stage === "storyboard_draft" ? "分镜还是草稿，可直接告诉我要调整的镜头内容。" : "";
              return `现在不需要撤销分镜确认：${err.message}。${hint}`;
            }
            throw err;
          }
          const { state, idempotentHit } = await mutateQuickVideoState(
            projectId,
            { expectedVersion: current.version, idempotencyKey, sessionId },
            (s) => applyStoryboardGate(projectId, s, "reject"),
          );
          if (idempotentHit) return "该次撤销分镜确认已应用过（幂等命中），未重复写入。";
          return `好的，已撤销分镜确认，分镜回到草稿状态（状态版本 ${state.version}）。请告诉我要调整哪些镜头，我来修改；调整好后说「确认分镜」即可重新锁定。`;
        }).catch((err) => `撤销分镜确认失败：${describeError(err)}`);
      },
    }),

    get_generation_status: tool({
      description: "查询各镜头图片/视频生成状态（用于向用户汇报生成进度或定位失败镜头）。",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
      execute: async () => {
        const state = await loadQuickVideoState(projectId);
        if (!state?.storyboard) return "暂无分镜";
        return JSON.stringify(
          state.storyboard.shots.map((s) => ({
            shotId: s.id,
            index: s.index,
            continuity: s.continuity ?? "last_frame",
            imageState: s.imageState,
            videoState: s.videoState,
            errorReason: s.errorReason,
          })),
          null,
          2,
        );
      },
    }),

    retry_shot: tool({
      description:
        "重试生成失败的镜头（等同右侧面板「重试该镜头 / 重试全部失败镜头」按钮）：仅生成（generating）阶段可用。用户说「重试镜头2」时传 [\"shot-2\"]（「镜头N」对应 shot-N）；说「重试全部失败镜头」时不传 shotIds，缺省重置全部失败镜头。已完成的镜头不会被重置。",
      inputSchema: jsonSchema<{ shotIds?: string[] }>(
        z
          .object({
            shotIds: z
              .array(z.string().min(1).max(40))
              .min(1)
              .max(12)
              .optional()
              .describe("要重试的镜头 ID 列表（如 [\"shot-2\"]，用户说的「镜头2」对应 \"shot-2\"）；不传时重试全部失败镜头"),
          })
          .toJSONSchema(),
      ),
      execute: async (input, options) => {
        const { toolCallId } = options as { toolCallId: string };
        const idempotencyKey = `tool:retry_shot:${toolCallId}`;
        return withThinking(msg, "正在重试失败镜头...", async () => {
          const current = await loadQuickVideoState(projectId);
          if (!current) return "未找到工作台状态，请先创建 quick_video 项目。";
          if (current.appliedKeys[idempotencyKey] != null) {
            return "该次重试请求已应用过（幂等命中），未重复发起；可调用 get_generation_status 查询进度后向用户汇报。";
          }
          try {
            // 前置解析重试目标（阶段白名单 + 缺省全部失败镜头），权威校验与任务重建在 retryQuickVideoShots 内
            const shotIds = pickRetryShotIds(current, input.shotIds);
            // 复用 REST /quickVideo/retryShot 的同一内核；与按钮同口径，不校验 expectedVersion
            // （生成链路会并发回写镜头状态，重试是显式新动作，幂等由 toolCallId 键去重重放）
            const result = await retryQuickVideoShots(projectId, userId, shotIds, sessionId, idempotencyKey);
            if (result.idempotentHit) {
              return "该次重试请求已应用过（幂等命中），未重复发起；可调用 get_generation_status 查询进度后向用户汇报。";
            }
            return `已为 ${result.retried.length} 个镜头重新发起生成（运行 ${result.runId}）：${result.retried.join("、")}。已完成的镜头不受影响，可调用 get_generation_status 跟踪进度并向用户汇报。`;
          } catch (err) {
            if (err instanceof QuickVideoError) {
              if (err.code === "NO_FAILED_SHOTS") {
                return `当前没有失败镜头，无需重试。${current.stage === "generating" ? "生成仍在进行中，可调用 get_generation_status 查询进度后向用户汇报。" : ""}`;
              }
              if (err.code === "STAGE_MISMATCH") {
                const hint = ["storyboard_draft", "storyboard_confirmed"].includes(current.stage)
                  ? "分镜尚未开始生成；用户想生成时回复「开始生成」即可启动管道。"
                  : ["ready_to_assemble", "completed"].includes(current.stage)
                    ? "全部镜头已生成完毕，无需重试；请提醒用户在右侧预览面板查看并导出 MP4。"
                    : "进入生成阶段后才能重试失败镜头。";
                return `现在不能重试：${err.message}。${hint}`;
              }
              if (err.code === "GENERATION_RUNNING") {
                return `整批镜头正在生成中，暂不能单独重试失败镜头：${err.message}。我会用 get_generation_status 跟踪进度，整批结束后再重试失败镜头。`;
              }
              if (err.code === "SHOT_RUNNING") {
                return `${err.message}。等该镜头出结果后再看是否需要重试。`;
              }
              if (err.code === "SHOT_ALREADY_DONE") {
                return `用户想重试的镜头其实已生成完成，无需重试：${err.message}。可调用 get_generation_status 确认各镜头状态后向用户说明。`;
              }
              if (err.code === "MATERIALS_NOT_CONFIRMED") {
                return `最终生成参数尚未确认，不能重试：${err.message}`;
              }
            }
            throw err;
          }
        }).catch((err) => `重试镜头失败：${describeError(err)}`);
      },
    }),

    generate_shots: tool({
      description:
        "一键启动分镜生成管道（自动通过分镜确认门与最终参数确认门）：逐镜头生成分镜图 + 5-15 秒视频片段，完成后系统自动装配时间线，用户在右侧预览面板查看成片。仅在用户聊天中明确要求生成/开始制作（如「开始生成」「按这个做」「生成全部镜头」）时调用；用户还在讨论修改方案时严禁调用。分镜草稿状态调用会自动确认当前分镜并冻结生成快照；生成中重复调用返回当前进度（幂等）。",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
      execute: async (_input, options) => {
        const { toolCallId } = options as { toolCallId: string };
        return withThinking(msg, "正在启动生成管道...", async () => {
          const state = await loadQuickVideoState(projectId);
          if (!state) return "未找到工作台状态，请先创建 quick_video 项目";

          if (state.stage === "ready_to_assemble" || state.stage === "completed") {
            return "所有镜头已生成完毕，成片已在右侧预览面板就绪；如需成片请提醒用户在预览面板导出 MP4。";
          }

          if (state.stage === "generating") {
            // 阶段已就绪但没有任何运行在跑（如服务重启后的遗留）：幂等重启
            const { started, alreadyRunning, runId } = await startQuickVideoGeneration(projectId, userId, sessionId);
            if (started) {
              return `检测到上次生成中断，已重新启动生成（运行 ${runId}）。右侧面板会实时展示各镜头进度；失败镜头可单独重试。`;
            }
            if (alreadyRunning) {
              return `生成正在进行中（运行 ${runId}），无需重复启动。可调用 get_generation_status 查询镜头级进度后向用户汇报。`;
            }
          }

          if (state.stage === "storyboard_draft" || state.stage === "storyboard_confirmed") {
            if (!state.storyboard) return "当前没有分镜：请先用 propose_storyboard 提交一版分镜，再启动生成。";

            let shouldStart = false;
            await mutateQuickVideoState(
              projectId,
              { idempotencyKey: `tool:generate_shots:${toolCallId}`, sessionId },
              async (s) => {
                if (!s.storyboard) throw new QuickVideoError("NO_STORYBOARD", "暂无分镜", s.version);

                // 分镜草稿 -> 自动通过分镜确认门（用户在聊天中的生成请求即确认意向）
                if (s.storyboard.status === "draft") {
                  if (s.stage !== "storyboard_draft") {
                    throw new QuickVideoError("STAGE_MISMATCH", `当前阶段 ${s.stage} 不允许确认分镜`, s.version);
                  }
                  const errors = validateStoryboard(s.targetDuration, s.storyboard.shots);
                  if (errors.length) throw new QuickVideoError("STORYBOARD_INVALID", errors.join("；"), s.version);
                  s.stage = "storyboard_confirmed";
                  s.storyboard.status = "confirmed";
                  s.storyboard.confirmedAt = Date.now();
                }

                if (s.stage !== "storyboard_confirmed" && s.stage !== "generating") {
                  throw new QuickVideoError("STAGE_MISMATCH", `当前阶段 ${s.stage} 无法启动生成`, s.version);
                }
                // 最终参数确认门：聊天生成请求视为已确认（快照缺失或版本变化时现场重建）
                const needResolve = !s.generation?.snapshot || s.generation.snapshot.storyboardVersion !== s.storyboard.version;
                if (needResolve) {
                  const { materials, snapshotShots } = await buildSnapshot(projectId, s);
                  applySnapshotToState(s, s.storyboard.version, snapshotShots, materials);
                }
                if (!s.generation.snapshot) {
                  throw new QuickVideoError("SNAPSHOT_FAILED", "生成参数快照组装失败，无法开始生成", s.version);
                }
                s.generation.materialsConfirmed = true;
                s.generation.materialsConfirmedAt = Date.now();
                s.generation.startedAt = Date.now();
                s.generation.finishedAt = null;
                s.stage = "generating";
                shouldStart = true;
              },
            );

            if (shouldStart) {
              try {
                const start = await startQuickVideoGeneration(projectId, userId, sessionId);
                if (start.started) {
                  return `生成管道已启动（运行 ${start.runId}），系统将按分镜顺序逐镜头生成分镜图与视频片段。右侧预览面板会实时展示进度，全部完成后自动装配时间线供预览与导出。`;
                }
                if (start.alreadyRunning) {
                  return `生成正在进行中（运行 ${start.runId}），无需重复启动。请用 get_generation_status 查询进度并向用户汇报。`;
                }
              } catch (err: any) {
                console.error(`[quickVideo] 项目 ${projectId} Agent 启动生成管道失败:`, u.error(err as Error).message);
                return `生成已确认但启动失败：${describeError(err)}。请提醒用户稍后在聊天中重新发送「开始生成」即可幂等重启。`;
              }
            }

            return `生成确认已通过（状态版本 ${state.version}）。系统已进入生成阶段，可调用 get_generation_status 查询各镜头进度。`;
          }

          return `当前阶段 ${state.stage} 还不能开始生成：请先保存简报并提交分镜（propose_storyboard），再启动生成管道。`;
        }).catch((err) => `启动生成失败：${describeError(err)}`);
      },
    }),
  };

  // 仅当本轮 socket 已校验通过 imageModel 时才对 Agent 暴露该工具：mode=text 的普通
  // 对话轮次不应该、也不能触发图片生成（见 socket/routes/quickVideoAgent.ts 的服务端校验）。
  if (toolConfig.imageModel) {
    const imageModel = toolConfig.imageModel;
    tools.generate_image = tool({
      description:
        "在当前聊天会话中生成一张图片（默认文生图；用户消息带 ##图N## 占位符或明确指定引用图时自动转为图生图/垫图）。生成成功会自动出现在聊天记录和资产白板中，" +
        "但不会绑定到任何镜头、不会修改分镜——绑定镜头首帧请用 bind_shot_first_frame 工具。",
      inputSchema: jsonSchema<{ prompt: string; referenceMediaIds?: number[]; referenceSlots?: number[] }>(
        z
          .object({
            prompt: z.string().min(1).max(2000).describe("图片生成提示词（画面描述，尽量具体：主体、构图、风格、光影）；请剔除 ##图N## 占位符本身，不要把它写进提示词"),
            referenceMediaIds: z
              .array(z.number().int().positive())
              .max(4)
              .optional()
              .describe("引用媒体的 mediaId 列表（图生图参考），只能是用户在本轮聊天中明确选中的引用，不要凭空编造 id"),
            referenceSlots: z
              .array(z.number().int().min(1).max(4))
              .max(4)
              .optional()
              .describe("占位符编号列表（如 [1] 表示 ##图1##）；用户消息中提到 ##图N## 时优先传编号"),
          })
          .toJSONSchema(),
      ),
      execute: async (input, options) => {
        const { toolCallId } = options as { toolCallId: string };
        return withThinking(msg, "正在生成图片...", async () => {
          const project = await u.db("o_project").where("id", projectId).select("videoRatio").first();
          const aspectRatio = (project?.videoRatio || "16:9") as `${number}:${number}`;

          const { media, idempotentHit } = await createChatMedia({
            projectId,
            sessionId,
            messageId: msg.id,
            kind: "image",
            model: imageModel,
            prompt: input.prompt,
            source: "chat",
            idempotencyKey: `tool:generate_image:${toolCallId}`,
          });
          if (idempotentHit) {
            if (media.state === "done") return "该次图片生成请求已处理过（幂等命中），图片已在聊天记录和资产白板中。";
            if (media.state === "failed") return `该次图片生成请求已处理过（幂等命中），生成失败：${media.errorReason ?? "未知原因"}`;
            return "该次图片生成请求正在处理中（幂等命中），请稍候查看聊天记录或资产白板。";
          }

          // 参考图解析优先级：显式 mediaId > 显式占位符编号 > 用户消息占位符（确定性回退）；
          // 全部落空时保持纯文生图。单张参考图失效只跳过该图，不阻断本次生成。
          const slotSource = input.referenceSlots?.length ? input.referenceSlots : (toolConfig.placeholderSlots ?? []);
          const slotIds = slotSource.map((slot) => resolveSlotMediaId(toolConfig, slot)).filter((id): id is number => id != null);
          const mediaIds = input.referenceMediaIds?.length ? input.referenceMediaIds : slotIds;
          const referenceIds = mediaIds.slice(0, 4);
          const referenceList: { type: "image"; base64: string }[] = [];
          for (const refId of referenceIds) {
            try {
              referenceList.push({ type: "image", base64: await resolveMediaImageBase64(projectId, refId) });
            } catch {
              // 单张参考图失效不阻断本次生成，退化为纯文本提示词
            }
          }
          const droppedRefs = referenceIds.length - referenceList.length;

          try {
            const imageCls = u.Ai.Image(imageModel as `${string}:${string}`, userId);
            await imageCls.run(
              { prompt: input.prompt, referenceList, size: "1K", aspectRatio },
              {
                taskClass: "快创聊天生图",
                describe: `聊天生图${referenceList.length ? "（图生图）" : ""}：${input.prompt.slice(0, 100)}`,
                relatedObjects: JSON.stringify({ projectId, sessionId, mediaId: media.id }),
                projectId,
              },
            );
            const savePath = `/${projectId}/quickVideo/chat-${u.uuid().slice(0, 8)}.jpg`;
            await imageCls.save(savePath);
            await markChatMediaDone(media.id, savePath);

            const url = await u.oss.getFileUrl(savePath);
            msg.image(
              { name: input.prompt.slice(0, 60), url },
              { mediaId: media.id, assetId: media.assetId, imageId: media.imageId, kind: "image", model: imageModel, promptSummary: input.prompt.slice(0, 200), state: "done", source: "chat" },
            );
            const modeText = referenceList.length ? `已按${referenceList.length}张参考图做图生图${droppedRefs ? `（${droppedRefs}张参考图失效已跳过）` : ""}` : "纯文生图";
            return `图片已生成并加入聊天记录与资产白板（mediaId ${media.id}，${modeText}）。提醒用户：如需用作某个镜头的首帧，可以在聊天中告诉我「把这张图设为镜头N首帧」，或在右侧分镜表手动绑定。`;
          } catch (err) {
            const reason = describeError(err);
            await markChatMediaFailed(media.id, reason);
            return `图片生成失败：${reason}。可以请用户换一个描述或换一个图片模型后重新发送。`;
          }
        }).catch((err) => `图片生成失败：${describeError(err)}`);
      },
    });
  }

  // 仅当本轮 socket 已校验通过 videoModel 时才对 Agent 暴露该工具（SIY-134；SIY-151 放开纯文生视频）。
  if (toolConfig.videoModel) {
    const videoModel = toolConfig.videoModel;
    tools.generate_video = tool({
      description:
        "在当前聊天会话中生成一段视频（支持纯文生视频；带 ##图1## 时以该图为首帧；带 ##图1## ##图2## 时生成首尾帧过渡视频，模型不支持时自动退化为首帧模式）。生成成功会自动出现在聊天记录和资产白板中，" +
        "但不会绑定到任何镜头、不会修改分镜——绑定镜头首帧请用 bind_shot_first_frame 工具。",
      inputSchema: jsonSchema<{ prompt: string; referenceSlots?: number[]; referenceMediaIds?: number[]; duration?: number }>(
        z
          .object({
            prompt: z.string().min(1).max(2000).describe("视频生成提示词（画面内容、动作、运镜、氛围，尽量具体）；请剔除 ##图N## 占位符本身，不要把它写进提示词"),
            referenceSlots: z
              .array(z.number().int().min(1).max(4))
              .max(2)
              .optional()
              .describe("占位符编号列表（按顺序）：1 个表示首帧参考图，2 个表示首尾帧过渡视频；用户消息中提到 ##图N## 时优先传编号"),
            referenceMediaIds: z
              .array(z.number().int().positive())
              .max(2)
              .optional()
              .describe("参考图 mediaId 列表（第 1 个为首帧，第 2 个为尾帧），只能是用户明确选中的引用，不要凭空编造 id"),
            duration: z
              .number()
              .int()
              .min(SHOT_DURATION_MIN)
              .max(SHOT_DURATION_MAX)
              .optional()
              .describe(`视频时长（秒），${SHOT_DURATION_MIN}-${SHOT_DURATION_MAX}，未提供时默认 ${SHOT_DURATION_MIN} 秒`),
          })
          .toJSONSchema(),
      ),
      execute: async (input, options) => {
        const { toolCallId } = options as { toolCallId: string };
        return withThinking(msg, "正在生成视频...", async () => {
          // 参考图解析优先级：显式 mediaId > 显式占位符编号 > 用户消息占位符（确定性回退）
          const slotSource = input.referenceSlots?.length ? input.referenceSlots : (toolConfig.placeholderSlots ?? []);
          const slotIds = slotSource.map((slot) => resolveSlotMediaId(toolConfig, slot)).filter((id): id is number => id != null);
          const referenceIds = (input.referenceMediaIds?.length ? input.referenceMediaIds : slotIds).slice(0, 2);

          // 纯文生视频守门：目录明确声明不支持 text 模式时提前拦截，避免必然失败的供应商调用
          if (!referenceIds.length) {
            try {
              if (!(await videoModelSupportsTextToVideo(videoModel))) {
                return `视频生成失败：所选视频模型「${videoModel.split(":").pop()}」不支持纯文字生视频。请提醒用户改在聊天框附带一张图片（用 ##图1## 引用）作为首帧，或更换视频模型后重试。`;
              }
            } catch (err) {
              return `视频生成失败：${describeError(err)}`;
            }
          }

          const project = await u.db("o_project").where("id", projectId).select("videoRatio").first();
          const aspectRatio = castAspectRatio((project?.videoRatio || "16:9") as QuickVideoRatio);
          const duration = input.duration ?? SHOT_DURATION_MIN;

          const { media, idempotentHit } = await createChatMedia({
            projectId,
            sessionId,
            messageId: msg.id,
            kind: "video",
            model: videoModel,
            prompt: input.prompt,
            source: "chat",
            idempotencyKey: `tool:generate_video:${toolCallId}`,
          });
          if (idempotentHit) {
            if (media.state === "done") return "该次视频生成请求已处理过（幂等命中），视频已在聊天记录和资产白板中。";
            if (media.state === "failed") return `该次视频生成请求已处理过（幂等命中），生成失败：${media.errorReason ?? "未知原因"}`;
            return "该次视频生成请求正在处理中（幂等命中），请稍候查看聊天记录或资产白板。";
          }

          // 解析参考图为 Base64；单张失效只降级（首尾帧 -> 首帧 -> 纯文本），不直接失败
          const imageBase64List: string[] = [];
          for (const refId of referenceIds) {
            try {
              imageBase64List.push(await resolveMediaImageBase64(projectId, refId));
            } catch (err) {
              await markChatMediaFailed(media.id, `参考图 ${refId} 无效：${describeError(err)}`);
              return `视频生成失败：参考图无效（${describeError(err)}）。请提醒用户重新选择一张已生成完成的图片作为参考后再试。`;
            }
          }

          // 输入模式决策：0 图=纯文本；1 图=首帧；2 图=首尾帧（目录未声明支持时退化为首帧）
          let mode: ("text" | "singleImage" | "startEndRequired" | "endFrameOptional" | "startFrameOptional")[] = ["text"];
          let degradedNote = "";
          if (imageBase64List.length === 1) {
            try {
              await assertVideoSupportsSingleImage(videoModel, false);
              mode = ["singleImage"];
            } catch (err) {
              await markChatMediaFailed(media.id, describeError(err));
              return `视频生成失败：${describeError(err)}`;
            }
          } else if (imageBase64List.length >= 2) {
            const startEndMode = await resolveVideoStartEndMode(videoModel);
            if (startEndMode) {
              mode = [startEndMode];
            } else {
              mode = ["singleImage"];
              imageBase64List.length = 1;
              degradedNote = "（该视频模型未声明支持首尾帧过渡，已自动退化为仅用首帧）";
            }
          }

          try {
            const videoAi = u.Ai.Video(videoModel as `${string}:${string}`, userId);
            await videoAi.run(
              {
                prompt: input.prompt,
                referenceList: imageBase64List.map((base64) => ({ type: "image" as const, base64 })),
                mode: mode as any,
                duration,
                aspectRatio,
                resolution: "720p",
              },
              {
                taskClass: "快创聊天生视频",
                describe: `聊天生视频：${input.prompt.slice(0, 100)}`,
                relatedObjects: JSON.stringify({ projectId, sessionId, mediaId: media.id }),
                projectId,
              },
            );
            const savePath = `/${projectId}/quickVideo/chat-${u.uuid().slice(0, 8)}.mp4`;
            await videoAi.save(savePath);
            await markChatMediaDone(media.id, savePath);

            const url = await u.oss.getFileUrl(savePath);
            msg.video(
              { name: input.prompt.slice(0, 60), url },
              { mediaId: media.id, assetId: media.assetId, videoId: media.videoId, kind: "video", model: videoModel, promptSummary: input.prompt.slice(0, 200), state: "done", source: "chat" },
            );
            const modeText = imageBase64List.length >= 2 ? "首尾帧过渡" : imageBase64List.length === 1 ? "以参考图为首帧" : "纯文生视频";
            return `视频已生成并加入聊天记录与资产白板（mediaId ${media.id}，${modeText}）${degradedNote}。提醒用户：如需把视频/图片用于某个镜头，可以在聊天中告诉我，或在右侧分镜表手动绑定。`;
          } catch (err) {
            const reason = describeError(err);
            await markChatMediaFailed(media.id, reason);
            return `视频生成失败：${reason}。可以请用户换一个描述、换一张参考图或换一个视频模型后重新发送。`;
          }
        }).catch((err) => `视频生成失败：${describeError(err)}`);
      },
    });
  }

  return tools;
};
