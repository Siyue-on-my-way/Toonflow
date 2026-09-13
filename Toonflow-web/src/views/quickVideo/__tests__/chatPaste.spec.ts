import { describe, expect, it } from "vitest";
import { isValidMediaRef, readMediaRefsFromText, CHAT_REFERENCE_MAX } from "../chatPaste";
import type { MediaRef } from "@/types/quickVideo";

const ref: MediaRef = {
  mediaId: 12,
  projectId: 1,
  kind: "image",
  assetId: 3,
  imageId: 5,
  videoId: null,
  state: "done",
  model: null,
  promptSummary: "截图",
  source: "upload",
  errorReason: null,
  url: "/oss/1/quickVideo/a.png",
  createTime: 1,
};

describe("chatPaste（SIY-144 聊天输入框粘贴解析）", () => {
  it("isValidMediaRef：必须有正整数 mediaId，拒绝 Base64/path 伪引用", () => {
    expect(isValidMediaRef(ref)).toBe(true);
    expect(isValidMediaRef({ mediaId: 1 })).toBe(true);
    expect(isValidMediaRef({})).toBe(false);
    expect(isValidMediaRef({ mediaId: 0 })).toBe(false);
    expect(isValidMediaRef({ mediaId: -1 })).toBe(false);
    expect(isValidMediaRef({ mediaId: "12" })).toBe(false);
    expect(isValidMediaRef({ mediaId: 1, base64: "xxxx" })).toBe(false);
    expect(isValidMediaRef({ mediaId: 1, path: "/1/quickVideo/a.jpg" })).toBe(false);
    expect(isValidMediaRef(null)).toBe(false);
  });

  it("readMediaRefsFromText：解析单个对象或数组，非法输入返回 null", () => {
    expect(readMediaRefsFromText(JSON.stringify(ref))).toEqual([ref]);
    expect(readMediaRefsFromText(JSON.stringify([ref, { mediaId: 9 }]))).toHaveLength(2);
    expect(readMediaRefsFromText("普通文本")).toBeNull();
    expect(readMediaRefsFromText("{not json")).toBeNull();
    expect(readMediaRefsFromText(JSON.stringify({}))).toBeNull();
    expect(readMediaRefsFromText("")).toBeNull();
    expect(readMediaRefsFromText(null)).toBeNull();
  });

  it("readMediaRefsFromText：超过单轮引用上限时整体拒绝", () => {
    const many = Array.from({ length: CHAT_REFERENCE_MAX + 1 }, (_, i) => ({ mediaId: i + 1 }));
    expect(readMediaRefsFromText(JSON.stringify(many))).toBeNull();
    expect(readMediaRefsFromText(JSON.stringify(many.slice(0, CHAT_REFERENCE_MAX)))).toHaveLength(CHAT_REFERENCE_MAX);
  });
});
