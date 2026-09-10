import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import settingStore from "@/stores/setting";
import { useChat } from "@/utils/useChat";
import type {
  QuickVideoConfigPatch,
  QuickVideoReject,
  QuickVideoState,
  QuickVideoWorkbench,
  QuickVideoSession,
  QuickVideoSessionStatus,
} from "@/types/quickVideo";

/**
 * 单视频快创工作台 store：
 * - 左侧聊天走 /socket/quickVideoAgent 命名空间，隔离键由服务端按 projectId + 当前
 *   会话（sessionId）拼出；切换会话时必须重新握手（见 switchSession）
 * - 右侧产物（简报/分镜/素材与生成进度）来自 /quickVideo/getWorkbench 聚合查询，项目级共享，不随会话切换变化
 * - 会话列表（sessions）、当前会话（currentSessionId）与三类模型偏好按会话隔离，
 *   互不覆盖；聊天记录/模型偏好属于会话，工作台产物属于项目
 * - Agent 每轮回复结束后刷新一次工作台状态（工具写库后同步右侧面板）
 * - generating 阶段自动轮询（4s）展示镜头级进度；轮询中断/页面刷新后恢复轮询即可续看
 */
const POLL_INTERVAL_MS = 4000;
const CHAT_HISTORY_LIMIT = 20;

function makeQuickVideoStore(projectId: string) {
  return defineStore(`quickVideo-${projectId}`, () => {
    const workbench = ref<QuickVideoWorkbench>({ project: null, script: null, state: null, shotBounds: null });
    const state = computed<QuickVideoState | null>(() => workbench.value.state);
    const loadingWorkbench = ref(false);
    const loadingHistory = ref(false);
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    // ===== 会话（session，SIY-128） =====
    const sessions = ref<QuickVideoSession[]>([]);
    const loadingSessions = ref(false);
    const currentSessionId = ref<number | null>(null);
    const currentSession = computed<QuickVideoSession | null>(() => sessions.value.find((s) => s.id === currentSessionId.value) ?? null);
    /** 当前会话保存的三类模型偏好；未选中会话或会话未设置过偏好时为空字符串 */
    const modelPreferences = computed(() => ({
      text: currentSession.value?.textModel || "",
      image: currentSession.value?.imageModel || "",
      video: currentSession.value?.videoModel || "",
    }));

    const { connected, messages, chat, stopGenerate, socket, status, disconnect, connect, clearMessages, isGenerating } = useChat({
      url: `${settingStore().baseUrl}/socket/quickVideoAgent`,
      // 只传 projectId + sessionId，不再由客户端拼隔离键：服务端会校验 sessionId
      // 真实属于该 projectId 后才据此构造 Agent 记忆隔离键，拒绝跨项目/跨会话访问。
      auth: () => ({
        projectId: Number(projectId),
        sessionId: currentSessionId.value,
      }),
      manageLifecycle: false,
      autoConnect: false,
    });

    watch(isGenerating, (generating, prev) => {
      // Agent 一轮结束（流式中->空闲）后刷新工作台，同步工具写入的简报/分镜
      if (prev && !generating) {
        getWorkbench();
        // 智能标题生成是脱离聊天响应链路的异步任务，回复结束时未必已经写完；
        // 立即刷新一次会话列表，并在几秒后再补一次，捕捉稍晚写完的标题，
        // 不引入新的 socket 事件/房间机制。纯读请求，不会触发新的 Agent 回复。
        loadSessions();
        setTimeout(() => loadSessions(), 4000);
      }
    });

    // 生成阶段自动轮询；离开生成阶段停止
    watch(
      () => state.value?.stage,
      (stage) => {
        if (stage === "generating") startPolling();
        else stopPolling();
      },
      { immediate: true },
    );

    function startPolling() {
      if (pollTimer) return;
      pollTimer = setInterval(() => {
        // 聊天流式回复中跳过，避免 socket 消息与轮询刷新打架
        if (!isGenerating.value) getWorkbench();
      }, POLL_INTERVAL_MS);
    }

    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    async function getWorkbench() {
      loadingWorkbench.value = true;
      try {
        // The shared Axios interceptor returns the HTTP response body directly,
        // so `response.data` is already the endpoint's payload.
        const response = await axios.post("/quickVideo/getWorkbench", { projectId: Number(projectId) });
        const payload = response?.data ?? response;
        if (payload && payload.code && payload.code !== 200) throw new Error(payload.message ?? "getWorkbench failed");
        workbench.value = payload ?? { project: null, script: null, state: null, shotBounds: null };
      } finally {
        loadingWorkbench.value = false;
      }
      return workbench.value;
    }

    /**
     * 加载会话列表（按 update_time 倒序，存量项目没有会话时由服务端自动补建默认会话）。
     * 当前选中的会话若仍在返回列表中则保持不变（避免刷新时因活跃度排序变化跳到别的会话）；
     * 否则默认选中第一个非归档会话（全部归档时选列表第一条）。
     */
    async function loadSessions(): Promise<QuickVideoSession[]> {
      loadingSessions.value = true;
      try {
        const response = await axios.post("/quickVideo/listSessions", { projectId: Number(projectId) });
        const payload = response?.data ?? response;
        if (payload && payload.code && payload.code !== 200) throw new Error(payload.message ?? "listSessions failed");
        sessions.value = payload?.sessions ?? [];

        if (!sessions.value.some((s) => s.id === currentSessionId.value)) {
          const defaultSession = sessions.value.find((s) => s.status === "active") ?? sessions.value[0] ?? null;
          currentSessionId.value = defaultSession?.id ?? null;
        }
      } finally {
        loadingSessions.value = false;
      }
      return sessions.value;
    }

    /** 新建会话并立即切换到它；模型偏好从项目当前配置继承一次，之后独立编辑 */
    async function createSession(title?: string): Promise<QuickVideoSession> {
      const response = await axios.post("/quickVideo/createSession", { projectId: Number(projectId), title });
      const payload = response?.data ?? response;
      if (payload && payload.code && payload.code !== 200) throw new Error(payload.message ?? "创建会话失败");
      const created: QuickVideoSession = payload.session;
      sessions.value = [created, ...sessions.value];
      await switchSession(created.id);
      return created;
    }

    /** 重命名会话标题，或归档/恢复会话 */
    async function updateSession(sessionId: number, patch: { title?: string; status?: QuickVideoSessionStatus }): Promise<QuickVideoSession> {
      const response = await axios.post("/quickVideo/updateSession", { projectId: Number(projectId), sessionId, ...patch });
      const payload = response?.data ?? response;
      if (payload && payload.code && payload.code !== 200) throw new Error(payload.message ?? "更新会话失败");
      const updated: QuickVideoSession = payload.session;
      sessions.value = sessions.value.map((s) => (s.id === updated.id ? updated : s));
      // 归档当前会话后，它会从下拉框中消失；立即切到最近的活动会话，
      // 避免界面仍显示已归档会话的聊天和模型偏好。
      if (updated.status === "archived" && currentSessionId.value === updated.id) {
        const fallback = sessions.value.find((session) => session.status === "active");
        if (fallback) {
          await switchSession(fallback.id);
        } else {
          disconnect();
          socket.value = null;
          clearMessages();
          currentSessionId.value = null;
        }
      }
      return updated;
    }

    /**
     * 切换当前会话：清空聊天消息与 socket 内部私有状态，重新建立 socket 连接
     * （握手时 auth() 会读取新的 currentSessionId，服务端据此重新拼出隔离键），
     * 并重新拉取该会话的历史记录。
     *
     * useChat 的 auth 只在首次创建 socket 实例时读取一次，之后 connect() 只会
     * 复用旧连接，因此必须先 disconnect + 把 socket 置空，下一次 connect() 才会
     * 真正用新会话重新握手，而不是继续用旧会话的连接收发消息。
     */
    async function switchSession(sessionId: number) {
      if (sessionId === currentSessionId.value) return;
      if (!sessions.value.some((s) => s.id === sessionId)) throw new Error("会话不存在");

      disconnect();
      socket.value = null;
      clearMessages();
      currentSessionId.value = sessionId;

      connect();
      await getHistory();
    }

    /**
     * Restore the user-visible conversation from the Agent memory table.
     * This endpoint only reads persisted messages, so restoring history never
     * starts another Agent turn. A failed history request is intentionally
     * isolated from the workbench and socket connection.
     */
    async function getHistory() {
      if (loadingHistory.value) return messages.value;
      const sessionId = currentSessionId.value;
      if (!sessionId) return messages.value;

      loadingHistory.value = true;
      try {
        const response = await axios.post("/agents/getMemory", {
          projectId: Number(projectId),
          agentType: "quickVideoAgent",
          sessionId,
          limit: CHAT_HISTORY_LIMIT,
        });
        const payload = response?.data ?? response;
        if (!Array.isArray(payload)) {
          throw new Error(payload?.message ?? "加载聊天历史失败");
        }

        // The welcome card is local UI copy, not a persisted Agent message.
        // Preserve it while replacing stale/in-memory history with the
        // server's chronological result.
        const welcomeMessages = messages.value.filter((message) => message.id === "welcome");
        messages.value = [...welcomeMessages, ...payload];
      } catch (error) {
        console.error("[quickVideo] 加载聊天历史失败", error);
      } finally {
        loadingHistory.value = false;
      }

      return messages.value;
    }

    /**
     * 保存当前会话的某一类模型偏好（文本/图片/视频），乐观更新本地状态，
     * 失败时回滚；不新建、不切换 session_id，也不影响其他会话已保存的偏好。
     */
    async function setModelPreference(type: "text" | "image" | "video", value: string) {
      const sessionId = currentSessionId.value;
      const target = sessions.value.find((s) => s.id === sessionId);
      if (!target) return;

      const previous = { textModel: target.textModel, imageModel: target.imageModel, videoModel: target.videoModel };
      const next = { ...modelPreferences.value, [type]: value };
      target.textModel = next.text;
      target.imageModel = next.image;
      target.videoModel = next.video;

      try {
        const response = await axios.post("/quickVideo/updateModels", {
          projectId: Number(projectId),
          sessionId,
          textModel: next.text,
          imageModel: next.image,
          videoModel: next.video,
        });
        const payload = response?.data ?? response;
        if (payload && payload.code && payload.code !== 200) throw new Error(payload.message ?? "保存模型偏好失败");
      } catch (error) {
        console.error("[quickVideo] 保存模型偏好失败", error);
        target.textModel = previous.textModel;
        target.imageModel = previous.imageModel;
        target.videoModel = previous.videoModel;
      }
    }

    /** 更新快创项目基础配置，使用状态版本做乐观锁校验。 */
    async function updateConfig(
      patch: QuickVideoConfigPatch,
    ): Promise<
      | { ok: true; state: QuickVideoState | null; project: QuickVideoWorkbench["project"] }
      | { ok: false; error: QuickVideoReject }
    > {
      const current = state.value;
      if (!current) {
        return { ok: false, error: { code: "STATE_NOT_FOUND", message: "未找到 quickVideoAgent 状态", currentVersion: null } };
      }

      const response: any = await axios.post("/quickVideo/updateConfig", {
        projectId: Number(projectId),
        expectedVersion: current.version,
        idempotencyKey: `web-config-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        patch,
      });

      if (response?.code !== 200) {
        await getWorkbench();
        return {
          ok: false,
          error: {
            code: String(response?.code ?? "UPDATE_CONFIG_FAILED"),
            message: response?.message ?? "项目配置更新失败",
            currentVersion: response?.currentVersion ?? null,
          },
        };
      }

      await getWorkbench();
      return { ok: true, state: workbench.value.state, project: workbench.value.project };
    }

    /** 时间线装配查询（ready_to_assemble / completed 阶段）：规划 + 字幕 + 视频地址 */
    async function getTimeline() {
      const response = await axios.post("/quickVideo/getTimeline", { projectId: Number(projectId) });
      const payload = response?.data ?? response;
      if (payload && payload.code && payload.code !== 200) throw new Error(payload.message ?? "getTimeline failed");
      return payload ?? null;
    }

    /** 镜头产物访问地址（imageRef/videoRef -> 预览链接），存在已完成镜头时按需调用 */
    async function getMediaUrls(): Promise<Record<string, { imageUrl: string | null; videoUrl: string | null }>> {
      const response = await axios.post("/quickVideo/getMediaUrls", { projectId: Number(projectId) });
      const payload = response?.data ?? response;
      // Axios has already unwrapped the HTTP response body; the endpoint
      // payload is success({ media }).
      return payload?.media ?? {};
    }

    return {
      connected,
      messages,
      chat,
      stopGenerate,
      socket,
      status,
      connect,
      disconnect,
      isGenerating,
      workbench,
      state,
      loadingWorkbench,
      loadingHistory,
      getWorkbench,
      getHistory,
      getMediaUrls,
      getTimeline,
      updateConfig,
      sessions,
      loadingSessions,
      currentSessionId,
      currentSession,
      modelPreferences,
      loadSessions,
      createSession,
      updateSession,
      switchSession,
      setModelPreference,
    };
  });
}

const storeMap = new Map<string, ReturnType<typeof makeQuickVideoStore>>();

function createQuickVideoStore(projectId: string) {
  if (!storeMap.has(projectId)) {
    storeMap.set(projectId, makeQuickVideoStore(projectId));
  }
  return storeMap.get(projectId)!;
}

export default function useQuickVideoStore() {
  const id = projectStore().project?.id;
  if (!id) throw new Error("No project selected");
  return createQuickVideoStore(id)();
}
