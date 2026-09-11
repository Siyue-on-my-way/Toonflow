import { Socket } from "socket.io";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import useTools from "@/agents/quickVideoAgent/tools";
import ResTool from "@/socket/resTool";
import * as fs from "fs";
import path from "path";
import { loadQuickVideoState } from "@/lib/quickVideo/state";
import { shotCountBounds, QuickVideoChatMode, QuickVideoState } from "@/lib/quickVideo/contract";
import { ChatShotRef } from "@/lib/quickVideo/shotRef";

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  sessionId: number;
  userId: number;
  text: string;
  /** 剥离 ##编号# 引用标记后的用户指令（无引用时与 text 相同）；LLM 收到的是它，记忆里保留原文 */
  cleanedText?: string;
  textModel?: `${string}:${string}`;
  /** 本轮聊天发送模式：text=普通对话，image=受限图片生成，video=受限图生视频（SIY-132/SIY-134） */
  mode?: QuickVideoChatMode;
  /** mode=image 时服务端已校验过的图片模型 key（vendorId:modelName），未校验通过则不会传入 */
  imageModel?: string;
  /** mode=video 时服务端已校验过的视频模型 key（vendorId:modelName），未校验通过则不会传入（SIY-134） */
  videoModel?: string;
  /** 用户在聊天/白板选中的引用媒体 mediaId 列表（图生图参考，可选） */
  references?: number[];
  /** 本轮解析出的有效镜头引用（服务端已按当前分镜校验归属，SIY-140） */
  shotRefs?: ChatShotRef[];
  /** 本轮被拒绝的镜头引用提示（编号不存在/格式非法/已过期），需向用户转述 */
  shotRefErrors?: string[];
  /** socket 层已加载的工作台状态（避免本函数内重复读库；解析失败时为 null） */
  workbenchState?: QuickVideoState | null;
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
 * 状态机的阶段推进（确认门）只由用户在右侧面板触发，Agent 不得也無法代替用户确认。
 */
export async function runQuickVideoAgent(ctx: AgentContext) {
  const { isolationKey, sessionId, text, textModel, userMessageTime, abortSignal, resTool, userId } = ctx;
  const memory = new Memory("quickVideoAgent", isolationKey, userId);
  await memory.add("user", text, { createTime: userMessageTime });

  const skill = path.join(u.getPath("skills"), "quick_video_agent.md");
  const prompt = await fs.promises.readFile(skill, "utf-8");

  const mem = buildMemPrompt(await memory.get(text));

  const projectData = await u.db("o_project").where("id", resTool.data.projectId).first();
  const sessionData = await u.db("o_quickVideoSession").where("id", sessionId).first();
  const state = ctx.workbenchState !== undefined ? ctx.workbenchState : await loadQuickVideoState(Number(resTool.data.projectId));
  // 文本模型优先级：本轮显式传入 > 当前会话保存的偏好 > 项目历史默认值（兼容未迁移前的选择）
  const effectiveTextModel = textModel || (sessionData?.textModel as `${string}:${string}` | undefined) || (projectData?.textModel as `${string}:${string}` | undefined);

  // 按镜头引用上下文（SIY-140）：把编号映射到 storyboardId 并附镜头结构化摘要，
  // 让 Agent 无需再调 get_state 就能直接调用按镜头生成工具。
  const shotRefContext = buildShotRefContext(state, ctx.shotRefs, ctx.shotRefErrors);

  const projectInfo = [
    "## 项目信息",
    `视频标题：${projectData?.name ?? "未知"}`,
    `画风：${state?.artStyle || projectData?.artStyle || "无"}`,
    `画面比例：${state?.videoRatio ?? projectData?.videoRatio ?? "16:9"}`,
    `目标时长：${state?.targetDuration ?? "未知"}秒`,
    state ? `当前阶段：${state.stage}（状态版本 ${state.version}）` : "",
    state?.brief ? `简报确认状态：${state.brief.confirmed ? "已确认" : "未确认"}` : "简报：暂无",
    state?.storyboard ? `分镜：v${state.storyboard.version}（${state.storyboard.status === "confirmed" ? "已确认" : "草稿"}，共 ${state.storyboard.shots.length} 镜）` : "分镜：暂无",
    state ? `允许镜头数量：${shotCountBounds(state.targetDuration).min}-${shotCountBounds(state.targetDuration).max} 个` : "",
    ctx.mode === "image"
      ? `本轮用户在聊天框选择了「图片」生成模式，模型：${ctx.imageModel}。请调用 generate_image 工具按用户描述生成图片，不要只用文字描述画面；生成的图片会自动出现在聊天记录和资产白板中，不会自动绑定到任何镜头或自动确认分镜。`
      : ctx.mode === "video"
        ? `本轮用户在聊天框选择了「视频」生成模式，模型：${ctx.videoModel}。请调用 generate_video 工具按用户描述生成图生视频；该工具必须有一张参考图作为首帧，没有参考图时工具会明确告知用户先在聊天记录或资产白板复制一张图片，不要凭空生成或改用其他方式生成；生成的视频会自动出现在聊天记录和资产白板中，不会自动绑定到任何镜头或自动确认分镜。`
        : "",
    shotRefContext,
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
      { role: "user", content: ctx.cleanedText || text },
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
        references: ctx.references,
        shotRefs: ctx.shotRefs,
        shotRefErrors: ctx.shotRefErrors,
        hasStoryboard: !!state?.storyboard?.shots?.length,
      }),
    },
    onFinish: async (completion) => {
      await mutateLastChatAt(Number(resTool.data.projectId), sessionId);
      await memory.add("assistant", removeAllXmlTags(completion.text));
    },
  });

  await consumeFullStream(fullStream, ctx.msg);
}

/** 组装按镜头引用上下文：编号 -> storyboardId 映射 + 镜头摘要 + 无效引用告警 */
function buildShotRefContext(state: QuickVideoState | null | undefined, shotRefs?: ChatShotRef[], shotRefErrors?: string[]): string {
  const parts: string[] = [];
  if (shotRefErrors?.length) {
    parts.push(`【注意】以下镜头引用无效，请向用户说明原因，不要为其创建任何生成任务：\n- ${shotRefErrors.join("\n- ")}`);
  }
  if (shotRefs?.length) {
    const lines = (state?.storyboard?.shots ?? [])
      .filter((s) => shotRefs.some((r) => r.shotId === s.id))
      .map((s) => {
        const firstFrame = s.firstFrame ? "首帧已绑定" : "首帧未绑定";
        return `- 镜头${s.index}（storyboardId: ${s.id}，${s.duration} 秒）：${s.description.slice(0, 120)}［分镜图: ${s.imageState}；视频: ${s.videoState}；${firstFrame}］`;
      });
    parts.push(
      [
        "## 本轮用户引用的镜头（通过 ##编号# 或分镜选择器指定）",
        ...lines,
        "用户想对这些镜头执行生成类操作时：生视频用 generate_shot_video（会先出确认卡片），生图用 generate_shot_image；" +
          "用户的补充指令通过工具的 instruction 参数传入，不要直接改写分镜表文本（改分镜请用 update_shot 且需用户明确要求）。",
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
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
