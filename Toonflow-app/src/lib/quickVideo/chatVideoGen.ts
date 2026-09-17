/**
 * QuickVideo / 单视频快创 —— 聊天生视频共享内核（SIY-161）
 *
 * 从 quickVideoAgent 的 generate_video 工具中抽出的生成内核，供三条入口复用：
 * 1. Agent 工具 generate_video（聊天即时生成，行为与 SIY-154/158 版本保持一致）；
 * 2. request_video_params 工具的「沿用上次参数不再询问」直通路径；
 * 3. socket confirmVideoParams（参数确认卡确认后的生成，参数经元数据硬校验）。
 *
 * 职责：媒体占位落库 -> 参考图解析 -> 输入模式决策（能力感知，不按模型名特判）->
 * 时长就近取整 -> 供应商请求组装（透传确认卡的 resolution/quality/音频/种子等参数）->
 * 结果落库与聊天流回显。所有失败都显式返回原因，绝不静默退化。
 */
import u from "@/utils";
import {
  ChatVideoParams,
  QuickVideoRatio,
} from "./contract";
import { castAspectRatio } from "./generate";
import { collectDurationTiers, isVideoModelSupportingSingleImage, snapDurationToTiers, type VendorModelEntry } from "./modelValidation";
import {
  createChatMedia,
  getVideoModelCatalogEntry,
  getVideoModelDefaultQuality,
  markChatMediaDone,
  markChatMediaFailed,
  resolveDefaultImageModel,
  resolveMediaImageBase64,
  resolveVideoStartEndMode,
  videoModelSupportsTextToVideo,
} from "./media";

/** 生成内核对聊天消息发射器的最小接口（MessageBuilder 结构兼容） */
export interface ChatVideoGenEmitter {
  /** 所在消息 id（媒体记录留痕用；历史回放按 messageId 关联） */
  id?: string;
  thinking(title: string): {
    appendText(text: string): unknown;
    updateTitle(title: string): unknown;
    complete(): unknown;
  };
  image(data: { name: string; url: string }, ext?: Record<string, any>): unknown;
  video(data: { name: string; url: string }, ext?: Record<string, any>): unknown;
}

export interface RunChatVideoGenerationOptions {
  projectId: number;
  userId: number;
  sessionId: number;
  msg: ChatVideoGenEmitter;
  /** 本次生成的幂等键（防重试重复落库） */
  idempotencyKey: string;
  videoModel: string;
  /** 概念首帧链式生成用的图片模型（所选视频模型不支持文生视频时需要） */
  imageModel?: string;
  prompt: string;
  /** 已解析的参考图 mediaId（调用方完成三级解析与守门；内核不再二次解析） */
  referenceIds: number[];
  /** 模型声明的时长档位（就近取整与说明用；空数组表示不做取整） */
  durationTiers: number[];
  /** 确认卡参数（时长/分辨率/比例/画质/音频/种子等）；缺省字段沿用既有默认行为 */
  params: ChatVideoParams;
  /** 审计日志来源标注（tool=Agent 工具 / card=确认卡 / preference=偏好直通） */
  source?: string;
}

export type ChatVideoGenerationResult =
  | { ok: true; videoMediaId: number; conceptImageMediaId?: number; notes: string[] }
  | { ok: false; reason: string; videoMediaId?: number; conceptImageMediaId?: number };

/** 供应商请求参数审计日志（SIY-158 第4层延续）：Base64 参考图以张数代替，不刷日志 */
function logVideoVendorRequest(
  source: string,
  model: string,
  input: { prompt: string; mode: string[]; duration: number; aspectRatio: string; resolution: string; quality?: string; extra: Record<string, unknown>; referenceCount: number },
) {
  const extraText = Object.entries(input.extra)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "boolean" ? (v ? "on" : "off") : String(v)}`)
    .join(" ");
  console.log(
    `[quickVideo][chatVideoGen:${source}] 供应商请求 model=${model} mode=[${input.mode.join(",")}] duration=${input.duration} ` +
      `aspectRatio=${input.aspectRatio} resolution=${input.resolution} quality=${input.quality ?? "-"}${extraText ? " " + extraText : ""} ` +
      `参考图=${input.referenceCount}张 prompt="${input.prompt.slice(0, 80)}${input.prompt.length > 80 ? "…" : ""}"`,
  );
}

/** 从目录条目解析 mode 声明里第一个含图片参考的数组组合（多模态参考图模式） */
function firstMultiImageMode(entry: VendorModelEntry): string[] | null {
  const modes = Array.isArray(entry.mode) ? (entry.mode as unknown[]) : [];
  for (const m of modes) {
    if (Array.isArray(m) && m.some((ref) => String(ref).startsWith("imageReference:"))) return m.map(String);
  }
  return null;
}

/**
 * 运行一次聊天生视频。成功返回媒体 id 与展示说明；失败返回可读原因（媒体记录标记 failed）。
 * 行为基线 = SIY-154/158 的 generate_video 工具（含概念首帧链式生成），差异仅在：
 * 参数显式来自确认卡（分辨率/画质/音频/种子等不再硬编码）、输入模式按目录声明能力感知。
 */
export async function runChatVideoGeneration(opts: RunChatVideoGenerationOptions): Promise<ChatVideoGenerationResult> {
  const { projectId, userId, sessionId, msg, idempotencyKey, videoModel, prompt, referenceIds, durationTiers } = opts;
  const params = opts.params ?? {};
  const source = opts.source ?? "tool";

  const project = await u.db("o_project").where("id", projectId).select("videoRatio").first();
  const aspectRatio = (params.aspectRatio ?? castAspectRatio((project?.videoRatio || "16:9") as QuickVideoRatio)) as `${number}:${number}`;

  // 时长就近取整（SIY-154 P2）：非档位值自动映射到最近档位并说明，不把非法值交给供应商校验
  const requestedDuration = params.duration ?? 5;
  const snappedDuration = snapDurationToTiers(requestedDuration, durationTiers);
  const duration = snappedDuration ?? requestedDuration;
  const durationNote =
    snappedDuration != null && snappedDuration !== requestedDuration
      ? `（原时长 ${requestedDuration} 秒不受当前模型支持，已自动就近取整为 ${snappedDuration} 秒）`
      : "";

  const { media, idempotentHit } = await createChatMedia({
    projectId,
    sessionId,
    messageId: opts.msg.id ?? null,
    kind: "video",
    model: videoModel,
    prompt,
    source: "chat",
    idempotencyKey,
  });
  if (idempotentHit) {
    if (media.state === "done") return { ok: true, videoMediaId: media.id, notes: ["该次视频生成请求已处理过（幂等命中）。"] };
    if (media.state === "failed") return { ok: false, videoMediaId: media.id, reason: media.errorReason ?? "生成失败（幂等命中）" };
    return { ok: false, videoMediaId: media.id, reason: "该次视频生成请求正在处理中（幂等命中），请稍候。" };
  }

  // 解析参考图为 Base64；单张失效视为整体失败（参考图是用户显式授权的条件输入，静默丢图属事故）
  const imageBase64List: string[] = [];
  for (const refId of referenceIds) {
    try {
      imageBase64List.push(await resolveMediaImageBase64(projectId, refId));
    } catch (err) {
      const reason = `参考图 ${refId} 无效：${u.error(err as Error).message}`;
      await markChatMediaFailed(media.id, reason);
      return { ok: false, videoMediaId: media.id, reason: `视频生成失败：${reason}。请提醒用户重新选择有效的参考图后再试。` };
    }
  }

  // 纯文生请求但模型不支持 text 模式：走概念首帧链式生成（能力守门，避免必然失败的供应商调用）
  let conceptImageMediaId: number | undefined;
  if (!imageBase64List.length) {
    let supportsText = true;
    try {
      supportsText = await videoModelSupportsTextToVideo(videoModel);
    } catch (err) {
      const reason = u.error(err as Error).message;
      await markChatMediaFailed(media.id, reason);
      return { ok: false, videoMediaId: media.id, reason: `视频生成失败：${reason}` };
    }
    if (!supportsText) {
      const chain = await generateWithConceptFirstFrame(opts, media, aspectRatio, duration, durationNote);
      if (chain.conceptImageMediaId) conceptImageMediaId = chain.conceptImageMediaId;
      return chain.result;
    }
  }

  const entry = await getVideoModelCatalogEntry(videoModel);

  // 输入模式决策：显式确认参数 > 按参考图张数与目录声明能力推断（能力感知，不再只认「首帧」一种图输入）
  let mode: string[] = ["text"];
  let degradedNote = "";
  const declaredMode = parseDeclaredModeValue(params.mode);
  if (declaredMode) {
    mode = declaredMode;
  } else if (imageBase64List.length === 1) {
    if (entry && !isVideoModelSupportingSingleImage(entry)) {
      const multi = entry ? firstMultiImageMode(entry) : null;
      if (multi) {
        mode = multi; // 多模态参考图模型（如 seedance）：图片作为参考而非首帧
      } else {
        const reason = "所选视频模型不支持单图/首帧输入，请更换视频模型后重试";
        await markChatMediaFailed(media.id, reason);
        return { ok: false, videoMediaId: media.id, reason: `视频生成失败：${reason}` };
      }
    } else {
      mode = ["singleImage"];
    }
  } else if (imageBase64List.length >= 2) {
    const startEndMode = await resolveVideoStartEndMode(videoModel);
    if (startEndMode) {
      mode = [startEndMode];
    } else if (!entry || isVideoModelSupportingSingleImage(entry)) {
      mode = ["singleImage"];
      imageBase64List.length = 1;
      degradedNote = "（该视频模型未声明支持首尾帧过渡，已自动退化为仅用首帧）";
    } else {
      const multi = firstMultiImageMode(entry);
      if (multi) {
        mode = multi;
      } else {
        mode = ["singleImage"];
        imageBase64List.length = 1;
        degradedNote = "（该视频模型未声明支持首尾帧过渡，已自动退化为仅用首帧）";
      }
    }
  }

  const resolution = params.resolution ?? "720p";
  const quality = params.quality ?? (await getVideoModelDefaultQuality(videoModel)) ?? undefined;

  try {
    const videoAi = u.Ai.Video(videoModel as `${string}:${string}`, userId);
    logVideoVendorRequest(source, videoModel, {
      prompt,
      mode,
      duration,
      aspectRatio,
      resolution,
      quality,
      extra: {
        generateAudio: params.generateAudio,
        returnLastFrame: params.returnLastFrame,
        seed: params.seed,
        realPersonMode: params.realPersonMode,
      },
      referenceCount: imageBase64List.length,
    });
    await videoAi.run(
      {
        prompt,
        referenceList: imageBase64List.map((base64) => ({ type: "image" as const, base64 })),
        mode: mode as any,
        duration,
        aspectRatio,
        resolution,
        // 模型目录声明 qualityOptions 时自动补齐（如 Kling O1 的 std），避免供应商侧必填校验失败（SIY-154 P1）
        quality,
        ...(params.generateAudio !== undefined ? { generateAudio: params.generateAudio } : {}),
        ...(params.returnLastFrame !== undefined ? { returnLastFrame: params.returnLastFrame } : {}),
        ...(params.seed !== undefined ? { seed: params.seed } : {}),
        ...(params.realPersonMode !== undefined ? { realPersonMode: params.realPersonMode } : {}),
      } as any,
      {
        taskClass: "快创聊天生视频",
        describe: `聊天生视频：${prompt.slice(0, 100)}`,
        relatedObjects: JSON.stringify({ projectId, sessionId, mediaId: media.id }),
        projectId,
      },
    );
    const savePath = `/${projectId}/quickVideo/chat-${u.uuid().slice(0, 8)}.mp4`;
    await videoAi.save(savePath);
    await markChatMediaDone(media.id, savePath);

    const url = await u.oss.getFileUrl(savePath);
    msg.video(
      { name: prompt.slice(0, 60), url },
      { mediaId: media.id, assetId: media.assetId, videoId: media.videoId, kind: "video", model: videoModel, promptSummary: prompt.slice(0, 200), state: "done", source: "chat" },
    );
    const notes: string[] = [];
    if (degradedNote) notes.push(degradedNote);
    if (durationNote) notes.push(durationNote);
    return { ok: true, videoMediaId: media.id, conceptImageMediaId, notes };
  } catch (err) {
    const reason = u.error(err as Error).message;
    await markChatMediaFailed(media.id, reason);
    return { ok: false, videoMediaId: media.id, conceptImageMediaId, reason: `视频生成失败：${reason}。可以请用户调整参数、换一个描述或换一个视频模型后重试。` };
  }
}

/** 解析确认参数里的 mode（JSON 序列化的目录声明原值）；无法识别时返回 null 走能力推断 */
function parseDeclaredModeValue(mode: string | undefined): string[] | null {
  if (!mode) return null;
  try {
    const parsed = JSON.parse(mode);
    if (typeof parsed === "string") return [parsed];
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed.map(String);
  } catch {
    if (/^[a-zA-Z]+$/.test(mode)) return [mode];
  }
  return null;
}

/** 概念首帧链式生成（双轨自适应轨道 2，SIY-149）：先文生一张概念图，再以其为首帧生视频 */
async function generateWithConceptFirstFrame(
  opts: RunChatVideoGenerationOptions,
  videoMedia: { id: number; assetId: number | null; videoId: number | null },
  aspectRatio: `${number}:${number}`,
  duration: number,
  durationNote: string,
): Promise<{ result: ChatVideoGenerationResult; conceptImageMediaId?: number }> {
  const { projectId, userId, sessionId, msg, idempotencyKey, videoModel, prompt } = opts;
  const source = opts.source ?? "tool";
  const videoMediaId = videoMedia.id;

  let effectiveImageModel = opts.imageModel;
  if (!effectiveImageModel) {
    effectiveImageModel = await resolveDefaultImageModel(projectId, sessionId);
  }
  if (!effectiveImageModel) {
    const reason = "所选视频模型仅支持图生视频（单图首帧），系统尝试自动生成概念首帧图，但未找到可用的图片模型，请在设置中配置或启用图片模型。";
    await markChatMediaFailed(videoMediaId, reason);
    return { result: { ok: false, videoMediaId, reason } };
  }

  const { media: imageMedia, idempotentHit: imageIdempotentHit } = await createChatMedia({
    projectId,
    sessionId,
    messageId: opts.msg.id ?? null,
    kind: "image",
    model: effectiveImageModel,
    prompt,
    source: "chat",
    idempotencyKey: `${idempotencyKey}:first_frame`,
  });

  // 生成概念首帧图
  let conceptBase64: string;
  if (imageIdempotentHit && imageMedia.state === "done" && imageMedia.imageId) {
    try {
      conceptBase64 = await resolveMediaImageBase64(projectId, imageMedia.id);
    } catch (err) {
      const reason = `首帧概念图读取失败: ${u.error(err as Error).message}`;
      await markChatMediaFailed(videoMediaId, reason);
      return { result: { ok: false, videoMediaId, reason: `视频生成失败：${reason}` }, conceptImageMediaId: imageMedia.id };
    }
  } else {
    try {
      const imageCls = u.Ai.Image(effectiveImageModel as `${string}:${string}`, userId);
      await imageCls.run(
        { prompt, referenceList: [], size: "1K", aspectRatio },
        {
          taskClass: "快创聊天概念首帧",
          describe: `概念首帧：${prompt.slice(0, 100)}`,
          relatedObjects: JSON.stringify({ projectId, sessionId, mediaId: imageMedia.id }),
          projectId,
        },
      );
      const imageSavePath = `/${projectId}/quickVideo/chat-concept-${u.uuid().slice(0, 8)}.jpg`;
      await imageCls.save(imageSavePath);
      await markChatMediaDone(imageMedia.id, imageSavePath);
      const imageUrl = await u.oss.getFileUrl(imageSavePath);
      msg.image(
        { name: `[概念首帧] ${prompt.slice(0, 50)}`, url: imageUrl },
        { mediaId: imageMedia.id, assetId: imageMedia.assetId, imageId: imageMedia.imageId, kind: "image", model: effectiveImageModel, promptSummary: prompt.slice(0, 200), state: "done", source: "chat" },
      );
      conceptBase64 = await resolveMediaImageBase64(projectId, imageMedia.id);
    } catch (err) {
      const reason = u.error(err as Error).message;
      await markChatMediaFailed(imageMedia.id, reason);
      const videoReason = `所选视频模型需要首帧参考图，系统尝试自动生成概念首帧图失败（${reason}）。可以请用户换一个描述或换一个模型后重试。`;
      await markChatMediaFailed(videoMediaId, videoReason);
      return { result: { ok: false, videoMediaId, reason: `视频生成失败：${videoReason}` }, conceptImageMediaId: imageMedia.id };
    }
  }

  // 概念图作为首帧送入视频模型
  try {
    const videoAi = u.Ai.Video(videoModel as `${string}:${string}`, userId);
    const quality = (await getVideoModelDefaultQuality(videoModel)) ?? undefined;
    logVideoVendorRequest(source, videoModel, {
      prompt,
      mode: ["singleImage"],
      duration,
      aspectRatio,
      resolution: opts.params?.resolution ?? "720p",
      quality,
      extra: {},
      referenceCount: 1,
    });
    await videoAi.run(
      {
        prompt,
        referenceList: [{ type: "image" as const, base64: conceptBase64 }],
        mode: ["singleImage"],
        duration,
        aspectRatio,
        resolution: opts.params?.resolution ?? "720p",
        quality,
      },
      {
        taskClass: "快创聊天生视频",
        describe: `聊天生视频：${prompt.slice(0, 100)}`,
        relatedObjects: JSON.stringify({ projectId, sessionId, mediaId: videoMediaId }),
        projectId,
      },
    );
    const videoSavePath = `/${projectId}/quickVideo/chat-${u.uuid().slice(0, 8)}.mp4`;
    await videoAi.save(videoSavePath);
    await markChatMediaDone(videoMediaId, videoSavePath);
    const videoUrl = await u.oss.getFileUrl(videoSavePath);
    msg.video(
      { name: prompt.slice(0, 60), url: videoUrl },
      { mediaId: videoMediaId, assetId: videoMedia.assetId, videoId: videoMedia.videoId, kind: "video", model: videoModel, promptSummary: prompt.slice(0, 200), state: "done", source: "chat" },
    );
    return {
      result: {
        ok: true,
        videoMediaId,
        conceptImageMediaId: imageMedia.id,
        notes: [durationNote].filter(Boolean),
      },
      conceptImageMediaId: imageMedia.id,
    };
  } catch (err) {
    const reason = u.error(err as Error).message;
    const videoReason = `${reason}（概念首帧图已生成并保存在资产白板中，mediaId ${imageMedia.id}）`;
    await markChatMediaFailed(videoMediaId, videoReason);
    return {
      result: { ok: false, videoMediaId, conceptImageMediaId: imageMedia.id, reason: `视频生成失败：${videoReason}。可以请用户换一个描述或换一个视频模型后重试。` },
      conceptImageMediaId: imageMedia.id,
    };
  }
}

/** 从目录条目收集全部声明时长档位（含 -1 自动档；供上层做参数说明） */
export function collectEntryDurationTiers(entry: VendorModelEntry | null | undefined): number[] {
  if (!entry) return [];
  const map = Array.isArray(entry.durationResolutionMap) ? (entry.durationResolutionMap as { duration: number[] }[]) : [];
  return collectDurationTiers(map);
}
