/** 视频引用守门纯函数测试（SIY-164）：图片引用放行、视频引用拦截、发送前兜底过滤 */
import { describe, expect, it } from "vitest";
import { collectImageReferenceIds, isImageMediaRef } from "../mediaRefGuard";
import type { MediaRef } from "@/types/quickVideo";

const ref = (overrides: Partial<MediaRef> = {}): MediaRef => ({
  mediaId: 1,
  projectId: 100,
  kind: "image",
  assetId: null,
  imageId: null,
  videoId: null,
  state: "done",
  model: null,
  promptSummary: null,
  source: "chat",
  errorReason: null,
  url: null,
  createTime: 1000,
  ...overrides,
});

describe("isImageMediaRef（SIY-164 视频素材复制引用守门）", () => {
  it("图片引用放行", () => {
    expect(isImageMediaRef(ref({ kind: "image" }))).toBe(true);
  });

  it("视频引用被拦截", () => {
    expect(isImageMediaRef(ref({ kind: "video", videoId: 9 }))).toBe(false);
  });

  it("空引用视为不通过", () => {
    expect(isImageMediaRef(null)).toBe(false);
    expect(isImageMediaRef(undefined)).toBe(false);
  });
});

describe("collectImageReferenceIds（发送前兜底过滤历史遗留视频引用）", () => {
  it("只保留图片引用并按 mediaId 去重保序", () => {
    const result = collectImageReferenceIds([
      ref({ mediaId: 11 }),
      ref({ mediaId: 11 }),
      ref({ mediaId: 12, kind: "video", videoId: 5 }),
      ref({ mediaId: 13 }),
      null,
    ]);
    expect(result.referenceIds).toEqual([11, 13]);
    expect(result.droppedCount).toBe(1);
  });

  it("全部为视频引用时返回空列表并计数", () => {
    const result = collectImageReferenceIds([ref({ mediaId: 21, kind: "video" }), ref({ mediaId: 22, kind: "video" })]);
    expect(result.referenceIds).toEqual([]);
    expect(result.droppedCount).toBe(2);
  });

  it("空候选列表返回空结果", () => {
    expect(collectImageReferenceIds([])).toEqual({ referenceIds: [], droppedCount: 0 });
  });
});
