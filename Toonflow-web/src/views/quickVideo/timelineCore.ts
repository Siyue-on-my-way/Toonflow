/**
 * QuickVideo / 单视频快创 —— 时间线装配核心逻辑（SIY-111，纯函数，无 DOM 依赖）
 *
 * 与后端 src/lib/quickVideo/timeline.ts 同一套适配数学（镜像维护）：
 * 服务端规划基于镜头期望时长；本模块在前端拿到真实媒体时长后重新适配，以实际片段为准。
 * - 相邻镜头 crossfade 重叠 TRANSITION_DURATION 秒；
 * - 需要媒体总长 L = 目标 + (n-1)×重叠；源总长 S = Σ 实际片段时长；
 * - r = S/L ∈ [MIN_SPEED, MAX_SPEED]：整体变速精确贴合目标；
 * - r > MAX_SPEED：按 MAX_SPEED 播放，源窗口按比例裁剪（保留每个镜头开头）；
 * - r < MIN_SPEED：按 MIN_SPEED 放慢，不足部分用片尾 CTA 定版补齐。
 */
import type { QuickVideoDuration, QuickVideoRatio, QuickVideoTimelinePlan } from "@/types/quickVideo";

export const TRANSITION_DURATION = 0.5;
export const MAX_SPEED = 1.5;
export const MIN_SPEED = 0.75;

export const RATIO_DIMENSIONS: Record<QuickVideoRatio, { width: number; height: number }> = {
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "1:1": { width: 960, height: 960 },
};

export interface PlanShotInput {
  id: string;
  index: number;
  duration: number;
  dialogue?: string;
}

export interface BuildPlanInput {
  shots: PlanShotInput[];
  targetDuration: QuickVideoDuration;
  videoRatio: QuickVideoRatio;
  ctaText?: string;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const round3 = (v: number) => Math.round(v * 1e3) / 1e3;

/** 与服务端 buildTimelinePlan 同构：基于实际媒体时长推导最终装配方案 */
export function buildTimelinePlan({ shots, targetDuration, videoRatio, ctaText = "" }: BuildPlanInput): QuickVideoTimelinePlan {
  const ordered = [...shots].sort((a, b) => a.index - b.index);
  if (!ordered.length) throw new Error("TIMELINE_NO_SHOTS");

  const n = ordered.length;
  const transition = n >= 2 ? TRANSITION_DURATION : 0;
  const sourceTotal = ordered.reduce((sum, s) => sum + s.duration, 0);
  const mediaNeeded = targetDuration + (n - 1) * transition;

  let playbackRate: number;
  let trimFraction = 1;
  let tailPadSeconds = 0;
  const rateRaw = sourceTotal / mediaNeeded;
  if (rateRaw > MAX_SPEED) {
    playbackRate = MAX_SPEED;
    trimFraction = (mediaNeeded * MAX_SPEED) / sourceTotal;
  } else if (rateRaw < MIN_SPEED) {
    playbackRate = MIN_SPEED;
    tailPadSeconds = round6(mediaNeeded - sourceTotal / MIN_SPEED);
  } else {
    playbackRate = round6(rateRaw);
  }

  const clips: QuickVideoTimelinePlan["clips"] = [];
  let cursor = 0;
  ordered.forEach((shot, i) => {
    const windowSeconds = round6(shot.duration * trimFraction);
    const timelineDuration = round6(windowSeconds / playbackRate);
    const start = round6(cursor);
    const end = round6(start + timelineDuration);
    clips.push({
      shotId: shot.id,
      index: shot.index,
      sourceDuration: shot.duration,
      trimStart: 0,
      trimEnd: round6(windowSeconds),
      playbackRate,
      start,
      end,
      subtitleText: (shot.dialogue ?? "").trim(),
    });
    cursor = end - (i < n - 1 ? transition : 0);
  });

  const transitions = clips.slice(0, -1).map((clip) => ({
    afterShotId: clip.shotId,
    type: "crossfade" as const,
    duration: transition,
  }));

  const lastEnd = clips[clips.length - 1].end;
  const tailPad = tailPadSeconds > 0.05 ? { type: "endcard" as const, duration: round6(tailPadSeconds), text: ctaText.trim() } : null;
  const totalDuration = round6(lastEnd + (tailPad?.duration ?? 0));

  const { width, height } = RATIO_DIMENSIONS[videoRatio];
  return { targetDuration, videoRatio, width, height, totalDuration, clips, transitions, tailPad };
}

/** 字幕时间轴（秒）：片段完全可见区间（避开两侧 crossfade 重叠） */
export function buildSubtitleCues(plan: QuickVideoTimelinePlan): { start: number; end: number; text: string }[] {
  const cues: { start: number; end: number; text: string }[] = [];
  plan.clips.forEach((clip, i) => {
    const text = clip.subtitleText.trim();
    if (!text) return;
    const start = clip.start + (i > 0 ? plan.transitions[i - 1]?.duration ?? 0 : 0);
    const end = clip.end - (i < plan.clips.length - 1 ? plan.transitions[i]?.duration ?? 0 : 0);
    if (end - start > 0.3) cues.push({ start: round3(start), end: round3(end), text });
  });
  return cues;
}

/**
 * Keep a subtitle cue within a bounded number of rendered lines. WebAV does
 * width wrapping itself, but it cannot prevent a very long dialogue from
 * overflowing above the video frame. The cue timing stays intact; only the
 * visual label is shortened with an ellipsis.
 */
export function clampSubtitleText(text: string, maxCharsPerLine: number, maxLines = 3): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const maxChars = Math.max(1, Math.floor(maxCharsPerLine) * Math.max(1, Math.floor(maxLines)));
  if (Array.from(normalized).length <= maxChars) return normalized;
  const visibleChars = Math.max(1, maxChars - 1);
  return `${Array.from(normalized).slice(0, visibleChars).join("")}…`;
}

/** 字幕轨（WebAV EmbedSubtitlesClip 的 SubtitleStruct[]，微秒） */
export function toEmbedSubtitleStructs(cues: { start: number; end: number; text: string }[]): { start: number; end: number; text: string }[] {
  return cues.map((c) => ({ start: Math.round(c.start * 1e6), end: Math.round(c.end * 1e6), text: c.text }));
}

/** mm:ss 展示 */
export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * 导出体积粗估（字节）：720p 档按分辨率推码率（2.5-8 Mbps 夹紧），仅用于导出确认门展示。
 */
export function estimateExportBytes(width: number, height: number, durationSeconds: number): number {
  const bitrate = Math.min(8e6, Math.max(2.5e6, Math.round(width * height * 4.5)));
  return Math.round((bitrate / 8) * Math.max(0, durationSeconds));
}

/** 可读的体积文案（MB，保留 1 位） */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1e3))} KB`;
}
