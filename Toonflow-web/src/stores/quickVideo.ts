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
  MediaRef,
  ChatShotOpAction,
  ChatShotRef,
  ShotOpStartResult,
  ShotOpUpdateEvent,
} from "@/types/quickVideo";

/**
 * 单视频快创工作台 store：
 * - 左侧聊天走 /socket/quickVideoAgent 命名空间，隔离键由服务端按 projectId + 当前
 *   会话（sessionId）拼出；切换会话时必须重新握手（见 switchSession）
 * - 右侧产物（简报/分镜/素材与生成进度）来自 /quickVideo/getWorkbench 聚合查询，项目级共享，不随会话切换变化
 * - 会话列表（sessions）、当前会话（currentSessionId）与三类模型偏好按会话隔离，
 *   互不覆盖；聊天记录/模型偏好属于会话，工作台产物属于项目
 * - Agent 每轮回复结束后刷新一次工作台状态（工具写库后同步右侧面板）
 * - generating 阶段或存在进行中的按镜头操作时自动轮询（4s）展示镜头级进度
 */
const POLL_INTERVAL_MS = 4000;
const CHAT_HISTORY_LIMIT = 20;
/** 按镜头操作兜底清理时间：视频任务超时 15 分钟 + 轮询余量，超过后不再为其轮询 */
const SHOT_OP_STALE_MS = 20 * 60 * 1000;

function makeQuickVideoStore(projectId: string) {
  return defineStore(`quickVideo-${projectId}`, () => {
    const workbench = ref<QuickVideoWorkbench>({ project: null, script: null, state: null, shotBounds: null });
    const state = computed<QuickVideoState | null>(() => workbench.value.state);
    const loadingWorkbench = ref(false);
    const workbenchError = ref("");
    const loadingHistory = ref(false);
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let titleRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let workbenchRequest: Promise<QuickVideoWorkbench> | null = null;
    let lifecycleActive = false;

    // ===== 聊天按镜头操作状态（SIY-140）=====
    // 声明在轮询 watch 之前：syncPolling 的 immediate 回调会读取活动操作数
    /** 输入框「选择分镜」当前选中的镜头引用（与 ##编号# 文本语法共同构成 shotRefs） */
    const selectedShotRefs = ref<ChatShotRef[]>([]);
    /** 进行中的按镜头操作：opId -> { action, shotIds, startedAt }；驱动轮询与本地对账 */
    const activeShotOps = ref<Record<string, { action: ChatShotOpAction; shotIds: string[]; startedAt: number }>>({});

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

    const { connected, messages, chat, stopGenerate, socket, status, disconnect, destroy: destroyChat, connect, clearMessages, isGenerating } = useChat({
      url: `${settingStore().baseUrl}/socket/quickVideoAgent`,
      // 只传 projectId + sessionId，不再由客户端拼隔离键：服务端会校验 sessionId
      // 真实属于该 projectId 后才据此构造 Agent 记忆隔离键，拒绝跨项目/跨会话访问。
      auth: () => ({
        projectId: Number(projectId),
        sessionId: currentSessionId.value,
      }),
      manageLifecycle: false,
      autoConnect: false,
      // Tool calls write the workbench state through the same socket turn. If
      // a provider/socket error ends that turn before the normal idle watcher
      // runs, refresh once so the right-hand module does not stay stale.
      onError: () => {
        void getWorkbench();
      },
    });

    watch(isGenerating, (generating, prev) => {
      // Agent 一轮结束（流式中->空闲）后刷新工作台，同步工具写入的简报/分镜
      if (prev && !generating) {
        getWorkbench();
        // 智能标题生成是脱离聊天响应链路的异步任务，回复结束时未必已经写完；
        // 立即刷新一次会话列表，并在几秒后再补一次，捕捉稍晚写完的标题，
        // 不引入新的 socket 事件/房间机制。纯读请求，不会触发新的 Agent 回复。
        loadSessions();
        if (titleRefreshTimer) clearTimeout(titleRefreshTimer);
        titleRefreshTimer = setTimeout(() => {
          titleRefreshTimer = null;
          void loadSessions();
        }, 4000);
      }
    });

    // 生成阶段或按镜头操作进行中时自动轮询；离开生成阶段且无活动操作时停止
    watch(
      () => state.value?.stage,
      (stage) => {
        syncPolling(stage);
      },
      { immediate: true },
    );

    function syncPolling(stage: QuickVideoState["stage"] | undefined) {
      if (!lifecycleActive || (stage !== "generating" && !hasActiveShotOps())) {
        stopPolling();
        return;
      }
      startPolling();
    }

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

    async function getWorkbench(): Promise<QuickVideoWorkbench> {
      // Polling, the socket idle watcher and explicit refreshes can converge
      // on the same tick. Share one request so an older response cannot
      // overwrite a newer state snapshot and loading cannot get stuck false
      // while a second request is still in flight.
      if (workbenchRequest) return workbenchRequest;

      const request = (async () => {
        loadingWorkbench.value = true;
        workbenchError.value = "";
        try {
          // The shared Axios interceptor returns the HTTP response body directly,
          // so `response.data` is already the endpoint's payload.
          const response = await axios.post("/quickVideo/getWorkbench", { projectId: Number(projectId) });
          const payload = response?.data ?? response;
          if (payload && payload.code && payload.code !== 200) throw new Error(payload.message ?? "getWorkbench failed");
          workbench.value = payload ?? { project: null, script: null, state: null, shotBounds: null };
          syncPolling(workbench.value.state?.stage);
          reconcileShotOps();
        } catch (error: any) {
          workbenchError.value = error?.message ?? "快创工作台状态加载失败";
          console.error("[quickVideo] 加载工作台状态失败", error);
        } finally {
          loadingWorkbench.value = false;
        }
        return workbench.value;
      })();

      workbenchRequest = request;
      try {
        return await request;
      } finally {
        if (workbenchRequest === request) workbenchRequest = null;
      }
    }

    /** 路由离开时释放 store-owned socket、页面事件和生成轮询。 */
    function resume() {
      lifecycleActive = true;
      syncPolling(state.value?.stage);
    }

    function dispose() {
      lifecycleActive = false;
      stopPolling();
      if (titleRefreshTimer) {
        clearTimeout(titleRefreshTimer);
        titleRefreshTimer = null;
      }
      destroyChat();
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
          destroyChat();
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

      destroyChat();
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

    /** 镜头产物访问地址（imageRef/videoRef -> 预览链接，firstFrame -> 首帧缩略图），存在已完成镜头或已绑定首帧时按需调用 */
    async function getMediaUrls(): Promise<Record<string, { imageUrl: string | null; videoUrl: string | null; firstFrameUrl: string | null }>> {
      const response = await axios.post("/quickVideo/getMediaUrls", { projectId: Number(projectId) });
      const payload = response?.data ?? response;
      // Axios has already unwrapped the HTTP response body; the endpoint
      // payload is success({ media }).
      return payload?.media ?? {};
    }

    // ===== 资产白板与首帧绑定（SIY-132） =====

    /** 应用内部剪贴板：只保存稳定的 MediaRef，不保存 URL；聊天卡片和白板卡片的"复制"共用同一个槽位 */
    const clipboardMediaRef = ref<MediaRef | null>(null);

    /** 资产白板分页查询：项目范围，可选按会话/类型/状态过滤 */
    async function getAssetBoard(opts: { sessionId?: number; kind?: "all" | "image" | "video"; state?: "all" | "generating" | "done" | "failed"; page?: number; pageSize?: number } = {}) {
      const response = await axios.post("/quickVideo/getAssetBoard", { projectId: Number(projectId), ...opts });
      const payload = response?.data ?? response;
      if (payload && payload.code && payload.code !== 200) throw new Error(payload.message ?? "getAssetBoard failed");
      return payload as { items: MediaRef[]; total: number; page: number; pageSize: number };
    }

    /**
     * 绑定/替换/解除某个草稿镜头的首帧。mediaId 传 null 表示解除。
     * 复制到聊天卡片和资产白板的引用最终都走这一个接口，避免两套权限/状态逻辑。
     */
    async function bindShotFirstFrame(shotId: string, mediaId: number | null) {
      const current = state.value;
      if (!current) return { ok: false as const, error: { code: "STATE_NOT_FOUND", message: "未找到 quickVideoAgent 状态", currentVersion: null } };

      const response: any = await axios.post("/quickVideo/bindShotFirstFrame", {
        projectId: Number(projectId),
        expectedVersion: current.version,
        idempotencyKey: `web-firstframe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        shotId,
        mediaId,
      });

      if (response?.code !== 200) {
        await getWorkbench();
        return {
          ok: false as const,
          error: {
            code: String(response?.code ?? "BIND_FIRST_FRAME_FAILED"),
            message: response?.message ?? "首帧绑定失败",
            currentVersion: response?.currentVersion ?? null,
          },
        };
      }

      await getWorkbench();
      return { ok: true as const, state: workbench.value.state };
    }

    // ===== 聊天按镜头操作（SIY-140）=====

    function hasActiveShotOps(): boolean {
      return Object.keys(activeShotOps.value).length > 0;
    }

    /** 登记一个新的进行中操作并按需启动轮询（启动/确认入口与 socket 广播共用） */
    function trackShotOp(result: Pick<ShotOpStartResult, "opId" | "action" | "tasks">) {
      activeShotOps.value = {
        ...activeShotOps.value,
        [result.opId]: {
          action: result.action,
          shotIds: result.tasks.map((t) => t.shotId).filter(Boolean),
          startedAt: Date.now(),
        },
      };
      syncPolling(state.value?.stage);
    }

    /**
     * 把一次按镜头操作状态更新合并进聊天消息里的操作卡片（activity content），
     * 并刷新工作台让分镜行同步。socket 广播与轮询对账共用本入口。
     */
    function applyShotOpUpdate(update: ShotOpUpdateEvent) {
      for (const message of messages.value as any[]) {
        const content = message?.content;
        if (!Array.isArray(content)) continue;
        for (const item of content) {
          const payload = item?.data?.content;
          if (item?.type === "activity" && item.data?.activityType === "shotOp" && payload?.opId === update.opId) {
            payload.phase = update.state;
            if (update.errorReason) payload.errorReason = update.errorReason;
            payload.shots = (payload.shots ?? []).map((cardShot: any) => {
              const next = update.shots.find((s) => s.shotId === cardShot.shotId);
              return next ? { ...cardShot, ...next } : cardShot;
            });
          }
        }
      }
      delete activeShotOps.value[update.opId];
      void getWorkbench();
    }

    /**
     * 轮询对账：socket 广播丢失时（断线/切会话），每次工作台刷新后按镜头终态
     * 收敛活动操作；超过兜底时长的操作直接清理，避免轮询永不停止。
     */
    function reconcileShotOps() {
      const entries = Object.entries(activeShotOps.value);
      if (!entries.length) return;
      const now = Date.now();
      for (const [opId, op] of entries) {
        if (now - op.startedAt > SHOT_OP_STALE_MS) {
          delete activeShotOps.value[opId];
          continue;
        }
        if (!op.shotIds.length) continue; // generate_asset 无镜头状态，依赖 socket 事件收敛
        const shots: any[] = workbench.value.state?.storyboard?.shots ?? [];
        const involved = op.shotIds.map((id) => shots.find((s) => s.id === id)).filter(Boolean);
        if (involved.length < op.shotIds.length) continue; // 分镜变化等场景交由 socket 事件或过期清理兜底
        const terminalOf = (shot: any) => (op.action === "generate_shot_image" ? shot.imageState : shot.videoState);
        const allTerminal = involved.every((shot: any) => terminalOf(shot) === "done" || terminalOf(shot) === "failed");
        if (!allTerminal) continue;
        const failed = involved.filter((shot: any) => terminalOf(shot) === "failed");
        applyShotOpUpdate({
          opId,
          projectId: Number(projectId),
          action: op.action,
          state: failed.length === involved.length ? "failed" : "done",
          ...(failed.length ? { errorReason: failed.map((shot: any) => shot.errorReason).filter(Boolean).join("；") } : {}),
          shots: involved.map((shot: any) => ({
            shotId: shot.id,
            displayNo: shot.index,
            description: shot.description,
            imageState: shot.imageState,
            videoState: shot.videoState,
            errorReason: shot.errorReason,
          })),
        });
      }
      syncPolling(state.value?.stage);
    }

    /** socket 广播订阅：连接建立/重建（切换会话）后重新挂接 */
    watch(socket, (sock) => {
      sock?.on("shotOp:update", (evt: ShotOpUpdateEvent) => {
        applyShotOpUpdate(evt);
      });
    });

    /** 直接启动一次按镜头生成（结果卡片「重试/重新生成」；首次视频触发走确认卡片） */
    async function startShotOp(input: { action: Exclude<ChatShotOpAction, "generate_asset">; shotRefs: ChatShotRef[]; instruction?: string }): Promise<ShotOpStartResult> {
      const response = await axios.post("/quickVideo/startShotOp", {
        projectId: Number(projectId),
        sessionId: currentSessionId.value,
        ...input,
      });
      const payload = response?.data ?? response;
      if (payload && payload.code && payload.code !== 200) throw new Error(payload.message ?? "启动按镜头生成失败");
      const result: ShotOpStartResult = payload;
      trackShotOp(result);
      return result;
    }

    /** 确认聊天流中的镜头视频生成（轻量确认门），确认后才真正入队异步任务 */
    async function confirmShotOp(confirmToken: string): Promise<ShotOpStartResult> {
      const response = await axios.post("/quickVideo/confirmShotOp", {
        projectId: Number(projectId),
        sessionId: currentSessionId.value,
        confirmToken,
      });
      const payload = response?.data ?? response;
      if (payload && payload.code && payload.code !== 200) throw new Error(payload.message ?? "确认失败");
      const result: ShotOpStartResult = payload;
      trackShotOp(result);
      return result;
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
      workbenchError,
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
      clipboardMediaRef,
      getAssetBoard,
      bindShotFirstFrame,
      selectedShotRefs,
      activeShotOps,
      startShotOp,
      confirmShotOp,
      resume,
      dispose,
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
