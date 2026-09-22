/**
 * LibTV 错误卡片映射（前端侧）。
 *
 * 后端 LibTV 渠道的失败消息带机器可读前缀 `[LIBTV:<CODE>]`（见 src/vendors/libtv.ts 的 LibtvError），
 * 随 errorReason 落库/下发。这里把前缀解析出来，映射成「说人话的文案 + 下一步动作」的卡片配置，
 * 快创各生成面（塑角造景、视频生产等）据此渲染带动作的失败卡片，而不是裸的错误文本。
 */

export type LibtvErrorCode = "NOT_BOUND" | "AUTH_EXPIRED" | "INSUFFICIENT_CREDITS" | "COMPLIANCE_REJECTED" | "GENERATION_TIMEOUT" | "UNKNOWN";

export interface ParsedLibtvError {
  isLibtv: boolean;
  code: LibtvErrorCode;
  /** 去掉前缀后的可读原因 */
  reason: string;
}

const CODE_RE = /^\s*\[LIBTV:(NOT_BOUND|AUTH_EXPIRED|INSUFFICIENT_CREDITS|COMPLIANCE_REJECTED|GENERATION_TIMEOUT|UNKNOWN)\]\s*/;

export function parseLibtvError(reason?: string | null): ParsedLibtvError {
  const text = String(reason ?? "");
  const m = text.match(CODE_RE);
  if (!m) return { isLibtv: false, code: "UNKNOWN", reason: text };
  return { isLibtv: true, code: m[1] as LibtvErrorCode, reason: text.slice(m[0].length).trim() };
}

export function isLibtvError(reason?: string | null): boolean {
  return parseLibtvError(reason).isLibtv;
}

export function isLibtvModel(model?: string | null): boolean {
  return String(model ?? "").startsWith("libtv:");
}

/** 去掉前缀后的纯文本（不需要动作卡片、只想要可读原因时用） */
export function stripLibtvPrefix(reason?: string | null): string {
  return parseLibtvError(reason).reason || String(reason ?? "");
}
