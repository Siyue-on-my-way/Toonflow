/**
 * QuickVideo / 单视频快创 —— 时间线装配规划（SIY-111）
 *
 * 纯函数模块：根据镜头结果与目标时长推导时间线装配方案（裁剪/变速/补齐/转场/字幕）。
 * - 服务端 getTimeline 用它生成规划并落库（o_videoTrack + state.generation.timeline）；
 * - 前端拿到实际媒体时长后用同一套数学（timelineCore.ts 镜像）重新适配，以实际片段为准。
 *
 * 适配规则（确定性，可单测）：
 * - 相邻镜头之间 crossfade 重叠 D 秒；
 * - 需要的媒体总长 L = 目标时长 + (n-1)×D；源总长 S = Σ 镜头时长；
 * - 速率 r = S / L：介于 [MIN_SPEED, MAX_SPEED] 时整体变速精确贴合目标；
 * - r > MAX_SPEED（内容过多）：整体按 MAX_SPEED 播放，源窗口按比例裁剪（保留每个镜头开头）；
 * - r < MIN_SPEED（内容不足）：整体按 MIN_SPEED 放慢，不足部分用片尾 CTA 定版补齐。
 */
import {
  QUICK_VIDEO_DIMENSIONS,
  QuickVideoDuration,
  QuickVideoRatio,
  QuickVideoTimelinePlan,
  SHOT_COUNT_MAX,
  TIMELINE_MAX_SPEED,
  TIMELINE_MIN_SPEED,
  TIMELINE_TRANSITION_DURATION_S,
} from "./contract";

/** 规划输入镜头（最小字段；服务端传 storyboard.shots，前端传实际读取的镜头） */
export interface TimelinePlanShotInput {
  id: string;
  index: number;
  duration: number;
  dialogue?: string;
}

export interface BuildTimelinePlanInput {
  shots: TimelinePlanShotInput[];
  targetDuration: QuickVideoDuration;
  videoRatio: QuickVideoRatio;
  /** 片尾定版文案（简报 CTA，缺省用空串渲染纯色定版） */
  ctaText?: string;
}

/**
 * 构建时间线装配规划。
 * 总时长恒等于目标时长（精确贴合）；clips 相邻处在转场时长内重叠。
 */
export function buildTimelinePlan({ shots, targetDuration, videoRatio, ctaText = "" }: BuildTimelinePlanInput): QuickVideoTimelinePlan {
  const ordered = [...shots].sort((a, b) => a.index - b.index).slice(0, SHOT_COUNT_MAX);
  if (!ordered.length) throw new Error("TIMELINE_NO_SHOTS");

  const n = ordered.length;
  const transition = n >= 2 ? TIMELINE_TRANSITION_DURATION_S : 0;
  const sourceTotal = ordered.reduce((sum, s) => sum + s.duration, 0);
  const mediaNeeded = targetDuration + (n - 1) * transition;

  let playbackRate: number;
  let trimFraction = 1; // r0 > MAX_SPEED 时按比例裁剪源窗口
  let tailPadSeconds = 0; // r0 < MIN_SPEED 时片尾补齐
  const rateRaw = sourceTotal / mediaNeeded;
  if (rateRaw > TIMELINE_MAX_SPEED) {
    playbackRate = TIMELINE_MAX_SPEED;
    trimFraction = (mediaNeeded * TIMELINE_MAX_SPEED) / sourceTotal;
  } else if (rateRaw < TIMELINE_MIN_SPEED) {
    playbackRate = TIMELINE_MIN_SPEED;
    tailPadSeconds = round3(mediaNeeded - sourceTotal / TIMELINE_MIN_SPEED);
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
  const tailPad =
    tailPadSeconds > 0.05
      ? { type: "endcard" as const, duration: round6(lastEnd + tailPadSeconds) - round6(lastEnd), text: ctaText.trim() }
      : null;
  const totalDuration = round6(lastEnd + (tailPad?.duration ?? 0));

  const { width, height } = QUICK_VIDEO_DIMENSIONS[videoRatio];
  return {
    targetDuration,
    videoRatio,
    width,
    height,
    totalDuration,
    clips,
    transitions,
    tailPad,
  };
}

/** 字幕时间轴（秒）：片段可见区间（避开两侧 crossfade 重叠），供前端 SRT/字幕轨使用 */
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

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
function round3(v: number): number {
  return Math.round(v * 1e3) / 1e3;
}
