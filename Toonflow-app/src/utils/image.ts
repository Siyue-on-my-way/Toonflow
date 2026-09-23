import sharp from "sharp";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
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

/** ffmpeg 可执行文件解析：FFMPEG_PATH 环境变量优先，其次 PATH 上的 ffmpeg；找不到返回 null（海报功能自动降级关闭） */
async function resolveFfmpegPath(): Promise<string | null> {
  const configured = (process.env.FFMPEG_PATH ?? "").trim();
  if (configured) return configured;
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-version"], { timeout: 10000 }, (err) => resolve(err ? null : "ffmpeg"));
  });
}

/**
 * 生成视频封面帧（海报）：真实事故背景——白板用 <video> 全量拉 MP4 只为显示一张封面，8 个素材 118MB。
 * 约定：海报缓存 key = smallImage/<视频目录>/<文件名>_poster.jpg（与图片缩略图 smallImage 前缀一致）。
 * - 已缓存直接返回；ffmpeg 缺失/抽帧失败返回 null（调用方降级，不阻塞主流程）。
 * - 优先取 atSeconds 处（默认 1s，避开纯黑首帧），失败回退第 0 帧（短视频兜底）。
 */
export async function ensureVideoPoster(videoKey: string, posterKey: string, opts?: { atSeconds?: number }): Promise<Buffer | null> {
  if (await oss.fileExists(posterKey)) {
    return oss.getFile(posterKey);
  }
  if (!(await oss.fileExists(videoKey))) {
    return null;
  }
  const ffmpeg = await resolveFfmpegPath();
  if (!ffmpeg) {
    console.warn("[videoPoster] 未找到 ffmpeg（Dockerfile 已内置；Electron 场景可设 FFMPEG_PATH），视频海报降级关闭:", videoKey);
    return null;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-poster-"));
  const tmpVideo = path.join(tmpDir, path.basename(videoKey) || "input.mp4");
  const tmpPoster = path.join(tmpDir, "poster.jpg");
  try {
    // ffmpeg 需要可 seek 的本地输入，MinIO 流先落临时文件（视频几十 MB，临时目录即删）
    const { stream } = await oss.getFileStream(videoKey);
    await pipeline(stream, fs.createWriteStream(tmpVideo));
    const extract = (ss?: number) =>
      new Promise<boolean>((resolve) => {
        const args = ["-y", "-hide_banner", "-loglevel", "error"];
        if (ss && ss > 0) args.push("-ss", String(ss));
        args.push("-i", tmpVideo, "-frames:v", "1", "-q:v", "3", tmpPoster);
        execFile(ffmpeg, args, { timeout: 60000 }, (err) => resolve(!err && fs.existsSync(tmpPoster)));
      });
    const at = opts?.atSeconds ?? 1;
    const ok = (await extract(at)) || (await extract(0));
    if (!ok) {
      console.warn("[videoPoster] 抽帧失败:", videoKey);
      return null;
    }
    const poster = await fs.promises.readFile(tmpPoster);
    await oss.writeFile(posterKey, poster);
    return poster;
  } catch (e) {
    console.warn("[videoPoster] 生成失败:", videoKey, e);
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
