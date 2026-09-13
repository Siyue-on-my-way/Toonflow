/**
 * 快创聊天输入框粘贴解析（SIY-144）
 *
 * 粘贴优先级：二进制图片（截图/本地图，由调用方处理 File）→ 剪贴板文本中的
 * 稳定 MediaRef JSON → 应用内剪贴板对象。本模块只负责文本解析与结构校验：
 * 引用只允许携带稳定 ID（mediaId 必填、整数、正数），拒绝把 URL/Base64/path
 * 当引用传递（引用身份只由稳定 ID 决定，预览 URL 由接口按需签发）。
 */
import type { MediaRef } from "@/types/quickVideo";

/** 单轮聊天允许的引用数量上限（与后端 references 上限一致） */
export const CHAT_REFERENCE_MAX = 4;

/** 最小结构校验：必须有正整数 mediaId（o_quickVideoMedia.id 是唯一稳定标识） */
export function isValidMediaRef(value: unknown): value is MediaRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, any>;
  if (!Number.isInteger(ref.mediaId) || Number(ref.mediaId) <= 0) return false;
  // 伪引用拒绝：把二进制/路径当引用传（这些字段不应出现在 MediaRef 协议里；
  // url 字段属于 MediaRef 本身且仅作展示，不作为引用身份，允许存在）
  if (typeof ref.base64 === "string" || typeof ref.path === "string") return false;
  return true;
}

/** 从任意文本中解析 MediaRef JSON（单个对象或数组）；解析失败或不合法时返回 null */
export function readMediaRefsFromText(text: string | null | undefined): MediaRef[] | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  if (!candidates.length || candidates.length > CHAT_REFERENCE_MAX) return null;
  if (!candidates.every(isValidMediaRef)) return null;
  return candidates as MediaRef[];
}
