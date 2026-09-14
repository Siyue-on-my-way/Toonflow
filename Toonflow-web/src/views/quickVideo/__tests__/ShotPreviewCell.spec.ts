/** 分镜表预览单元格测试（SIY-147）：双卡片并排、封面降级、骨架屏、状态占位与重试、地址失效刷新 */
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ShotPreviewCell from "../components/ShotPreviewCell.vue";
import type { QuickVideoShot } from "@/types/quickVideo";

const baseShot = (overrides: Partial<QuickVideoShot> = {}): QuickVideoShot => ({
  id: "shot-1",
  index: 1,
  duration: 5,
  description: "镜头描述",
  dialogue: "",
  camera: "特写",
  assetRefs: [],
  imageState: "done",
  videoState: "done",
  imageRef: "/1/quickVideo/a.jpg",
  videoRef: "/1/quickVideo/a.mp4",
  errorReason: null,
  firstFrame: null,
  ...overrides,
});

const urls = (overrides: Record<string, string | null> = {}) => ({
  imageUrl: "http://localhost/oss/1/quickVideo/a.jpg?size=20",
  videoUrl: "http://localhost/oss/1/quickVideo/a.mp4",
  videoPosterUrl: "http://localhost/oss/1/quickVideo/poster.jpg?size=20",
  firstFrameUrl: null,
  ...overrides,
});

const baseProps = (overrides: Record<string, unknown> = {}) => ({
  shot: baseShot(),
  urls: urls(),
  imageLabel: "图",
  videoLabel: "视频",
  generatingText: "生成中",
  failedText: "失败",
  imageUnavailableText: "图片预览不可用",
  videoUnavailableText: "视频预览不可用",
  retryText: "重试该镜头",
  ...overrides,
});

const mountCell = (options: Parameters<typeof mount>[1] = {}) =>
  mount(ShotPreviewCell, {
    global: {
      stubs: {
        "t-loading": true,
        "i-close-circle": true,
        "i-refresh": true,
        "i-play-circle": true,
      },
    },
    ...options,
  });

describe("ShotPreviewCell.vue", () => {
  it("图片与视频均完成时双卡片并排呈现，视频卡片有封面、播放按钮和类型角标", () => {
    const wrapper = mountCell({ props: baseProps() });
    const img = wrapper.find('[data-testid="qv-shot-image-img"]');
    const poster = wrapper.find('[data-testid="qv-shot-video-poster"]');
    expect(img.exists()).toBe(true);
    expect(poster.exists()).toBe(true);
    expect(wrapper.find('[data-testid="qv-shot-video-play"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="qv-shot-image-badge"]').text()).toBe("图");
    expect(wrapper.find('[data-testid="qv-shot-video-badge"]').text()).toBe("视频");
  });

  it("点击图片卡片与视频卡片分别触发 open-image / open-video（单元格内不播放）", async () => {
    const wrapper = mountCell({ props: baseProps() });
    await wrapper.find('[data-testid="qv-shot-image-card"]').trigger("click");
    expect(wrapper.emitted("open-image")?.[0]).toEqual([urls().imageUrl]);
    await wrapper.find('[data-testid="qv-shot-video-card"]').trigger("click");
    expect(wrapper.emitted("open-video")?.[0]).toEqual([urls().videoUrl]);
    expect(wrapper.emitted("open-video")!.length).toBe(1);
  });

  it("无海报封面时回退 <video preload=metadata> 抽首帧；海报加载失败也降级到 metadata 视频", async () => {
    const noPoster = mountCell({ props: baseProps({ urls: urls({ videoPosterUrl: null }) }) });
    expect(noPoster.find('[data-testid="qv-shot-video-meta"]').exists()).toBe(true);
    expect(noPoster.find('[data-testid="qv-shot-video-meta"]').attributes("preload")).toBe("metadata");
    expect((noPoster.find('[data-testid="qv-shot-video-meta"]').element as HTMLVideoElement).muted).toBe(true);

    const posterFails = mountCell({ props: baseProps() });
    await posterFails.find('[data-testid="qv-shot-video-poster"]').trigger("error");
    expect(posterFails.find('[data-testid="qv-shot-video-meta"]').exists()).toBe(true);
    expect(posterFails.find('[data-testid="qv-shot-video-unavailable"]').exists()).toBe(false);
  });

  it("无海报封面且 metadata 视频也失败时直接展示「视频预览不可用」卡片，保留播放弹窗入口", async () => {
    const wrapper = mountCell({ props: baseProps({ urls: urls({ videoPosterUrl: null }) }) });
    expect(wrapper.find('[data-testid="qv-shot-video-meta"]').exists()).toBe(true);
    await wrapper.find('[data-testid="qv-shot-video-meta"]').trigger("error");
    expect(wrapper.find('[data-testid="qv-shot-video-unavailable"]').exists()).toBe(true);
    expect(wrapper.emitted("refresh")!.length).toBe(1);
    await wrapper.find('[data-testid="qv-shot-video-card"]').trigger("click");
    expect(wrapper.emitted("open-video")?.[0]).toEqual([urls().videoUrl]);
  });

  it("metadata 视频也失败时展示「视频预览不可用」卡片，且仍保留播放弹窗入口；同一地址只自动刷新一次", async () => {
    const wrapper = mountCell({ props: baseProps() });
    await wrapper.find('[data-testid="qv-shot-video-poster"]').trigger("error");
    await wrapper.find('[data-testid="qv-shot-video-meta"]').trigger("error");
    expect(wrapper.find('[data-testid="qv-shot-video-unavailable"]').exists()).toBe(true);
    expect(wrapper.emitted("refresh")!.length).toBe(1);

    // 弹窗入口保留：点击仍触发 open-video
    await wrapper.find('[data-testid="qv-shot-video-card"]').trigger("click");
    expect(wrapper.emitted("open-video")?.[0]).toEqual([urls().videoUrl]);

    // reloadTick 重挂载后同一地址再次失败，不再重复触发 refresh，避免刷新循环
    await wrapper.setProps({ reloadTick: 1, urls: urls() });
    await wrapper.find('[data-testid="qv-shot-video-poster"]').trigger("error");
    await wrapper.find('[data-testid="qv-shot-video-meta"]').trigger("error");
    expect(wrapper.find('[data-testid="qv-shot-video-unavailable"]').exists()).toBe(true);
    expect(wrapper.emitted("refresh")!.length).toBe(1);
  });

  it("图片加载失败展示不可用卡并触发一次静默刷新，点击后可重新触发手动刷新", async () => {
    const wrapper = mountCell({ props: baseProps() });
    await wrapper.find('[data-testid="qv-shot-image-img"]').trigger("error");
    expect(wrapper.find('[data-testid="qv-shot-image-unavailable"]').exists()).toBe(true);
    expect(wrapper.emitted("refresh")!.length).toBe(1);
    await wrapper.find('[data-testid="qv-shot-image-card"]').trigger("click");
    expect(wrapper.emitted("refresh")!.length).toBe(2);
    expect(wrapper.emitted("open-image")).toBeUndefined();
  });

  it("生成中/待生成/失败状态互不阻塞：图片生成中时视频卡片正常展示封面", () => {
    const wrapper = mountCell({
      props: baseProps({ shot: baseShot({ imageState: "generating" }) }),
    });
    expect(wrapper.find('[data-testid="qv-shot-image-generating"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="qv-shot-image-img"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="qv-shot-video-poster"]').exists()).toBe(true);
  });

  it("视频失败展示失败卡与重试入口（仅 generating 阶段），点击触发 retry", async () => {
    const shot = baseShot({ videoState: "failed", errorReason: "供应商超时" });
    const retryable = mountCell({ props: baseProps({ shot, canRetry: true }) });
    expect(retryable.find('[data-testid="qv-shot-video-failed"]').exists()).toBe(true);
    expect(retryable.find('[data-testid="qv-shot-video-failed"]').attributes("title")).toContain("供应商超时");
    expect(retryable.find('[data-testid="qv-shot-video-retry"]').exists()).toBe(true);
    await retryable.find('[data-testid="qv-shot-video-retry"]').trigger("click");
    expect(retryable.emitted("retry")).toHaveLength(1);

    const notRetryable = mountCell({ props: baseProps({ shot }) });
    expect(notRetryable.find('[data-testid="qv-shot-video-retry"]').exists()).toBe(false);
  });

  it("镜头完成但地址未返回时：请求中展示骨架屏，请求完成仍无地址展示不可用卡并可点击刷新", async () => {
    const pending = mountCell({ props: baseProps({ urls: null, urlsPending: true }) });
    expect(pending.find('[data-testid="qv-shot-image-skeleton"]').exists()).toBe(true);
    expect(pending.find('[data-testid="qv-shot-video-skeleton"]').exists()).toBe(true);

    const stale = mountCell({
      props: baseProps({ urls: urls({ imageUrl: null, videoUrl: null, videoPosterUrl: null }) }),
    });
    expect(stale.find('[data-testid="qv-shot-image-unavailable"]').exists()).toBe(true);
    expect(stale.find('[data-testid="qv-shot-video-unavailable"]').exists()).toBe(true);
    await stale.find('[data-testid="qv-shot-video-card"]').trigger("click");
    expect(stale.emitted("refresh")).toHaveLength(1);
  });

  it("reloadTick 变化重置内部失败态，地址失效后静默刷新可恢复重试", async () => {
    const wrapper = mountCell({ props: baseProps() });
    await wrapper.find('[data-testid="qv-shot-image-img"]').trigger("error");
    expect(wrapper.find('[data-testid="qv-shot-image-unavailable"]').exists()).toBe(true);
    await wrapper.setProps({ reloadTick: 1, urls: urls() });
    // 重置后等待骨架屏状态：图片重新进入加载流程，不可用卡消失
    expect(wrapper.find('[data-testid="qv-shot-image-unavailable"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="qv-shot-image-img"]').exists()).toBe(true);
  });
});
