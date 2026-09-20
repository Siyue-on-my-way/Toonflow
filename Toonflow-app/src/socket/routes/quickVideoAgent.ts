import jwt from "jsonwebtoken";
import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/quickVideoAgent/index";
import ResTool from "@/socket/resTool";
import { buildSessionIsolationKey, QuickVideoChatMode, QuickVideoError, videoParamsCardEditsSchema, QuickVideoVideoParamsCard } from "@/lib/quickVideo/contract";
import { loadQuickVideoState, mutateQuickVideoState } from "@/lib/quickVideo/state";
import { generateSessionTitle } from "@/lib/quickVideo/title";
import {
  getOwnedSession,
  bumpUserMessageCountAndMaybeClaimTitle,
  saveVideoParamsPreference,
  getVideoParamsPreference,
} from "@/lib/quickVideo/session";
import { validateImageModelKey, validateVideoModelKey, getVideoModelDurationOptions, getVideoModelCatalogEntry, getMediaKindsByIds } from "@/lib/quickVideo/media";
import { runChatVideoGeneration, collectEntryDurationTiers } from "@/lib/quickVideo/chatVideoGen";
import { applyVideoParamsEdits, cardFieldsToParams, validateVideoParamsAgainstCatalog } from "@/lib/quickVideo/videoParamsCard";

async function verifyToken(rawToken: string): Promise<{ id: number; name: string; role: string } | null> {
  const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
  if (!setting) return null;
  const { value: tokenKey } = setting;
  if (!rawToken) return null;
  const token = rawToken.replace("Bearer ", "");
  try {
    return jwt.verify(token, tokenKey as string) as { id: number; name: string; role: string };
  } catch (err) {
    return null;
  }
}

export default (nsp: Namespace) => {
  nsp.on("connection", async (socket: Socket) => {
    // 事件监听先于鉴权注册（SIY-161 E2E 修复的存量缺陷）：connection 回调里的 token 校验与
    // 会话归属校验都是异步 DB 操作，若先 await 再注册 socket.on("chat")，客户端在 connect
    // 后立即发送的首条消息会落在监听注册之前被静默丢弃。这里先注册全部事件处理器，
    // 处理器内统一等待鉴权结果（鉴权失败则断开），行为与原实现一致，只是不再丢首条消息。
    let authed: { user: { id: number; name: string; role: string }; projectId: number; sessionId: number; isolationKey: string } | null = null;
    const authReady = (async () => {
      const token = socket.handshake.auth.token;
      const user = await verifyToken(token);
      if (!user) {
        console.log("[quickVideoAgent] 连接失败，token无效");
        socket.disconnect();
        return null;
      }
      const projectId = Number(socket.handshake.auth.projectId);
      const sessionId = Number(socket.handshake.auth.sessionId);
      if (!projectId || !sessionId) {
        console.log("[quickVideoAgent] 连接失败，缺少 projectId/sessionId");
        socket.disconnect();
        return null;
      }
      // isolationKey 由服务端根据校验过归属关系的 projectId + sessionId 拼出，
      // 禁止直接采信客户端传入的隔离键，避免跨项目/跨会话读写记忆。
      try {
        await getOwnedSession(projectId, sessionId);
      } catch (err) {
        console.log("[quickVideoAgent] 连接失败，session 校验不通过:", u.error(err as Error).message);
        socket.disconnect();
        return null;
      }
      const isolationKey = buildSessionIsolationKey(projectId, sessionId);
      console.log("[quickVideoAgent] 已连接:", socket.id);
      return { user, projectId, sessionId, isolationKey };
    })().catch((err) => {
      console.error("[quickVideoAgent] 连接初始化异常:", u.error(err as Error).message);
      socket.disconnect();
      return null;
    });

    const resTool = new ResTool(socket, {
      projectId: 0,
      userId: 0,
    });
    let abortController: AbortController | null = null;

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    socket.on("chat", async (data: { content: string; textModel?: string; mode?: string; imageModel?: string; videoModel?: string; references?: number[]; playmode?: string }) => {
      authed = await authReady;
      if (!authed) return;
      const { user, projectId, sessionId, isolationKey } = authed;
      resTool.data.projectId = projectId;
      resTool.data.userId = user.id;
      const { content, textModel } = data;
      const mode: QuickVideoChatMode = data.mode === "image" ? "image" : data.mode === "video" ? "video" : "text";
      abortController?.abort();
      abortController = new AbortController();
      const currentController = abortController;

      const msg = resTool.newMessage("assistant", "快创助手");

      // 计数 + 抢占放在模型校验/Agent 调用之前：即使本轮因图片/视频模型无效被提前拒绝，
      // 用户也确实发了一条消息，仍应计入"第几条消息"的判断，避免图片/视频模式的失败请求
      // 让智能标题触发计数悄悄比实际对话轮次滞后。
      const claimedTitleGeneration = await bumpUserMessageCountAndMaybeClaimTitle(sessionId);

      // 图片/视频模式必须先在服务端校验模型确实存在、已启用、类型匹配，不盲信浏览器传入的字符串；
      // 校验失败直接报错并结束本轮，不进入 Agent（Agent 拿到的 imageModel/videoModel 视为已受信）。
      let validatedImageModel: string | undefined;
      let validatedVideoModel: string | undefined;
      let validatedVideoDurationOptions: number[] | undefined;
      if (mode === "image") {
        try {
          if (!data.imageModel) throw new QuickVideoError("IMAGE_MODEL_INVALID", "请先在模型选择框中选择一个图片模型");
          await validateImageModelKey(data.imageModel);
          validatedImageModel = data.imageModel;
        } catch (err) {
          msg.error(err instanceof QuickVideoError ? err.message : u.error(err as Error).message);
          return;
        }
      } else if (mode === "video") {
        try {
          if (!data.videoModel) throw new QuickVideoError("VIDEO_MODEL_INVALID", "请先在模型选择框中选择一个视频模型");
          await validateVideoModelKey(data.videoModel);
          validatedVideoModel = data.videoModel;
          // 模型声明时长档位（如 Kling O1 的 5/10 秒）：随上下文传给 generate_video 工具，
          // 写入参数说明并对 LLM 传入的其他值就近取整（SIY-154 P2）
          validatedVideoDurationOptions = (await getVideoModelDurationOptions(data.videoModel)) ?? undefined;
        } catch (err) {
          msg.error(err instanceof QuickVideoError ? err.message : u.error(err as Error).message);
          return;
        }
        if (data.imageModel) {
          try {
            await validateImageModelKey(data.imageModel);
            validatedImageModel = data.imageModel;
          } catch {
            // 选填图片模型校验失败不阻断视频模式主流程，后续由服务端自动解析可用图片模型
          }
        }
      }

      const ctx: agent.AgentContext = {
        socket,
        isolationKey,
        sessionId,
        userId: user.id,
        text: content,
        textModel: textModel as `${string}:${string}` | undefined,
        mode,
        imageModel: validatedImageModel,
        videoModel: validatedVideoModel,
        videoDurationOptions: validatedVideoDurationOptions,
        references: Array.isArray(data.references) ? data.references.filter((n) => Number.isInteger(n)).slice(0, 4) : undefined,
        playmode: typeof data.playmode === "string" && data.playmode.length > 0 && data.playmode.length <= 200 ? data.playmode : undefined,
        userMessageTime: new Date(msg.datetime).getTime() - 1,
        abortSignal: currentController.signal,
        resTool,
        msg,
        thinkConfig,
      };
      // SIY-165：玩法声明的非图片引用（如全能参考下的视频/音频）按类型分流——图片仍走 references
      //（占位符 ##图N## 与既有生成链路语义不变），视频/音频记录为声明意图供 Agent 说明（生成参数接线属下期）。
      if (ctx.references?.length) {
        try {
          const kinds = await getMediaKindsByIds(Number(resTool.data.projectId), ctx.references);
          const imageRefs = ctx.references.filter((id) => kinds.get(id) === "image");
          const videoRefs = ctx.references.filter((id) => kinds.get(id) === "video");
          const audioRefs = ctx.references.filter((id) => kinds.get(id) === "audio");
          if (imageRefs.length || videoRefs.length || audioRefs.length) {
            ctx.references = imageRefs.length ? imageRefs : undefined;
            if (videoRefs.length || audioRefs.length) ctx.declaredMediaReferences = { videoIds: videoRefs, audioIds: audioRefs };
          }
        } catch (err) {
          // 类型查询失败不阻断主流程：保持原 references 语义，由既有生成链路的参考图校验兜底报错
          u.error(err as Error);
        }
      }

      try {
        await agent.runQuickVideoAgent(ctx);
      } catch (err: any) {
        if (err.name !== "AbortError" && !currentController.signal.aborted) {
          console.error("[quickVideoAgent] chat error:", u.error(err).message);
          msg.error(u.error(err).message);
        }
      } finally {
        if (abortController === currentController) {
          abortController = null;
        }
      }

      // 脱离聊天响应链路异步生成，不阻塞、不延迟本轮回复；失败只留在 failed 状态。
      if (claimedTitleGeneration) {
        void generateSessionTitle({ projectId, sessionId, isolationKey, userId: user.id }).catch((err) =>
          console.error("[quickVideoAgent] 会话标题生成异常:", u.error(err).message),
        );
      }
    });

    socket.on("updateThinkConfig", (data: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 }) => {
      thinkConfig.think = data.think;
      thinkConfig.thinlLevel = data.thinlLevel;
      console.log("[quickVideoAgent] 更新思考配置:", thinkConfig);
    });

    // ---------------------------------------------------------------------------
    // 参数确认卡确认（SIY-161）：用户在聊天流卡片上确认/修改参数后提交。
    // 服务端流程：找到 pending 的最新卡 -> 应用用户修改（来源标记 user）-> 按模型元数据
    // 硬校验（前端校验可被绕过）-> 走共享生成内核直达供应商 -> 成功后卡片落定为 confirmed
    // 并按需保存会话偏好（「沿用上次参数不再询问」）。失败时卡片保持 pending，可重新确认。
    // ---------------------------------------------------------------------------
    socket.on(
      "confirmVideoParams",
      async (
        data: { cardId?: string; edits?: Record<string, unknown>; prompt?: string; remember?: boolean },
        ack?: (result: { ok: boolean; message?: string; videoMediaId?: number }) => void,
      ) => {
        authed = await authReady;
        if (!authed) return;
        const { user, projectId, sessionId } = authed;
        const reply = (result: { ok: boolean; message?: string; videoMediaId?: number }) => {
          try {
            ack?.(result);
          } catch {
            // ack 回调异常不影响主流程（生成结果已进聊天流）
          }
        };
        if (!data || typeof data.cardId !== "string" || !data.cardId.trim()) {
          return reply({ ok: false, message: "缺少参数卡 ID" });
        }
        const cardId = data.cardId.trim();

        const msg = resTool.newMessage("assistant", "快创助手");
        try {
          const state = await loadQuickVideoState(projectId);
          if (!state) throw new QuickVideoError("STATE_NOT_FOUND", "未找到工作台状态");
          const cards = state.generation?.videoParamsCards ?? [];
          const card = cards.find((c: QuickVideoVideoParamsCard) => c.cardId === cardId);
          if (!card) throw new QuickVideoError("VIDEO_PARAMS_CARD_NOT_FOUND", "参数确认卡不存在或已被清理，请重新发起生成");
          if (card.status !== "pending") throw new QuickVideoError("VIDEO_PARAMS_CARD_STALE", "该参数卡已确认过，请重新发起生成");
          if (card.sessionId !== sessionId) throw new QuickVideoError("VIDEO_PARAMS_CARD_STALE", "该参数卡属于其他会话，请在本会话重新发起生成");
          if (cards[cards.length - 1]?.cardId !== cardId) {
            throw new QuickVideoError("VIDEO_PARAMS_CARD_STALE", "已有更新的参数卡，当前卡片已失效");
          }

          // 应用用户修改（edits 白名单 + 来源标记），随后按模型元数据硬校验
          const edits = videoParamsCardEditsSchema.safeParse(data.edits ?? {});
          if (!edits.success) throw new QuickVideoError("VIDEO_PARAMS_INVALID", "参数格式不正确，请刷新后重试");
          const editedCard = applyVideoParamsEdits(card, edits.data, typeof data.prompt === "string" ? data.prompt : undefined);
          const entry = await getVideoModelCatalogEntry(card.modelKey);
          if (!entry) throw new QuickVideoError("VIDEO_MODEL_INVALID", "所选视频模型不可用（未在渠道目录中或未启用），请重新选择");
          const params = cardFieldsToParams(editedCard);
          const validated = validateVideoParamsAgainstCatalog(entry, params, editedCard.referenceMediaIds.length, editedCard.prompt);

          // 确认即执行：新助手消息承载生成进度与结果媒体（与聊天生视频同构）
          const result = await runChatVideoGeneration({
            projectId,
            userId: user.id,
            sessionId,
            msg,
            idempotencyKey: `socket:confirmVideoParams:${cardId}:${Date.now()}`,
            videoModel: card.modelKey,
            prompt: editedCard.prompt,
            referenceIds: editedCard.referenceMediaIds,
            durationTiers: collectEntryDurationTiers(entry),
            params: validated,
            source: "card",
          });
          if (!result.ok) {
            msg.error(result.reason);
            // 生成失败：卡片保持 pending，用户可在同一张卡上重试确认
            return reply({ ok: false, message: result.reason });
          }

          // 成功：卡片落定 + 按需保存会话偏好
          await mutateQuickVideoState(
            projectId,
            { sessionId },
            (s) => {
              const target = (s.generation.videoParamsCards ?? []).find((c) => c.cardId === cardId);
              if (target && target.status === "pending") {
                target.status = "confirmed";
                target.confirmedAt = Date.now();
                target.prompt = editedCard.prompt;
                target.promptSource = editedCard.promptSource;
                for (const field of editedCard.fields) {
                  const mirror = target.fields.find((f) => f.key === field.key);
                  if (mirror) {
                    mirror.value = field.value;
                    mirror.source = field.source;
                  }
                }
              }
            },
          );
          if (data.remember === true) {
            await saveVideoParamsPreference(projectId, sessionId, {
              modelKey: card.modelKey,
              params: validated,
              prompt: editedCard.prompt,
              skipAsk: true,
              updatedAt: Date.now(),
            });
          } else {
            // 未勾选「不再询问」时也记录最近一次确认参数（下次出卡预填，来源 preference），但不跳过确认
            await saveVideoParamsPreference(projectId, sessionId, {
              modelKey: card.modelKey,
              params: validated,
              prompt: editedCard.prompt,
              skipAsk: false,
              updatedAt: Date.now(),
            });
          }
          msg.complete();
          return reply({ ok: true, videoMediaId: result.videoMediaId });
        } catch (err: any) {
          const message = err instanceof QuickVideoError ? err.message : u.error(err as Error).message;
          console.error("[quickVideoAgent] confirmVideoParams error:", message);
          msg.error(message);
          return reply({ ok: false, message });
        }
      },
    );

    socket.on("stop", () => {
      abortController?.abort();
      abortController = null;
    });
  });
  nsp.on("disconnect", (socket: Socket) => {
    console.log("[quickVideoAgent] 已断开连接:", socket.id);
  });
};
