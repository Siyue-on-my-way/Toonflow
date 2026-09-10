import jwt from "jsonwebtoken";
import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/quickVideoAgent/index";
import ResTool from "@/socket/resTool";
import { getOwnedSession, bumpUserMessageCountAndMaybeClaimTitle } from "@/lib/quickVideo/session";
import { buildSessionIsolationKey, QuickVideoChatMode } from "@/lib/quickVideo/contract";
import { generateSessionTitle } from "@/lib/quickVideo/title";
import { validateImageModelKey, validateVideoModelKey } from "@/lib/quickVideo/media";
import { QuickVideoError } from "@/lib/quickVideo/state";

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
    let abortController: AbortController | null = null;

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    socket.on("chat", async (data: { content: string; textModel?: string; mode?: string; imageModel?: string; videoModel?: string; references?: number[] }) => {
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
        references: Array.isArray(data.references) ? data.references.filter((n) => Number.isInteger(n)).slice(0, 4) : undefined,
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
    });

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
