/**
 * QuickVideo / 单视频快创 —— 跨镜头连续性管道（SIY-150 双模态连续性保障）
 *
 * 核心机制：
 * 1. 顺承镜头（last_frame，默认）：
 *    上一镜头视频产出后，调用 ffmpeg 毫秒级提取最后一帧（Last Frame），
 *    自动存入项目资产白板（留存 MediaRef），并自动注入为下一镜头的首帧（firstFrame），
 *    实现人物、服装、道具像素级连贯续写。
 * 2. 切镜（assets_only）：
 *    调度器自动提取上一镜头绑定的角色图与道具图，以多图参考（referenceList）注入视频/图片模型，
 *    并在 Prompt 模板中自动补齐主体特征词（如“保持同一角色...手持上一镜头的道具...”）。
 * 3. 独立镜头（independent）：
 *    不继承前序镜头帧或特定资产，独立生成。
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  QuickVideoShot,
  QuickVideoSnapshotShot,
  ShotAssetRef,
  ShotContinuityType,
  SnapshotFirstFrame,
} from "./contract";

const execFileAsync = promisify(execFile);

export interface ExtractedLastFrameResult {
  mediaId: number;
  assetId: number;
  imageId: number;
  filePath: string;
}

/**
 * 使用 ffmpeg 从视频 buffer 中毫秒级提取最后一帧
 */
export async function extractVideoLastFrameBuffer(videoBuffer: Buffer): Promise<Buffer> {
  if (!videoBuffer || videoBuffer.length === 0) {
    throw new Error("视频 Buffer 为空，无法提取尾帧");
  }

  const tmpUid = crypto.randomUUID();
  const inputVideoPath = path.join(os.tmpdir(), `qv-in-${tmpUid}.mp4`);
  const outputFramePath = path.join(os.tmpdir(), `qv-out-${tmpUid}.jpg`);

  try {
    await fs.writeFile(inputVideoPath, videoBuffer);

    // 优先尝试 -sseof -0.1 提取倒数 0.1 秒的最后一帧
    try {
      await execFileAsync("ffmpeg", [
        "-sseof",
        "-0.1",
        "-i",
        inputVideoPath,
        "-update",
        "1",
        "-q:v",
        "2",
        "-frames:v",
        "1",
        outputFramePath,
        "-y",
      ]);
    } catch {
      // 容错兜底：若视频过短或 seek 失败，提取视频最后一帧
      await execFileAsync("ffmpeg", [
        "-i",
        inputVideoPath,
        "-update",
        "1",
        "-q:v",
        "2",
        "-frames:v",
        "1",
        outputFramePath,
        "-y",
      ]);
    }

    const frameBuffer = await fs.readFile(outputFramePath);
    if (!frameBuffer || frameBuffer.length === 0) {
      throw new Error("ffmpeg 提取出的尾帧文件为空");
    }
    return frameBuffer;
  } finally {
    await Promise.all([
      fs.unlink(inputVideoPath).catch(() => {}),
      fs.unlink(outputFramePath).catch(() => {}),
    ]);
  }
}

/**
 * 将提取出的尾帧持久化至 MinIO 并收录进项目资产白板（o_quickVideoMedia + o_assets）
 */
export async function saveLastFrameToAssetBoard(
  projectId: number,
  sessionId: number | null | undefined,
  shotId: string,
  runId: string,
  frameBuffer: Buffer,
): Promise<ExtractedLastFrameResult> {
  const u = (await import("@/utils")).default;
  const { createChatMedia, markChatMediaDone } = await import("./media");

  const savePath = `/${projectId}/quickVideo/lastframe-${shotId}-${crypto.randomUUID().slice(0, 8)}.jpg`;
  await u.oss.writeFile(savePath, frameBuffer);

  const idempotencyKey = `last_frame:${projectId}:${shotId}:${runId}`;
  const { media } = await createChatMedia({
    projectId,
    sessionId: sessionId ?? null,
    messageId: null,
    kind: "image",
    model: "ffmpeg:last_frame",
    prompt: `镜头 ${shotId} 尾帧（连续性保障）`,
    source: "generated",
    idempotencyKey,
  });

  await markChatMediaDone(media.id, savePath);

  return {
    mediaId: media.id,
    assetId: media.assetId!,
    imageId: media.imageId!,
    filePath: savePath,
  };
}

/**
 * 提取镜头中的角色与道具资产（切镜一致性多模态参考）
 */
export function extractRoleAndToolAssets(assetRefs?: ShotAssetRef[]): {
  roles: ShotAssetRef[];
  tools: ShotAssetRef[];
} {
  const roles: ShotAssetRef[] = [];
  const tools: ShotAssetRef[] = [];
  for (const ref of assetRefs ?? []) {
    if (ref.type === "role") roles.push(ref);
    else if (ref.type === "tool") tools.push(ref);
  }
  return { roles, tools };
}

/**
 * 切镜（assets_only）提示词主体特征词增强
 */
export function augmentPromptForCutContinuity(
  basePrompt: string,
  prevShot?: QuickVideoSnapshotShot | QuickVideoShot | null,
  currShot?: QuickVideoSnapshotShot | QuickVideoShot | null,
): string {
  if (!prevShot) return basePrompt;

  const prevAssets = extractRoleAndToolAssets(prevShot.assetRefs);
  const currAssets = extractRoleAndToolAssets(currShot?.assetRefs);

  // 合并上一镜头与当前镜头的人物/道具
  const roleNames = Array.from(new Set([...prevAssets.roles, ...currAssets.roles].map((r) => r.name))).filter(Boolean);
  const toolNames = Array.from(new Set([...prevAssets.tools, ...currAssets.tools].map((t) => t.name))).filter(Boolean);

  const clauses: string[] = [];
  if (roleNames.length > 0) {
    clauses.push(`保持与上一镜头同一角色（${roleNames.join("、")}）的面部容貌、发型、体态与服装款式色彩严格一致`);
  }
  if (toolNames.length > 0) {
    clauses.push(`手持上一镜头的道具（${toolNames.join("、")}），道具外形、材质与细节保持一致`);
  }

  if (clauses.length === 0) {
    return basePrompt;
  }

  return `${basePrompt}；【跨镜头主体道具一致性】${clauses.join("；")}`;
}

/**
 * 检查镜头是否依赖上一镜头
 */
export function getShotDependencyId(
  shotIndex: number,
  allShots: { id: string; index: number; continuity?: ShotContinuityType }[],
): string | null {
  if (shotIndex <= 1) return null; // 首镜头无前置依赖
  const curr = allShots.find((s) => s.index === shotIndex);
  const continuity = curr?.continuity ?? "last_frame";
  if (continuity === "independent") return null;

  // last_frame 与 assets_only 均依赖上一镜头
  const prev = allShots.find((s) => s.index === shotIndex - 1);
  return prev ? prev.id : null;
}
