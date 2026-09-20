/**
 * 视频引用守门（SIY-164）：平台暂无“视频生视频”能力，所有视频模型的输入模式只有
 * 纯文本 / 首帧图 / 首尾帧 / 参考图，均不接受视频作为输入——视频引用进入聊天托盘或
 * 引用列表后注定无效（生成失败或被静默忽略），因此在入口层与发送前统一拦截。
 */
import type { MediaRef } from "@/types/quickVideo";

type MediaRefKind = Pick<MediaRef, "kind">;

/**
 * 仅图片可作为生成引用（首帧/参考图/图生图）。
 * 未来若启用“视频生视频”（如 RunningHub Seedance 2.0 的 videoUrls 参考视频），
 * 应在模型元数据声明 videoReference 输入能力，并把此判定升级为
 * “模型能力包含素材类型”后动态放行，同时区分托盘槽位徽标（图N / 视频N）。
 */
export function isImageMediaRef(ref: MediaRefKind | null | undefined): boolean {
  return !!ref && ref.kind === "image";
}

export interface CollectImageReferencesResult {
  /** 去重后的图片引用 mediaId 列表（保序） */
  referenceIds: number[];
  /** 因非图片（视频/未知类型）被拦截丢弃的引用数量 */
  droppedCount: number;
}

/**
 * 发送前兜底：从候选引用（托盘待发送项 + 应用内剪贴板）中只保留图片引用，
 * 历史遗留的已 stage 视频引用在此被过滤，不随消息发出。
 */
export function collectImageReferenceIds(candidates: Array<MediaRefKind & { mediaId: number } | null | undefined>): CollectImageReferencesResult {
  const referenceIds: number[] = [];
  let droppedCount = 0;
  for (const ref of candidates) {
    if (!ref) continue;
    if (ref.kind !== "image") {
      droppedCount += 1;
      continue;
    }
    if (!referenceIds.includes(ref.mediaId)) referenceIds.push(ref.mediaId);
  }
  return { referenceIds, droppedCount };
}
