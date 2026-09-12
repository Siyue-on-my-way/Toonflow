/**
 * 快创聊天媒体卡片与气泡展示（SIY-143）—— 纯展示层能力。
 *
 * 背景：tdesign-web-components 的 t-chat-item 对 assistant 消息中的 image 内容块固定
 * 渲染默认 <img> 气泡，无法通过插槽或 allowContentSegmentCustom 关闭；快创的媒体
 * 统一由 qvChatMediaCard 自定义卡片承载（查看大图/复制/设为首帧等操作都在卡片上）。
 * 因此传给 t-chat-message 的消息必须剥离 image/video 内容块，否则同一张媒体会出现
 * "默认图片气泡 + 自定义卡片"双重渲染。
 */
import { computed, toRaw, type Ref } from "vue";
import { isMediaBlock } from "@/utils/useChat";

export interface BubbleMessageView {
  /** 传入 t-chat-message 的展示副本：媒体块已剥离；同一消息对象返回同一副本引用 */
  bubbleMessageOf: (message: any) => any;
  /** 是否还有值得渲染的气泡内容；纯媒体消息返回 false，避免渲染空白气泡 */
  hasBubbleContent: (message: any) => boolean;
}

/**
 * 基于消息列表构造气泡展示视图。副本按消息对象记忆在 computed 里：聊天流式更新的是
 * 内容块内部数据（块类型/数量不变时 computed 不失效），副本引用保持稳定，避免每帧
 * 重建对象导致整列气泡无谓重渲染（t-chat-item 收到新 content 引用就会整条重绘）。
 */
export function createBubbleMessageView(messages: Ref<any[]>): BubbleMessageView {
  const displayCopies = computed(() => {
    // 键用 toRaw 归一：模板迭代拿到的是响应式代理，任何一侧拿到原始对象时查找仍然命中
    const map = new Map<object, any>();
    for (const message of messages.value) {
      const content = message?.content;
      if (!Array.isArray(content) || !content.some(isMediaBlock)) continue;
      map.set(toRaw(message), { ...message, content: content.filter((block: any) => !isMediaBlock(block)) });
    }
    return map;
  });

  function bubbleMessageOf(message: any) {
    return displayCopies.value.get(toRaw(message)) ?? message;
  }

  function hasBubbleContent(message: any): boolean {
    // 与 t-chat-item 内部展示规则对齐：pending / streaming 的空内容气泡承载"..."加载态，
    // 不能丢弃；其余情况只有在剥离媒体后仍有内容块时才渲染气泡
    if (message?.status === "pending" || message?.status === "streaming") return true;
    const content = bubbleMessageOf(message)?.content;
    return Array.isArray(content) ? content.length > 0 : Boolean(content);
  }

  return { bubbleMessageOf, hasBubbleContent };
}
