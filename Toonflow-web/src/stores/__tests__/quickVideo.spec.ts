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
