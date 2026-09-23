/**
 * HTTP Range 请求头解析（纯函数）。
 * 背景：/oss 媒体代理原本不支持 Range，<video> 只能整文件下载——白板封面慢的根因之一。
 * 只支持单区间（浏览器 <video>/预览场景足够）；多区间或非法头返回 null（调用方退回 200 全量）。
 */
export interface ParsedRange {
  start: number;
  end: number;
}

export function parseRangeHeader(header: string | undefined, totalSize: number): ParsedRange | null {
  if (!header || totalSize <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;
  let start: number;
  let end: number;
  if (rawStart === "") {
    // bytes=-N：末尾 N 字节
    const suffix = parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = parseInt(rawStart, 10);
    if (!Number.isFinite(start) || start >= totalSize) return null;
    end = rawEnd === "" ? totalSize - 1 : parseInt(rawEnd, 10);
    if (!Number.isFinite(end) || end < start) return null;
  }
  end = Math.min(end, totalSize - 1);
  return { start, end };
}

/** ETag 是否命中 If-None-Match（弱比较；* 通配命中） */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const candidates = ifNoneMatch.split(",").map((s) => s.trim().replace(/^W\//, ""));
  return candidates.includes("*") || candidates.includes(etag);
}
