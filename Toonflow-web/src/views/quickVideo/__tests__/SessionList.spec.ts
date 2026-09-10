/** 快创会话列表组件测试（SIY-128）：展示、切换、新建、重命名、归档交互事件 */
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import SessionList from "../components/SessionList.vue";
import type { QuickVideoSession } from "@/types/quickVideo";

const session = (overrides: Partial<QuickVideoSession> = {}): QuickVideoSession => ({
  id: 1,
  projectId: 100,
  title: "会话A",
  status: "active",
  textModel: null,
  imageModel: null,
  videoModel: null,
  createTime: 1,
  updateTime: 1,
  ...overrides,
});

const baseProps = {
  sessions: [] as QuickVideoSession[],
  currentSessionId: null as number | null,
  title: "会话",
  createText: "新建会话",
  emptyText: "暂无会话",
  renameText: "重命名",
  archiveText: "归档",
  unarchiveText: "取消归档",
  archivedText: "已归档",
  defaultTitleText: "默认会话",
};

describe("SessionList.vue", () => {
  it("没有会话时展示空态", () => {
    const wrapper = mount(SessionList, { props: baseProps });
    expect(wrapper.find('[data-testid="qv-session-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="qv-session-item"]').exists()).toBe(false);
  });

  it("收起时只展示当前会话标题，不平铺会话项", () => {
    const sessions = [session({ id: 1, title: "会话A" }), session({ id: 2, title: "会话B" })];
    const wrapper = mount(SessionList, { props: { ...baseProps, sessions, currentSessionId: 2 } });
    expect(wrapper.find('[data-testid="qv-session-current"]').text()).toBe("会话B");
    expect(wrapper.find('[data-testid="qv-session-trigger"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="qv-session-item"]')).toHaveLength(0);
  });

  it("展开后点击会话项触发 select，携带对应 sessionId", async () => {
    const sessions = [session({ id: 1 }), session({ id: 2 })];
    const wrapper = mount(SessionList, { props: { ...baseProps, sessions, currentSessionId: 1 } });
    await wrapper.find('[data-testid="qv-session-trigger"]').trigger("click");
    await wrapper.findAll('[data-testid="qv-session-option"]')[1].trigger("click");
    expect(wrapper.emitted("select")).toEqual([[2]]);
  });

  it("点击新建按钮触发 create", async () => {
    const wrapper = mount(SessionList, { props: baseProps });
    await wrapper.find('[data-testid="qv-session-create"]').trigger("click");
    expect(wrapper.emitted("create")).toHaveLength(1);
  });

  it("归档会话不展示，活动会话仍可归档且不触发 select", async () => {
    const sessions = [session({ id: 1, title: "活动会话" }), session({ id: 2, title: "旧会话", status: "archived" })];
    const wrapper = mount(SessionList, { props: { ...baseProps, sessions, currentSessionId: 1 } });
    expect(wrapper.text()).not.toContain("旧会话");
    expect(wrapper.find('[data-session-id="2"]').exists()).toBe(false);
    await wrapper.find('[data-testid="qv-session-archive"]').trigger("click");
    expect(wrapper.emitted("toggleArchive")).toEqual([[1]]);
    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("重命名：点击编辑图标进入输入态，回车提交 rename 且不触发 select", async () => {
    const sessions = [session({ id: 1, title: "旧标题" })];
    const wrapper = mount(SessionList, { props: { ...baseProps, sessions, currentSessionId: 1 } });
    await wrapper.find('[data-testid="qv-session-rename"]').trigger("click");
    const input = wrapper.find('[data-testid="qv-session-rename-input"]');
    expect(input.exists()).toBe(true);
    await input.setValue("新标题");
    await input.trigger("keyup.enter");
    expect(wrapper.emitted("rename")).toEqual([[1, "新标题"]]);
    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("重命名为空白时不触发 rename", async () => {
    const sessions = [session({ id: 1, title: "旧标题" })];
    const wrapper = mount(SessionList, { props: { ...baseProps, sessions, currentSessionId: 1 } });
    await wrapper.find('[data-testid="qv-session-rename"]').trigger("click");
    const input = wrapper.find('[data-testid="qv-session-rename-input"]');
    await input.setValue("   ");
    await input.trigger("keyup.enter");
    expect(wrapper.emitted("rename")).toBeUndefined();
  });
});
