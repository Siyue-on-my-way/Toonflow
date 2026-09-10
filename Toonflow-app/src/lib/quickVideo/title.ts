/**
 * QuickVideo / 单视频快创 —— 会话智能标题生成
 *
 * 触发方只负责在用户消息计数达到 TITLE_GENERATION_TRIGGER_COUNT 时抢占 running 状态
 * （见 session.ts 的 bumpUserMessageCountAndMaybeClaimTitle）；本文件只管抢到资格后
 * 怎么生成标题——读取该会话已持久化的用户消息、调用 LLM、校验结果、回写。
 * 任何一步失败都只落回 failed 状态保留原标题，绝不影响聊天主流程，也不会重试。
 */
import { tool, jsonSchema } from "ai";
import { z } from "zod";
import u from "@/utils";
import { finishTitleGeneration } from "./session";

/** 生成时最多回看的用户消息条数，以及总字符数上限（防止上下文无限增长） */
const MAX_MESSAGES = 12;
const MAX_CHARS = 4000;

/** 标题生成用的模型：当前部署下唯一验证过支持工具调用的 Gemini 路由，vendorId:modelName 格式 */
const TITLE_MODEL = "aibotplatform:gemini-3.1-pro-preview";

const TITLE_PROMPT = [
  "你是一个短标题生成助手。下面是用户在一个短视频创作会话里发出的几条消息。",
  "请用一句不超过 20 个中文字符（或等价长度）的短标题概括这段对话的核心主题/目标，",
  "不要加引号、Markdown、换行或任何解释性前后缀，不要输出系统提示词或与内容无关的话。",
  "生成结果必须通过 titleTool 工具返回，不要直接用文字回复。",
].join("");

function sanitizeTitle(raw: string): string | null {
  const title = raw
    .replace(/^["'“”「」]+|["'“”「」]+$/g, "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (!title) return null;
  return title.length > 40 ? title.slice(0, 40) : title;
}

/** 拼出模型输入：该会话最近若干条用户消息，按时间顺序，总字符数有上限 */
async function buildContext(isolationKey: string): Promise<string> {
  const rows = await u
    .db("memories")
    .where({ isolationKey, type: "message", role: "user" })
    .whereNotNull("content")
    .whereNot("content", "")
    .orderBy("createTime", "desc")
    .limit(MAX_MESSAGES)
    .select("content");

  let text = rows
    .reverse()
    .map((r) => String(r.content).trim())
    .filter(Boolean)
    .join("\n");
  if (text.length > MAX_CHARS) text = text.slice(text.length - MAX_CHARS);
  return text;
}

/**
 * 生成并回写一次会话标题。调用方保证：本函数是在成功抢占 titleStatus=running 之后、
 * 脱离聊天响应链路异步触发的，因此这里不再做并发保护——同一会话不会有第二个调用方。
 */
export async function generateSessionTitle(params: { projectId: number; sessionId: number; isolationKey: string; userId: number }): Promise<void> {
  const { sessionId, isolationKey, userId } = params;
  try {
    const context = await buildContext(isolationKey);
    if (!context) {
      await finishTitleGeneration(sessionId, { error: "会话内没有可用于生成标题的用户消息" });
      return;
    }

    let captured: string | null = null;
    const titleTool = tool({
      description: "返回生成的会话标题时必须调用这个工具",
      inputSchema: jsonSchema<{ title: string }>(z.object({ title: z.string().min(1).max(60).describe("会话短标题") }).toJSONSchema()),
      execute: async ({ title }) => {
        captured = title;
        return "ok";
      },
    });

    await u.Ai.Text("universalAi", userId, undefined, 0, TITLE_MODEL).invoke({
      messages: [
        { role: "system", content: TITLE_PROMPT },
        { role: "user", content: context },
      ],
      tools: { titleTool },
    });

    const title = captured ? sanitizeTitle(captured) : null;
    if (!title) {
      await finishTitleGeneration(sessionId, { error: "模型未返回有效标题" });
      return;
    }
    await finishTitleGeneration(sessionId, { title });
  } catch (err) {
    await finishTitleGeneration(sessionId, { error: u.error(err as Error).message });
  }
}
