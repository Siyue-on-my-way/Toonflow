/** 快创导出进度组件测试（SIY-111）：状态驱动的展示与交互事件 */
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ExportProgress from "../ExportProgress.vue";

const baseProps = {
  visible: true,
  status: "idle" as const,
  progress: 0,
  fileName: "quick-video-1-20260907.mp4",
  title: "MP4 编码",
  cancelText: "取消",
  retryText: "重试",
  closeText: "关闭",
};

describe("ExportProgress.vue", () => {
  it("visible=false 时不渲染", () => {
    const wrapper = mount(ExportProgress, { props: { ...baseProps, visible: false } });
    expect(wrapper.find('[data-testid="qv-export-progress"]').exists()).toBe(false);
  });

  it("encoding 状态展示进度与文件名，提供取消", async () => {
    const wrapper = mount(ExportProgress, { props: { ...baseProps, status: "encoding", progress: 42, metaLine: "1280×720 · 4.5 MB" } });
    expect(wrapper.find('[data-testid="qv-export-file"]').text()).toContain("quick-video-1-20260907.mp4");
    expect(wrapper.find('[data-testid="qv-export-percent"]').text()).toBe("42%");
    expect(wrapper.find('[data-testid="qv-export-bar"] .qvExportBarFill').attributes("style")).toContain("width: 42%");
    expect(wrapper.find('[data-testid="qv-export-cancel"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="qv-export-retry"]').exists()).toBe(false);

    await wrapper.find('[data-testid="qv-export-cancel"]').trigger("click");
    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });

  it("error 状态展示错误信息与重试/关闭", async () => {
    const wrapper = mount(ExportProgress, { props: { ...baseProps, status: "error", progress: 60, errorMessage: "镜头 2 视频下载失败" } });
    expect(wrapper.find('[data-testid="qv-export-error"]').text()).toContain("镜头 2 视频下载失败");
    expect(wrapper.find('[data-testid="qv-export-retry"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="qv-export-cancel"]').exists()).toBe(false);

    await wrapper.find('[data-testid="qv-export-retry"]').trigger("click");
    await wrapper.find('[data-testid="qv-export-close"]').trigger("click");
    expect(wrapper.emitted("retry")).toHaveLength(1);
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("success 状态提供关闭且无取消/重试，进度钳制到 0-100", async () => {
    const wrapper = mount(ExportProgress, { props: { ...baseProps, status: "success", progress: 120 } });
    expect(wrapper.find('[data-testid="qv-export-percent"]').text()).toBe("100%");
    expect(wrapper.find('[data-testid="qv-export-cancel"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="qv-export-retry"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="qv-export-close"]').exists()).toBe(true);
    await wrapper.find('[data-testid="qv-export-close"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("warning 状态说明文件已生成但状态待保存，并允许只重试回写", async () => {
    const wrapper = mount(ExportProgress, {
      props: { ...baseProps, status: "warning", progress: 100, errorMessage: "文件已下载，等待保存" },
    });
    expect(wrapper.find('[data-testid="qv-export-error"]').text()).toContain("文件已下载");
    expect(wrapper.find('[data-testid="qv-export-retry"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="qv-export-close"]').exists()).toBe(true);

    await wrapper.find('[data-testid="qv-export-retry"]').trigger("click");
    expect(wrapper.emitted("retry")).toHaveLength(1);
  });
});
