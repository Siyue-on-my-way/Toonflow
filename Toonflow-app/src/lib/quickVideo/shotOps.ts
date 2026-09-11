/**
 * QuickVideo / 单视频快创 —— 聊天按镜头操作（SIY-140）
 *
 * 用户在聊天里通过 `##编号#` 语法或分镜选择器引用镜头后，由 Agent 工具触发的
 * 三类轻量生成动作：generate_shot_video / generate_shot_image / generate_asset。
 *
 * 设计要点（对应任务约束）：
 * - 分镜表（o_agentWorkData 的 storyboard.shots）与 o_image / o_video 是镜头媒体结果的
 *   唯一存储位置；聊天消息只携带操作上下文（shotRefs / action / opId / 结果摘要）。
 * - 生成产物文件路径同时回写 shot.imageRef / shot.videoRef（分镜表主存储），
 *   并经 o_quickVideoMedia（既有索引表，source="chat"）建立聊天卡片与白板可见性，
 *   不新建任何媒体存储体系。
 * - storyboardId（shot.id）是执行与回写的唯一镜头标识；displayNo 仅用于聊天显示，
 *   启动前按当前分镜重新核对（防止过期编号错位引用）。
 * - 视频生成（高成本）在任务创建前于聊天流提供轻量确认卡片，确认后才真正提交任务；
 *   图片与素材生成低成本，直接入队（素材生成不引入旧版成本确认环节）。
 * - 复用既有 AI 供应商链路、MinIO 存储与 mutateQuickVideoState 事务化状态写入。
 */
import u from "@/utils";
import { GENERATION_CONCURRENCY, QuickVideoRatio, QuickVideoShot } from "./contract";
import { QuickVideoError, loadQuickVideoState, mutateQuickVideoState } from "./state";
import {
  ChatShotOpAction,
  ChatShotRef,
  buildAssetImagePrompt,
  buildChatShotImagePrompt,
  buildChatShotVideoPrompt,
  parseAssetType,
} from "./shotRef";
import { assertVideoSupportsSingleImage, castAspectRatio, findFirstAvailableModel, isShotPipelineActive, matchProjectAsset } from "./generate";
import { createChatMedia, markChatMediaDone, markChatMediaFailed, resolveMediaImageBase64 } from "./media";
import { recordEvent, qvLog } from "./metrics";

// ---------------------------------------------------------------------------
// 事件广播（Socket.IO 双向更新聊天卡片与分镜行）
// ---------------------------------------------------------------------------

export interface ShotOpShotUpdate {
  shotId: string;
  displayNo: number;
  imageState?: QuickVideoShot["imageState"];
  videoState?: QuickVideoShot["videoState"];
  errorReason?: string | null;
  /** 生成完成时按需签发的短期预览地址（不持久化） */
  imageUrl?: string | null;
  videoUrl?: string | null;
  /** generate_asset 产出的资产 id */
  assetId?: number | null;
  mediaId?: number | null;
}

export interface ShotOpUpdateEvent {
  opId: string;
  projectId: number;
  action: ChatShotOpAction;
  state: "running" | "done" | "failed";
  /** 整体失败原因（如模型未配置、全部镜头失败） */
  errorReason?: string;
  shots: ShotOpShotUpdate[];
}

type ShotOpListener = (evt: ShotOpUpdateEvent) => void;

const listeners = new Map<number, Set<ShotOpListener>>();

/** Socket 路由在连接建立时注册本项目的监听（连接断开时用返回的函数注销） */
export function registerShotOpListener(projectId: number, listener: ShotOpListener): () => void {
  let set = listeners.get(projectId);
  if (!set) {
    set = new Set();
    listeners.set(projectId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(projectId);
    if (!current) return;
    current.delete(listener);
    if (!current.size) listeners.delete(projectId);
  };
}

function emitShotOpUpdate(projectId: number, evt: ShotOpUpdateEvent) {
  const set = listeners.get(projectId);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(evt);
    } catch {
      // 单个订阅者（socket）异常不影响其他订阅者与主流程
    }
  }
}

// ---------------------------------------------------------------------------
// 运行登记
// ---------------------------------------------------------------------------

interface RunningShotOp {
  opId: string;
  projectId: number;
  sessionId: number | null;
  userId: number;
  action: ChatShotOpAction;
  shotIds: string[];
  instruction: string;
  startedAt: number;
}

/** 进程内按镜头操作登记：`${projectId}:${opId}` -> op（与 generate.ts 的运行登记互斥补充） */
const runningShotOps = new Map<string, RunningShotOp>();

/** 某镜头是否已被某个聊天按镜头操作占用 */
function isShotOpBusy(projectId: number, shotId: string): boolean {
  for (const op of runningShotOps.values()) {
    if (op.projectId === projectId && op.shotIds.includes(shotId)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 模型解析（优先会话偏好 -> 项目偏好 -> 第一个可用模型；只解析动作需要的类型）
// ---------------------------------------------------------------------------

/** 解析按镜头操作使用的模型（优先会话偏好 -> 项目偏好 -> 第一个可用模型）；工具预检与启动共用 */
export async function resolveOpModel(projectId: number, sessionId: number | null, kind: "image" | "video"): Promise<string> {
  const project = await u.db("o_project").where("id", projectId).first();
  const session = sessionId ? await u.db("o_quickVideoSession").where({ id: sessionId, projectId }).first() : null;
  const saved = kind === "image" ? session?.imageModel || project?.imageModel : session?.videoModel || project?.videoModel;
  if (saved) return String(saved);
  const fallback = await findFirstAvailableModel(kind);
  if (!fallback) {
    throw new QuickVideoError("MODEL_NOT_CONFIGURED", `未找到可用的${kind === "image" ? "图片" : "视频"}生成模型，请先在聊天模型选择器或设置页配置`);
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// 轻量确认（视频动作：任务创建前在聊天流确认，确认后才真正提交任务）
// ---------------------------------------------------------------------------

export interface PendingShotOp {
  token: string;
  projectId: number;
  sessionId: number | null;
  action: ChatShotOpAction;
  shotRefs: ChatShotRef[];
  instruction: string;
  referenceMediaIds: number[];
  createdAt: number;
}

/** 待确认视频操作：内存级 TTL 缓存；服务重启丢失后用户重新发起即可（卡片失效有友好提示） */
const pendingConfirmations = new Map<string, PendingShotOp>();
const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_MAX = 50;

function createPendingConfirmation(input: Omit<PendingShotOp, "token" | "createdAt">): PendingShotOp {
  // 顺带清理过期与超量的旧确认，防止长期运行内存膨胀
  const now = Date.now();
  for (const [key, pending] of pendingConfirmations) {
    if (now - pending.createdAt > PENDING_TTL_MS) pendingConfirmations.delete(key);
  }
  while (pendingConfirmations.size >= PENDING_MAX) {
    const oldest = [...pendingConfirmations.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) break;
    pendingConfirmations.delete(oldest.token);
  }
  const pending: PendingShotOp = { ...input, token: `${u.uuid().slice(0, 8)}${Date.now().toString(36)}`, createdAt: now };
  pendingConfirmations.set(pending.token, pending);
  return pending;
}

/** 取出待确认操作（确认/取消都是一次性消费）；不存在或已过期返回 null */
export function consumePendingConfirmation(token: string): PendingShotOp | null {
  const pending = pendingConfirmations.get(token);
  if (!pending) return null;
  pendingConfirmations.delete(token);
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) return null;
  return pending;
}

/** 供 Agent 工具创建视频确认卡片（返回卡片需要的计划信息与确认令牌） */
export async function createShotVideoConfirmation(input: {
  projectId: number;
  sessionId: number | null;
  shotRefs: ChatShotRef[];
  instruction: string;
  referenceMediaIds?: number[];
}): Promise<PendingShotOp> {
  return createPendingConfirmation({
    projectId: input.projectId,
    sessionId: input.sessionId,
    action: "generate_shot_video",
    shotRefs: input.shotRefs,
    instruction: input.instruction.slice(0, 1000),
    referenceMediaIds: (input.referenceMediaIds ?? []).slice(0, 4),
  });
}

// ---------------------------------------------------------------------------
// 启动入口
// ---------------------------------------------------------------------------

export interface StartChatShotOpInput {
  projectId: number;
  sessionId: number | null;
  userId: number;
  action: Exclude<ChatShotOpAction, "generate_asset">;
  /** 已经过 resolveShotRefsFromState 归一化、并在启动时再次核对的引用 */
  shotRefs: ChatShotRef[];
  /** 用户本次补充指令（已剥离引用标记；可为空） */
  instruction?: string;
  /** 用户在聊天选中的引用媒体（图生图参考），mediaId 列表 */
  referenceMediaIds?: number[];
  /** 触发本轮操作的消息 id（任务绑定到消息上下文） */
  messageId?: string | null;
}

export interface ShotOpTask {
  shotId: string;
  displayNo: number;
  mediaId: number;
  assetId: number | null;
}

export interface ShotOpStartResult {
  opId: string;
  action: ChatShotOpAction;
  tasks: ShotOpTask[];
}

/**
 * 启动一次按镜头生成（图片 / 视频）。服务端校验：阶段放行、镜头归属与存在性、
 * 与整项目生成/其它按镜头操作互斥、模型可用 → 建占位媒体行 → 置镜头生成中 → 分离运行。
 * 每次启动都是显式的新动作（幂等键按 opId 维度），重复「重试/重新生成」产生新 opId，
 * 与 retryQuickVideoShots 同一约定。
 */
export async function startChatShotOp(input: StartChatShotOpInput): Promise<ShotOpStartResult> {
  const { projectId, sessionId, userId, action } = input;
  const state = await loadQuickVideoState(projectId);
  if (!state) throw new QuickVideoError("STATE_NOT_FOUND", "未找到 quickVideoAgent 状态，请先创建 quick_video 项目");
  if (!state.storyboard?.shots?.length) {
    throw new QuickVideoError("NO_STORYBOARD", "当前项目暂无分镜，无法按镜头生成；请先确认简报并生成分镜", state.version);
  }
  if (!input.shotRefs.length) {
    throw new QuickVideoError("SHOT_REFS_REQUIRED", "未指定目标镜头，请先通过 ##编号# 或分镜选择器引用镜头", state.version);
  }

  // 归属与存在性核对：displayNo 按 index 定位、storyboardId 必须与当前分镜一致（防错位引用的最后一道闸）
  const shotRefs: ChatShotRef[] = [];
  for (const ref of input.shotRefs) {
    const shot = state.storyboard.shots.find((s) => s.id === ref.shotId);
    if (!shot || shot.index !== ref.displayNo) {
      throw new QuickVideoError("SHOT_NOT_FOUND", `镜头 ##${ref.displayNo}# 不存在或引用已过期，请刷新分镜后重试`, state.version);
    }
    shotRefs.push({ displayNo: ref.displayNo, shotId: shot.id });
  }

  // 互斥：整项目生成进行中不允许按镜头操作；同一镜头不允许并发操作
  for (const ref of shotRefs) {
    if (isShotOpBusy(projectId, ref.shotId) || isShotPipelineActive(projectId, ref.shotId)) {
      throw new QuickVideoError("SHOT_RUNNING", `镜头 ##${ref.displayNo}# 正在生成中，请等待完成后再操作`, state.version);
    }
  }

  // 模型解析在启动时进行（Agent 工具只负责触发；REST 重试路径同样走这里）
  const imageModel = await resolveOpModel(projectId, sessionId, "image");
  const videoModel = action === "generate_shot_video" ? await resolveOpModel(projectId, sessionId, "video") : "";

  const opId = `op-${u.uuid().slice(0, 8)}`;
  const instruction = (input.instruction ?? "").slice(0, 1000);

  // 建占位媒体行（生成中 -> 完成/失败回写），把任务绑定到当前消息上下文
  const tasks: ShotOpTask[] = [];
  for (const ref of shotRefs) {
    const shot = state.storyboard.shots.find((s) => s.id === ref.shotId)!;
    const kind = action === "generate_shot_video" ? "video" : "image";
    const { media } = await createChatMedia({
      projectId,
      sessionId,
      messageId: input.messageId ?? null,
      kind,
      model: kind === "video" ? videoModel : imageModel,
      prompt: buildOpPromptPreview(action, shot, instruction),
      source: "chat",
      idempotencyKey: `shotop:${opId}:${shot.id}`,
    });
    tasks.push({ shotId: shot.id, displayNo: ref.displayNo, mediaId: media.id, assetId: media.assetId });
  }

  const op: RunningShotOp = {
    opId,
    projectId,
    sessionId,
    userId,
    action,
    shotIds: shotRefs.map((r) => r.shotId),
    instruction,
    startedAt: Date.now(),
  };
  runningShotOps.set(`${projectId}:${opId}`, op);

  try {
    // 目标镜头状态置为生成中（卡片与分镜行立即联动）；失败在管线内回写
    await mutateQuickVideoState(projectId, { sessionId: sessionId ?? undefined }, (s) => {
      for (const ref of shotRefs) {
        const live = s.storyboard?.shots.find((x) => x.id === ref.shotId);
        if (!live) continue;
        if (action === "generate_shot_image") live.imageState = "generating";
        else live.videoState = "generating";
        live.errorReason = null;
      }
    });
  } catch (err) {
    runningShotOps.delete(`${projectId}:${opId}`);
    throw err;
  }

  // 分离运行：工具/接口立刻返回，进度经 socket 广播与工作台轮询观察
  runChatShotOp(op, imageModel, videoModel, input, tasks)
    .catch((err) => console.error(`[quickVideo] 按镜头操作 ${opId} 异常终止:`, u.error(err as Error).message))
    .finally(() => {
      runningShotOps.delete(`${projectId}:${opId}`);
    });

  recordEvent(action === "generate_shot_image" ? "shotOpImage" : "shotOpVideo");
  qvLog("shot_op_start", { projectId, opId, action, shots: op.shotIds, sessionId });

  return { opId, action, tasks };
}

/** 占位媒体行的提示词摘要（卡片与白板展示用；与真实生成提示词同一来源的简化版） */
function buildOpPromptPreview(action: ChatShotOpAction, shot: QuickVideoShot, instruction: string): string {
  const base = action === "generate_shot_video" ? `镜头${shot.index} 视频：${shot.description}` : `镜头${shot.index} 分镜图：${shot.description}`;
  return instruction ? `${base}（补充：${instruction.slice(0, 100)}）` : base;
}

/**
 * 启动一次独立的素材资产生成（generate_asset）：不走镜头状态，产物直接入 o_assets
 * （type = role/scene/tool，参与后续素材匹配与镜头绑定），同时建立聊天/白板可见性。
 */
export async function startChatAssetOp(
  input: {
    projectId: number;
    sessionId: number | null;
    userId: number;
    asset: { assetType: "role" | "scene" | "tool"; name: string; description: string };
    instruction?: string;
    messageId?: string | null;
  },
): Promise<ShotOpStartResult> {
  const { projectId, sessionId } = input;
  const state = await loadQuickVideoState(projectId);
  if (!state) throw new QuickVideoError("STATE_NOT_FOUND", "未找到 quickVideoAgent 状态，请先创建 quick_video 项目");

  const assetType = parseAssetType(input.asset.assetType);
  const imageModel = await resolveOpModel(projectId, sessionId, "image");

  const opId = `op-${u.uuid().slice(0, 8)}`;
  const prompt = buildAssetImagePrompt({
    artStyle: state.artStyle,
    assetType,
    name: input.asset.name,
    description: input.asset.description,
    instruction: input.instruction || undefined,
  });

  const { media } = await createChatMedia({
    projectId,
    sessionId,
    messageId: input.messageId ?? null,
    kind: "image",
    model: imageModel,
    prompt,
    source: "chat",
    idempotencyKey: `shotop:${opId}:asset`,
    assetType,
    assetName: input.asset.name,
  });

  const op: RunningShotOp = {
    opId,
    projectId,
    sessionId,
    userId: input.userId,
    action: "generate_asset",
    shotIds: [],
    instruction: input.instruction ?? "",
    startedAt: Date.now(),
  };
  runningShotOps.set(`${projectId}:${opId}`, op);

  runAssetPipeline(op, imageModel, media.id, { assetType, name: input.asset.name, description: input.asset.description }, input.instruction ?? "")
    .catch((err) => console.error(`[quickVideo] 素材生成操作 ${opId} 异常终止:`, u.error(err as Error).message))
    .finally(() => {
      runningShotOps.delete(`${projectId}:${opId}`);
    });

  recordEvent("shotOpAsset");
  qvLog("shot_op_start", { projectId, opId, action: "generate_asset", asset: input.asset.name, sessionId });
  return { opId, action: "generate_asset", tasks: [{ shotId: "", displayNo: 0, mediaId: media.id, assetId: media.assetId }] };
}

// ---------------------------------------------------------------------------
// 管线
// ---------------------------------------------------------------------------

async function runChatShotOp(op: RunningShotOp, imageModel: string, videoModel: string, input: StartChatShotOpInput, tasks: ShotOpTask[]) {
  const { projectId } = op;
  const failures: string[] = [];
  const shotUpdates = new Map<string, ShotOpShotUpdate>();
  for (const task of tasks) {
    shotUpdates.set(task.shotId, { shotId: task.shotId, displayNo: task.displayNo, mediaId: task.mediaId });
  }

  emitShotOpUpdate(projectId, { opId: op.opId, projectId, action: op.action, state: "running", shots: [...shotUpdates.values()] });

  const runOne = async (task: ShotOpTask) => {
    try {
      if (op.action === "generate_shot_image") {
        const update = await runShotImagePart(op, imageModel, task, input);
        shotUpdates.set(task.shotId, { ...shotUpdates.get(task.shotId), ...update });
      } else {
        const update = await runShotVideoPart(op, imageModel, videoModel, task, input);
        shotUpdates.set(task.shotId, { ...shotUpdates.get(task.shotId), ...update });
      }
    } catch (err) {
      const reason = u.error(err as Error).message;
      failures.push(`镜头${task.displayNo}：${reason}`);
      await markChatMediaFailed(task.mediaId, reason);
      await markShotOpFailedInState(projectId, op.action, task.shotId, reason);
      shotUpdates.set(task.shotId, { ...shotUpdates.get(task.shotId)!, errorReason: reason });
      qvLog("shot_op_failed", { projectId, opId: op.opId, shotId: task.shotId, reason });
    }
    emitShotOpUpdate(projectId, { opId: op.opId, projectId, action: op.action, state: "running", shots: [shotUpdates.get(task.shotId)!] });
  };

  // 与整项目生成一致的并发节奏（供应商任务并发上限）
  for (let i = 0; i < tasks.length; i += GENERATION_CONCURRENCY) {
    await Promise.all(tasks.slice(i, i + GENERATION_CONCURRENCY).map(runOne));
  }

  const finalState: ShotOpUpdateEvent["state"] = failures.length && failures.length === tasks.length ? "failed" : "done";
  emitShotOpUpdate(projectId, {
    opId: op.opId,
    projectId,
    action: op.action,
    state: finalState,
    ...(failures.length ? { errorReason: failures.join("；") } : {}),
    shots: [...shotUpdates.values()],
  });
  qvLog("shot_op_done", { projectId, opId: op.opId, failed: failures.length, total: tasks.length });
}

/** 按镜头生图段：资产参考图 + 聊天引用图 → 生图 → 回写 imageRef（分镜表主存储） */
async function runShotImagePart(op: RunningShotOp, imageModel: string, task: ShotOpTask, input: StartChatShotOpInput): Promise<ShotOpShotUpdate> {
  const { projectId } = op;
  const state = await loadQuickVideoState(projectId);
  const shot = state?.storyboard?.shots.find((s) => s.id === task.shotId);
  if (!state || !shot) throw new QuickVideoError("SHOT_NOT_FOUND", "镜头已不存在（分镜可能被修改），本次操作终止", undefined);

  const referenceList: { type: "image"; base64: string }[] = [];
  // 已绑定资产（含 generate_asset 生成的 role/scene/tool 资产）作为一致性参考
  for (const ref of shot.assetRefs ?? []) {
    if (referenceList.length >= 4) break;
    const matched = await matchProjectAsset(projectId, ref);
    if (!matched) continue;
    try {
      referenceList.push({ type: "image", base64: await u.oss.getImageBase64(matched.filePath) });
    } catch {
      // 单个参考图失效不阻断
    }
  }
  // 用户聊天引用的媒体（assetRefs 上下文）
  for (const mediaId of (input.referenceMediaIds ?? []).slice(0, 4)) {
    if (referenceList.length >= 4) break;
    try {
      referenceList.push({ type: "image", base64: await resolveMediaImageBase64(projectId, mediaId) });
    } catch {
      // 引用失效退化为纯文本提示词
    }
  }

  const prompt = buildChatShotImagePrompt({
    artStyle: state.artStyle,
    videoRatio: state.videoRatio,
    shot,
    instruction: op.instruction || undefined,
  });

  const imageCls = u.Ai.Image(imageModel as `${string}:${string}`, op.userId);
  await imageCls.run(
    { prompt, referenceList, size: "1K", aspectRatio: castAspectRatio(state.videoRatio as QuickVideoRatio) },
    {
      taskClass: "快创按镜头生图",
      describe: `镜头${shot.index} 聊天生图${op.instruction ? "（含补充指令）" : ""}`,
      relatedObjects: JSON.stringify({ projectId, shotId: shot.id, opId: op.opId, sessionId: op.sessionId }),
      projectId,
    },
  );
  const savePath = `/${projectId}/quickVideo/${shot.id}-${u.uuid().slice(0, 8)}.jpg`;
  await imageCls.save(savePath);
  await markChatMediaDone(task.mediaId, savePath);

  await mutateQuickVideoState(projectId, { sessionId: op.sessionId ?? undefined }, (s) => {
    const live = s.storyboard?.shots.find((x) => x.id === shot.id);
    if (!live) return;
    live.imageState = "done";
    live.imageRef = savePath;
    live.errorReason = null;
  });

  let imageUrl: string | null = null;
  try {
    imageUrl = await u.oss.getFileUrl(savePath);
  } catch {
    // 预览地址签发失败不影响结果
  }
  recordEvent("shotOpImageDone");
  return { shotId: shot.id, displayNo: task.displayNo, imageState: "done", errorReason: null, imageUrl, mediaId: task.mediaId };
}

/** 按镜头生视频段：首帧（绑定 > 分镜图 > 现场补图）→ 图生视频 → 回写 videoRef（分镜表主存储） */
async function runShotVideoPart(op: RunningShotOp, imageModel: string, videoModel: string, task: ShotOpTask, input: StartChatShotOpInput): Promise<ShotOpShotUpdate> {
  const { projectId } = op;
  const state = await loadQuickVideoState(projectId);
  const shot = state?.storyboard?.shots.find((s) => s.id === task.shotId);
  if (!state || !shot) throw new QuickVideoError("SHOT_NOT_FOUND", "镜头已不存在（分镜可能被修改），本次操作终止", undefined);

  await assertVideoSupportsSingleImage(videoModel, !!shot.firstFrame);

  // 首帧解析：用户绑定首帧 → 已生成分镜图 → 现场补生成一张分镜图（结果同样落 shot.imageRef）
  let baseImagePath: string | null = null;
  if (shot.firstFrame) {
    const image = await u.db("o_image").where("id", shot.firstFrame.imageId).select("filePath").first();
    baseImagePath = image?.filePath ?? null;
    if (!baseImagePath) console.warn(`[quickVideo] 镜头 ${shot.id} 绑定首帧已失效，回退分镜图/现场补图`);
  }
  if (!baseImagePath && shot.imageRef && shot.imageState === "done") baseImagePath = shot.imageRef;
  if (!baseImagePath) {
    console.log(`[quickVideo] 镜头 ${shot.id} 无可用首帧，先补生成分镜图`);
    // 现场补图走独立的占位媒体行（kind=image）：绝不能复用视频占位行，
    // 否则 markChatMediaDone 会把 .jpg 路径写进 o_video。
    const { media: imageMedia } = await createChatMedia({
      projectId,
      sessionId: op.sessionId,
      messageId: input.messageId ?? null,
      kind: "image",
      model: imageModel,
      prompt: buildOpPromptPreview("generate_shot_image", shot, op.instruction),
      source: "chat",
      idempotencyKey: `shotop:${op.opId}:${shot.id}:img`,
    });
    await mutateQuickVideoState(projectId, { sessionId: op.sessionId ?? undefined }, (s) => {
      const live = s.storyboard?.shots.find((x) => x.id === shot.id);
      if (live && live.imageState === "pending") live.imageState = "generating";
    });
    const imageUpdate = await runShotImagePart(
      { ...op, action: "generate_shot_image" },
      imageModel,
      { ...task, mediaId: imageMedia.id, assetId: imageMedia.assetId },
      input,
    );
    baseImagePath = (await loadQuickVideoState(projectId))?.storyboard?.shots.find((s) => s.id === shot.id)?.imageRef ?? null;
    if (!baseImagePath) {
      throw new QuickVideoError("SHOT_IMAGE_FAILED", imageUpdate.errorReason || "首帧补生成分镜图失败，请先为该镜头生成图片", undefined);
    }
  }

  const imageBase64 = await u.oss.getImageBase64(baseImagePath);
  const prompt = buildChatShotVideoPrompt(shot, op.instruction || undefined);
  const videoAi = u.Ai.Video(videoModel as `${string}:${string}`, op.userId);
  await videoAi.run(
    {
      prompt,
      referenceList: [{ type: "image", base64: imageBase64 }],
      mode: ["singleImage"],
      duration: shot.duration,
      aspectRatio: castAspectRatio(state.videoRatio as QuickVideoRatio),
      resolution: "720p",
    },
    {
      taskClass: "快创按镜头生视频",
      describe: `镜头${shot.index} 聊天生成 ${shot.duration} 秒视频片段`,
      relatedObjects: JSON.stringify({ projectId, shotId: shot.id, opId: op.opId, sessionId: op.sessionId }),
      projectId,
    },
  );
  const savePath = `/${projectId}/quickVideo/${shot.id}-${u.uuid().slice(0, 8)}.mp4`;
  await videoAi.save(savePath);
  await markChatMediaDone(task.mediaId, savePath);

  await mutateQuickVideoState(projectId, { sessionId: op.sessionId ?? undefined }, (s) => {
    const live = s.storyboard?.shots.find((x) => x.id === shot.id);
    if (!live) return;
    live.videoState = "done";
    live.videoRef = savePath;
    live.errorReason = null;
  });

  let videoUrl: string | null = null;
  try {
    videoUrl = await u.oss.getFileUrl(savePath);
  } catch {
    // 预览地址签发失败不影响结果
  }
  recordEvent("shotOpVideoDone");
  return { shotId: shot.id, displayNo: task.displayNo, videoState: "done", errorReason: null, videoUrl, mediaId: task.mediaId };
}

/** 素材资产生成段（无镜头状态写入；产物即资产，入 o_assets 参与素材匹配与首帧绑定） */
async function runAssetPipeline(
  op: RunningShotOp,
  imageModel: string,
  mediaId: number,
  asset: { assetType: "role" | "scene" | "tool"; name: string; description: string },
  instruction: string,
) {
  const { projectId } = op;
  const emit = (state: ShotOpUpdateEvent["state"], update: ShotOpShotUpdate, errorReason?: string) =>
    emitShotOpUpdate(projectId, { opId: op.opId, projectId, action: "generate_asset", state, ...(errorReason ? { errorReason } : {}), shots: [update] });

  emit("running", { shotId: "", displayNo: 0, mediaId });
  try {
    const state = await loadQuickVideoState(projectId);
    const prompt = buildAssetImagePrompt({
      artStyle: state?.artStyle ?? "",
      assetType: asset.assetType,
      name: asset.name,
      description: asset.description,
      instruction: instruction || undefined,
    });
    const imageCls = u.Ai.Image(imageModel as `${string}:${string}`, op.userId);
    await imageCls.run(
      { prompt, referenceList: [], size: "1K", aspectRatio: state ? castAspectRatio(state.videoRatio as QuickVideoRatio) : "16:9" },
      {
        taskClass: "快创素材生成",
        describe: `素材「${asset.name}」生成`,
        relatedObjects: JSON.stringify({ projectId, opId: op.opId, sessionId: op.sessionId, assetName: asset.name }),
        projectId,
      },
    );
    const savePath = `/${projectId}/quickVideo/asset-${u.uuid().slice(0, 8)}.jpg`;
    await imageCls.save(savePath);
    await markChatMediaDone(mediaId, savePath);
    const mediaRow = await u.db("o_quickVideoMedia").where("id", mediaId).first();
    let imageUrl: string | null = null;
    try {
      imageUrl = await u.oss.getFileUrl(savePath);
    } catch {
      // 预览地址签发失败不影响结果
    }
    emit("done", { shotId: "", displayNo: 0, mediaId, assetId: mediaRow?.assetId ?? null, imageUrl, imageState: "done" });
    qvLog("shot_op_done", { projectId, opId: op.opId, asset: asset.name });
  } catch (err) {
    const reason = u.error(err as Error).message;
    await markChatMediaFailed(mediaId, reason);
    emit("failed", { shotId: "", displayNo: 0, mediaId, errorReason: reason }, reason);
    qvLog("shot_op_failed", { projectId, opId: op.opId, asset: asset.name, reason });
  }
}

/** 管线内单镜头失败回写（与 generate.ts 的失败收敛语义一致：视频依赖图，图失败视频一并收敛） */
async function markShotOpFailedInState(projectId: number, action: ChatShotOpAction, shotId: string, reason: string) {
  try {
    await mutateQuickVideoState(projectId, {}, (s) => {
      const live = s.storyboard?.shots.find((x) => x.id === shotId);
      if (!live) return;
      if (action === "generate_shot_image") {
        live.imageState = "failed";
        // 视频管线依赖分镜图：图失败时把视频也收敛为 failed，避免镜头卡在 image=failed/video=pending
        if (live.videoState === "pending" || live.videoState === "generating") live.videoState = "failed";
      } else {
        // 生视频操作中补生成的分镜图若停在 generating，一并收敛，保证镜头状态可对账
        if (live.imageState === "generating") live.imageState = "failed";
        live.videoState = "failed";
      }
      live.errorReason = reason;
    });
  } catch (err) {
    console.error(`[quickVideo] 回写镜头 ${shotId} 失败状态出错:`, u.error(err as Error).message);
  }
}
