import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import settingStore from "@/stores/setting";
import { useChat } from "@/utils/useChat";
import type { QuickVideoConfigPatch, QuickVideoReject, QuickVideoState, QuickVideoWorkbench } from "@/types/quickVideo";

/**
 * 单视频快创工作台 store：
 * - 左侧聊天走 /socket/quickVideoAgent 命名空间
 * - 右侧产物（简报/分镜/素材与生成进度）来自 /quickVideo/getWorkbench 聚合查询，刷新可恢复
 * - Agent 每轮回复结束后刷新一次工作台状态（工具写库后同步右侧面板）
 * - generating 阶段自动轮询（4s）展示镜头级进度；轮询中断/页面刷新后恢复轮询即可续看
 */
const POLL_INTERVAL_MS = 4000;

function makeQuickVideoStore(projectId: string) {
  return defineStore(`quickVideo-${projectId}`, () => {
    const workbench = ref<QuickVideoWorkbench>({ project: null, script: null, state: null, shotBounds: null });
    const state = computed<QuickVideoState | null>(() => workbench.value.state);
    const loadingWorkbench = ref(false);
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const { connected, messages, chat, stopGenerate, socket, status, disconnect, connect, isGenerating } = useChat({
      url: `${settingStore().baseUrl}/socket/quickVideoAgent`,
      auth: () => ({
        isolationKey: `${projectId}:quickVideoAgent`,
        projectId: projectId,
      }),
      manageLifecycle: false,
      autoConnect: false,
    });

    watch(isGenerating, (generating, prev) => {
      // Agent 一轮结束（流式中->空闲）后刷新工作台，同步工具写入的简报/分镜
      if (prev && !generating) getWorkbench();
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
      getWorkbench,
      updateConfig,
      getMediaUrls,
      getTimeline,
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
