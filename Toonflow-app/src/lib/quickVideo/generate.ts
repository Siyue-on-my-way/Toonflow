/**
 * QuickVideo 逐镜头生成引擎（图片 → 5-15 秒视频片段）
 *
 * 设计要点（对应 SIY-109 约束）：
 * - 生成只读取最终生成参数确认时冻结的快照（generationSnapshot），不读实时分镜内容；
 *   镜头级生成状态（imageState/videoState/imageRef/videoRef/errorReason）实时回写 o_agentWorkData。
 * - 复用现有 AI 供应商链路（u.Ai.Image / u.Ai.Video，内部自带任务记录与重试型供应商轮询）
 *   与 MinIO 存储（u.oss）。
 * - 单镜头失败互不影响：每条镜头管线独立 try/catch，失败只写该镜头；
 *   重试只重建该镜头的任务，已成功镜头不重跑。
 * - 服务重启 / 轮询中断恢复：进程内运行登记与库内状态对账（ensureGenerationRecovery）。
 */
import u from "@/utils";
import {
  GENERATION_CONCURRENCY,
  GENERATION_IMAGE_TIMEOUT_MS,
  GENERATION_VIDEO_TIMEOUT_MS,
  QuickVideoDuration,
  QuickVideoGenerationSnapshot,
  QuickVideoMaterialItem,
  QuickVideoRatio,
  QuickVideoShot,
  QuickVideoSnapshotShot,
  QuickVideoState,
  SnapshotFirstFrame,
  applyStoryboardGateReject,
  assertRetryShotStage,
  assertStoryboardGate,
  echoFinalParamsCard,
  validateStoryboard,
} from "./contract";
import { QuickVideoError, loadQuickVideoState, mutateQuickVideoState } from "./state";
import { recordEvent, qvLog } from "./metrics";
import { CHAT_MEDIA_ASSET_TYPE, getVendorModelCatalog, findFirstAvailableModel, getVideoModelDurationOptions, getVideoModelDefaultQuality } from "./media";
import { isVideoModelSupportingSingleImage, snapDurationToTiers } from "./modelValidation";
import {
  extractVideoLastFrameBuffer,
  saveLastFrameToAssetBoard,
  augmentPromptForCutContinuity,
  getShotDependencyId,
} from "./continuity";

/** 进程内生成运行登记：projectId -> 运行 runId（防止重复启动） */
const runningGenerations = new Map<number, { runId: string }>();
/** 进程内单镜头重试登记：`${projectId}:${shotId}` -> runId */
const runningShots = new Map<string, { runId: string }>();

// ---------------------------------------------------------------------------
// 对外查询
// ---------------------------------------------------------------------------

export function isGenerationActive(projectId: number): boolean {
  if (runningGenerations.has(projectId)) return true;
  for (const key of runningShots.keys()) {
    if (key.startsWith(`${projectId}:`)) return true;
  }
  return false;
}

export function getActiveRunId(projectId: number): string | null {
  return runningGenerations.get(projectId)?.runId ?? null;
}

// ---------------------------------------------------------------------------
// 素材解析与生成快照
// ---------------------------------------------------------------------------

/**
 * 解析分镜中引用的资产：按项目 + 名称（优先同类型）匹配资产库，
 * 命中则复用已有资产图作为生成参考，否则标记为需要先生成素材图。
 * 返回解析结果并写入 state.generation.snapshot（未确认快照，可反复刷新）。
 */
export async function resolveMaterialsSnapshot(
  projectId: number,
  opts: { expectedVersion?: number; idempotencyKey?: string } = {},
) {
  const state = await loadQuickVideoState(projectId);
  if (!state) throw new QuickVideoError("STATE_NOT_FOUND", "未找到 quickVideoAgent 状态，请先创建 quick_video 项目");
  if (!state.storyboard) throw new QuickVideoError("NO_STORYBOARD", "暂无分镜，无法解析素材", state.version);
  if (!["storyboard_draft", "storyboard_confirmed"].includes(state.stage)) {
    throw new QuickVideoError("STAGE_FORBIDDEN", `当前阶段 ${state.stage} 不允许解析素材`, state.version);
  }

  const { materials, snapshotShots } = await buildSnapshot(projectId, state);

  const { state: next, idempotentHit } = await mutateQuickVideoState(projectId, opts, (s) => {
    if (!s.storyboard) throw new QuickVideoError("NO_STORYBOARD", "暂无分镜，无法解析素材", s.version);
    applySnapshotToState(s, s.storyboard.version, snapshotShots, materials);
  });
  return { state: next, materials, idempotentHit };
}

/** 素材解析（不落库，供最终参数确认/卡片回显现场重建快照时复用） */
export async function buildSnapshot(projectId: number, state: QuickVideoState) {
  if (!state.storyboard) throw new QuickVideoError("NO_STORYBOARD", "暂无分镜，无法解析素材", state.version);
  const materials = await buildMaterials(projectId, state.storyboard.shots);
  const snapshotShots: QuickVideoSnapshotShot[] = await Promise.all(
    state.storyboard.shots.map(async (s) => ({
      id: s.id,
      index: s.index,
      duration: s.duration,
      description: s.description,
      dialogue: s.dialogue,
      camera: s.camera,
      imagePrompt: s.imagePrompt ?? "",
      videoPrompt: s.videoPrompt ?? "",
      assetRefs: s.assetRefs,
      continuity: s.continuity ?? "last_frame",
      firstFrame: await resolveSnapshotFirstFrame(s),
    })),
  );
  return { materials, snapshotShots };
}
/**
 * 冻结镜头的首帧引用：把 shot.firstFrame（mediaId/assetId/imageId）解析出 filePath 一并
 * 写入快照，生成引擎直接读取，不再二次查库/查权限。首帧已绑定但文件已失效时直接报错，
 * 不允许静默回退到分镜图（任务约束「禁止静默换图」）——用户需要在草稿阶段重新绑定或解除。
 */
async function resolveSnapshotFirstFrame(shot: QuickVideoShot): Promise<SnapshotFirstFrame | null> {
  if (!shot.firstFrame) return null;
  const image = await u.db("o_image").where("id", shot.firstFrame.imageId).select("filePath").first();
  if (!image?.filePath) {
    throw new QuickVideoError(
      "FIRST_FRAME_MISSING",
      `镜头 ${shot.id} 绑定的首帧已失效，请在分镜草稿阶段重新绑定或解除后再确认`,
    );
  }
  return { ...shot.firstFrame, filePath: image.filePath };
}

/** 把解析结果写入状态的 generation.snapshot（最终参数确认前为未确认快照；新快照会重置确认状态） */
export function applySnapshotToState(
  s: QuickVideoState,
  storyboardVersion: number,
  snapshotShots: QuickVideoSnapshotShot[],
  materials: QuickVideoMaterialItem[],
) {
  s.generation.snapshot = {
    storyboardVersion,
    targetDuration: s.targetDuration,
    videoRatio: s.videoRatio,
    artStyle: s.artStyle,
    shots: snapshotShots,
    materials,
  };
  s.generation.materialsConfirmed = false;
  s.generation.materialsConfirmedAt = null;
}

/** 分镜 assetRefs -> 素材解析列表（按 type+name 去重） */
async function buildMaterials(projectId: number, shots: QuickVideoShot[]): Promise<QuickVideoMaterialItem[]> {
  const refs = new Map<string, { type: "role" | "scene" | "tool"; name: string; desc: string }>();
  for (const shot of shots) {
    for (const ref of shot.assetRefs ?? []) {
      refs.set(`${ref.type}:${ref.name}`, { type: ref.type, name: ref.name, desc: ref.desc ?? "" });
    }
  }
  const materials: QuickVideoMaterialItem[] = [];
  for (const ref of refs.values()) {
    const matched = await matchProjectAsset(projectId, ref);
    materials.push({
      type: ref.type,
      name: ref.name,
      desc: ref.desc,
      source: matched ? "matched" : "to_generate",
      assetId: matched?.assetId ?? null,
      imageId: matched?.imageId ?? null,
      filePath: matched?.filePath ?? null,
    });
  }
  return materials;
}

/** 按 项目 + 名称 匹配资产库（优先同类型），返回带图片的命中项；无图资产不算命中。
 *  聊天/白板生成的媒体资产（CHAT_MEDIA_ASSET_TYPE）明确排除在外——它们没有 role/scene/tool
 *  语义，只是碰巧同名就被当成素材参考图会悄悄改变镜头生成输入（SIY-132 review 发现的缺口）。 */
async function matchProjectAsset(
  projectId: number,
  ref: { type: string; name: string },
): Promise<{ assetId: number; imageId: number; filePath: string } | null> {
  const rows = await u
    .db("o_assets")
    .leftJoin("o_image", "o_assets.imageId", "o_image.id")
    .where("o_assets.projectId", projectId)
    .andWhere("o_assets.name", ref.name)
    .andWhereNot("o_assets.type", CHAT_MEDIA_ASSET_TYPE)
    .select("o_assets.id as assetId", "o_assets.type as assetType", "o_image.id as imageId", "o_image.filePath as filePath");

  const hit = rows.find((r: any) => r.assetType === ref.type && r.filePath) ?? rows.find((r: any) => r.filePath);
  if (!hit?.filePath) return null;
  return { assetId: hit.assetId, imageId: hit.imageId, filePath: hit.filePath };
}

// ---------------------------------------------------------------------------
// 模型解析
// ---------------------------------------------------------------------------

export async function resolveGenerationModels(projectId: number, sessionId?: number | null): Promise<{ imageModel: string; videoModel: string }> {
  const project = await u.db("o_project").where("id", projectId).first();
  const session = sessionId ? await u.db("o_quickVideoSession").where({ id: sessionId, projectId }).first() : null;
  // 会话内保存的偏好优先；未设置时回退项目历史默认值（兼容尚未迁移/未设置过偏好的会话）
  let imageModel = String(session?.imageModel || project?.imageModel || "");
  let videoModel = String(session?.videoModel || project?.videoModel || "");
  if (!imageModel) imageModel = await findFirstAvailableModel("image");
  if (!videoModel) videoModel = await findFirstAvailableModel("video");
  if (!imageModel || !videoModel) {
    throw new QuickVideoError("MODEL_NOT_CONFIGURED", "未找到可用的图片/视频生成模型，请先在设置页配置或启用对应模型");
  }
  return { imageModel, videoModel };
}

// ---------------------------------------------------------------------------
// 生成启动 / 重试 / 恢复
// ---------------------------------------------------------------------------

/**
 * 启动（或幂等复用）一次整项目生成运行。
 * 前置条件由服务端校验：generating 阶段 + 最终生成参数确认已通过 + 快照存在。
 */
export async function startQuickVideoGeneration(
  projectId: number,
  userId: number,
  sessionId?: number | null,
): Promise<{ started: boolean; alreadyRunning: boolean; runId: string }> {
  const active = runningGenerations.get(projectId);
  if (active) return { started: false, alreadyRunning: true, runId: active.runId };

  const state = await loadQuickVideoState(projectId);
  if (!state) throw new QuickVideoError("STATE_NOT_FOUND", "未找到 quickVideoAgent 状态");
  if (state.stage !== "generating") {
    throw new QuickVideoError("STAGE_MISMATCH", `当前阶段 ${state.stage} 不允许开始生成，请先确认最终生成参数`, state.version);
  }
  if (!state.generation?.materialsConfirmed || !state.generation?.snapshot) {
    throw new QuickVideoError("MATERIALS_NOT_CONFIRMED", "最终生成参数尚未确认，无法开始生成", state.version);
  }

  const runId = `run-${u.uuid().slice(0, 8)}`;
  runningGenerations.set(projectId, { runId });
  try {
    await mutateQuickVideoState(projectId, { sessionId: sessionId ?? undefined }, (s) => {
      s.generation.runId = runId;
      s.generation.startedAt = Date.now();
      s.generation.finishedAt = null;
    });
  } catch (err) {
    // Do not launch a detached run if its run id could not be persisted. A
    // process-local task with no durable marker cannot be recovered reliably
    // after a restart and would leave the workbench in a misleading state.
    runningGenerations.delete(projectId);
    throw err;
  }
  // 分离运行：接口立刻返回，进度通过状态轮询观察
  runGeneration(projectId, userId, runId, sessionId)
    .catch((err) => console.error(`[quickVideo] 生成运行 ${runId} 异常终止:`, u.error(err).message))
    .finally(() => {
      if (runningGenerations.get(projectId)?.runId === runId) runningGenerations.delete(projectId);
      maybeFinishGeneration(projectId).catch(() => {});
    });
  return { started: true, alreadyRunning: false, runId };
}

/**
 * gate=storyboard 内核：确认 / 撤销确认（REST confirmStage 与 Agent 的 confirm_storyboard /
 * reject_storyboard 工具共用，必须在 mutateQuickVideoState 的 mutator 内调用，事务 + 乐观锁 + 幂等由调用方负责）。
 * - confirm：校验镜头数量与总时长，通过后锁定分镜并组装生成快照、回显最终参数确认卡片；
 * - reject：分镜回到草稿状态解锁编辑（纯转移见 contract.applyStoryboardGateReject）。
 */
export async function applyStoryboardGate(projectId: number, state: QuickVideoState, action: "confirm" | "reject"): Promise<void> {
  assertStoryboardGate(state, action);
  if (action === "reject") {
    applyStoryboardGateReject(state);
    return;
  }
  const storyboard = state.storyboard!;
  const errors = validateStoryboard(state.targetDuration, storyboard.shots);
  if (errors.length) throw new QuickVideoError("STORYBOARD_INVALID", errors.join("；"), state.version);
  state.stage = "storyboard_confirmed";
  storyboard.status = "confirmed";
  storyboard.confirmedAt = Date.now();
  // 分镜确认后直接组装最终生成参数并回显确认卡片（快照同步冻结，供生成引擎读取）；
  // 不再设置任何素材/成本前置门槛
  const { materials, snapshotShots } = await buildSnapshot(projectId, state);
  applySnapshotToState(state, storyboard.version, snapshotShots, materials);
  echoFinalParamsCard(state);
}

/**
 * 重试镜头：重置失败（或中断遗留 pending/generating）镜头的状态并单独重建任务。
 * 已成功（done）的镜头不会被重置，其他镜头任务不受影响。
 */
export async function retryQuickVideoShots(
  projectId: number,
  userId: number,
  shotIds: string[],
  sessionId?: number | null,
  /** 幂等键（Agent retry_shot 工具按 toolCallId 传入；REST 不传，行为不变：重试是显式新动作） */
  idempotencyKey?: string,
) {
  const state = await loadQuickVideoState(projectId);
  if (!state) throw new QuickVideoError("STATE_NOT_FOUND", "未找到 quickVideoAgent 状态");
  assertRetryShotStage(state);
  if (!state.generation?.materialsConfirmed) {
    throw new QuickVideoError("MATERIALS_NOT_CONFIRMED", "最终生成参数尚未确认", state.version);
  }
  if (runningGenerations.has(projectId)) {
    throw new QuickVideoError("GENERATION_RUNNING", "整批生成正在进行中，请等待结束后再重试失败镜头", state.version);
  }

  for (const shotId of shotIds) {
    const shot = state.storyboard?.shots.find((s) => s.id === shotId);
    if (!shot) throw new QuickVideoError("SHOT_NOT_FOUND", `未找到镜头 ${shotId}`, state.version);
    if (runningShots.has(`${projectId}:${shotId}`)) {
      throw new QuickVideoError("SHOT_RUNNING", `镜头 ${shotId} 正在生成中，请稍候`, state.version);
    }
    if (shot.imageState === "done" && shot.videoState === "done") {
      throw new QuickVideoError("SHOT_ALREADY_DONE", `镜头 ${shotId} 已生成完成，无需重试`, state.version);
    }
  }

  // 重试是显式的新动作：REST 不记幂等键（同镜头可反复重试）；Agent 工具传入 toolCallId 幂等键时
  // 只用于同一调用的重放去重。done 镜头已在上方拦截
  const runId = `retry-${u.uuid().slice(0, 8)}`;
  const { state: next, idempotentHit } = await mutateQuickVideoState(
    projectId,
    { sessionId: sessionId ?? undefined, idempotencyKey },
    (s) => {
      s.generation.runId = runId;
      for (const shotId of shotIds) {
        const shot = s.storyboard?.shots.find((x) => x.id === shotId);
        if (!shot) continue;
        // 只重置未成功的部分；done 保持不动
        if (shot.imageState !== "done") shot.imageState = "pending";
        if (shot.videoState !== "done") shot.videoState = "pending";
        shot.errorReason = null;
      }
    },
  );
  if (idempotentHit) {
    return { state: next, retried: [] as string[], runId: null as string | null, idempotentHit };
  }

  for (const shotId of shotIds) {
    launchShotPipeline(projectId, userId, runId, shotId, sessionId);
  }
  return { state: next, retried: shotIds, runId, idempotentHit };
}

/** 启动单镜头管线（登记 + 分离运行），重复启动会被登记挡下 */
function launchShotPipeline(projectId: number, userId: number, runId: string, shotId: string, sessionId?: number | null) {
  const key = `${projectId}:${shotId}`;
  if (runningShots.has(key)) return;
  runningShots.set(key, { runId });
  runShotPipeline(projectId, userId, shotId, undefined, sessionId)
    .catch((err) => console.error(`[quickVideo] 镜头 ${shotId} 管线异常:`, u.error(err).message))
    .finally(() => {
      runningShots.delete(key);
      maybeFinishGeneration(projectId).catch(() => {});
    });
}

/**
 * 服务重启 / 进程崩溃后的对账恢复（getWorkbench 时调用）：
 * - 库内 generating 阶段但进程内无任何活动运行 → 若全部完成则推进 ready_to_assemble；
 * - 存在卡在 generating 的镜头 → 标记失败并提示重试。
 */
export async function ensureGenerationRecovery(projectId: number): Promise<void> {
  try {
    if (isGenerationActive(projectId)) return;
    const state = await loadQuickVideoState(projectId);
    if (!state || state.stage !== "generating" || !state.generation?.materialsConfirmed) return;
    const shots = state.storyboard?.shots ?? [];
    if (!shots.length) return;

    if (shots.every((s) => s.imageState === "done" && s.videoState === "done")) {
      await mutateQuickVideoState(
        projectId,
        { stageTransition: { from: "generating", to: "ready_to_assemble" } },
        (s) => {
          s.stage = "ready_to_assemble";
          s.generation.finishedAt = Date.now();
        },
      );
      return;
    }

    // Pending is also an interrupted state: a process can die after the
    // confirmation transaction but before the first shot worker gets a turn.
    // Leaving pending shots untouched makes the UI show an endless
    // generating stage with no retryable shot.
    const interrupted = shots.some(
      (s) => s.imageState === "generating" || s.videoState === "generating" || s.imageState === "pending" || s.videoState === "pending",
    );
    if (!interrupted) return;
    await mutateQuickVideoState(projectId, {}, (s) => {
      for (const shot of s.storyboard?.shots ?? []) {
        if (shot.imageState === "generating" || shot.imageState === "pending") {
          shot.imageState = "failed";
          shot.errorReason = "生成中断（服务重启或轮询中断），请重试该镜头";
        }
        if (shot.videoState === "generating" || shot.videoState === "pending") {
          shot.videoState = "failed";
          shot.errorReason = "生成中断（服务重启或轮询中断），请重试该镜头";
        }
      }
    });
  } catch (err) {
    console.error(`[quickVideo] 项目 ${projectId} 生成恢复检查失败:`, u.error(err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// 生成管线
// ---------------------------------------------------------------------------

interface GenerationContext {
  projectId: number;
  userId: number;
  runId: string;
  snapshot: QuickVideoGenerationSnapshot;
  imageModel: string;
  videoModel: string;
  sessionId?: number | null;
}

async function runGeneration(projectId: number, userId: number, runId: string, sessionId?: number | null) {
  const state = await loadQuickVideoState(projectId);
  const snapshot = state?.generation?.snapshot;
  if (!snapshot) {
    console.error(`[quickVideo] 运行 ${runId} 缺少生成快照，终止`);
    await markShotsFailed(projectId, state?.storyboard?.shots.map((shot) => shot.id) ?? [], "生成快照缺失，请重新确认分镜并重试");
    return;
  }

  let models: { imageModel: string; videoModel: string };
  try {
    models = await resolveGenerationModels(projectId, sessionId);
  } catch (err) {
    await markShotsFailed(projectId, snapshot.shots.map((s) => s.id), u.error(err as Error).message);
    return;
  }

  const ctx: GenerationContext = { projectId, userId, runId, snapshot, sessionId, ...models };

  // 先补齐需要生成的素材图（同一素材只生成一次，供引用它的镜头做参考图）
  await ensureMaterialImages(ctx);

  // 流水线生成调度（SIY-150）：
  // 有依赖关系的镜头（顺承 last_frame 或切镜 assets_only）等待前置镜头产出后自动启动，
  // 独立镜头（independent）在并发上限内并发执行；单镜头失败只影响自身及直接后继
  const shots = snapshot.shots;
  const completedShotIds = new Set<string>();
  const failedShotIds = new Set<string>();
  const activeRuns = new Map<string, Promise<void>>();

  const isShotReady = (s: QuickVideoSnapshotShot) => {
    if (completedShotIds.has(s.id) || failedShotIds.has(s.id) || activeRuns.has(s.id)) return false;
    const depId = getShotDependencyId(s.index, shots);
    if (!depId) return true;
    return completedShotIds.has(depId);
  };

  while (completedShotIds.size + failedShotIds.size < shots.length) {
    // 检查是否有前置依赖已失败但后续仍在等待的镜头
    for (const s of shots) {
      if (completedShotIds.has(s.id) || failedShotIds.has(s.id) || activeRuns.has(s.id)) continue;
      const depId = getShotDependencyId(s.index, shots);
      if (depId && failedShotIds.has(depId)) {
        failedShotIds.add(s.id);
        await updateShotState(projectId, s.id, {
          imageState: "failed",
          videoState: "failed",
          errorReason: `前置镜头 ${depId} 生成失败，无法保障跨镜头连续性，请先重试前置镜头`,
        });
      }
    }

    // 调度就绪的镜头，不超过并发上限 GENERATION_CONCURRENCY
    for (const s of shots) {
      if (activeRuns.size >= GENERATION_CONCURRENCY) break;
      if (isShotReady(s)) {
        const shotId = s.id;
        const taskPromise = runShotPipeline(projectId, userId, shotId, ctx)
          .catch((err) => {
            console.error(`[quickVideo] 运行 ${runId} 镜头 ${shotId} 管线异常:`, u.error(err).message);
          })
          .then(async () => {
            const freshState = await loadQuickVideoState(projectId);
            const shotNow = freshState?.storyboard?.shots.find((x) => x.id === shotId);
            if (shotNow?.videoState === "done") {
              completedShotIds.add(shotId);
            } else {
              failedShotIds.add(shotId);
            }
            activeRuns.delete(shotId);
          });
        activeRuns.set(shotId, taskPromise);
      }
    }

    if (activeRuns.size === 0) {
      break;
    }

    await Promise.race(activeRuns.values());
  }
}

/** 整批标记失败（如模型未配置时的统一失败原因） */
async function markShotsFailed(projectId: number, shotIds: string[], reason: string) {
  try {
    await mutateQuickVideoState(projectId, {}, (s) => {
      for (const shotId of shotIds) {
        const shot = s.storyboard?.shots.find((x) => x.id === shotId);
        if (!shot) continue;
        if (shot.imageState !== "done") shot.imageState = "failed";
        if (shot.videoState !== "done") shot.videoState = "failed";
        shot.errorReason = reason;
      }
    });
  } catch (err) {
    console.error(`[quickVideo] 标记镜头失败时出错:`, u.error(err as Error).message);
  }
}

/** 生成缺失的素材图（命中资产库的素材直接复用已有图，无需生成） */
async function ensureMaterialImages(ctx: GenerationContext) {
  const state = await loadQuickVideoState(ctx.projectId);
  const cached = state?.generation?.materialImages ?? {};
  const toGenerate = ctx.snapshot.materials.filter((m) => m.source === "to_generate" && !cached[m.name]);

  for (const material of toGenerate) {
    try {
      const prompt = [
        ctx.snapshot.artStyle ? `画面风格：${ctx.snapshot.artStyle}` : "",
        `${materialLabel(material.type)}「${material.name}」的定妆图/空镜图`,
        material.desc,
        "构图干净，主体清晰，无文字水印",
      ]
        .filter(Boolean)
        .join("；");
      const imageCls = u.Ai.Image(ctx.imageModel as `${string}:${string}`, ctx.userId);
      await withTimeout(
        imageCls.run(
          {
            prompt,
            referenceList: [],
            size: "1K",
            aspectRatio: castAspectRatio(ctx.snapshot.videoRatio),
          },
          {
            taskClass: "快创素材图",
            describe: `素材「${material.name}」参考图生成`,
            relatedObjects: JSON.stringify({ projectId: ctx.projectId, material: material.name, runId: ctx.runId }),
            projectId: ctx.projectId,
          },
        ),
        GENERATION_IMAGE_TIMEOUT_MS,
        `素材「${material.name}」参考图生成超时`,
      );
      const savePath = `/${ctx.projectId}/quickVideo/material-${u.uuid().slice(0, 8)}.jpg`;
      await imageCls.save(savePath);
      await mutateQuickVideoState(ctx.projectId, {}, (s) => {
        s.generation.materialImages[material.name] = savePath;
      });
    } catch (err) {
      // 单个素材图失败不终止生成：引用它的镜头退化为纯文本提示词
      console.error(`[quickVideo] 素材「${material.name}」参考图生成失败:`, u.error(err as Error).message);
    }
  }
}

/** 单镜头管线：分镜图（未完成时）→ 5-15 秒视频片段（图生视频） */
async function runShotPipeline(projectId: number, userId: number, shotId: string, presetCtx?: GenerationContext, sessionId?: number | null) {
  const state = await loadQuickVideoState(projectId);
  const snapshot = state?.generation?.snapshot;
  const liveShot = state?.storyboard?.shots.find((s) => s.id === shotId);
  if (!snapshot || !liveShot) return;
  const shotContent = snapshot.shots.find((s) => s.id === shotId);
  if (!shotContent) return;

  const ctx =
    presetCtx ??
    (await (async () => {
      const models = await resolveGenerationModels(projectId, sessionId);
      return { projectId, userId, runId: `retry-${u.uuid().slice(0, 8)}`, snapshot, sessionId, ...models } as GenerationContext;
    })());

  const prevShot = shotContent.index > 1 ? snapshot.shots.find((s) => s.index === shotContent.index - 1) : null;
  const continuity = shotContent.continuity ?? "last_frame";

  // --- 顺承镜头（last_frame）尾帧注入处理 ---
  // 若本镜头为顺承镜头且未显式指定首帧，从上一镜头已生成的视频中自动提取尾帧，存入资产白板并绑定为本镜头的首帧
  if (shotContent.index > 1 && continuity === "last_frame") {
    if (!shotContent.firstFrame) {
      const liveState = await loadQuickVideoState(projectId);
      const prevLive = liveState?.storyboard?.shots.find((s) => s.index === shotContent.index - 1);
      if (prevLive?.videoRef && prevLive.videoState === "done") {
        try {
          const videoBuffer = await u.oss.getFile(prevLive.videoRef);
          const frameBuffer = await extractVideoLastFrameBuffer(videoBuffer);
          const savedFrame = await saveLastFrameToAssetBoard(projectId, ctx.sessionId, prevLive.id, ctx.runId, frameBuffer);
          const firstFrameInfo = {
            mediaId: savedFrame.mediaId,
            assetId: savedFrame.assetId,
            imageId: savedFrame.imageId,
            boundAt: Date.now(),
          };
          await mutateQuickVideoState(projectId, {}, (s) => {
            const cur = s.storyboard?.shots.find((x) => x.id === shotId);
            if (cur) {
              cur.firstFrame = firstFrameInfo;
              cur.imageState = "done";
              cur.imageRef = savedFrame.filePath;
              cur.errorReason = null;
            }
          });
          shotContent.firstFrame = { ...firstFrameInfo, filePath: savedFrame.filePath };
          liveShot.firstFrame = firstFrameInfo;
          liveShot.imageState = "done";
          liveShot.imageRef = savedFrame.filePath;
        } catch (extractErr) {
          console.warn(`[quickVideo] 提取上一镜头 ${prevLive.id} 尾帧失败:`, u.error(extractErr).message);
        }
      }
    } else {
      liveShot.imageState = "done";
      liveShot.imageRef = shotContent.firstFrame.filePath;
    }
  }

  // --- 分镜图 ---
  let imageRef = shotContent.firstFrame?.filePath ?? liveShot.imageRef;
  if (liveShot.imageState !== "done" || !imageRef) {
    await updateShotState(projectId, shotId, { imageState: "generating", errorReason: null });
    try {
      const referenceList = await buildShotImageReferences(ctx, shotContent, prevShot);
      const imageCls = u.Ai.Image(ctx.imageModel as `${string}:${string}`, ctx.userId);
      await withTimeout(
        imageCls.run(
          {
            prompt: buildShotImagePrompt(ctx.snapshot, shotContent, prevShot),
            referenceList,
            size: "1K",
            aspectRatio: castAspectRatio(ctx.snapshot.videoRatio),
          },
          {
            taskClass: "快创分镜图片",
            describe: `镜头${shotContent.index} 分镜图生成`,
            relatedObjects: JSON.stringify({ projectId, shotId, runId: ctx.runId }),
            projectId,
          },
        ),
        GENERATION_IMAGE_TIMEOUT_MS,
        "分镜图生成超时",
      );
      imageRef = `/${projectId}/quickVideo/${shotId}-${u.uuid().slice(0, 8)}.jpg`;
      await imageCls.save(imageRef);
      await updateShotState(projectId, shotId, { imageState: "done", imageRef, errorReason: null });
      recordEvent("generationShotImageDone");
    } catch (err) {
      const reason = u.error(err as Error).message;
      // 视频管线依赖分镜图。图片失败时也要把视频收敛到 failed，
      // 否则镜头会永远停在 image=failed/video=pending，既无法完成
      // 项目级失败对账，也无法让用户明确触发单镜头重试。
      await updateShotState(projectId, shotId, { imageState: "failed", videoState: "failed", errorReason: reason });
      recordEvent("generationShotFailed");
      qvLog("shot_failed", { projectId, shotId, stage: "image", reason });
      return; // 视频依赖分镜图，图失败则该镜头终止（其余镜头不受影响）
    }
  }

  // --- 视频片段 ---
  const liveAfterImage = (await loadQuickVideoState(projectId))?.storyboard?.shots.find((s) => s.id === shotId);
  if (liveAfterImage?.videoState === "done" && liveAfterImage.videoRef) return;
  await updateShotState(projectId, shotId, { videoState: "generating", errorReason: null });
  try {
    // 优先使用用户绑定的冻结首帧；未绑定时回退到本镜头自动生成的分镜图（imageRef 与
    // firstFrame 分开建模，见 contract.ts shotFirstFrameSchema 注释）。
    const baseImagePath = shotContent.firstFrame?.filePath ?? imageRef;
    await assertVideoSupportsSingleImage(ctx.videoModel, !!shotContent.firstFrame);
    const imageBase64 = await u.oss.getImageBase64(baseImagePath!);
    // 模型声明能力适配（SIY-154 P1/P2）：镜头时长按模型声明档位就近取整（如 Kling O1 仅支持
    // 5/10 秒）；模型目录声明 qualityOptions 时自动补齐生成质量（供应商侧 mode 必填字段）。
    const [durationTiers, modelQuality] = await Promise.all([
      getVideoModelDurationOptions(ctx.videoModel),
      getVideoModelDefaultQuality(ctx.videoModel),
    ]);
    const shotDuration = snapDurationToTiers(shotContent.duration, durationTiers ?? []) ?? shotContent.duration;
    const videoAi = u.Ai.Video(ctx.videoModel as `${string}:${string}`, ctx.userId);
    await withTimeout(
      videoAi.run(
        {
          prompt: buildShotVideoPrompt(shotContent, prevShot),
          referenceList: [{ type: "image", base64: imageBase64 }],
          mode: ["singleImage"],
          duration: shotDuration,
          aspectRatio: castAspectRatio(ctx.snapshot.videoRatio),
          resolution: "720p",
          quality: modelQuality ?? undefined,
        },
        {
          taskClass: "快创镜头视频",
          describe: `镜头${shotContent.index} 视频片段生成（${shotDuration} 秒）`,
          relatedObjects: JSON.stringify({ projectId, shotId, runId: ctx.runId }),
          projectId,
        },
      ),
      GENERATION_VIDEO_TIMEOUT_MS,
      "镜头视频生成超时",
    );
    const videoRef = `/${projectId}/quickVideo/${shotId}-${u.uuid().slice(0, 8)}.mp4`;
    await videoAi.save(videoRef);
    await updateShotState(projectId, shotId, { videoState: "done", videoRef, errorReason: null });
    recordEvent("generationShotDone");
    qvLog("shot_done", { projectId, shotId, duration: shotDuration });

    // 预抽尾帧：若后序镜头为顺承镜头，立即抽帧存入资产白板并预注入首帧
    const nextShot = snapshot.shots.find((s) => s.index === shotContent.index + 1);
    if (nextShot && (nextShot.continuity ?? "last_frame") === "last_frame" && !nextShot.firstFrame) {
      try {
        const videoBuffer = await u.oss.getFile(videoRef);
        const frameBuffer = await extractVideoLastFrameBuffer(videoBuffer);
        const savedFrame = await saveLastFrameToAssetBoard(projectId, ctx.sessionId, shotId, ctx.runId, frameBuffer);
        const firstFrameInfo = {
          mediaId: savedFrame.mediaId,
          assetId: savedFrame.assetId,
          imageId: savedFrame.imageId,
          boundAt: Date.now(),
        };
        await mutateQuickVideoState(projectId, {}, (s) => {
          const cur = s.storyboard?.shots.find((x) => x.id === nextShot.id);
          if (cur) {
            cur.firstFrame = firstFrameInfo;
            cur.imageState = "done";
            cur.imageRef = savedFrame.filePath;
            cur.errorReason = null;
          }
        });
        nextShot.firstFrame = { ...firstFrameInfo, filePath: savedFrame.filePath };
      } catch (err) {
        console.warn(`[quickVideo] 镜头 ${shotId} 完成后预抽尾帧失败:`, u.error(err).message);
      }
    }
  } catch (err) {
    const reason = u.error(err as Error).message;
    await updateShotState(projectId, shotId, { videoState: "failed", errorReason: reason });
    recordEvent("generationShotFailed");
    qvLog("shot_failed", { projectId, shotId, stage: "video", reason });
  }
}

/**
 * 视频模型单图/首帧模式能力检查：仅当目录中明确声明了 mode 且不包含 singleImage 时才拦截；
 * 目录缺失/未声明 mode 时放行（与既有"未收紧则放行"的模型解析约定一致，避免误伤已在用模型）。
 * hasBoundFirstFrame 只影响报错文案——没有绑定首帧时走的是自动生成的分镜图回退，
 * 提示用户"解除首帧"并不适用（该镜头本来就没有绑定）。
 */
export async function assertVideoSupportsSingleImage(videoModelKey: string, hasBoundFirstFrame: boolean): Promise<void> {
  const sep = videoModelKey.indexOf(":");
  if (sep <= 0) return;
  const vendorId = videoModelKey.slice(0, sep);
  const modelName = videoModelKey.slice(sep + 1);
  const catalog = await getVendorModelCatalog(vendorId);
  if (!catalog) return;
  const hit = catalog.models.find((m) => m?.modelName === modelName && m?.type === "video");
  if (!isVideoModelSupportingSingleImage(hit)) {
    const hint = hasBoundFirstFrame ? "请更换视频模型或解除该镜头首帧后重试" : "请更换视频模型后重试";
    throw new Error(`所选视频模型「${modelName}」不支持单图/首帧输入，${hint}`);
  }
}

/** 全部镜头生成完毕且无活动运行时，推进 generating -> ready_to_assemble */
async function maybeFinishGeneration(projectId: number) {
  try {
    if (isGenerationActive(projectId)) return;
    const state = await loadQuickVideoState(projectId);
    if (!state || state.stage !== "generating" || !state.generation?.materialsConfirmed) return;
    const shots = state.storyboard?.shots ?? [];
    if (!shots.length || !shots.every((s) => s.imageState === "done" && s.videoState === "done")) return;
    await mutateQuickVideoState(
      projectId,
      { stageTransition: { from: "generating", to: "ready_to_assemble" } },
      (s) => {
        s.stage = "ready_to_assemble";
        s.generation.finishedAt = Date.now();
      },
    );
  } catch {
    // 竞态下阶段已被推进等情况，忽略
  }
}

// ---------------------------------------------------------------------------
// 状态回写与提示词
// ---------------------------------------------------------------------------

async function updateShotState(
  projectId: number,
  shotId: string,
  patch: Partial<Pick<QuickVideoShot, "imageState" | "videoState" | "imageRef" | "videoRef" | "errorReason">>,
) {
  try {
    await mutateQuickVideoState(projectId, {}, (s) => {
      const shot = s.storyboard?.shots.find((x) => x.id === shotId);
      if (!shot) return;
      if (patch.imageState != null) shot.imageState = patch.imageState;
      if (patch.videoState != null) shot.videoState = patch.videoState;
      if (patch.imageRef !== undefined) shot.imageRef = patch.imageRef;
      if (patch.videoRef !== undefined) shot.videoRef = patch.videoRef;
      if (patch.errorReason !== undefined) shot.errorReason = patch.errorReason;
    });
  } catch (err) {
    console.error(`[quickVideo] 回写镜头 ${shotId} 状态失败:`, u.error(err as Error).message);
  }
}

function materialLabel(type: string): string {
  return type === "role" ? "角色" : type === "scene" ? "场景" : "道具";
}

/** 镜头分镜图提示词：优先使用分镜表策划的 imagePrompt（SIY-151），未填写时按描述+运镜+资产自动组装 */
function buildShotImagePrompt(
  snapshot: QuickVideoGenerationSnapshot,
  shot: QuickVideoSnapshotShot,
  prevShot?: QuickVideoSnapshotShot | null,
): string {
  const planned = shot.imagePrompt?.trim();
  if (planned) {
    // 策划板提示词是用户/Agent 打磨过的直接依据：仅补充画风、比例与连续性特征词
    let prompt = [
      snapshot.artStyle ? `整体画面风格：${snapshot.artStyle}` : "",
      `画面比例 ${snapshot.videoRatio}`,
      planned,
      "单幅完整画面，无文字、无水印、无分屏",
    ]
      .filter(Boolean)
      .join("；");
    if (shot.continuity === "assets_only" && prevShot) {
      prompt = augmentPromptForCutContinuity(prompt, prevShot, shot);
    }
    return prompt;
  }
  const parts = [
    snapshot.artStyle ? `整体画面风格：${snapshot.artStyle}` : "",
    `画面比例 ${snapshot.videoRatio}`,
    shot.description,
    shot.camera ? `景别/运镜：${shot.camera}` : "",
    shot.assetRefs?.length
      ? `画面需保持以下要素的视觉一致性：${shot.assetRefs.map((a) => `${materialLabel(a.type)}「${a.name}」${a.desc ? `（${a.desc}）` : ""}`).join("；")}`
      : "",
    "单幅完整画面，无文字、无水印、无分屏",
  ];
  let prompt = parts.filter(Boolean).join("；");
  if (shot.continuity === "assets_only" && prevShot) {
    prompt = augmentPromptForCutContinuity(prompt, prevShot, shot);
  }
  return prompt;
}

/** 镜头视频提示词：优先使用分镜表策划的 videoPrompt（SIY-151），未填写时按画面描述与时长运动组装 */
function buildShotVideoPrompt(shot: QuickVideoSnapshotShot, prevShot?: QuickVideoSnapshotShot | null): string {
  const planned = shot.videoPrompt?.trim();
  let prompt = planned
    ? [
        planned,
        shot.dialogue ? `画面人物口型对齐台词：${shot.dialogue}` : "",
        `镜头时长 ${shot.duration} 秒，动作自然连贯，保持人物与环境一致`,
      ]
        .filter(Boolean)
        .join("；")
    : [
        `以参考图为首帧，生成 ${shot.duration} 秒的连续镜头`,
        shot.description,
        shot.camera ? `运镜：${shot.camera}` : "",
        shot.dialogue ? `画面人物口型对齐台词：${shot.dialogue}` : "",
        "动作自然连贯，保持人物与环境一致",
      ]
        .filter(Boolean)
        .join("；");
  if (shot.continuity === "assets_only" && prevShot) {
    prompt = augmentPromptForCutContinuity(prompt, prevShot, shot);
  }
  return prompt;
}

/** 镜头参考图：命中的资产图 + 已生成的素材图（按镜头 assetRefs 过滤；切镜模式下合并上一镜头的角色/道具图） */
async function buildShotImageReferences(
  ctx: GenerationContext,
  shot: QuickVideoSnapshotShot,
  prevShot?: QuickVideoSnapshotShot | null,
): Promise<{ type: "image"; base64: string }[]> {
  const state = await loadQuickVideoState(ctx.projectId);
  const materialImages = state?.generation?.materialImages ?? {};
  const refs: { type: "image"; base64: string }[] = [];

  const combinedAssetRefs = [...(shot.assetRefs ?? [])];
  if (shot.continuity === "assets_only" && prevShot?.assetRefs) {
    for (const r of prevShot.assetRefs) {
      if ((r.type === "role" || r.type === "tool") && !combinedAssetRefs.some((x) => x.type === r.type && x.name === r.name)) {
        combinedAssetRefs.push(r);
      }
    }
  }

  for (const ref of combinedAssetRefs) {
    const material = ctx.snapshot.materials.find((m) => m.type === ref.type && m.name === ref.name);
    if (!material) continue;
    const path = material.source === "matched" ? material.filePath : materialImages[material.name];
    if (!path) continue;
    try {
      refs.push({ type: "image", base64: await u.oss.getImageBase64(path) });
    } catch {
      // 单个参考图读取失败不阻断镜头生成
    }
  }
  return refs.slice(0, 4); // 参考图过多会显著拖慢/干扰生成
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

export function castAspectRatio(ratio: QuickVideoRatio): "16:9" | "9:16" {
  // 供应商接口仅声明 16:9 / 9:16；1:1 项目按竖版生成，由前端裁剪展示
  return ratio === "9:16" ? "9:16" : "16:9";
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 供路由使用：目标时长类型收窄 */
export function asQuickVideoDuration(d: number): QuickVideoDuration {
  return (d === 15 || d === 30 || d === 60 ? d : 30) as QuickVideoDuration;
}
