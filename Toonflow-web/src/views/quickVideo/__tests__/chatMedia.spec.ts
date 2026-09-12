/**
 * 快创聊天气泡展示视图单元测试（SIY-143）：
 * 覆盖媒体块剥离、纯媒体消息空气泡抑制、pending/streaming 加载态保留、
 * 展示副本引用稳定性（流式更新不整列重建）。
 */
import { describe, expect, it } from "vitest";
import { ref } from "vue";
import { createBubbleMessageView } from "../chatMedia";

function textBlock(data: string, status = "complete") {
  return { type: "text", data, status };
}

function mediaBlock(mediaId: number, overrides: Record<string, any> = {}) {
  return {
    type: "image",
    id: `img-${mediaId}`,
    data: { name: "一只猫", url: `http://x/${mediaId}.jpg` },
    status: "complete",
    ext: { mediaId, kind: "image", state: "done" },
    ...overrides,
  };
}

describe("createBubbleMessageView — 展示副本剥离（SIY-143）", () => {
  const messages = ref<any[]>([]);
  const { bubbleMessageOf, hasBubbleContent } = createBubbleMessageView(messages);

  it("不含媒体块的消息原样透传，不产生新对象", () => {
    const message = { id: "m1", role: "assistant", status: "complete", content: [textBlock("你好")] };
    messages.value = [message];
    expect(bubbleMessageOf(message)).toBe(message);
    expect(hasBubbleContent(message)).toBe(true);
  });

  it("文本 + 图片消息：副本剥离媒体块，文本块引用保持不变", () => {
    const text = textBlock("图片已生成");
    const image = mediaBlock(7);
    const message = { id: "m2", role: "assistant", status: "complete", content: [text, image] };
    messages.value = [message];

    const copy = bubbleMessageOf(message);
    expect(copy).not.toBe(message);
    expect(copy.content).toEqual([text]);
    // 副本里的块是同一响应式对象的引用，块内流式更新仍能透传到气泡
    expect(copy.content[0]).toBe(messages.value[0].content[0]);
    expect(hasBubbleContent(message)).toBe(true);
  });

  it("纯媒体消息（complete）：剥离后无内容，不渲染空气泡", () => {
    const message = { id: "media-7", role: "assistant", status: "complete", content: [mediaBlock(7)] };
    messages.value = [message];
    expect(hasBubbleContent(message)).toBe(false);
    expect(bubbleMessageOf(message).content).toEqual([]);
  });

  it("失败媒体消息（error）：不渲染气泡，错误信息由媒体卡片承载", () => {
    const message = { id: "media-8", role: "assistant", status: "error", content: [mediaBlock(8, { status: "error", ext: { mediaId: 8, kind: "image", state: "failed", errorReason: "供应商超时" } })] };
    messages.value = [message];
    expect(hasBubbleContent(message)).toBe(false);
  });

  it("pending 空内容消息保留气泡，承载加载态", () => {
    const message = { id: "m3", role: "assistant", status: "pending", content: [] };
    messages.value = [message];
    expect(hasBubbleContent(message)).toBe(true);
  });

  it("streaming 且只有媒体块时保留气泡（组件内部渲染加载态）", () => {
    const message = { id: "m4", role: "assistant", status: "streaming", content: [mediaBlock(9)] };
    messages.value = [message];
    expect(hasBubbleContent(message)).toBe(true);
  });

  it("错误单文本消息不受影响，仍渲染错误气泡", () => {
    const message = { id: "m5", role: "assistant", status: "error", content: [textBlock("请求出错")] };
    messages.value = [message];
    expect(hasBubbleContent(message)).toBe(true);
  });

  it("视频块同样剥离", () => {
    const message = {
      id: "m6",
      role: "assistant",
      status: "complete",
      content: [textBlock("视频好了"), { type: "video", data: { url: "http://x/v.mp4" }, status: "complete", ext: { mediaId: 10, kind: "video", state: "done" } }],
    };
    messages.value = [message];
    expect(bubbleMessageOf(message).content).toEqual([message.content[0]]);
  });
});

describe("createBubbleMessageView — 副本引用稳定性", () => {
  it("流式更新文本数据（块集合不变）时副本引用保持稳定", () => {
    const messages = ref<any[]>([]);
    const { bubbleMessageOf } = createBubbleMessageView(messages);
    const message = { id: "m7", role: "assistant", status: "streaming", content: [textBlock("部分", "streaming"), mediaBlock(11)] };
    messages.value = [message];

    const first = bubbleMessageOf(message);
    // 通过响应式代理更新块内数据：视图只追踪块的类型/数量，不因文本流式刷新而重建副本
    messages.value[0].content[0].data = "部分回复";
    expect(bubbleMessageOf(messages.value[0])).toBe(first);
  });

  it("媒体块后续加入时副本随之更新", () => {
    const messages = ref<any[]>([]);
    const { bubbleMessageOf, hasBubbleContent } = createBubbleMessageView(messages);
    messages.value = [{ id: "m8", role: "assistant", status: "complete", content: [textBlock("图片已生成")] }];
    const proxy = messages.value[0];
    expect(bubbleMessageOf(proxy)).toBe(proxy);

    proxy.content.push(mediaBlock(12));
    const copy = bubbleMessageOf(proxy);
    expect(copy).not.toBe(proxy);
    expect(copy.content).toHaveLength(1);
    expect(hasBubbleContent(proxy)).toBe(true);
  });

  it("content 不是数组时原样透传，不渲染空气泡判定为有内容", () => {
    const messages = ref<any[]>([]);
    const { bubbleMessageOf, hasBubbleContent } = createBubbleMessageView(messages);
    const message = { id: "m9", role: "assistant", status: "complete", content: "legacy-text" };
    messages.value = [message];
    expect(bubbleMessageOf(messages.value[0])).toBe(messages.value[0]);
    expect(hasBubbleContent(messages.value[0])).toBe(true);
  });
});
