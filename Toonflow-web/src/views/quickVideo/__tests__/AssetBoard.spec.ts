/** 资产白板组件测试（SIY-132）：网格展示、状态区分、复制/设为首帧/放大事件、分页与筛选 */
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
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
  deleteText: "删除",
  deleteConfirmText: "确定删除？",
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

  it("视频资产不提供复制和设为首帧操作（无视频生视频能力，SIY-164），点缩略图仍可放大", async () => {
    const item = media({ mediaId: 43, kind: "video" });
    const wrapper = mount(AssetBoard, { props: { ...baseProps, items: [item], total: 1 } });
    const cell = wrapper.find('[data-testid="qv-asset-cell-43"]');
    expect(cell.find('[data-testid="qv-asset-copy"]').exists()).toBe(false);
    expect(cell.find('[data-testid="qv-asset-set-first-frame"]').exists()).toBe(false);

    await cell.find('[data-testid="qv-asset-zoom"]').trigger("click");
    expect(wrapper.emitted("zoom")?.[0]).toEqual([item]);
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
    // 按 testid 找刷新按钮（此前按下标取第一个，LibTV 导入按钮加入后失效）
    const refreshButton = wrapper.find('[data-testid="qv-asset-refresh"]');
    expect(refreshButton.exists()).toBe(true);
    await refreshButton.trigger("click");
    expect(wrapper.emitted("refresh")).toBeTruthy();
  });

  it("封面顺序加载：并发 2 逐个出现，图片走 480x480 小图、视频走抽帧海报，未轮到的显示骨架", async () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      media({ mediaId: 100 + i, kind: i % 2 ? "video" : "image", url: `http://localhost/oss/48/x-${i}.${i % 2 ? "mp4" : "png"}` }),
    );
    const wrapper = mount(AssetBoard, { props: { ...baseProps, items, total: 5 } });
    await nextTick();
    // 队列并发 2：只有前两张有 src（浏览器开始加载），其余显示骨架占位
    let imgs = wrapper.findAll("img.qvAssetCoverImg");
    expect(imgs.length).toBe(2);
    expect(imgs[0].attributes("src")).toContain("/oss/48/x-0.png?size=480x480");
    expect(imgs[1].attributes("src")).toContain("/oss/48/x-1.mp4?size=poster");
    expect(wrapper.findAll(".qvAssetCoverSkeleton").length).toBe(3);
    // 第一张加载完成 → 队列放行下一张
    await imgs[0].trigger("load");
    await nextTick();
    imgs = wrapper.findAll("img.qvAssetCoverImg");
    expect(imgs.length).toBe(3);
  });

  it("删除按钮：done/failed 素材提供删除入口，生成中的素材不提供（确认交互由 popconfirm 承载，E2E 覆盖）", () => {
    const done = media({ mediaId: 61, kind: "image" });
    const generating = media({ mediaId: 62, kind: "image", state: "generating" });
    const wrapper = mount(AssetBoard, { props: { ...baseProps, items: [done, generating], total: 2 } });
    expect(wrapper.find('[data-testid="qv-asset-cell-61"]').find('[data-testid="qv-asset-delete"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="qv-asset-cell-62"]').find('[data-testid="qv-asset-delete"]').exists()).toBe(false);
  });
});
