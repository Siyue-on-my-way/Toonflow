import { Socket } from "socket.io";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import useTools from "@/agents/quickVideoAgent/tools";
import ResTool from "@/socket/resTool";
import * as fs from "fs";
import path from "path";
import { loadQuickVideoState } from "@/lib/quickVideo/state";
import { shotCountBounds, QuickVideoChatMode, resolveSlotReferences, parseImagePlaceholderSlots } from "@/lib/quickVideo/contract";
import { isVisionTextModel, resolveMediaImageBase64 } from "@/lib/quickVideo/media";
import { resolveAgentModelKey } from "@/utils/ai";

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  sessionId: number;
  userId: number;
  text: string;
  textModel?: `${string}:${string}`;
  /** 本轮聊天发送模式：text=普通对话，image=受限图片生成，video=受限图生视频（SIY-132/SIY-134） */
  mode?: QuickVideoChatMode;
  /** mode=image 时服务端已校验过的图片模型 key（vendorId:modelName），未校验通过则不会传入 */
  imageModel?: string;
  /** mode=video 时服务端已校验过的视频模型 key（vendorId:modelName），未校验通过则不会传入（SIY-134） */
  videoModel?: string;
  /** 所选视频模型目录声明的时长档位（如 Kling O1 的 [5,10]），供 generate_video 参数说明与就近取整（SIY-154 P2） */
  videoDurationOptions?: number[];
  /** 用户在聊天/白板选中的引用媒体 mediaId 列表（图生图参考，可选） */
  references?: number[];
  /** 占位符编号 -> mediaId 映射（##图N## = 托盘第 N 张图），socket 层按用户消息解析（SIY-151） */
  slotReferences?: Record<number, number>;
  /** 用户本轮消息中出现的占位符编号（升序去重），供工具做确定性回退 */
  placeholderSlots?: number[];
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  thinkConfig: {
    think: boolean;
    thinlLevel: 0 | 1 | 2 | 3;
  };
}

function buildMemPrompt(mem: Awaited<ReturnType<Memory["get"]>>): string {
  let memoryContext = "";
  if (mem.rag.length) {
    memoryContext += `[相关记忆]\n${mem.rag.map((r) => r.content).join("\n")}`;
  }
  if (mem.summaries.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[历史摘要]\n${mem.summaries.map((s, i) => `${i + 1}. ${s.content}`).join("\n")}`;
  }
  if (mem.shortTerm.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[近期对话]\n${mem.shortTerm.map((m) => `${m.role}: ${m.content}`).join("\n")}`;
  }
  return `## Memory\n以下是你对用户的记忆，可作为参考但不要主动提及：\n${memoryContext}`;
}

/**
 * 单视频快创 Agent：单层结构（无子 Agent），通过受限 JSON Schema 工具读写工作台状态。
 * 状态机的阶段推进（确认门）只由用户在右侧面板/聊天确认卡片触发，Agent 不得也無法代替用户确认。
 */
export async function runQuickVideoAgent(ctx: AgentContext) {
  const { isolationKey, sessionId, text, textModel, userMessageTime, abortSignal, resTool, userId } = ctx;
  const memory = new Memory("quickVideoAgent", isolationKey, userId);
  // 引用媒体仅以稳定 mediaId 记入记忆正文（不含 Base64/私有 Key/签名 URL）
  const refNote = ctx.references?.length ? `\n[本轮附带媒体引用 mediaId: ${ctx.references.slice(0, 4).join(", ")}]` : "";
  await memory.add("user", `${text}${refNote}`, { createTime: userMessageTime });

  const skill = path.join(u.getPath("skills"), "quick_video_agent.md");
  const prompt = await fs.promises.readFile(skill, "utf-8");

  const mem = buildMemPrompt(await memory.get(text));

  const projectData = await u.db("o_project").where("id", resTool.data.projectId).first();
  const sessionData = await u.db("o_quickVideoSession").where("id", sessionId).first();
  const state = await loadQuickVideoState(Number(resTool.data.projectId));
  // 文本模型优先级：本轮显式传入 > 当前会话保存的偏好 > 项目历史默认值（兼容未迁移前的选择）
  const effectiveTextModel = textModel || (sessionData?.textModel as `${string}:${string}` | undefined) || (projectData?.textModel as `${string}:${string}` | undefined);

  // SIY-144 文本模式图文守门：引用在 image/video 模式由受限工具直接消费；
  // text 模式要让文本模型"看懂"图片，必须具备视觉理解能力（协议目录 vision=true），
  // 不支持时直接阻断本轮并给出可见原因，严禁静默丢图退化为纯文本对话。
  let referenceImages: { type: "image"; image: string }[] = [];
  if ((ctx.mode ?? "text") === "text" && ctx.references?.length) {
    const modelKey = await resolveAgentModelKey("quickVideoAgent", effectiveTextModel);
    if (!(await isVisionTextModel(modelKey))) {
      await emitVisionBlocked(ctx, memory, `当前文本模型「${modelKey}」不支持图片理解，请切换为具备视觉能力的文本模型后再发送图片，或改用「图片」模式生成`);
      return;
    }
    const dataUrls: string[] = [];
    for (const mediaId of ctx.references.slice(0, 4)) {
      try {
        dataUrls.push(await resolveMediaImageBase64(Number(resTool.data.projectId), mediaId));
      } catch (err) {
        await emitVisionBlocked(ctx, memory, `参考图 mediaId ${mediaId} 读取失败（${u.error(err as Error).message}），请重新选择有效的图片引用`);
        return;
      }
    }
    // 图文多模态内容只进本轮 LLM 消息，不落记忆
    referenceImages = dataUrls.map((image) => ({ type: "image" as const, image }));
  }

  // SIY-151 占位符映射：##图N## 指附件托盘第 N 张图（references 的第 N-1 项）；
  // 映射同步告知 Agent 与工具层，工具层在 Agent 未显式传引用时做确定性回退。
  const placeholderSlots = parseImagePlaceholderSlots(text);
  const slotReferences = resolveSlotReferences(ctx.references, placeholderSlots);
  const slotNote = placeholderSlots.length
    ? [
        "",
        "## 本轮图片占位符映射",
        ...placeholderSlots.map((slot) =>
          slotReferences[slot] != null ? `- ##图${slot}## -> mediaId ${slotReferences[slot]}（用户托盘中的第 ${slot} 张图片）` : `- ##图${slot}## -> 无对应图片（用户托盘只有 ${ctx.references?.length ?? 0} 张图，如需使用请提醒用户补图）`,
        ),
        "用户提到 ##图N## 时即指上述图片：生图用 referenceSlots=[N]、生视频用 referenceSlots=[N] 或 [N,M]（首尾帧）、绑定首帧用 slot=N。",
      ].join("\n")
    : "";

  const projectInfo = [
    "## 项目信息",
    `视频标题：${projectData?.name ?? "未知"}`,
    `画风：${state?.artStyle || projectData?.artStyle || "自由画风（由聊天或分镜自然生成）"}`,
    `画面比例：${state?.videoRatio ?? projectData?.videoRatio ?? "16:9"}`,
    `目标时长：${state?.targetDuration ? `${state.targetDuration}秒` : "自适应（未指定，上限60秒）"}`,
    state ? `配置版本：configVersion=${state.configVersion ?? 0}（状态版本 ${state.version}）` : "",
    state ? `当前阶段：${state.stage}` : "",
    state?.brief ? `简报确认状态：${state.brief.confirmed ? "已确认" : "未确认"}` : "简报：暂无",
    state?.storyboard ? `分镜：v${state.storyboard.version}（${state.storyboard.status === "confirmed" ? "已确认" : "草稿"}，共 ${state.storyboard.shots.length} 镜，每镜含 imagePrompt/videoPrompt 双提示词）` : "分镜：暂无",
    state?.storyboard?.status === "confirmed"
      ? `生成状态：${state.generation?.materialsConfirmed ? "生成已启动或进行中" : "分镜已确认，用户在聊天中明确要求生成时调用 generate_shots 一键启动生成管道"}`
      : "",
    state ? `允许镜头数量：${shotCountBounds(state.targetDuration).min}-${shotCountBounds(state.targetDuration).max} 个` : "",
    ctx.mode === "image"
      ? `本轮用户在聊天框选择了「图片」生成模式，模型：${ctx.imageModel}。请调用 generate_image 工具按用户描述生成图片；用户消息带 ##图N## 占位符时传 referenceSlots 自动转为图生图，否则为纯文生图；不要只用文字描述画面。生成的图片会自动出现在聊天记录和资产白板中。`
      : ctx.mode === "video"
        ? `本轮用户在聊天框选择了「视频」生成模式，模型：${ctx.videoModel}。请调用 generate_video 工具：纯文字描述即文生视频（无需图片）；消息带 ##图N## 时传 referenceSlots=[N] 以该图为首帧；带 ##图1## ##图2## 时传 referenceSlots=[1,2] 生成首尾帧过渡视频（模型不支持时工具会自动退化为首帧模式）；所选模型不支持文生视频时，工具会自动生成一张概念首帧图并链式生视频。生成的视频（和概念图）会自动出现在聊天记录和资产白板中，不会自动绑定镜头。`
        : "",
    slotNote,
    "",
    mem,
  ]
    .filter(Boolean)
    .join("\n");

  const { fullStream } = await u.Ai.Text(
    "quickVideoAgent",
    ctx.userId,
    ctx.thinkConfig.think,
    ctx.thinkConfig.thinlLevel,
    effectiveTextModel,
  ).stream({
    messages: [
      { role: "system", content: prompt },
      { role: "assistant", content: projectInfo },
      { role: "user", content: referenceImages.length ? [{ type: "text", text }, ...referenceImages] : text },
    ],
    abortSignal,
    tools: {
      ...memory.getTools(),
      ...useTools({
        resTool: ctx.resTool,
        msg: ctx.msg,
        sessionId: ctx.sessionId,
        imageModel: ctx.imageModel,
        videoModel: ctx.videoModel,
        videoDurationOptions: ctx.videoDurationOptions,
        references: ctx.references,
        slotReferences,
        placeholderSlots,
      }),
    },
    onFinish: async (completion) => {
      await mutateLastChatAt(Number(resTool.data.projectId), sessionId);
      // UI 动作元数据（ext.actions，SIY-153）随记忆正文一起持久化：getMemory 还原历史时
      // 会解析回消息 ext 供前端回放展示；回放动作由前端执行器按消息 id 去重，不会重复执行。
      const uiActions = ctx.msg.getExt()?.actions;
      await memory.add(
        "assistant",
        removeAllXmlTags(completion.text),
        Array.isArray(uiActions) && uiActions.length ? { ext: JSON.stringify(uiActions) } : undefined,
      );
    },
  });

  await consumeFullStream(fullStream, ctx.msg);
}

/** 记录最近聊天时间与触发会话，供工作台展示/留痕（失败不影响主流程） */
async function mutateLastChatAt(projectId: number, sessionId: number) {
  try {
    const { mutateQuickVideoState } = await import("@/lib/quickVideo/state");
    await mutateQuickVideoState(projectId, { sessionId }, (s) => {
      s.lastChatAt = Date.now();
    });
  } catch {
    // 状态行不存在等场景忽略
  }
}

/** 文本模式图文守门阻断：在聊天流给出可见原因，并把阻断说明落记忆保持会话连续（SIY-144） */
async function emitVisionBlocked(ctx: AgentContext, memory: Memory, reason: string) {
  const note = ctx.msg.markdown(`⚠️ ${reason}`);
  note.complete();
  ctx.msg.complete();
  try {
    await memory.add("assistant", `[未处理] ${reason}`);
  } catch {
    // 记忆失败不阻断错误提示
  }
}

async function consumeFullStream(fullStream: AsyncIterable<any>, initialMsg: ReturnType<ResTool["newMessage"]>): Promise<string> {
  let msg = initialMsg;
  let text = msg.text();
  let thinking: ReturnType<typeof msg.thinking> | null = null;
  let thinkTime = 0;
  let fullResponse = "";

  try {
    for await (const chunk of fullStream) {
      if (chunk.type === "reasoning-start") {
        thinkTime = Date.now();
        thinking = msg.thinking("思考中...");
      } else if (chunk.type === "reasoning-delta") {
        thinking?.append(chunk.text);
      } else if (chunk.type === "reasoning-end") {
        thinkTime = Date.now() - thinkTime;
        thinking?.updateTitle(`思考完毕（${(thinkTime / 1000).toFixed(1)} 秒）`);
        thinking?.complete();
        thinking = null;
      } else if (chunk.type === "text-delta") {
        text.append(chunk.text);
        fullResponse += chunk.text;
      } else if (chunk.type === "error") {
        throw chunk.error;
      }
    }
    text.complete();
    msg.complete();
  } catch (err: any) {
    thinking?.complete();
    const errMsg = err?.message ?? String(err);
    text.append(errMsg);
    text.error();
    msg.error();
    throw err;
  }

  return fullResponse;
}

function removeAllXmlTags(text: string): string {
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "");
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "");
  text = text.replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "");
  return text.trim();
}
