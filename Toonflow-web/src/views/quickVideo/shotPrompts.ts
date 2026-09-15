/**
 * 分镜表 Prompt 策划板的纯展示/填入逻辑（SIY-151）。
 *
 * 分镜表瘦身为"创意与 Prompt 策划中心"后，每行镜头的生成动作全部发生在聊天窗：
 * 本模块只负责把镜头的双提示词（imagePrompt/videoPrompt）整理成一键填入聊天框的
 * 文案与多镜批量语法，不触碰状态机 / Socket / WebAV。
 */
import type { QuickVideoShot } from "@/types/quickVideo";

/** 生图填入文案：优先分镜表策划的 imagePrompt，未填写时回退画面描述 */
export function buildImageFillPrompt(shot: Pick<QuickVideoShot, "imagePrompt" | "description">): string {
  const planned = shot.imagePrompt?.trim();
  if (planned) return planned;
  return shot.description?.trim() || "";
}

/** 生视频填入文案：优先分镜表策划的 videoPrompt，未填写时按画面描述 + 运镜拼装 */
export function buildVideoFillPrompt(shot: Pick<QuickVideoShot, "videoPrompt" | "description" | "camera">): string {
  const planned = shot.videoPrompt?.trim();
  if (planned) return planned;
  const parts = [shot.description?.trim(), shot.camera?.trim() ? `运镜：${shot.camera.trim()}` : ""].filter(Boolean);
  return parts.join("，");
}

/** 复制文案：双提示词 + 画面描述的紧凑文本块 */
export function buildShotPromptCopyText(shot: QuickVideoShot): string {
  const lines = [
    `镜头${shot.index}（${shot.duration}s）`,
    `画面：${shot.description?.trim() || "-"}`,
    `生图提示词：${buildImageFillPrompt(shot) || "-"}`,
    `生视频提示词：${buildVideoFillPrompt(shot) || "-"}`,
  ];
  if (shot.dialogue?.trim()) lines.push(`台词：${shot.dialogue.trim()}`);
  return lines.join("\n");
}

/**
 * 多镜批量填入文案：把全部镜头整理成「镜头N：<生视频提示词>」语法块，
 * 用户在聊天窗发送后由 Agent 拆解为镜头序列并启动逐镜头生成管道。
 */
export function buildMultiShotPrompt(shots: Pick<QuickVideoShot, "index" | "videoPrompt" | "description" | "camera">[]): string {
  return shots
    .map((shot) => `镜头${shot.index}：${buildVideoFillPrompt(shot) || "（待补充画面描述）"}`)
    .join("\n");
}
