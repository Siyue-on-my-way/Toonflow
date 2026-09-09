import { Socket } from "socket.io";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import useTools from "@/agents/quickVideoAgent/tools";
import ResTool from "@/socket/resTool";
import * as fs from "fs";
import path from "path";
import { loadQuickVideoState } from "@/lib/quickVideo/state";
import { shotCountBounds } from "@/lib/quickVideo/contract";

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  sessionId: number;
  userId: number;
  text: string;
  textModel?: `${string}:${string}`;
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
  const state = await loadQuickVideoState(Number(resTool.data.projectId));
  // 文本模型优先级：本轮显式传入 > 当前会话保存的偏好 > 项目历史默认值（兼容未迁移前的选择）
  const effectiveTextModel = textModel || (sessionData?.textModel as `${string}:${string}` | undefined) || (projectData?.textModel as `${string}:${string}` | undefined);

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
      { role: "user", content: text },
    ],
    abortSignal,
    tools: {
      ...memory.getTools(),
      ...useTools({ resTool: ctx.resTool, msg: ctx.msg, sessionId: ctx.sessionId }),
    },
    onFinish: async (completion) => {
      await mutateLastChatAt(Number(resTool.data.projectId), sessionId);
      await memory.add("assistant", removeAllXmlTags(completion.text));
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
