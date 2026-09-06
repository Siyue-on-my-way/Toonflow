/**
 * Decode an in-memory base64 payload.
 *
 * Uploads in the API use JSON data URLs rather than multipart files. Keeping
 * the decoding in one place makes it explicit that the payload becomes a
 * Buffer and is never materialized through a local file path.
 */
export function decodeBase64(value: string, fieldName = "文件"): { buffer: Buffer; mimeType?: string } {
  if (typeof value !== "string") {
    throw new TypeError(`${fieldName}必须是 base64 字符串`);
  }

  const input = value.trim();
  const dataUrl = input.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s);
  const rawBase64 = (dataUrl?.[2] ?? input).replace(/\s+/g, "");
  if (!rawBase64) {
    throw new Error(`${fieldName}不能为空`);
  }

  // Accept URL-safe base64 as well as the standard alphabet. Buffer.from is
  // intentionally permissive, so validate first to avoid silently accepting
  // malformed uploads as truncated files.
  const normalized = rawBase64.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error(`${fieldName}不是有效的 base64 数据`);
  }

  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0) {
    throw new Error(`${fieldName}不能为空`);
  }

  return { buffer, mimeType: dataUrl?.[1]?.toLowerCase() };
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/aiff": "aiff",
  "audio/x-aiff": "aiff",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/ogg": "ogg",
  "audio/aac": "aac",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export function extensionFromMime(mimeType: string | undefined, fallback = "bin"): string {
  return (mimeType && MIME_EXTENSIONS[mimeType.toLowerCase()]) || fallback;
}
