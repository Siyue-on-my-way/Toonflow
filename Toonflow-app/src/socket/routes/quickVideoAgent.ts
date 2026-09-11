import jwt from "jsonwebtoken";
import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/quickVideoAgent/index";
import ResTool from "@/socket/resTool";
import { getOwnedSession, bumpUserMessageCountAndMaybeClaimTitle } from "@/lib/quickVideo/session";
import { buildSessionIsolationKey, QuickVideoChatMode } from "@/lib/quickVideo/contract";
import { generateSessionTitle } from "@/lib/quickVideo/title";
import { validateImageModelKey, validateVideoModelKey } from "@/lib/quickVideo/media";
import { loadQuickVideoState, QuickVideoError } from "@/lib/quickVideo/state";
import { RawShotRefInput, hasShotRefTokens, parseShotRefTokens, resolveShotRefsFromState } from "@/lib/quickVideo/shotRef";
import { registerShotOpListener } from "@/lib/quickVideo/shotOps";

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
    const token = socket.handshake.auth.token;
    const user = await verifyToken(token);
    if (!user) {
      console.log("[quickVideoAgent] 连接失败，token无效");
      socket.disconnect();
      return;
    }
    const projectId = Number(socket.handshake.auth.projectId);
    const sessionId = Number(socket.handshake.auth.sessionId);
    if (!projectId || !sessionId) {
      console.log("[quickVideoAgent] 连接失败，缺少 projectId/sessionId");
      socket.disconnect();
      return;
    }
    // isolationKey 由服务端根据校验过归属关系的 projectId + sessionId 拼出，
    // 禁止直接采信客户端传入的隔离键，避免跨项目/跨会话读写记忆。
    let isolationKey: string;
    try {
      await getOwnedSession(projectId, sessionId);
      isolationKey = buildSessionIsolationKey(projectId, sessionId);
    } catch (err) {
      console.log("[quickVideoAgent] 连接失败，session 校验不通过:", u.error(err as Error).message);
      socket.disconnect();
      return;
    }

    console.log("[quickVideoAgent] 已连接:", socket.id);

    const resTool = new ResTool(socket, {
      projectId,
      userId: user.id,
    });

    // 按镜头操作任务完成/失败时广播到本连接（前端更新聊天卡片并刷新分镜表；
    // socket 断开期间错过的更新由工作台轮询兜底）。连接断开时注销，避免监听器泄漏。
    const unregisterShotOpListener = registerShotOpListener(projectId, (evt) => {
      socket.emit("shotOp:update", evt);
    });
    socket.on("disconnect", () => {
      unregisterShotOpListener();
    });

    let abortController: AbortController | null = null;

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    socket.on(
      "chat",
      async (data: {
        content: string;
        textModel?: string;
        mode?: string;
        imageModel?: string;
        videoModel?: string;
        references?: number[];
        /** 分镜选择器选中的镜头引用（displayNo + storyboardId）；##编号# 语法在服务端另行解析 */
        shotRefs?: { displayNo: number; storyboardId?: string }[];
      }) => {
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
          } catch (err) {
            msg.error(err instanceof QuickVideoError ? err.message : u.error(err as Error).message);
            return;
          }
        }

        // ===== 按镜头引用解析（SIY-140）=====
        // 服务端以当前分镜为唯一权威：合并「分镜选择器引用」与「##编号# 文本语法」，
        // 校验编号归属与 storyboardId 一致性；全部无效时直接友好报错结束本轮，不进入 Agent、不建任务。
        let shotRefs: agent.AgentContext["shotRefs"];
        let shotRefErrors: string[] = [];
        let cleanedText = content;
        let workbenchState: agent.AgentContext["workbenchState"];
        const rawRefs: RawShotRefInput[] = [];
        for (const ref of Array.isArray(data.shotRefs) ? data.shotRefs : []) {
          if (ref && Number.isInteger(ref.displayNo)) {
            rawRefs.push({ displayNo: Number(ref.displayNo), storyboardId: typeof ref.storyboardId === "string" ? ref.storyboardId : undefined });
          }
        }
        const hasTokenRefs = hasShotRefTokens(content);
        if (hasTokenRefs) {
          const parsed = parseShotRefTokens(content);
          cleanedText = parsed.cleaned || content;
          for (const displayNo of parsed.displayNos) {
            if (!rawRefs.some((r) => r.displayNo === displayNo)) rawRefs.push({ displayNo });
          }
        }
        if (rawRefs.length) {
          try {
            workbenchState = await loadQuickVideoState(projectId);
          } catch (err) {
            console.error("[quickVideoAgent] 加载工作台状态失败:", u.error(err as Error).message);
            workbenchState = null;
          }
          const resolved = resolveShotRefsFromState(workbenchState, rawRefs);
          shotRefs = resolved.resolved;
          shotRefErrors = resolved.errors;
          if (!shotRefs.length) {
            // 引用的编号全部无效：直接给出友好错误，不创建任何生成任务。
            // 抢占过智能标题生成的话也要照常触发，否则会话标题状态会永远停在 running。
            const text = msg.text(`未能识别你引用的镜头：${shotRefErrors.join("；")}。请刷新右侧分镜后，用 ##编号# 或分镜选择器重新引用。`);
            text.complete();
            msg.complete();
            if (claimedTitleGeneration) {
              void generateSessionTitle({ projectId, sessionId, isolationKey, userId: user.id }).catch((err) =>
                console.error("[quickVideoAgent] 会话标题生成异常:", u.error(err).message),
              );
            }
            return;
          }
        }

        const ctx: agent.AgentContext = {
          socket,
          isolationKey,
          sessionId,
          userId: user.id,
          text: content,
          cleanedText: hasTokenRefs ? cleanedText : undefined,
          textModel: textModel as `${string}:${string}` | undefined,
          mode,
          imageModel: validatedImageModel,
          videoModel: validatedVideoModel,
          references: Array.isArray(data.references) ? data.references.filter((n) => Number.isInteger(n)).slice(0, 4) : undefined,
          shotRefs,
          shotRefErrors,
          workbenchState,
          userMessageTime: new Date(msg.datetime).getTime() - 1,
          abortSignal: currentController.signal,
          resTool,
          msg,
          thinkConfig,
        };

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
      }
    );

    socket.on("updateThinkConfig", (data: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 }) => {
      thinkConfig.think = data.think;
      thinkConfig.thinlLevel = data.thinlLevel;
      console.log("[quickVideoAgent] 更新思考配置:", thinkConfig);
    });

    socket.on("stop", () => {
      abortController?.abort();
      abortController = null;
    });
  });
  nsp.on("disconnect", (socket: Socket) => {
    console.log("[quickVideoAgent] 已断开连接:", socket.id);
  });
};
