import sharp from "sharp";
import oss from "@/utils/oss";

/**
 * 图片缩放选项
 */
export interface ResizeOptions {
  /** 最大宽度（默认 256 */
  width?: number;
  /** 最大高度（默认 256 */
  height?: number;
  /** 缩放策略，默认等比缩放不超出边界 */
  fit?: keyof sharp.FitEnum;
  /** 是否禁止放大（默认 true） */
  withoutEnlargement?: boolean;
}

const defaultResizeOptions: Required<ResizeOptions> = {
  width: 256,
  height: 256,
  fit: "inside",
  withoutEnlargement: true,
};

/**
 * 将图片缩放并返回缩放后的 Buffer。
 * @param src 源图片内容
 * @param opts 缩放选项
 */
export async function resizeImage(src: Buffer, opts?: ResizeOptions): Promise<Buffer> {
  const { width, height, fit, withoutEnlargement } = { ...defaultResizeOptions, ...opts };
  return sharp(src).resize(width, height, { fit, withoutEnlargement }).toBuffer();
}

/**
 * 缩略图自定义尺寸选项
 */
export type ThumbnailSize =
  | { type: "dimensions"; width: number; height: number }
  | { type: "percentage"; value: number };

/**
 * 生成缩略图（原图与缩略图缓存都存放在 MinIO 对象存储中，不落本地磁盘）。
 * - 若缩略图缓存已存在，直接从 MinIO 读取返回。
 * - 若不存在，从 MinIO 读取原图生成后写回 MinIO 缓存，再返回。
 *
 * @param originalKey 原图在对象存储中的 key
 * @param thumbnailKey 缩略图缓存在对象存储中的 key
 * @param size 可选的自定义尺寸：固定宽高 或 百分比（默认 256x256 inside）
 * @returns 缩略图内容，失败返回 null
 */
export async function ensureThumbnail(
  originalKey: string,
  thumbnailKey: string,
  size?: ThumbnailSize,
): Promise<Buffer | null> {
  // 小图缓存已存在，直接返回
  if (await oss.fileExists(thumbnailKey)) {
    return oss.getFile(thumbnailKey);
  }
  // 原图不存在，无法生成
  if (!(await oss.fileExists(originalKey))) {
    return null;
  }
  try {
    const original = await oss.getFile(originalKey);
    let thumbnail: Buffer;
    if (size?.type === "percentage") {
      // 百分比缩放：先获取原图尺寸，再等比计算目标尺寸
      const meta = await sharp(original).metadata();
      if (!meta.width || !meta.height) {
        console.warn("[image] 无法获取原图尺寸:", originalKey);
        return null;
      }
      const pct = size.value / 100;
      const w = Math.round(meta.width * pct);
      const h = Math.round(meta.height * pct);
      thumbnail = await resizeImage(original, { width: w, height: h });
    } else if (size?.type === "dimensions") {
      // 固定宽高：等比缩放适配到指定边界
      thumbnail = await resizeImage(original, {
        width: size.width,
        height: size.height,
      });
    } else {
      // 默认 256x256 inside
      thumbnail = await resizeImage(original);
    }
    await oss.writeFile(thumbnailKey, thumbnail);
    console.info(`[${thumbnailKey}] 小图生成成功`);
    return thumbnail;
  } catch (e) {
    console.warn("[image] 生成缩略图失败:", e);
    return null;
  }
}
