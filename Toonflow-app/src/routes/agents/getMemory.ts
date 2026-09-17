import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getOwnedSession } from "@/lib/quickVideo/session";
import { buildSessionIsolationKey, normalizeQuickVideoUiActions, QuickVideoUiAction } from "@/lib/quickVideo/contract";
import { QuickVideoError } from "@/lib/quickVideo/state";
import { getAssetBoard, toMediaRef } from "@/lib/quickVideo/media";
const router = express.Router();

function normalizeRole(role?: string | null): "user" | "assistant" | null {
  if (role === "user") return "user";
  if (role?.startsWith("assistant")) return "assistant";
  return null;
}

/**
 * 解析消息展示层元数据（SIY-153 actions + SIY-161 videoParamsCard）：
 * memories.ext 存 JSON——旧格式是 actions 数组，新格式是 { actions?, videoParamsCard? } 对象；
 * 白名单外/畸形数据静默忽略（normalize 返回空数组即不附带），历史回放动作由前端按消息 id 去重。
 */
function parseMessageExt(row: { role?: string | null; ext?: string | null }): { actions: QuickVideoUiAction[]; videoParamsCard: Record<string, unknown> | null } {
  if (!row.ext || !normalizeRole(row.role)) return { actions: [], videoParamsCard: null };
  try {
    const parsed = JSON.parse(row.ext);
    if (Array.isArray(parsed)) return { actions: normalizeQuickVideoUiActions(parsed).accepted, videoParamsCard: null };
    if (parsed && typeof parsed === "object") {
      const actions = Array.isArray(parsed.actions) ? normalizeQuickVideoUiActions(parsed.actions).accepted : [];
      // 确认卡只透传定义（字段/来源/冻结引用），状态（active/confirmed/stale）由前端按状态机最新数据判定
      const card = parsed.videoParamsCard && typeof parsed.videoParamsCard === "object" && !Array.isArray(parsed.videoParamsCard)
        ? (parsed.videoParamsCard as Record<string, unknown>)
        : null;
      return { actions, videoParamsCard: card };
    }
    return { actions: [], videoParamsCard: null };
  } catch {
    return { actions: [], videoParamsCard: null };
  }
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

    const rows = await query.select("id", "role", "name", "content", "ext", "createTime");

    // 用户消息中的引用注记（SIY-137 审核反馈）：聊天时随消息引用的媒体以
    // `[本轮附带(图片|媒体)引用 mediaId: 1, 2]` 追加在记忆正文尾部；
    // 历史回放时剥离该注记并还原为媒体卡片块，让用户能看到自己引用了哪些图。
    const REF_NOTE_RE = /\n?\[本轮附(?:带)?(?:图片|媒体)引用 mediaId: ([0-9,\s]+)\]/g;
    const refMediaIdsByMessage = new Map<number, number[]>();

    const history = rows
      .reverse()
      .map((row) => {
        const role = normalizeRole(row.role);
        if (!role || !row.content?.trim()) return null;
        let text = row.content;
        let refIds: number[] | null = null;
        if (agentType === "quickVideoAgent" && role === "user") {
          const matches = [...text.matchAll(REF_NOTE_RE)];
          if (matches.length) {
            refIds = matches
              .flatMap((m) => m[1].split(",").map((x: string) => Number(x.trim())))
              .filter((n) => Number.isInteger(n) && n > 0);
            text = text.replace(REF_NOTE_RE, "").trim();
          }
        }
        // UI 动作元数据（SIY-153）与参数确认卡（SIY-161）随历史一起回放：动作只登记消息 id，
        // 确认卡的实时状态由前端按 workbench 状态机数据判定
        const ext = parseMessageExt(row);
        const hasExt = ext.actions.length > 0 || ext.videoParamsCard != null;
        if (refIds?.length && !text) return null; // 纯引用无文本的消息不产空气泡（媒体块在下方合并时补挂）
        const message: any = {
          id: row.id,
          role,
          name: row.name ?? (agentType === "quickVideoAgent" && role === "assistant" ? "快创助手" : undefined),
          status: "complete",
          datetime: new Date(row.createTime).toISOString(),
          content: [{ type: "markdown", status: "complete", data: text }],
          ...(hasExt
            ? {
                ext: {
                  ...(ext.actions.length ? { actions: ext.actions } : {}),
                  ...(ext.videoParamsCard ? { videoParamsCard: ext.videoParamsCard } : {}),
                },
              }
            : {}),
          createTime: row.createTime,
        };
        if (refIds?.length) {
          message.refMediaIds = refIds;
          refMediaIdsByMessage.set(row.id, refIds);
        }
        return message;
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

      // 把用户消息的引用还原为媒体卡片块（与聊天生成的媒体块同构，前端 mediaCardsOf 统一渲染）。
      // 直接按 mediaId 查项目内素材：白板查询带 sessionId 过滤，会遗漏无会话归属的上传素材。
      if (refMediaIdsByMessage.size) {
        const allRefIds = [...new Set([...refMediaIdsByMessage.values()].flat())];
        const refRows = (await u
          .db("o_quickVideoMedia")
          .where("projectId", projectId)
          .whereIn("id", allRefIds)
          .whereNull("deletedAt")) as { id: number }[];
        const refById = new Map<number, Awaited<ReturnType<typeof toMediaRef>>>();
        for (const row of refRows) refById.set(row.id, await toMediaRef(row as any));
        for (const message of merged as any[]) {
          const ids: number[] | undefined = message.refMediaIds;
          if (!ids?.length) continue;
          for (const id of ids) {
            const ref = refById.get(id);
            if (!ref || ref.state !== "done") continue; // 已删除/生成中的引用不回显
            message.content.push({
              type: ref.kind,
              status: "complete",
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
            });
          }
          delete message.refMediaIds;
        }
      }

      return res.status(200).send(success(merged));
    }

    res.status(200).send(success(history));
  },
);
