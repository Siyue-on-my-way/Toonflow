/**
 * QuickVideo / 单视频快创 —— 结构化日志与指标（SIY-111）
 *
 * 进程内轻量指标注册表（无外部依赖，随进程生命周期累计）：
 * - counters：事件计数（装配、导出确认/失败/取消、镜头重试、镜头生成成败…）
 * - durations：耗时累计（次数 + 总毫秒，snapshot 时给出均值）
 * - derived：派生指标（镜头生成失败率等）
 * 结构化日志统一走 qvLog：单行 JSON，便于采集与检索。
 */

type QuickVideoCounter =
  | "timelineAssembled"
  | "exportConfirmed"
  | "exportFailed"
  | "exportCancelled"
  | "shotRetry"
  | "generationConfirmed"
  | "generationShotImageDone"
  | "generationShotDone"
  | "generationShotFailed";

type QuickVideoDurationMetric = "timelineAssembleMs" | "exportEncodeMs";

const counters: Record<string, number> = {};
const durations: Record<string, { count: number; totalMs: number }> = {};

export function recordEvent(name: QuickVideoCounter): void {
  counters[name] = (counters[name] ?? 0) + 1;
}

export function recordDuration(name: QuickVideoDurationMetric, ms: number): void {
  const slot = (durations[name] ??= { count: 0, totalMs: 0 });
  slot.count += 1;
  slot.totalMs += Math.max(0, Math.round(ms));
}

/** 结构化日志：单行 JSON（level 固定 info/error，由调用方在 fields 里带 error） */
export function qvLog(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: "quickVideo", event, ...fields }));
}

/** 指标快照（getMetrics 返回；derived 里的失败率保留 4 位小数） */
export function snapshotMetrics() {
  const genDone = counters["generationShotDone"] ?? 0;
  const genFailed = counters["generationShotFailed"] ?? 0;
  const durationSlots = Object.fromEntries(
    Object.entries(durations).map(([name, slot]) => [
      name,
      { count: slot.count, totalMs: slot.totalMs, avgMs: slot.count ? Math.round(slot.totalMs / slot.count) : 0 },
    ]),
  );
  return {
    counters: { ...counters },
    durations: durationSlots,
    derived: {
      generationShotFailureRate: genDone + genFailed > 0 ? Math.round((genFailed / (genDone + genFailed)) * 10000) / 10000 : 0,
      generationShotTotal: genDone + genFailed,
    },
  };
}

/** 仅测试使用：清空进程内指标 */
export function resetMetrics(): void {
  Object.keys(counters).forEach((k) => delete counters[k]);
  Object.keys(durations).forEach((k) => delete durations[k]);
}
