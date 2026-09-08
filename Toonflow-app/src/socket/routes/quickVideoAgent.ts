import jwt from "jsonwebtoken";
import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/quickVideoAgent/index";
import ResTool from "@/socket/resTool";

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
    const isolationKey = socket.handshake.auth.isolationKey;
    if (!isolationKey) {
      console.log("[quickVideoAgent] 连接失败，缺少 isolationKey");
      socket.disconnect();
      return;
    }

    console.log("[quickVideoAgent] 已连接:", socket.id);

    const resTool = new ResTool(socket, {
      projectId: socket.handshake.auth.projectId,
      userId: user.id,
    });
    let abortController: AbortController | null = null;

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    socket.on("chat", async (data: { content: string; textModel?: string }) => {
      const { content, textModel } = data;
      abortController?.abort();
      abortController = new AbortController();
      const currentController = abortController;

      const msg = resTool.newMessage("assistant", "快创助手");
      const ctx: agent.AgentContext = {
        socket,
        isolationKey,
        userId: user.id,
        text: content,
        textModel: textModel as `${string}:${string}` | undefined,
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
