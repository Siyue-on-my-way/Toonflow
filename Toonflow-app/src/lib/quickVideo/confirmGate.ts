/**
 * QuickVideo / 单视频快创 —— 生成确认门（SIY-138）
 *
 * 「确认生成」的唯一服务端入口：request（组装待确认快照）→ confirm（版本校验后
 * 冻结素材快照并启动逐镜头生成）→ cancel（返回修改）。
 * REST 路由 /quickVideo/generateConfirm 与 Agent 工具 request_generation_confirm /
 * confirm_generation 共用本层，保证两条入口的校验完全一致：
 * - request：storyboard_confirmed 阶段 + 分镜已确认 + 目标时长已设置；
 * - confirm：pendingSnapshot 存在且 confirmationStatus=pending，传入的 configVersion
 *   必须与当前最新 configVersion 一致，否则阻断（参数已变更需重新确认）；
 * - 生成启动前绝不创建任何素材任务（在用户明确确认前）。
 */
import u from "@/utils";
import {
  QuickVideoPendingSnapshot,
  QuickVideoState,
  buildPendingSnapshot,
  invalidatePendingConfirmation,
} from "./contract";
import { QuickVideoError, loadQuickVideoState, mutateQuickVideoState } from "./state";
import { applySnapshotToState, buildSnapshot, startQuickVideoGeneration } from "./generate";

/** 发起生成确认：校验前置条件并写入 pendingSnapshot（幂等键由调用方提供） */
export async function requestGenerationConfirm(
  projectId: number,
  opts: { idempotencyKey?: string; sessionId?: number | null } = {},
): Promise<{ state: QuickVideoState; pendingSnapshot: QuickVideoPendingSnapshot | null; idempotentHit: boolean }> {
  const state = await loadQuickVideoState(projectId);
  if (!state) throw new QuickVideoError("STATE_NOT_FOUND", "未找到 quickVideoAgent 状态，请先创建 quick_video 项目");
  if (!state.storyboard || state.storyboard.status !== "confirmed") {
    throw new QuickVideoError("STORYBOARD_NOT_CONFIRMED", "分镜尚未确认，请先在右侧面板确认分镜后再发起生成确认", state.version);
  }
  if (state.stage !== "storyboard_confirmed") {
    throw new QuickVideoError("STAGE_MISMATCH", `当前阶段 ${state.stage} 不允许发起生成确认`, state.version);
  }
  if (state.targetDuration == null) {
    throw new QuickVideoError("DURATION_NOT_SET", "目标时长尚未确定，请先在对话中确认视频时长（5-60 秒的整数）后再发起生成", state.version);
  }

  // 素材快照缺失或分镜版本已变化时现场解析，让确认卡片带上最新的素材/成本预估
  const needResolve = !state.generation?.snapshot || state.generation.snapshot.storyboardVersion !== state.storyboard.version;
  let estimate = { estimatedImageCount: 0, estimatedVideoCount: 0, estimatedCostYuan: 0 };
  if (needResolve) {
    const { materials, estimate: est, snapshotShots } = await buildSnapshot(projectId, state);
    estimate = { estimatedImageCount: est.estimatedImageCount, estimatedVideoCount: est.estimatedVideoCount, estimatedCostYuan: est.estimatedCostYuan };
    await mutateQuickVideoState(projectId, { sessionId: opts.sessionId ?? undefined }, (s) => {
      if (!s.storyboard) return;
      applySnapshotToState(s, s.storyboard.version, snapshotShots, materials, est);
    });
    // 重新加载：上一条 mutate 已递增状态版本
  }

  const { state: next, idempotentHit } = await mutateQuickVideoState(
    projectId,
    { idempotencyKey: opts.idempotencyKey, sessionId: opts.sessionId ?? undefined },
    (s) => {
      if (!s.storyboard || s.storyboard.status !== "confirmed") {
        throw new QuickVideoError("STORYBOARD_NOT_CONFIRMED", "分镜尚未确认，无法发起生成确认", s.version);
      }
      if (s.stage !== "storyboard_confirmed") {
        throw new QuickVideoError("STAGE_MISMATCH", `当前阶段 ${s.stage} 不允许发起生成确认`, s.version);
      }
      if (s.targetDuration == null) {
        throw new QuickVideoError("DURATION_NOT_SET", "目标时长尚未确定，无法发起生成确认", s.version);
      }
      const fresh = buildPendingSnapshot(s, estimate);
      s.pendingSnapshot = fresh;
      s.confirmationStatus = "pending";
    },
  );
  return { state: next, pendingSnapshot: next.pendingSnapshot, idempotentHit };
}

/**
 * 确认生成：校验版本一致后冻结素材快照、进入 generating 阶段并启动逐镜头生成。
 * 返回 shouldStart 由调用方在事务外启动生成（与 confirmStage 相同的分离运行模式）。
 */
export async function confirmGeneration(
  projectId: number,
  opts: { idempotencyKey?: string; sessionId?: number | null; expectedVersion?: number; /** 用户/Agent 确认时持有的配置版本；与服务端不一致时阻断 */ configVersion?: number; userId: number },
): Promise<{ started: boolean; alreadyRunning: boolean; runId: string | null }> {
  const state = await loadQuickVideoState(projectId);
  if (!state) throw new QuickVideoError("STATE_NOT_FOUND", "未找到 quickVideoAgent 状态");
  if (!state.pendingSnapshot || state.confirmationStatus !== "pending") {
    throw new QuickVideoError("CONFIRM_INVALID", "没有待确认的生成摘要（或确认已失效），请先重新发起生成确认", state.version);
  }
  const snapshotConfigVersion = state.pendingSnapshot.configVersion;
  if (opts.configVersion != null && opts.configVersion !== state.configVersion) {
    throw new QuickVideoError("CONFIG_VERSION_MISMATCH", "参数已变更，本次确认基于的版本已过期；请查看最新配置后重新确认生成", state.version);
  }
  if (snapshotConfigVersion !== state.configVersion) {
    throw new QuickVideoError("CONFIG_VERSION_MISMATCH", "参数已变更，待确认摘要已失效；请重新发起生成确认", state.version);
  }
  if (!state.storyboard || state.storyboard.status !== "confirmed") {
    throw new QuickVideoError("STORYBOARD_NOT_CONFIRMED", "分镜尚未确认，无法开始生成", state.version);
  }
  if (state.stage !== "storyboard_confirmed") {
    throw new QuickVideoError("STAGE_MISMATCH", `当前阶段 ${state.stage} 不允许确认生成`, state.version);
  }
  if (state.targetDuration == null) {
    throw new QuickVideoError("DURATION_NOT_SET", "目标时长尚未确定，无法开始生成", state.version);
  }

  // 快照缺失或分镜版本已变化时，服务端现场重新解析（门的判定不依赖前端传值）
  const needResolve = !state.generation?.snapshot || state.generation.snapshot.storyboardVersion !== state.storyboard.version;
  if (needResolve) {
    const { materials, estimate, snapshotShots } = await buildSnapshot(projectId, state);
    await mutateQuickVideoState(projectId, { sessionId: opts.sessionId ?? undefined }, (s) => {
      if (!s.storyboard) return;
      applySnapshotToState(s, s.storyboard.version, snapshotShots, materials, estimate);
    });
  }

  await mutateQuickVideoState(
    projectId,
    { idempotencyKey: opts.idempotencyKey, sessionId: opts.sessionId ?? undefined, stageTransition: { from: "storyboard_confirmed", to: "generating" } },
    (s) => {
      if (!s.pendingSnapshot || s.confirmationStatus !== "pending") {
        throw new QuickVideoError("CONFIRM_INVALID", "确认状态已变化，请重新发起生成确认", s.version);
      }
      if (s.pendingSnapshot.configVersion !== s.configVersion) {
        throw new QuickVideoError("CONFIG_VERSION_MISMATCH", "参数已变更，请重新确认生成", s.version);
      }
      if (!s.generation?.snapshot) {
        throw new QuickVideoError("MATERIALS_RESOLVE_FAILED", "素材解析失败，无法确认", s.version);
      }
      s.confirmationStatus = "confirmed";
      s.generation.materialsConfirmed = true;
      s.generation.materialsConfirmedAt = Date.now();
      s.generation.startedAt = Date.now();
      s.generation.finishedAt = null;
      s.stage = "generating";
    },
  );

  try {
    const start = await startQuickVideoGeneration(projectId, opts.userId, opts.sessionId ?? undefined);
    return { started: start.started, alreadyRunning: start.alreadyRunning, runId: start.runId };
  } catch (err: any) {
    // 启动失败不回滚确认：用户可通过失败镜头重试或 generate_shots 幂等重启
    console.error(`[quickVideo] 项目 ${projectId} 确认后启动生成失败:`, u.error(err as Error).message);
    return { started: false, alreadyRunning: false, runId: null };
  }
}

/** 取消（返回修改）：清空待确认快照，回到 storyboard_confirmed 继续打磨 */
export async function cancelGenerationConfirm(
  projectId: number,
  opts: { idempotencyKey?: string; sessionId?: number | null; expectedVersion?: number } = {},
) {
  return mutateQuickVideoState(
    projectId,
    { idempotencyKey: opts.idempotencyKey, sessionId: opts.sessionId ?? undefined, expectedVersion: opts.expectedVersion },
    (s) => {
      invalidatePendingConfirmation(s);
    },
  );
}
