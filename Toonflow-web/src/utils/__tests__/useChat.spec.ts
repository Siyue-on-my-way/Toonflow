/**
 * dedupeRestoredMessages 单元测试（SIY-143）：
 * 历史恢复的防御性去重——按消息 id 与媒体块 ext.mediaId 判重，绝不按 URL/提示词判重。
 */
import { describe, expect, it } from "vitest";
import { dedupeRestoredMessages, isMediaBlock } from "../useChat";

function mediaMessage(id: string, mediaId: number, overrides: Record<string, any> = {}) {
  return {
    id,
    role: "assistant",
    status: "complete",
    content: [{ type: "image", data: { url: `http://x/${mediaId}.jpg` }, status: "complete", ext: { mediaId, kind: "image", state: "done" } }],
    ...overrides,
  };
}

describe("dedupeRestoredMessages", () => {
  it("同一 mediaId 的重复媒体消息只保留第一条", () => {
    const a = mediaMessage("media-7", 7);
    const b = mediaMessage("media-7-dup", 7);
    const result = dedupeRestoredMessages([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(a);
  });

  it("同一消息内重复的媒体块只保留一个", () => {
    const message = {
      id: "m1",
      role: "assistant",
      status: "complete",
      content: [
        { type: "text", data: "生成完成", status: "complete" },
        { type: "image", data: { url: "http://x/7.jpg" }, status: "complete", ext: { mediaId: 7 } },
        { type: "image", data: { url: "http://x/7.jpg" }, status: "complete", ext: { mediaId: 7 } },
      ],
    };
    const result = dedupeRestoredMessages([message]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(2);
    expect(result[0].content[0].data).toBe("生成完成");
    expect(result[0].content[1].ext.mediaId).toBe(7);
  });

  it("不同 mediaId 不误删：同 URL / 同提示词的两次生成各自保留", () => {
    const a = mediaMessage("media-7", 7);
    const b = mediaMessage("media-8", 8);
    const result = dedupeRestoredMessages([a, b]);
    expect(result).toHaveLength(2);
  });

  it("没有 ext.mediaId 的媒体块不参与判重，原样保留", () => {
    const message = {
      id: "m2",
      role: "assistant",
      status: "complete",
      content: [
        { type: "image", data: { url: "http://x/a.jpg" }, status: "complete" },
        { type: "image", data: { url: "http://x/a.jpg" }, status: "complete" },
      ],
    };
    const result = dedupeRestoredMessages([message]);
    expect(result[0].content).toHaveLength(2);
  });

  it("媒体块全部去重后内容为空的消息整条丢弃", () => {
    const keep = { id: "t1", role: "assistant", status: "complete", content: [{ type: "markdown", data: "# 简报", status: "complete" }] };
    const first = mediaMessage("media-7", 7);
    const dup = mediaMessage("media-7-dup", 7);
    // first 是 mediaId=7 的首次合法出现，必须保留；dup 的媒体块与 first 重复，
    // 剥离后内容为空，作为纯媒体消息的重复副本整条丢弃
    const result = dedupeRestoredMessages([keep, first, dup]);
    expect(result).toEqual([keep, first]);
  });

  it("重复的消息 id 只保留第一条（防重放挂载重复气泡）", () => {
    const a = { id: "hist-1", role: "assistant", status: "complete", content: [{ type: "markdown", data: "第一份", status: "complete" }] };
    const b = { id: "hist-1", role: "assistant", status: "complete", content: [{ type: "markdown", data: "第二份", status: "complete" }] };
    const result = dedupeRestoredMessages([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].content[0].data).toBe("第一份");
  });

  it("非数组 content 的消息原样保留", () => {
    const message = { id: "m3", role: "user", status: "complete", content: "legacy" } as any;
    expect(dedupeRestoredMessages([message])).toEqual([message]);
  });

  it("空输入返回空数组", () => {
    expect(dedupeRestoredMessages([])).toEqual([]);
  });
});

describe("isMediaBlock", () => {
  it("image / video 判为媒体块，其余类型与空值判否", () => {
    expect(isMediaBlock({ type: "image" })).toBe(true);
    expect(isMediaBlock({ type: "video" })).toBe(true);
    expect(isMediaBlock({ type: "markdown" })).toBe(false);
    expect(isMediaBlock(null)).toBe(false);
    expect(isMediaBlock(undefined)).toBe(false);
  });
});
