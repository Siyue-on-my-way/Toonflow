/**
 * QuickVideo / 单视频快创 —— 聊天生图媒体索引（SIY-132）
 *
 * 落库策略（对应任务约束 2）：
 * - 复用 o_image / o_video 保存生成产物的文件引用与生成状态（沿用专业模式已有的中文状态值
 *   "生成中" / "已完成" / "生成失败"，与 fixDB 的崩溃恢复清理、既有资产轮询逻辑保持一致）。
 * - 复用 o_assets 建立项目内可复用资产记录（type 固定为 CHAT_MEDIA_ASSET_TYPE，
 *   与专业模式的 role/scene/tool 资产分开，不会被 generate.ts 的素材匹配逻辑误命中）。
 * - o_assets / o_image / o_video 均无法完整记录 sessionId、聊天消息 id、来源与幂等键，
 *   故新增 o_quickVideoMedia 关联表：只保存关系与元数据，不保存媒体二进制，见 initDB.ts。
 * - 预览/播放地址一律按需通过 u.oss 签发，不持久化 URL。
 */
import { db as knexDb } from "@/utils/db";
import u from "@/utils";
import {
  MediaRef,
  QuickVideoMediaKind,
  QuickVideoMediaSource,
  QuickVideoMediaState,
} from "./contract";
import { QuickVideoError } from "./state";
import { pickEnabledModel, type VendorModelEntry } from "./modelValidation";

/** o_assets.type 取值：聊天/白板生成的媒体资产，与专业模式 role/scene/tool 资产分开，不参与素材匹配 */
export const CHAT_MEDIA_ASSET_TYPE = "chat_media";

const LEGACY_STATE_GENERATING = "生成中";
const LEGACY_STATE_DONE = "已完成";
const LEGACY_STATE_FAILED = "生成失败";

export interface QuickVideoMediaRow {
  id: number;
  projectId: number;
  sessionId: number | null;
  messageId: string | null;
  kind: QuickVideoMediaKind;
  assetId: number | null;
  imageId: number | null;
  videoId: number | null;
  model: string | null;
  prompt: string | null;
  source: QuickVideoMediaSource;
  state: QuickVideoMediaState;
  errorReason: string | null;
  idempotencyKey: string;
  deletedAt: number | null;
  createTime: number;
  updateTime: number;
}

// ---------------------------------------------------------------------------
// 模型校验（不盲信浏览器传入的字符串；见任务约束「Chat Socket 与 QuickVideoAgent」）
// ---------------------------------------------------------------------------

/** 拆分 "vendorId:modelName" 形式的模型 key；格式不对时返回 null，不抛错（调用方决定如何处理） */
function splitModelKey(modelKey: string): { vendorId: string; modelName: string } | null {
  const sep = modelKey.indexOf(":");
  if (sep <= 0 || sep === modelKey.length - 1) return null;
  return { vendorId: modelKey.slice(0, sep), modelName: modelKey.slice(sep + 1) };
}

/**
 * 读取并解析某个渠道的模型目录 + 全局启用列表（o_vendorConfig.models / enabledModels）。
 * 渠道不存在时返回 null；JSON 解析失败时静默退化为空数组，不抛错——校验逻辑本身已经能
 * 处理"目录为空"的情况（pickEnabledModel 会返回 null）。同一份解析逻辑供图片模型校验
 * （本文件）和视频模型能力检查（generate.ts）共用，避免两处目录解析规则慢慢跑偏。
 */
export async function getVendorModelCatalog(vendorId: string): Promise<{ enabled: boolean; models: VendorModelEntry[]; enabledNames: string[] } | null> {
  const row = await u.db("o_vendorConfig").where("id", vendorId).first();
  if (!row) return null;

  let models: VendorModelEntry[] = [];
  try {
    const parsed = JSON.parse(row.models || "[]");
    if (Array.isArray(parsed)) models = parsed;
  } catch {
    models = [];
  }
  let enabledNames: string[] = [];
  try {
    const parsed = JSON.parse(row.enabledModels || "[]");
    if (Array.isArray(parsed)) enabledNames = parsed;
  } catch {
    enabledNames = [];
  }
  return { enabled: !!row.enable, models, enabledNames };
}

/**
 * 校验形如 "vendorId:modelName" 的模型 key 是否确实是供应商目录中已启用的 image 类型模型。
 * 无效时抛出 QuickVideoError("IMAGE_MODEL_INVALID", ...)，调用方据此拒绝生成请求。
 */
export async function validateImageModelKey(modelKey: string): Promise<{ vendorId: string; modelName: string }> {
  const split = splitModelKey(modelKey);
  if (!split) throw new QuickVideoError("IMAGE_MODEL_INVALID", "图片模型格式不正确，请重新在模型选择框中选择");
  const { vendorId, modelName } = split;

  const catalog = await getVendorModelCatalog(vendorId);
  if (!catalog?.enabled) throw new QuickVideoError("IMAGE_MODEL_INVALID", "所选图片模型所属渠道未启用，请重新选择或联系管理员启用");

  const hit = pickEnabledModel(catalog.models, catalog.enabledNames, modelName, "image");
  if (!hit) {
    throw new QuickVideoError("IMAGE_MODEL_INVALID", "所选图片模型不可用（未在渠道目录中或未启用），请重新选择");
  }
  return { vendorId, modelName };
}

/**
 * 校验形如 "vendorId:modelName" 的模型 key 是否确实是供应商目录中已启用的 video 类型模型（SIY-134）。
 * 无效时抛出 QuickVideoError("VIDEO_MODEL_INVALID", ...)，调用方据此拒绝生成请求。
 */
export async function validateVideoModelKey(modelKey: string): Promise<{ vendorId: string; modelName: string }> {
  const split = splitModelKey(modelKey);
  if (!split) throw new QuickVideoError("VIDEO_MODEL_INVALID", "视频模型格式不正确，请重新在模型选择框中选择");
  const { vendorId, modelName } = split;

  const catalog = await getVendorModelCatalog(vendorId);
  if (!catalog?.enabled) throw new QuickVideoError("VIDEO_MODEL_INVALID", "所选视频模型所属渠道未启用，请重新选择或联系管理员启用");

  const hit = pickEnabledModel(catalog.models, catalog.enabledNames, modelName, "video");
  if (!hit) {
    throw new QuickVideoError("VIDEO_MODEL_INVALID", "所选视频模型不可用（未在渠道目录中或未启用），请重新选择");
  }
  return { vendorId, modelName };
}

// ---------------------------------------------------------------------------
// 媒体落库（生成中占位 -> 完成/失败回写）
// ---------------------------------------------------------------------------

export interface CreateChatMediaInput {
  projectId: number;
  sessionId: number | null;
  messageId: string | null;
  kind: QuickVideoMediaKind;
  model: string;
  prompt: string;
  source: QuickVideoMediaSource;
  idempotencyKey: string;
  /** o_assets.type；generate_asset 生成角色/场景/道具资产时传对应类型（默认 chat_media，不参与素材匹配） */
  assetType?: string;
  /** o_assets.name；generate_asset 用资产名命名（默认截取提示词前 60 字） */
  assetName?: string;
}

/**
 * 创建一条"生成中"的媒体占位记录：同一事务内插入 o_image/o_video 占位行 + o_assets 资产行 +
 * o_quickVideoMedia 关联行。idempotencyKey 命中已有记录时直接返回该记录（不重复创建），
 * 用于防止工具重试/重复点击产生重复资产。
 */
export async function createChatMedia(
  input: CreateChatMediaInput,
): Promise<{ media: QuickVideoMediaRow; idempotentHit: boolean }> {
  // idempotencyKey 落在 varchar(191) 唯一索引列上：截断必须在查找和写入两处保持一致，
  // 否则超长 key（如某些供应商的 toolCallId）在重试时会查不到已插入的行，绕开幂等直接报错。
  const idempotencyKey = input.idempotencyKey.slice(0, 191);
  const assetType = input.assetType || CHAT_MEDIA_ASSET_TYPE;
  return knexDb.transaction(async (trx) => {
    const existing = await trx("o_quickVideoMedia")
      .where({ projectId: input.projectId, idempotencyKey })
      .first();
    if (existing) return { media: existing as QuickVideoMediaRow, idempotentHit: true };

    const now = Date.now();
    let imageId: number | null = null;
    let videoId: number | null = null;

    if (input.kind === "image") {
      const [id] = await trx("o_image").insert({ state: LEGACY_STATE_GENERATING, model: input.model, type: assetType });
      imageId = id;
    } else {
      const [id] = await trx("o_video").insert({ state: LEGACY_STATE_GENERATING, time: now, projectId: input.projectId });
      videoId = id;
    }

    const [assetId] = await trx("o_assets").insert({
      name: input.assetName?.slice(0, 60) || input.prompt.slice(0, 60) || "聊天生成媒体",
      prompt: input.prompt,
      type: assetType,
      describe: input.prompt,
      projectId: input.projectId,
      imageId: imageId ?? undefined,
      sourceType: input.source,
      promptState: LEGACY_STATE_DONE,
    });

    if (input.kind === "image") await trx("o_image").where("id", imageId!).update({ assetsId: assetId });

    const [mediaId] = await trx("o_quickVideoMedia").insert({
      projectId: input.projectId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      kind: input.kind,
      assetId,
      imageId,
      videoId,
      model: input.model,
      prompt: input.prompt,
      source: input.source,
      state: "generating" as QuickVideoMediaState,
      idempotencyKey,
      createTime: now,
      updateTime: now,
    });

    const media = await trx("o_quickVideoMedia").where("id", mediaId).first();
    return { media: media as QuickVideoMediaRow, idempotentHit: false };
  });
}

/** 生成成功：回写 o_image/o_video 的文件引用与状态，并同步 o_quickVideoMedia */
export async function markChatMediaDone(mediaId: number, filePath: string): Promise<void> {
  const media = await u.db("o_quickVideoMedia").where("id", mediaId).first();
  if (!media) return;
  await knexDb.transaction(async (trx) => {
    if (media.kind === "image" && media.imageId) {
      await trx("o_image").where("id", media.imageId).update({ state: LEGACY_STATE_DONE, filePath });
    } else if (media.kind === "video" && media.videoId) {
      await trx("o_video").where("id", media.videoId).update({ state: LEGACY_STATE_DONE, filePath });
    }
    await trx("o_quickVideoMedia").where("id", mediaId).update({ state: "done", errorReason: null, updateTime: Date.now() });
  });
}

/** 生成失败：回写失败原因，不影响其他媒体；重试走新的幂等键重新调用 createChatMedia */
export async function markChatMediaFailed(mediaId: number, reason: string): Promise<void> {
  const media = await u.db("o_quickVideoMedia").where("id", mediaId).first();
  if (!media) return;
  await knexDb.transaction(async (trx) => {
    if (media.kind === "image" && media.imageId) {
      await trx("o_image").where("id", media.imageId).update({ state: LEGACY_STATE_FAILED, errorReason: reason });
    } else if (media.kind === "video" && media.videoId) {
      await trx("o_video").where("id", media.videoId).update({ state: LEGACY_STATE_FAILED, errorReason: reason });
    }
    await trx("o_quickVideoMedia").where("id", mediaId).update({ state: "failed", errorReason: reason, updateTime: Date.now() });
  });
}

// ---------------------------------------------------------------------------
// 读取 / 白板查询
// ---------------------------------------------------------------------------

/**
 * o_image.id -> filePath（OSS key），查不到/无文件时返回 null。抽成独立函数是因为镜头首帧
 * 缩略图（getMediaUrls.ts）、白板/聊天卡片预览（本文件）都要做同一次查找，只是签地址时
 * 用的尺寸不同（小图 vs 原图）——避免两处各写一份 o_image 查询，容易在加权限/软删过滤时漏改一处。
 */
export async function getImageFilePath(imageId: number): Promise<string | null> {
  const image = await u.db("o_image").where("id", imageId).select("filePath").first();
  return image?.filePath ?? null;
}

/** 媒体行 -> 短期预览/播放地址；缺文件（生成中/失败）时为 null，不返回持久化 URL */
async function resolveMediaUrl(row: QuickVideoMediaRow): Promise<string | null> {
  try {
    if (row.kind === "image" && row.imageId) {
      const filePath = await getImageFilePath(row.imageId);
      return filePath ? await u.oss.getFileUrl(filePath) : null;
    }
    if (row.kind === "video" && row.videoId) {
      const video = await u.db("o_video").where("id", row.videoId).select("filePath").first();
      if (!video?.filePath) return null;
      return await u.oss.getFileUrl(video.filePath);
    }
  } catch {
    return null;
  }
  return null;
}

export async function toMediaRef(row: QuickVideoMediaRow): Promise<MediaRef> {
  const url = row.state === "done" ? await resolveMediaUrl(row) : null;
  return {
    mediaId: row.id,
    projectId: row.projectId,
    kind: row.kind,
    assetId: row.assetId,
    imageId: row.imageId,
    videoId: row.videoId,
    state: row.state,
    model: row.model,
    promptSummary: row.prompt ? row.prompt.slice(0, 200) : null,
    source: row.source,
    errorReason: row.errorReason,
    url,
    createTime: row.createTime,
  };
}

export interface GetAssetBoardOptions {
  kind?: "all" | QuickVideoMediaKind;
  state?: "all" | QuickVideoMediaState;
  sessionId?: number;
  page?: number;
  pageSize?: number;
}

/** 资产白板分页查询：项目范围隔离，排除软删除；聊天与白板共用同一份索引，见任务约束 */
export async function getAssetBoard(
  projectId: number,
  opts: GetAssetBoardOptions = {},
): Promise<{ items: MediaRef[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(60, Math.max(1, opts.pageSize ?? 24));

  const query = u.db("o_quickVideoMedia").where({ projectId }).whereNull("deletedAt");
  if (opts.kind && opts.kind !== "all") query.andWhere("kind", opts.kind);
  if (opts.state && opts.state !== "all") query.andWhere("state", opts.state);
  if (opts.sessionId != null) query.andWhere("sessionId", opts.sessionId);

  const countRow = await query.clone().count<{ c: number }[]>({ c: "*" }).first();
  const total = Number(countRow?.c ?? 0);

  const rows = (await query
    .clone()
    .orderBy("createTime", "desc")
    .offset((page - 1) * pageSize)
    .limit(pageSize)) as QuickVideoMediaRow[];

  const items = await Promise.all(rows.map(toMediaRef));
  return { items, total, page, pageSize };
}

// ---------------------------------------------------------------------------
// 首帧绑定校验
// ---------------------------------------------------------------------------

/**
 * 校验一个 mediaId 是否属于当前项目、类型为图片、已生成完成、未被软删除，
 * 返回稳定引用（assetId/imageId + filePath）。purpose 只影响错误提示文案。
 */
async function resolveReadyImageMedia(
  projectId: number,
  mediaId: number,
  purpose: "首帧" | "参考图",
): Promise<{ assetId: number; imageId: number; filePath: string }> {
  const row = (await u.db("o_quickVideoMedia").where({ id: mediaId, projectId }).first()) as QuickVideoMediaRow | undefined;
  if (!row || row.deletedAt) throw new QuickVideoError("MEDIA_NOT_FOUND", "未找到该媒体，或不属于当前项目");
  if (row.kind !== "image") throw new QuickVideoError("MEDIA_NOT_IMAGE", `只能使用图片作为${purpose}`);
  if (row.state !== "done" || !row.imageId || !row.assetId) {
    throw new QuickVideoError("MEDIA_NOT_READY", `该图片尚未生成完成或已失败，无法设为${purpose}`);
  }
  const filePath = await getImageFilePath(row.imageId);
  if (!filePath) throw new QuickVideoError("MEDIA_FILE_MISSING", `该图片文件已失效，无法设为${purpose}`);
  return { assetId: row.assetId, imageId: row.imageId, filePath };
}

/**
 * 校验一个 mediaId 是否可作为镜头首帧：必须属于当前项目、类型为图片、状态为已完成、
 * 未被软删除。返回绑定所需的稳定引用（assetId/imageId + 生成引擎需要的 filePath）。
 */
export function resolveMediaForFirstFrame(projectId: number, mediaId: number) {
  return resolveReadyImageMedia(projectId, mediaId, "首帧");
}

/** 校验一个 mediaId 是否可作为图生图参考（generate_image 工具的 references 参数） */
export async function resolveMediaImageBase64(projectId: number, mediaId: number): Promise<string> {
  const { filePath } = await resolveReadyImageMedia(projectId, mediaId, "参考图");
  return u.oss.getImageBase64(filePath);
}
