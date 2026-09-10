/**
 * QuickVideo 逐镜头生成引擎（图片 → 5-15 秒视频片段）
 *
 * 设计要点（对应 SIY-109 约束）：
 * - 生成只读取素材/成本确认门冻结的快照（generationSnapshot），不读实时分镜内容；
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
  computeGenerationEstimate,
} from "./contract";
import { QuickVideoError, loadQuickVideoState, mutateQuickVideoState } from "./state";
import { recordEvent, qvLog } from "./metrics";
import { CHAT_MEDIA_ASSET_TYPE, getVendorModelCatalog } from "./media";

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
// 素材解析与预估
// ---------------------------------------------------------------------------

/**
 * 解析分镜中引用的资产：按项目 + 名称（优先同类型）匹配资产库，
 * 命中则复用已有资产图作为生成参考，否则标记为需要先生成素材图。
 * 返回解析结果与预估，并写入 state.generation.snapshot（未确认，可反复刷新）。
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

  const { materials, estimate, snapshotShots } = await buildSnapshot(projectId, state);

  const { state: next, idempotentHit } = await mutateQuickVideoState(projectId, opts, (s) => {
    if (!s.storyboard) throw new QuickVideoError("NO_STORYBOARD", "暂无分镜，无法解析素材", s.version);
    applySnapshotToState(s, s.storyboard.version, snapshotShots, materials, estimate);
  });
  return { state: next, materials, estimate, idempotentHit };
}

/** 素材解析 + 预估推导（不落库，供素材确认门现场重建快照时复用） */
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
      assetRefs: s.assetRefs,
      firstFrame: await resolveSnapshotFirstFrame(s),
    })),
  );
  const estimate = computeGenerationEstimate(snapshotShots, materials);
  return { materials, estimate, snapshotShots };
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

/** 把解析结果写入状态的 generation.snapshot（确认门前为未确认快照；新快照会重置确认门） */
export function applySnapshotToState(
  s: QuickVideoState,
  storyboardVersion: number,
  snapshotShots: QuickVideoSnapshotShot[],
  materials: QuickVideoMaterialItem[],
  estimate: { estimatedImageCount: number; estimatedVideoCount: number; estimatedCostYuan: number; estimatedSeconds: number },
) {
  s.generation.snapshot = {
    storyboardVersion,
    targetDuration: s.targetDuration,
    videoRatio: s.videoRatio,
    artStyle: s.artStyle,
    shots: snapshotShots,
    materials,
    ...estimate,
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

/** 项目未配置生成模型时，按「启用的供应商 → 该类型第一个模型」兜底选择 */
async function findFirstAvailableModel(type: "image" | "video"): Promise<string> {
  const vendorRows = await u.db("o_vendorConfig").select("id").where("enable", 1);
  for (const row of vendorRows) {
    try {
      const models = (await u.vendor.getModelList(row.id)) ?? [];
      const hit = models.find((m: any) => m.type === type);
      if (!hit) continue;
      const enabled = await u.vendor.getEnabledModelNames(row.id);
      if (enabled.length === 0 || enabled.includes(hit.modelName)) {
        return `${row.id}:${hit.modelName}`;
      }
    } catch {
      // 单个供应商查询失败不影响兜底选择
    }
  }
  return "";
}

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
 * 前置条件由服务端校验：generating 阶段 + 素材确认门已通过 + 快照存在。
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
    throw new QuickVideoError("STAGE_MISMATCH", `当前阶段 ${state.stage} 不允许开始生成，请先通过确认门`, state.version);
  }
  if (!state.generation?.materialsConfirmed || !state.generation?.snapshot) {
    throw new QuickVideoError("MATERIALS_NOT_CONFIRMED", "素材/成本确认门尚未通过，无法开始生成", state.version);
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
 * 重试镜头：重置失败（或中断遗留 pending/generating）镜头的状态并单独重建任务。
 * 已成功（done）的镜头不会被重置，其他镜头任务不受影响。
 */
export async function retryQuickVideoShots(projectId: number, userId: number, shotIds: string[], sessionId?: number | null) {
  const state = await loadQuickVideoState(projectId);
  if (!state) throw new QuickVideoError("STATE_NOT_FOUND", "未找到 quickVideoAgent 状态");
  if (state.stage !== "generating") {
    throw new QuickVideoError("STAGE_MISMATCH", `当前阶段 ${state.stage} 不允许重试，仅生成阶段可重试失败镜头`, state.version);
  }
  if (!state.generation?.materialsConfirmed) {
    throw new QuickVideoError("MATERIALS_NOT_CONFIRMED", "素材/成本确认门尚未通过", state.version);
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

  // 重试是显式的新动作：不记幂等键（同镜头可反复重试）；done 镜头已在上方拦截
  const runId = `retry-${u.uuid().slice(0, 8)}`;
  const { state: next } = await mutateQuickVideoState(projectId, { sessionId: sessionId ?? undefined }, (s) => {
    s.generation.runId = runId;
    for (const shotId of shotIds) {
      const shot = s.storyboard?.shots.find((x) => x.id === shotId);
      if (!shot) continue;
      // 只重置未成功的部分；done 保持不动
      if (shot.imageState !== "done") shot.imageState = "pending";
      if (shot.videoState !== "done") shot.videoState = "pending";
      shot.errorReason = null;
    }
  });

  for (const shotId of shotIds) {
    launchShotPipeline(projectId, userId, runId, shotId, sessionId);
  }
  return { state: next, retried: shotIds, runId };
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
    await markShotsFailed(projectId, state?.storyboard?.shots.map((shot) => shot.id) ?? [], "生成快照缺失，请重新确认素材并重试");
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

  // 镜头按并发分批执行；单镜头失败只影响自身
  const shotIds = snapshot.shots.map((s) => s.id);
  for (let i = 0; i < shotIds.length; i += GENERATION_CONCURRENCY) {
    const batch = shotIds.slice(i, i + GENERATION_CONCURRENCY);
    await Promise.all(batch.map((shotId) => runShotPipeline(projectId, userId, shotId, ctx).catch((err) => {
      console.error(`[quickVideo] 运行 ${runId} 镜头 ${shotId} 管线异常:`, u.error(err).message);
    })));
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

  // --- 分镜图 ---
  let imageRef = liveShot.imageRef;
  if (liveShot.imageState !== "done" || !imageRef) {
    await updateShotState(projectId, shotId, { imageState: "generating", errorReason: null });
    try {
      const referenceList = await buildShotImageReferences(ctx, shotContent);
      const imageCls = u.Ai.Image(ctx.imageModel as `${string}:${string}`, ctx.userId);
      await withTimeout(
        imageCls.run(
          {
            prompt: buildShotImagePrompt(ctx.snapshot, shotContent),
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
    const videoAi = u.Ai.Video(ctx.videoModel as `${string}:${string}`, ctx.userId);
    await withTimeout(
      videoAi.run(
        {
          prompt: buildShotVideoPrompt(shotContent),
          referenceList: [{ type: "image", base64: imageBase64 }],
          mode: ["singleImage"],
          duration: shotContent.duration,
          aspectRatio: castAspectRatio(ctx.snapshot.videoRatio),
          resolution: "720p",
        },
        {
          taskClass: "快创镜头视频",
          describe: `镜头${shotContent.index} 视频片段生成（${shotContent.duration} 秒）`,
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
    qvLog("shot_done", { projectId, shotId, duration: shotContent.duration });
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
  const modes = Array.isArray(hit?.mode) ? (hit!.mode as string[]) : null;
  if (modes && !modes.includes("singleImage")) {
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

/** 镜头分镜图提示词：画风 + 画面描述 + 运镜 + 引用资产描述 */
function buildShotImagePrompt(snapshot: QuickVideoGenerationSnapshot, shot: QuickVideoSnapshotShot): string {
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
  return parts.filter(Boolean).join("；");
}

/** 镜头视频提示词：以分镜图为首帧，按画面描述与时长运动 */
function buildShotVideoPrompt(shot: QuickVideoSnapshotShot): string {
  return [
    `以参考图为首帧，生成 ${shot.duration} 秒的连续镜头`,
    shot.description,
    shot.camera ? `运镜：${shot.camera}` : "",
    shot.dialogue ? `画面人物口型对齐台词：${shot.dialogue}` : "",
    "动作自然连贯，保持人物与环境一致",
  ]
    .filter(Boolean)
    .join("；");
}

/** 镜头参考图：命中的资产图 + 已生成的素材图（按镜头 assetRefs 过滤） */
async function buildShotImageReferences(
  ctx: GenerationContext,
  shot: QuickVideoSnapshotShot,
): Promise<{ type: "image"; base64: string }[]> {
  const state = await loadQuickVideoState(ctx.projectId);
  const materialImages = state?.generation?.materialImages ?? {};
  const refs: { type: "image"; base64: string }[] = [];

  for (const ref of shot.assetRefs ?? []) {
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
