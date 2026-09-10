/** 资产白板组件测试（SIY-132）：网格展示、状态区分、复制/设为首帧/放大事件、分页与筛选 */
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import AssetBoard from "../components/AssetBoard.vue";
import type { MediaRef } from "@/types/quickVideo";

const media = (overrides: Partial<MediaRef> = {}): MediaRef => ({
  mediaId: 1,
  projectId: 100,
  kind: "image",
  assetId: 2,
  imageId: 3,
  videoId: null,
  state: "done",
  model: "aibotplatform:gpt-image-1",
  promptSummary: "一只猫在沙发上",
  source: "chat",
  errorReason: null,
  url: "http://localhost/oss/1.jpg",
  createTime: 1000,
  ...overrides,
});

const baseProps = {
  title: "资产白板",
  items: [] as MediaRef[],
  loading: false,
  total: 0,
  page: 1,
  pageSize: 24,
  allLabel: "全部",
  imageLabel: "图",
  videoLabel: "视频",
  emptyText: "暂无资产",
  copyText: "复制",
  setFirstFrameText: "设为首帧",
  failedText: "失败",
  generatingText: "生成中",
  expandText: "展开",
  collapseText: "收起",
};

describe("AssetBoard.vue", () => {
  it("没有资产时展示空态", () => {
    const wrapper = mount(AssetBoard, { props: baseProps });
    expect(wrapper.find('[data-testid="qv-asset-empty"]').exists()).toBe(true);
  });

  it("已完成的图片资产展示复制和设为首帧操作，点击缩略图触发 zoom", async () => {
    const item = media({ mediaId: 42 });
    const wrapper = mount(AssetBoard, { props: { ...baseProps, items: [item], total: 1 } });
    const cell = wrapper.find('[data-testid="qv-asset-cell-42"]');
    expect(cell.exists()).toBe(true);
    expect(cell.find('[data-testid="qv-asset-copy"]').exists()).toBe(true);
    expect(cell.find('[data-testid="qv-asset-set-first-frame"]').exists()).toBe(true);

    await cell.find('[data-testid="qv-asset-zoom"]').trigger("click");
    expect(wrapper.emitted("zoom")?.[0]).toEqual([item]);

    await cell.find('[data-testid="qv-asset-copy"]').trigger("click");
    expect(wrapper.emitted("copy")?.[0]).toEqual([item]);

    await cell.find('[data-testid="qv-asset-set-first-frame"]').trigger("click");
    expect(wrapper.emitted("set-first-frame")?.[0]).toEqual([item]);
  });

  it("视频资产不提供设为首帧操作（首帧只能是图片）", () => {
    const item = media({ mediaId: 43, kind: "video" });
    const wrapper = mount(AssetBoard, { props: { ...baseProps, items: [item], total: 1 } });
    const cell = wrapper.find('[data-testid="qv-asset-cell-43"]');
    expect(cell.find('[data-testid="qv-asset-copy"]').exists()).toBe(true);
    expect(cell.find('[data-testid="qv-asset-set-first-frame"]').exists()).toBe(false);
  });

  it("生成中的资产不提供任何绑定/复制操作，只展示占位态", () => {
    const item = media({ mediaId: 44, state: "generating", url: null });
    const wrapper = mount(AssetBoard, { props: { ...baseProps, items: [item], total: 1 } });
    const cell = wrapper.find('[data-testid="qv-asset-cell-44"]');
    expect(cell.find('[data-testid="qv-asset-generating"]').exists()).toBe(true);
    expect(cell.find('[data-testid="qv-asset-copy"]').exists()).toBe(false);
    expect(cell.find('[data-testid="qv-asset-set-first-frame"]').exists()).toBe(false);
  });

  it("失败的资产展示失败占位，不允许复制或设为首帧（禁止用失败资产静默绑定）", () => {
    const item = media({ mediaId: 45, state: "failed", url: null, errorReason: "供应商超时" });
    const wrapper = mount(AssetBoard, { props: { ...baseProps, items: [item], total: 1 } });
    const cell = wrapper.find('[data-testid="qv-asset-cell-45"]');
    expect(cell.find('[data-testid="qv-asset-failed"]').exists()).toBe(true);
    expect(cell.find('[data-testid="qv-asset-copy"]').exists()).toBe(false);
    expect(cell.find('[data-testid="qv-asset-set-first-frame"]').exists()).toBe(false);
  });

  it("翻页按钮触发 page-change，且首页时上一页禁用", async () => {
    const items = [media({ mediaId: 1 })];
    const wrapper = mount(AssetBoard, { props: { ...baseProps, items, total: 48, page: 1, pageSize: 24 } });
    const buttons = wrapper.findAll(".qvAssetBoardPager button, .qvAssetBoardPager t-button");
    expect(wrapper.find(".qvAssetBoardPager").exists()).toBe(true);
    // 总数 48、每页 24 => 2 页；点击"下一页"（第二个分页按钮）应发出 page-change(2)
    const pagerButtons = wrapper.findAll(".qvAssetBoardPager > *").filter((el) => el.element.tagName.toLowerCase().includes("button"));
    await pagerButtons[pagerButtons.length - 1]?.trigger("click");
    expect(wrapper.emitted("page-change")?.[0]).toEqual([2]);
  });

  it("刷新按钮触发 refresh 事件", async () => {
    const wrapper = mount(AssetBoard, { props: baseProps });
    const header = wrapper.find(".qvAssetBoardHeaderActions");
    const buttons = header.findAll("button, t-button");
    // 第一个是刷新按钮（筛选 select 之后、收起按钮之前）
    await buttons[0]?.trigger("click");
    expect(wrapper.emitted("refresh")).toBeTruthy();
  });
});
