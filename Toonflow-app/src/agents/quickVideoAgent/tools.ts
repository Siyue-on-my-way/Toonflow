import { tool, jsonSchema, Tool } from "ai";
import { z } from "zod";
import u from "@/utils";
import ResTool from "@/socket/resTool";
import { loadQuickVideoState, mutateQuickVideoState, QuickVideoError } from "@/lib/quickVideo/state";
import {
  QUICK_VIDEO_DURATION_MAX,
  QUICK_VIDEO_DURATION_MIN,
  QuickVideoShot,
  QuickVideoRatio,
  QUICK_VIDEO_RATIOS,
  SHOT_DURATION_MAX,
  SHOT_DURATION_MIN,
  bumpConfigVersion,
  shotAssetRefSchema,
  shotCountBounds,
  validateStoryboard,
} from "@/lib/quickVideo/contract";
import { findShot, nextShotId, normalizeShotDuration, reindexShots } from "@/lib/quickVideo/shots";
import { startQuickVideoGeneration, assertVideoSupportsSingleImage, castAspectRatio } from "@/lib/quickVideo/generate";
import { confirmGeneration, requestGenerationConfirm } from "@/lib/quickVideo/confirmGate";
import { createChatMedia, markChatMediaDone, markChatMediaFailed, resolveMediaImageBase64 } from "@/lib/quickVideo/media";

/**
 * QuickVideoAgent 受限工具层。
 * Agent 对工作台状态的唯一写入口：全部走 mutateQuickVideoState（服务端 zod 契约校验 + 阶段白名单 + 事务 + 幂等键）。
 * 工具只暴露受控的入参，且不提供任何确认门/导出能力——那是用户专属操作。
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
      description: "获取当前快创工作台的完整状态：阶段、目标时长（可能未设置 null）、画风（空串=未设置）、配置版本、生成确认状态、简报、分镜（含每个镜头的生成状态）。写操作前必须先调用本工具确认前置条件。",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
      execute: async () => {
        const state = await loadQuickVideoState(projectId);
        if (!state) return "未找到工作台状态";
        return JSON.stringify(
          {
            version: state.version,
            stage: state.stage,
            configVersion: state.configVersion,
            targetDuration: state.targetDuration,
            videoRatio: state.videoRatio,
            artStyle: state.artStyle || "",
            shotBounds: state.targetDuration != null ? shotCountBounds(state.targetDuration) : null,
            brief: state.brief,
            storyboard: state.storyboard,
            confirmationStatus: state.confirmationStatus,
            pendingSnapshot: state.pendingSnapshot,
          },
          null,
          2,
        );
      },
    }),

    update_config: tool({
      description:
        "修改单视频项目基础配置（标题、画风、画面比例、目标时长 5-60 的整数秒、简介）。目标时长与画风允许未设置时（时长 null/画风空串）直接设置。" +
        "解析用户自然语言时把「12秒以内/大约15秒/改成18秒」等表达规范为 5-60 的正整数秒，把画风提炼为简短的风格描述文本。" +
        "写入前必须调用 get_state；目标时长在分镜已确认后不可修改，需先提醒用户撤销分镜确认。" +
        "每次修改画风/时长/比例都会递增配置版本并使旧的生成确认失效；修改目标时长后应按新的镜头数量区间和总时长约束重新打磨分镜。",
      inputSchema: jsonSchema<{
        name?: string;
        artStyle?: string;
        videoRatio?: "16:9" | "9:16" | "1:1";
        targetDuration?: number;
        intro?: string;
        rawInput?: string;
      }>(
        z
          .object({
            name: z.string().min(1).max(100).optional().describe("项目标题"),
            artStyle: z.string().max(500).optional().describe("画风（空串表示清除/未设置）"),
            videoRatio: z.enum(QUICK_VIDEO_RATIOS).optional().describe("画面比例"),
            targetDuration: z
              .number()
              .int()
              .min(QUICK_VIDEO_DURATION_MIN)
              .max(QUICK_VIDEO_DURATION_MAX)
              .optional()
              .describe(`目标时长（${QUICK_VIDEO_DURATION_MIN}-${QUICK_VIDEO_DURATION_MAX} 的正整数秒）`),
            intro: z.string().max(2000).optional().describe("项目简介"),
            rawInput: z.string().max(500).optional().describe("用户关于时长/画风的原始表述（审计用，如「12秒以内」「改成18秒」）"),
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
              const targetDurationChanged = input.targetDuration != null && input.targetDuration !== s.targetDuration;
              const visualConfigChanged =
                (input.artStyle != null && input.artStyle !== (s.artStyle ?? "")) ||
                (input.videoRatio != null && input.videoRatio !== s.videoRatio);
              const generationConfigChanged = targetDurationChanged || visualConfigChanged;

              if (targetDurationChanged && s.storyboard?.status === "confirmed") {
                throw new QuickVideoError("FORBIDDEN", "分镜已确认，不允许修改目标时长；请先让用户撤销分镜确认", s.version);
              }
              if (generationConfigChanged && ["generating", "ready_to_assemble", "completed"].includes(s.stage)) {
                throw new QuickVideoError("FORBIDDEN", "生成已开始，生成参数已锁定；当前生成完成或新建项目后才能再调整目标时长、画风或比例", s.version);
              }
              if (input.targetDuration != null) s.targetDuration = input.targetDuration;
              if (input.videoRatio != null) s.videoRatio = input.videoRatio;
              if (input.artStyle != null) s.artStyle = input.artStyle;

              if (generationConfigChanged) {
                bumpConfigVersion(s);
                s.generation.snapshot = null;
                s.generation.materialsConfirmed = false;
                s.generation.materialsConfirmedAt = null;
                s.generation.materialImages = {};
                s.generation.timeline = null;
                s.generation.exportInfo = null;
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
          const durationHint = input.targetDuration != null ? `目标时长已更新为 ${state.targetDuration} 秒` : "项目配置已更新";
          const versionHint = `当前配置版本 configVersion=${state.configVersion}`;
          const storyboardHint = input.targetDuration != null && state.storyboard ? "请根据新目标时长重新打磨当前分镜。" : "";
          const visualHint = input.artStyle != null || input.videoRatio != null ? "请在素材/成本确认前重新解析素材快照。" : "";
          const auditHint = input.rawInput ? `（用户原始表述：${input.rawInput}）` : "";
          return `${durationHint}${auditHint}（状态版本 ${state.version}，${versionHint}）。${storyboardHint}${visualHint}`;
        }).catch((err) => `更新项目配置失败：${describeError(err)}`);
      },
    }),

    request_generation_confirm: tool({
      description:
        "发起生成确认（用户要求生成/出片时调用）：服务端校验分镜已确认且目标时长已设置后，组装包含最新 configVersion、目标时长、画风、分镜数量与逐镜摘要的生成确认摘要，" +
        "右侧工作台与聊天区会出现「生成确认卡片」。必须等用户明确确认（点击卡片按钮或回复「确认/开始生成」）后才能调用 confirm_generation 开始生成。",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
      execute: async () => {
        return withThinking(msg, "正在组装生成确认摘要...", async () => {
          const { state, pendingSnapshot } = await requestGenerationConfirm(projectId, { sessionId });
          if (!pendingSnapshot) return "生成确认摘要组装失败，请重试。";
          const styleText = pendingSnapshot.artStyle ? pendingSnapshot.artStyle : "未设置";
          const shotList = pendingSnapshot.shotSummaries
            .map((s) => `镜头${s.index}（${s.duration}秒）：${s.description}`)
            .join("；");
          return [
            `生成确认摘要已生成（configVersion=${pendingSnapshot.configVersion}）：`,
            `目标时长 ${pendingSnapshot.targetDuration} 秒；画风：${styleText}；画面比例 ${pendingSnapshot.videoRatio}；`,
            `分镜 v${pendingSnapshot.storyboardVersion}，共 ${pendingSnapshot.shotCount} 镜，总时长 ${pendingSnapshot.totalDuration} 秒。`,
            shotList ? `逐镜摘要：${shotList}。` : "",
            "请向用户复述以上要点，并提醒用户：确认无误请点击右侧「生成确认卡片」的确认按钮，或直接回复「确认生成」；需要调整请回复修改意见（修改后需重新确认）。",
            `(状态版本 ${state.version}）`,
          ]
            .filter(Boolean)
            .join("\n");
        }).catch((err) => `发起生成确认失败：${describeError(err)}`);
      },
    }),

    confirm_generation: tool({
      description:
        "确认生成（仅在用户已明确同意后调用，如用户回复「确认」「开始生成」「确认生成」）：传入待确认摘要的 configVersion；" +
        "服务端校验该版本与最新配置一致后冻结参数并启动逐镜头生成。若参数在确认后被修改过（版本不一致），调用会失败并提示重新确认。",
      inputSchema: jsonSchema<{ configVersion: number }>(
        z
          .object({
            configVersion: z.number().int().min(0).describe("待确认摘要中的配置版本（request_generation_confirm 返回或 get_state 中的 configVersion）"),
          })
          .toJSONSchema(),
      ),
      execute: async (input, options) => {
        const { toolCallId } = options as { toolCallId: string };
        return withThinking(msg, "正在校验生成确认...", async () => {
          const result = await confirmGeneration(projectId, {
            idempotencyKey: `tool:confirm_generation:${toolCallId}`,
            sessionId,
            configVersion: input.configVersion,
            userId,
          });
          if (result.started) return `生成已启动（运行 ${result.runId}），参数已按 configVersion=${input.configVersion} 锁定。系统将逐镜头生成分镜图和视频片段，请在右侧面板查看进度。`;
          if (result.alreadyRunning) return `生成已在进行中（运行 ${result.runId}），无需重复启动。`;
          return "确认已通过但生成启动失败，请让用户在右侧面板查看镜头状态，失败镜头可单独重试。";
        }).catch((err) => `确认生成失败：${describeError(err)}`);
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
        "提交一版完整分镜（替换式）：5-12 个镜头、每镜 5-15 秒、总时长贴近目标时长。前置条件：简报已存在且简报已确认（用户在确认门确认过）。提交后分镜为草稿，需用户在右侧面板确认。",
      inputSchema: jsonSchema<{
        summary: string;
        shots: { duration: number; description: string; dialogue: string; camera: string }[];
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
          if (current.targetDuration == null) {
            throw new QuickVideoError(
              "DURATION_NOT_SET",
              "目标时长尚未确定：请先与用户确认视频时长（5-60 的整数秒），并用 update_config 写入后再提交分镜",
              current.version,
            );
          }
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
              if (s.targetDuration == null) {
                throw new QuickVideoError("DURATION_NOT_SET", "目标时长尚未确定，请先用 update_config 写入目标时长", s.version);
              }

              const shots: QuickVideoShot[] = input.shots.map((shot, i) => ({
                id: `shot-${i + 1}`,
                index: i + 1,
                duration: normalizeShotDuration(shot.duration),
                description: shot.description,
                dialogue: shot.dialogue ?? "",
                camera: shot.camera ?? "",
                assetRefs: [],
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
              // 分镜内容变更：递增配置版本并使旧的生成确认失效
              bumpConfigVersion(s);
            },
          );
          if (idempotentHit) return "该次分镜提交已应用过（幂等命中），未重复写入。";
          const total = input.shots.reduce((sum, s) => sum + s.duration, 0);
          return `分镜 v${state.storyboard?.version} 已提交（${input.shots.length} 个镜头，总时长 ${total} 秒）。请向用户概述每镜内容，并提醒用户在右侧面板确认分镜。`;
        }).catch((err) => `提交分镜失败：${describeError(err)}`);
      },
    }),

    update_shot: tool({
      description: "修改单个草稿镜头的字段（画面描述/台词/运镜/时长/资产）。仅分镜草稿状态可用；镜头 id 与顺序不可改。",
      inputSchema: jsonSchema<{
        shotId: string;
        description?: string;
        dialogue?: string;
        camera?: string;
        duration?: number;
      }>(
        z
          .object({
            shotId: z.string().min(1).max(40).describe("镜头 ID（如 shot-2）"),
            description: z.string().min(1).max(2000).optional().describe("新的画面描述"),
            dialogue: z.string().max(500).optional().describe("新的台词/旁白"),
            camera: z.string().max(200).optional().describe("新的景别/运镜"),
            duration: z.number().int().min(SHOT_DURATION_MIN).max(SHOT_DURATION_MAX).optional().describe("新的镜头时长（秒）"),
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
              // 分镜内容变更：递增配置版本并使旧的生成确认失效
              bumpConfigVersion(s);
            },
          );
          return idempotentHit
            ? "该次镜头修改已应用过（幂等命中），未重复写入。"
            : `镜头 ${input.shotId} 已更新（状态版本 ${state.version}）。`;
        }).catch((err) => `修改镜头失败：${describeError(err)}`);
      },
    }),

    add_shot: tool({
      description: "在分镜草稿末尾追加一个镜头。",
      inputSchema: jsonSchema<{ duration: number; description: string; dialogue: string; camera: string }>(
        z
          .object({
            duration: z.number().int().min(SHOT_DURATION_MIN).max(SHOT_DURATION_MAX).describe(`镜头时长（秒）`),
            description: z.string().min(1).max(2000).describe("画面描述"),
            dialogue: z.string().max(500).describe("台词/旁白，可为空字符串"),
            camera: z.string().max(200).describe("景别/运镜"),
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
                assetRefs: [],
                imageState: "pending",
                videoState: "pending",
                imageRef: null,
                videoRef: null,
                errorReason: null,
                firstFrame: null,
              });
              reindexShots(s);
              bumpConfigVersion(s);
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
              bumpConfigVersion(s);
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
              bumpConfigVersion(s);
            },
          );
          return idempotentHit ? "该次绑定已应用过（幂等命中）。" : `镜头 ${input.shotId} 资产绑定已更新（状态版本 ${state.version}）。`;
        }).catch((err) => `绑定资产失败：${describeError(err)}`);
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
            imageState: s.imageState,
            videoState: s.videoState,
            errorReason: s.errorReason,
          })),
          null,
          2,
        );
      },
    }),

    generate_shots: tool({
      description:
        "处理用户的生成请求（分镜图 + 5-15 秒视频片段）。分镜已确认但尚未通过生成确认门时，本工具会自动组装生成确认摘要（确认卡片），" +
        "必须等用户明确确认（点击卡片按钮或回复「确认生成」）后用 confirm_generation 开始生成——绝不代替用户确认。" +
        "已确认但生成中断/未运行时幂等重启；生成中返回当前进度。",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
      execute: async () => {
        return withThinking(msg, "正在检查生成条件...", async () => {
          const state = await loadQuickVideoState(projectId);
          if (!state) return "未找到工作台状态，请先创建 quick_video 项目";

          if (state.stage === "generating") {
            // 阶段已就绪但没有任何运行在跑（如服务重启后的遗留）：幂等重启
            if (!state.generation?.materialsConfirmed) {
              return "处于生成阶段但素材/成本确认状态异常，请让用户在右侧面板重新操作确认门。";
            }
            const { started, alreadyRunning, runId } = await startQuickVideoGeneration(projectId, userId, sessionId);
            if (started) {
              return `生成已重新启动（运行 ${runId}）。请提醒用户右侧面板会实时展示各镜头进度；失败镜头可单独重试。`;
            }
            if (alreadyRunning) {
              return `生成正在进行中（运行 ${runId}），无需重复启动。请提醒用户在右侧面板查看镜头级进度。`;
            }
          }

          if (state.stage === "storyboard_confirmed") {
            // 生成启动必须先经过版本化的用户确认门：这里只负责把确认摘要组装出来（确认卡片），
            // 由用户点卡片确认或回复「确认生成」后由 confirm_generation 真正启动。
            const { pendingSnapshot } = await requestGenerationConfirm(projectId, { sessionId });
            if (!pendingSnapshot) return "生成确认摘要组装失败，请重试。";
            if (state.generation?.materialsConfirmed) {
              // 历史遗留：素材门已通过但确认门未走完，同样先补确认卡片
              const { started, alreadyRunning, runId } = await startQuickVideoGeneration(projectId, userId, sessionId);
              if (started) return `生成已重新启动（运行 ${runId}）。`;
              if (alreadyRunning) return `生成已在进行中（运行 ${runId}）。`;
            }
            const styleText = pendingSnapshot.artStyle ? pendingSnapshot.artStyle : "未设置";
            return [
              `已生成确认摘要（configVersion=${pendingSnapshot.configVersion}）：目标时长 ${pendingSnapshot.targetDuration} 秒，画风：${styleText}，分镜 ${pendingSnapshot.shotCount} 镜（总时长 ${pendingSnapshot.totalDuration} 秒）。`,
              "请提醒用户：确认无误请点击「生成确认卡片」的确认按钮，或直接回复「确认生成」；如需调整时长/画风/分镜，请直接提出（修改后需重新确认）。",
            ].join("\n");
          }

          if (state.stage === "ready_to_assemble") {
            return "所有镜头已生成完毕，可以进入装配/导出环节。";
          }

          return `当前阶段 ${state.stage} 还不能开始生成：需先确认简报、生成并确认分镜，再通过生成确认门。`;
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
        "在当前聊天会话中生成一张图片（文生图，可选引用图作为图生图参考）。生成成功会自动出现在聊天记录和资产白板中，" +
        "但不会绑定到任何镜头、不会修改分镜、不会代替用户确认任何确认门——绑定镜头首帧是用户在右侧分镜表的专属操作。",
      inputSchema: jsonSchema<{ prompt: string; referenceMediaIds?: number[] }>(
        z
          .object({
            prompt: z.string().min(1).max(2000).describe("图片生成提示词（画面描述，尽量具体：主体、构图、风格、光影）"),
            referenceMediaIds: z
              .array(z.number().int().positive())
              .max(4)
              .optional()
              .describe("引用媒体的 mediaId 列表（图生图参考），只能是用户在本轮聊天中明确选中的引用，不要凭空编造 id"),
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

          const referenceIds = (input.referenceMediaIds ?? toolConfig.references ?? []).slice(0, 4);
          const referenceList: { type: "image"; base64: string }[] = [];
          for (const refId of referenceIds) {
            try {
              referenceList.push({ type: "image", base64: await resolveMediaImageBase64(projectId, refId) });
            } catch {
              // 单张参考图失效不阻断本次生成，退化为纯文本提示词
            }
          }

          try {
            const imageCls = u.Ai.Image(imageModel as `${string}:${string}`, userId);
            await imageCls.run(
              { prompt: input.prompt, referenceList, size: "1K", aspectRatio },
              {
                taskClass: "快创聊天生图",
                describe: `聊天生图：${input.prompt.slice(0, 100)}`,
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
            return `图片已生成并加入聊天记录与资产白板（mediaId ${media.id}）。提醒用户：如需用作某个镜头的首帧，请在右侧分镜表对应镜头点击"设为首帧"手动绑定，我不会自动绑定。`;
          } catch (err) {
            const reason = describeError(err);
            await markChatMediaFailed(media.id, reason);
            return `图片生成失败：${reason}。可以请用户换一个描述或换一个图片模型后重新发送。`;
          }
        }).catch((err) => `图片生成失败：${describeError(err)}`);
      },
    });
  }

  // 仅当本轮 socket 已校验通过 videoModel 时才对 Agent 暴露该工具（SIY-134）：mode=text/image 的
  // 对话轮次不应该、也不能触发视频生成。
  if (toolConfig.videoModel) {
    const videoModel = toolConfig.videoModel;
    tools.generate_video = tool({
      description:
        "在当前聊天会话中生成一段图生视频（必须提供一张参考图作为首帧输入，不支持纯文字生视频）。生成成功会自动出现在聊天记录和资产白板中，" +
        "但不会绑定到任何镜头、不会修改分镜、不会代替用户确认任何确认门——绑定镜头首帧是用户在右侧分镜表的专属操作。",
      inputSchema: jsonSchema<{ prompt: string; referenceMediaId?: number; duration?: number }>(
        z
          .object({
            prompt: z.string().min(1).max(2000).describe("视频生成提示词（画面内容、动作、运镜、氛围，尽量具体）"),
            referenceMediaId: z
              .number()
              .int()
              .positive()
              .optional()
              .describe("作为首帧的参考图 mediaId，只能是用户在本轮聊天中明确选中/复制的图片，不要凭空编造 id；未提供时使用用户当前选中的引用"),
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
          const referenceId = input.referenceMediaId ?? toolConfig.references?.[0];
          if (!referenceId) {
            return "生视频需要先提供一张参考图作为首帧：请提醒用户在聊天记录或资产白板中复制一张图片作为引用后再发送生视频请求，我不会凭空生成视频。";
          }

          try {
            await assertVideoSupportsSingleImage(videoModel, false);
          } catch (err) {
            return `视频生成失败：${describeError(err)}`;
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

          let imageBase64: string;
          try {
            imageBase64 = await resolveMediaImageBase64(projectId, referenceId);
          } catch (err) {
            const reason = describeError(err);
            await markChatMediaFailed(media.id, reason);
            return `视频生成失败：参考图无效（${reason}）。请提醒用户重新选择一张已生成完成的图片作为参考后再试，不要凭空重试。`;
          }

          try {
            const videoAi = u.Ai.Video(videoModel as `${string}:${string}`, userId);
            await videoAi.run(
              {
                prompt: input.prompt,
                referenceList: [{ type: "image", base64: imageBase64 }],
                mode: ["singleImage"],
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
            return `视频已生成并加入聊天记录与资产白板（mediaId ${media.id}）。提醒用户：如需用作某个镜头的首帧，请在右侧分镜表对应镜头点击"设为首帧"手动绑定（仅图片可作首帧），我不会自动绑定。`;
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
