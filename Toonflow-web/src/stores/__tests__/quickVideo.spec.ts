/** 快创会话 store 测试（SIY-128）：会话列表加载、切换隔离、模型偏好按会话保存 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/utils/axios", () => ({ default: { post: vi.fn() } }));
vi.mock("socket.io-client", () => ({
  io: vi.fn(() => ({
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(),
    connected: false,
  })),
}));

import axios from "@/utils/axios";
import { io } from "socket.io-client";
import projectStore from "@/stores/project";
import useQuickVideoStore from "@/stores/quickVideo";
import type { QuickVideoSession } from "@/types/quickVideo";

const post = axios.post as unknown as ReturnType<typeof vi.fn>;

/** axios 拦截器已经把 HTTP 响应体直接展开返回，所以这里 mock 的就是接口自身的 {code,data,message} 包裹 */
const envelope = <T,>(data: T) => ({ code: 200, data, message: "成功" });

function makeSession(overrides: Partial<QuickVideoSession> = {}): QuickVideoSession {
  return {
    id: 1,
    projectId: 1,
    title: "默认会话",
    status: "active",
    textModel: null,
    imageModel: null,
    videoModel: null,
    createTime: 1000,
    updateTime: 1000,
    ...overrides,
  };
}

/** 每个用例用独立的 projectId，避免 store 工厂内部 storeMap 缓存跨用例串数据 */
let nextProjectId = 1;
function setupProject(): string {
  const id = String(nextProjectId++);
  const p = projectStore();
  p.project = { id } as any;
  return id;
}

beforeEach(() => {
  setActivePinia(createPinia());
  post.mockReset();
  (io as unknown as ReturnType<typeof vi.fn>).mockClear();
});

describe("quickVideo store — 会话（SIY-128）", () => {
  it("loadSessions：按 updateTime 倒序返回，默认选中第一个非归档会话", async () => {
    setupProject();
    const sessionA = makeSession({ id: 1, title: "A", status: "archived", updateTime: 2000 });
    const sessionB = makeSession({ id: 2, title: "B", status: "active", updateTime: 1000 });
    post.mockResolvedValueOnce(envelope({ sessions: [sessionA, sessionB] }));

    const store = useQuickVideoStore();
    await store.loadSessions();

    expect(store.sessions.map((s) => s.id)).toEqual([1, 2]);
    // 列表第一条（最新）已归档，默认应跳过它选中第一个非归档会话
    expect(store.currentSessionId).toBe(2);
  });

  it("loadSessions：全部会话都归档时，默认选中列表第一条", async () => {
    setupProject();
    const sessionA = makeSession({ id: 1, status: "archived", updateTime: 2000 });
    const sessionB = makeSession({ id: 2, status: "archived", updateTime: 1000 });
    post.mockResolvedValueOnce(envelope({ sessions: [sessionA, sessionB] }));

    const store = useQuickVideoStore();
    await store.loadSessions();
    expect(store.currentSessionId).toBe(1);
  });

  it("switchSession：清空聊天记录并重新拉取目标会话的历史，不残留另一会话的消息", async () => {
    setupProject();
    const sessionA = makeSession({ id: 1, updateTime: 2000 });
    const sessionB = makeSession({ id: 2, updateTime: 1000 });
    post.mockResolvedValueOnce(envelope({ sessions: [sessionA, sessionB] }));

    const store = useQuickVideoStore();
    await store.loadSessions();
    expect(store.currentSessionId).toBe(1);

    // 模拟会话A已经有一条本地消息（比如刚发过一条聊天）
    store.messages.push({ id: "msgA", role: "user", status: "complete", content: [{ type: "text", data: "会话A的消息", status: "complete" }] } as any);

    post.mockResolvedValueOnce(envelope([{ id: "hist-b-1", role: "assistant", content: [{ type: "markdown", data: "会话B的历史", status: "complete" }] }]));
    await store.switchSession(2);

    expect(store.currentSessionId).toBe(2);
    // 历史拉取请求必须携带新会话的 sessionId
    const getMemoryCall = post.mock.calls.find((c) => c[0] === "/agents/getMemory");
    expect(getMemoryCall?.[1]).toMatchObject({ sessionId: 2, agentType: "quickVideoAgent" });
    // 消息列表应只剩会话B的历史，不包含切换前会话A遗留的消息
    expect(store.messages.some((m: any) => m.content?.[0]?.data === "会话A的消息")).toBe(false);
    expect(store.messages.some((m: any) => m.content?.[0]?.data === "会话B的历史")).toBe(true);
  });

  it("switchSession：socket 会重新握手（旧连接断开、置空后重新 connect）", async () => {
    setupProject();
    const sessionA = makeSession({ id: 1, updateTime: 2000 });
    const sessionB = makeSession({ id: 2, updateTime: 1000 });
    post.mockResolvedValueOnce(envelope({ sessions: [sessionA, sessionB] }));

    const store = useQuickVideoStore();
    await store.loadSessions();
    store.connect();
    expect(io).toHaveBeenCalledTimes(1);

    post.mockResolvedValueOnce(envelope([]));
    await store.switchSession(2);
    store.connect();
    // 第一次 connect 创建的 socket 被置空，switchSession 后再次 connect 必须创建新的 socket 实例
    expect(io).toHaveBeenCalledTimes(2);
  });

  it("switchSession：目标会话不存在时报错，不改变当前会话", async () => {
    setupProject();
    const sessionA = makeSession({ id: 1 });
    post.mockResolvedValueOnce(envelope({ sessions: [sessionA] }));

    const store = useQuickVideoStore();
    await store.loadSessions();
    await expect(store.switchSession(999)).rejects.toThrow();
    expect(store.currentSessionId).toBe(1);
  });

  it("createSession：新建会话后自动切换为当前会话，并出现在列表最前", async () => {
    setupProject();
    const sessionA = makeSession({ id: 1, updateTime: 1000 });
    post.mockResolvedValueOnce(envelope({ sessions: [sessionA] }));
    const store = useQuickVideoStore();
    await store.loadSessions();

    const created = makeSession({ id: 2, title: "新会话", updateTime: 2000 });
    post.mockResolvedValueOnce(envelope({ session: created }));
    post.mockResolvedValueOnce(envelope([])); // getHistory triggered by switchSession

    await store.createSession("新会话");
    expect(store.sessions.map((s) => s.id)).toEqual([2, 1]);
    expect(store.currentSessionId).toBe(2);
  });

  it("setModelPreference：两个会话各自保存模型偏好，互不覆盖", async () => {
    setupProject();
    const sessionA = makeSession({ id: 1, updateTime: 2000, textModel: null });
    const sessionB = makeSession({ id: 2, updateTime: 1000, textModel: null });
    post.mockResolvedValueOnce(envelope({ sessions: [sessionA, sessionB] }));
    const store = useQuickVideoStore();
    await store.loadSessions();
    expect(store.currentSessionId).toBe(1);

    post.mockResolvedValueOnce(envelope({ session: { ...sessionA, textModel: "1:model-a" } }));
    await store.setModelPreference("text", "1:model-a");
    expect(store.modelPreferences.text).toBe("1:model-a");

    post.mockResolvedValueOnce(envelope([]));
    await store.switchSession(2);
    post.mockResolvedValueOnce(envelope({ session: { ...sessionB, textModel: "1:model-b" } }));
    await store.setModelPreference("text", "1:model-b");
    expect(store.modelPreferences.text).toBe("1:model-b");

    // 会话A的偏好在列表快照里应保持不变，没有被会话B的写入覆盖
    const savedA = store.sessions.find((s) => s.id === 1);
    expect(savedA?.textModel).toBe("1:model-a");
  });

  it("setModelPreference：保存失败时回滚为原值", async () => {
    setupProject();
    const sessionA = makeSession({ id: 1, textModel: "1:old-model" });
    post.mockResolvedValueOnce(envelope({ sessions: [sessionA] }));
    const store = useQuickVideoStore();
    await store.loadSessions();

    post.mockRejectedValueOnce(new Error("network down"));
    await store.setModelPreference("text", "1:new-model");

    expect(store.modelPreferences.text).toBe("1:old-model");
  });
});

describe("quickVideo store — 资产白板与首帧绑定（SIY-132）", () => {
  function makeWorkbenchState(overrides: Record<string, any> = {}) {
    return {
      schemaVersion: 1,
      version: 3,
      stage: "storyboard_draft",
      targetDuration: 15,
      videoRatio: "16:9",
      artStyle: "",
      createIdempotencyKey: "k",
      brief: null,
      storyboard: { version: 1, status: "draft", confirmedAt: null, summary: "", shots: [] },
      generation: { snapshot: null, materialsConfirmed: false, materialsConfirmedAt: null, runId: null, startedAt: null, finishedAt: null, materialImages: {}, timeline: null, exportInfo: null },
      appliedKeys: {},
      lastChatAt: null,
      updateTime: 1000,
      ...overrides,
    };
  }

  /** getWorkbench 接口返回的是 {project, script, state, shotBounds}，state 只是其中一个字段 */
  function makeWorkbench(stateOverrides: Record<string, any> = {}) {
    return { project: null, script: null, shotBounds: null, state: makeWorkbenchState(stateOverrides) };
  }

  it("getAssetBoard：请求携带 projectId 与筛选参数，原样返回分页结果", async () => {
    const id = setupProject();
    const items = [{ mediaId: 1, projectId: Number(id), kind: "image", assetId: 2, imageId: 3, videoId: null, state: "done", model: "aibotplatform:gpt-image-1", promptSummary: "猫", source: "chat", errorReason: null, url: "http://x/1.jpg", createTime: 1000 }];
    post.mockResolvedValueOnce(envelope({ items, total: 1, page: 1, pageSize: 24 }));

    const store = useQuickVideoStore();
    const result = await store.getAssetBoard({ kind: "image", page: 1, pageSize: 24 });

    expect(post).toHaveBeenCalledWith("/quickVideo/getAssetBoard", expect.objectContaining({ projectId: Number(id), kind: "image", page: 1, pageSize: 24 }));
    expect(result.items).toEqual(items);
    expect(result.total).toBe(1);
  });

  it("bindShotFirstFrame：成功时带上当前状态版本号，并在完成后刷新工作台", async () => {
    const id = setupProject();
    post.mockResolvedValueOnce(envelope(makeWorkbench()));
    const store = useQuickVideoStore();
    await store.getWorkbench();
    expect(store.state?.version).toBe(3);

    post.mockResolvedValueOnce({ code: 200 });
    post.mockResolvedValueOnce(envelope(makeWorkbench({ version: 4 })));

    const result = await store.bindShotFirstFrame("shot-1", 7);

    expect(post).toHaveBeenCalledWith("/quickVideo/bindShotFirstFrame", expect.objectContaining({ projectId: Number(id), expectedVersion: 3, shotId: "shot-1", mediaId: 7 }));
    expect(result.ok).toBe(true);
    // 绑定成功后应刷新工作台，拿到新的状态版本
    expect(store.state?.version).toBe(4);
  });

  it("bindShotFirstFrame：服务端拒绝（如版本冲突）时返回错误信息，仍重新拉取工作台对账", async () => {
    setupProject();
    post.mockResolvedValueOnce(envelope(makeWorkbench()));
    const store = useQuickVideoStore();
    await store.getWorkbench();

    post.mockResolvedValueOnce({ code: "VERSION_CONFLICT", message: "状态版本冲突，请刷新后重试", currentVersion: 5 });
    post.mockResolvedValueOnce(envelope(makeWorkbench({ version: 5 })));

    const result = await store.bindShotFirstFrame("shot-1", 7);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VERSION_CONFLICT");
      expect(result.error.message).toBe("状态版本冲突，请刷新后重试");
    }
    // 失败也要对账，避免前端继续拿着过期版本号重试
    expect(store.state?.version).toBe(5);
  });

  it("bindShotFirstFrame：mediaId 传 null 表示解除首帧", async () => {
    const id = setupProject();
    post.mockResolvedValueOnce(envelope(makeWorkbench()));
    const store = useQuickVideoStore();
    await store.getWorkbench();

    post.mockResolvedValueOnce({ code: 200 });
    post.mockResolvedValueOnce(envelope(makeWorkbench({ version: 4 })));

    await store.bindShotFirstFrame("shot-1", null);

    expect(post).toHaveBeenCalledWith("/quickVideo/bindShotFirstFrame", expect.objectContaining({ projectId: Number(id), shotId: "shot-1", mediaId: null }));
  });
});

describe("quickVideo store — configVersion 幂等合并与生成确认门（SIY-138）", () => {
  function makeWorkbenchState(overrides: Record<string, any> = {}) {
    return {
      schemaVersion: 1,
      version: 3,
      stage: "storyboard_confirmed",
      targetDuration: null,
      videoRatio: "16:9",
      artStyle: "",
      configVersion: 0,
      pendingSnapshot: null,
      confirmationStatus: "none",
      createIdempotencyKey: "k",
      brief: null,
      storyboard: { version: 1, status: "draft", confirmedAt: null, summary: "", shots: [] },
      generation: { snapshot: null, materialsConfirmed: false, materialsConfirmedAt: null, runId: null, startedAt: null, finishedAt: null, materialImages: {}, timeline: null, exportInfo: null },
      appliedKeys: {},
      lastChatAt: null,
      updateTime: 1000,
      ...overrides,
    };
  }

  function makeWorkbench(stateOverrides: Record<string, any> = {}) {
    return { project: null, script: null, shotBounds: null, state: makeWorkbenchState(stateOverrides) };
  }

  it("getWorkbench：更旧的 configVersion 响应不覆盖新状态（乱序/面板切换防漂移）", async () => {
    setupProject();
    const store = useQuickVideoStore();

    // 第一次：cv=2, v=5
    post.mockResolvedValueOnce(envelope(makeWorkbench({ configVersion: 2, version: 5, targetDuration: 12, artStyle: "水彩" })));
    await store.getWorkbench();
    expect(store.state?.configVersion).toBe(2);
    expect(store.state?.targetDuration).toBe(12);

    // 第二次返回更旧的 cv=1, v=4（乱序旧响应）→ 不得回退
    post.mockResolvedValueOnce(envelope(makeWorkbench({ configVersion: 1, version: 4, targetDuration: 30, artStyle: "" })));
    await store.getWorkbench();
    expect(store.state?.configVersion).toBe(2);
    expect(store.state?.targetDuration).toBe(12);
  });

  it("getWorkbench：同 configVersion 下更旧的 version 也不覆盖；更新版本正常生效", async () => {
    setupProject();
    const store = useQuickVideoStore();

    post.mockResolvedValueOnce(envelope(makeWorkbench({ configVersion: 2, version: 5, confirmationStatus: "pending" })));
    await store.getWorkbench();

    // 同 configVersion、更旧 version → 保留
    post.mockResolvedValueOnce(envelope(makeWorkbench({ configVersion: 2, version: 4, confirmationStatus: "none" })));
    await store.getWorkbench();
    expect(store.state?.version).toBe(5);
    expect(store.state?.confirmationStatus).toBe("pending");

    // configVersion 递增的新状态 → 正常生效
    post.mockResolvedValueOnce(envelope(makeWorkbench({ configVersion: 3, version: 6, confirmationStatus: "none", targetDuration: 18 })));
    await store.getWorkbench();
    expect(store.state?.configVersion).toBe(3);
    expect(store.state?.version).toBe(6);
    expect(store.state?.targetDuration).toBe(18);
  });

  it("requestGenerationConfirm / confirmGeneration：走 /quickVideo/generateConfirm，confirm 携带 configVersion", async () => {
    const id = setupProject();
    const store = useQuickVideoStore();

    post.mockResolvedValueOnce(
      envelope({
        state: makeWorkbenchState({
          configVersion: 1,
          version: 8,
          confirmationStatus: "pending",
          pendingSnapshot: {
            configVersion: 1,
            targetDuration: 12,
            artStyle: "水彩",
            videoRatio: "16:9",
            storyboardVersion: 2,
            shotCount: 2,
            totalDuration: 12,
            shotSummaries: [{ index: 1, duration: 5, description: "镜头一" }],
            estimatedImageCount: 2,
            estimatedVideoCount: 2,
            estimatedCostYuan: 3.6,
            requestedAt: 1000,
          },
        }),
        pendingSnapshot: { configVersion: 1 },
        idempotentHit: false,
      }),
    );
    // request 后的 getWorkbench 刷新
    post.mockResolvedValueOnce(envelope(makeWorkbench({ configVersion: 1, version: 8, confirmationStatus: "pending" })));

    await store.requestGenerationConfirm();

    expect(post).toHaveBeenCalledWith("/quickVideo/generateConfirm", expect.objectContaining({ projectId: Number(id), action: "request" }));
    expect(store.state?.confirmationStatus).toBe("pending");

    post.mockResolvedValueOnce({ code: 200, data: { started: true, alreadyRunning: false, runId: "run-1" } });
    post.mockResolvedValueOnce(envelope(makeWorkbench({ configVersion: 1, version: 9, stage: "generating", confirmationStatus: "confirmed" })));

    const result = await store.confirmGeneration(1);

    expect(post).toHaveBeenCalledWith("/quickVideo/generateConfirm", expect.objectContaining({ projectId: Number(id), action: "confirm", configVersion: 1 }));
    expect(result.ok).toBe(true);
    expect(store.state?.stage).toBe("generating");
  });

  it("confirmGeneration：服务端版本不一致拦截时返回 ok:false 与提示", async () => {
    setupProject();
    const store = useQuickVideoStore();
    post.mockResolvedValueOnce(envelope(makeWorkbench({ configVersion: 2, version: 5 })));
    await store.getWorkbench();

    post.mockResolvedValueOnce({ code: "CONFIG_VERSION_MISMATCH", message: "参数已变更，请重新确认生成", currentVersion: 2 });
    post.mockResolvedValueOnce(envelope(makeWorkbench({ configVersion: 2, version: 5 })));

    const result = await store.confirmGeneration(1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_VERSION_MISMATCH");
      expect(result.error.message).toBe("参数已变更，请重新确认生成");
    }
  });

  it("updateConfig：目标时长支持 5-60 任意整数（如 12/18）", async () => {
    const id = setupProject();
    post.mockResolvedValueOnce(envelope(makeWorkbench({ version: 3, configVersion: 0 })));
    const store = useQuickVideoStore();
    await store.getWorkbench();

    post.mockResolvedValueOnce({ code: 200 });
    post.mockResolvedValueOnce(envelope(makeWorkbench({ version: 4, configVersion: 1, targetDuration: 12, artStyle: "水彩" })));

    const result = await store.updateConfig({ targetDuration: 12, artStyle: "水彩" });

    expect(post).toHaveBeenCalledWith(
      "/quickVideo/updateConfig",
      expect.objectContaining({ projectId: Number(id), expectedVersion: 3, patch: { targetDuration: 12, artStyle: "水彩" } }),
    );
    expect(result.ok).toBe(true);
    expect(store.state?.targetDuration).toBe(12);
  });
});
