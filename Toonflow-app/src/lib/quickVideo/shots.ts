import { QuickVideoState, SHOT_DURATION_MAX, SHOT_DURATION_MIN, QuickVideoShot } from "./contract";
import { QuickVideoError } from "./state";

/** 分镜可编辑的前置条件：存在分镜、处于草稿状态、阶段允许 */
export function ensureStoryboardEditable(state: QuickVideoState): void {
  if (!state.storyboard) throw new QuickVideoError("NO_STORYBOARD", "暂无分镜，请先确认简报后由 Agent 生成或提交分镜", state.version);
  if (state.storyboard.status !== "draft") {
    throw new QuickVideoError("STORYBOARD_LOCKED", "分镜已确认锁定，请先撤销确认再编辑", state.version);
  }
  if (!["storyboard_draft"].includes(state.stage)) {
    throw new QuickVideoError("STAGE_FORBIDDEN", `当前阶段 ${state.stage} 不允许编辑分镜`, state.version);
  }
}

export function findShot(state: QuickVideoState, shotId: string): QuickVideoShot {
  const shot = state.storyboard?.shots.find((s) => s.id === shotId);
  if (!shot) throw new QuickVideoError("SHOT_NOT_FOUND", `未找到镜头 ${shotId}`, state.version);
  return shot;
}

/** 校验镜头时长并规范化（整数、限制在 5-15 秒） */
export function normalizeShotDuration(duration: number): number {
  const d = Math.round(Number(duration));
  if (!Number.isFinite(d) || d < SHOT_DURATION_MIN || d > SHOT_DURATION_MAX) {
    throw new QuickVideoError("SHOT_DURATION_INVALID", `镜头时长需为 ${SHOT_DURATION_MIN}-${SHOT_DURATION_MAX} 的整数秒`, undefined);
  }
  return d;
}

/** 按数组顺序重排镜头 index（1 开始），增删镜头后调用 */
export function reindexShots(state: QuickVideoState): void {
  state.storyboard?.shots.forEach((shot, i) => (shot.index = i + 1));
}

/** 生成下一个可用的镜头 ID */
export function nextShotId(state: QuickVideoState): string {
  const existing = new Set(state.storyboard?.shots.map((s) => s.id) ?? []);
  let i = state.storyboard?.shots.length ?? 0;
  let id = `shot-${i + 1}`;
  while (existing.has(id)) {
    i += 1;
    id = `shot-${i + 1}`;
  }
  return id;
}
