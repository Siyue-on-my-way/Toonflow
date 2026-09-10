import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getOwnedSession } from "@/lib/quickVideo/session";
import { buildSessionIsolationKey } from "@/lib/quickVideo/contract";
import { QuickVideoError } from "@/lib/quickVideo/state";
import { getAssetBoard } from "@/lib/quickVideo/media";
const router = express.Router();

function normalizeRole(role?: string | null): "user" | "assistant" | null {
  if (role === "user") return "user";
  if (role?.startsWith("assistant")) return "assistant";
  return null;
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    agentType: z.enum(["scriptAgent", "productionAgent", "quickVideoAgent"]),
    episodesId: z.number().optional(),
    sessionId: z.number().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async (req, res) => {
    const { projectId, agentType, episodesId, sessionId, limit } = req.body;

    let isolationKey: string;
    if (agentType === "quickVideoAgent") {
      // quickVideoAgent 的记忆按 projectId + sessionId 隔离；sessionId 必须真实属于该项目，
      // 拒绝客户端拼接任意隔离键跨项目/跨会话读取历史。
      if (!sessionId) return res.status(200).send(error("缺少 sessionId"));
      try {
        await getOwnedSession(projectId, sessionId);
      } catch (err) {
        if (err instanceof QuickVideoError) return res.status(200).send(error(err.message));
        throw err;
      }
      isolationKey = buildSessionIsolationKey(projectId, sessionId);
    } else {
      isolationKey = `${projectId}:${agentType}${episodesId ? `:${episodesId}` : ""}`;
    }

    const query = u
      .db("memories")
      .where({ isolationKey, type: "message" })
      // Only roles that can be rendered in the chat are eligible. This also
      // keeps internal/system memory entries out of the user-facing history.
      .where((builder) => builder.where("role", "user").orWhere("role", "like", "assistant%"))
      .whereNotNull("content")
      .whereNot("content", "")
      .orderBy("createTime", "desc");

    if (limit) query.limit(limit);

    const rows = await query.select("id", "role", "name", "content", "createTime");

    const history = rows
      .reverse()
      .map((row) => {
        const role = normalizeRole(row.role);
        if (!role || !row.content?.trim()) return null;
        return {
          id: row.id,
          role,
          name: row.name ?? (agentType === "quickVideoAgent" && role === "assistant" ? "快创助手" : undefined),
          status: "complete",
          datetime: new Date(row.createTime).toISOString(),
          content: [{ type: "markdown", status: "complete", data: row.content }],
          createTime: row.createTime,
        };
      })
      .filter((message): message is NonNullable<typeof message> => message !== null);

    // 聊天生成的图片/视频不落在 memories 表里（工具执行的副作用，不是文本记忆），
    // 单独查询同一份资产索引后按时间戳与文本历史合并展示，保证刷新/切换会话后仍可用。
    if (agentType === "quickVideoAgent") {
      const board = await getAssetBoard(projectId, { sessionId, pageSize: 60 });
      // 聊天记录只回放"由这轮聊天生成"的媒体；白板/未来其他来源（asset_board/generated/upload）
      // 不是这个会话的对话内容，混进聊天历史会显得像 Agent 突然凭空发了张不相关的图。
      const mediaMessages = board.items
        .filter((ref) => ref.source === "chat")
        .map((ref) => ({
        id: `media-${ref.mediaId}`,
        role: "assistant" as const,
        name: "快创助手",
        status: ref.state === "failed" ? ("error" as const) : ("complete" as const),
        datetime: new Date(ref.createTime).toISOString(),
        content: [
          {
            type: ref.kind,
            status: ref.state === "failed" ? "error" : "complete",
            data: { name: ref.promptSummary ?? undefined, url: ref.url ?? undefined },
            ext: {
              mediaId: ref.mediaId,
              assetId: ref.assetId,
              imageId: ref.imageId,
              videoId: ref.videoId,
              kind: ref.kind,
              model: ref.model,
              promptSummary: ref.promptSummary,
              state: ref.state,
              source: ref.source,
              errorReason: ref.errorReason,
            },
          },
        ],
        createTime: ref.createTime,
      }));

      const merged = [...history, ...mediaMessages].sort((a, b) => a.createTime - b.createTime);
      return res.status(200).send(success(merged));
    }

    res.status(200).send(success(history));
  },
);
