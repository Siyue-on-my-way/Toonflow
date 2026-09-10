/**
 * QuickVideo / 单视频快创 —— 时间线装配播放器（SIY-111，WebAV 前端装配与导出）
 *
 * 职责：
 * - 按 getTimeline 规划顺序加载镜头视频片段，用真实媒体时长重新适配时间线（timelineCore）；
 * - AVCanvas 预览：播放/暂停/seek、字幕（EmbedSubtitlesClip）、BGM（合成音频，音量可调）、crossfade 转场、片尾定版；
 * - createCombinator 浏览器端编码 MP4：进度、取消、内存释放（destroy 全部 clip/sprite/combinator）。
 * WebAV 用法与专业模式 videoPreview.vue 保持一致（split 裁剪、sprite.time 三件套、VisibleSprite）。
 */
import { ref } from "vue";
import { AVCanvas } from "@webav/av-canvas";
import { AudioClip, EmbedSubtitlesClip, ImgClip, VisibleSprite, renderTxt2ImgBitmap } from "@webav/av-cliper";
import type { IClip } from "@webav/av-cliper";
import type { QuickVideoTimelinePlan } from "@/types/quickVideo";
import { buildSubtitleCues, buildTimelinePlan, clampSubtitleText, toEmbedSubtitleStructs } from "./timelineCore";

/** split 裁剪安全边界（秒），与专业模式一致：过窄的窗口不裁，避免边界抖动 */
const SPLIT_SAFETY_MARGIN = 0.05;
/** Keep browser-side export usable on software-only WebCodecs builds. */
const EXPORT_MAX_DIMENSION = 320;
const SAMPLE_FPS = 10;
const EXPORT_FPS = 5;

/**
 * WebAV 的 MP4Clip 在部分 Chromium Linux 构建中会把一个长 GOP 一次性
 * 推入 VideoDecoder。5 秒、25fps 的生成片段可能因此停在约 60 帧，导致
 * Combinator 永远等不到剩余帧。这里使用浏览器原生 video 解码输入帧，
 * 仍将帧交给 WebAV 的 Sprite/Combinator 做预览和浏览器端 MP4 编码。
 */
interface NativeVideoSourceMeta {
  width: number;
  height: number;
  duration: number;
}

interface NativeVideoSource {
  id: number;
  blob: Blob;
  video: HTMLVideoElement;
  objectUrl: string;
  ready: Promise<NativeVideoSourceMeta>;
  decodedFrames: NativeVideoFrameSample[] | null;
  decodePromise: Promise<NativeVideoFrameSample[]> | null;
  callbackId: number | null;
  refs: number;
  destroyed: boolean;
}

interface NativeVideoFrameSample {
  timestamp: number;
  frame: VideoFrame;
}

let nativeVideoSourceId = 0;

function createNativeVideoSource(blob: Blob): NativeVideoSource {
  const video = document.createElement("video");
  const objectUrl = URL.createObjectURL(blob);
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.setAttribute("aria-hidden", "true");
  video.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(video);

  const ready = new Promise<NativeVideoSourceMeta>((resolve, reject) => {
    const onLoaded = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (!duration || !video.videoWidth || !video.videoHeight) {
        reject(new Error("视频元数据无效"));
        return;
      }
      resolve({ width: video.videoWidth, height: video.videoHeight, duration: duration * 1e6 });
    };
    const onError = () => reject(new Error(video.error?.message ?? "视频解码失败"));
    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.src = objectUrl;
    video.load();
  });

  return {
    id: ++nativeVideoSourceId,
    blob,
    video,
    objectUrl,
    ready,
    decodedFrames: null,
    decodePromise: null,
    callbackId: null,
    refs: 0,
    destroyed: false,
  };
}

function retainNativeVideoSource(source: NativeVideoSource) {
  source.refs += 1;
}

function releaseNativeVideoSource(source: NativeVideoSource) {
  source.refs = Math.max(0, source.refs - 1);
  if (source.refs > 0 || source.destroyed) return;
  source.destroyed = true;
  if (source.callbackId != null && "cancelVideoFrameCallback" in source.video) {
    source.video.cancelVideoFrameCallback(source.callbackId);
  }
  source.callbackId = null;
  source.decodedFrames?.forEach(({ frame }) => frame.close());
  source.decodedFrames = null;
  source.decodePromise = null;
  source.video.pause();
  source.video.removeAttribute("src");
  source.video.load();
  source.video.remove();
  URL.revokeObjectURL(source.objectUrl);
}

/**
 * Decode a source once with the browser's native H.264 decoder and retain a
 * sampled frame index for one timeline load/export. WebAV's MP4Clip decoder
 * is not reliable for the long-GOP clips emitted by the quick-video
 * generator; pre-decoding while the main thread is idle avoids both random
 * seeks and decoder starvation while Combinator is encoding.
 */
function prepareNativeVideoSource(source: NativeVideoSource): Promise<NativeVideoFrameSample[]> {
  if (source.decodedFrames) return Promise.resolve(source.decodedFrames);
  if (source.decodePromise) return source.decodePromise;

  source.decodePromise = source.ready.then(
    ({ width, height, duration }) =>
      new Promise<NativeVideoFrameSample[]>((resolve, reject) => {
        const video = source.video;
        const durationSeconds = duration / 1e6;
        const frames: NativeVideoFrameSample[] = [];
        const sampleInterval = 1e6 / SAMPLE_FPS;
        // Keep the sampled cache at the same maximum size as the export
        // canvas.  Holding full-resolution VideoFrames for every 100 ms of
        // every shot can consume hundreds of MB in a portrait project and
        // makes Chromium's VideoEncoder stall near the end of the export.
        const sampleScale = Math.min(1, EXPORT_MAX_DIMENSION / Math.max(width, height));
        const sampleWidth = Math.max(1, Math.round(width * sampleScale));
        const sampleHeight = Math.max(1, Math.round(height * sampleScale));
        const sampleCanvas = new OffscreenCanvas(sampleWidth, sampleHeight);
        const sampleContext = sampleCanvas.getContext("2d", { alpha: false });
        if (!sampleContext) {
          reject(new Error("视频采样画布初始化失败"));
          return;
        }
        let callbackId: number | null = null;
        let pollId: number | null = null;
        let timeoutId: number | null = null;
        let settled = false;
        let lastObserved = -Infinity;

        const cleanup = () => {
          if (callbackId != null && "cancelVideoFrameCallback" in video) video.cancelVideoFrameCallback(callbackId);
          if (pollId != null) window.clearInterval(pollId);
          if (timeoutId != null) window.clearTimeout(timeoutId);
          video.removeEventListener("ended", onEnded);
          video.removeEventListener("error", onError);
        };
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          video.pause();
          if (error) {
            frames.forEach(({ frame }) => frame.close());
            reject(error);
            return;
          }
          if (!frames.length) {
            reject(new Error("视频未解码出有效帧"));
            return;
          }
          source.decodedFrames = frames;
          resolve(frames);
        };
        const capture = (seconds: number) => {
          if (settled || !Number.isFinite(seconds)) return;
          const timestamp = Math.max(0, Math.min(seconds, durationSeconds)) * 1e6;
          if (timestamp <= lastObserved + 1_000) return;
          lastObserved = timestamp;
          try {
            sampleContext.clearRect(0, 0, sampleWidth, sampleHeight);
            sampleContext.drawImage(video, 0, 0, sampleWidth, sampleHeight);
            const frame = new VideoFrame(sampleCanvas, { timestamp, duration: sampleInterval });
            const last = frames[frames.length - 1];
            if (!last || timestamp >= last.timestamp + sampleInterval - 25_000) {
              frames.push({ timestamp, frame });
            } else {
              frame.close();
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        };
        const onVideoFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
          capture(metadata.mediaTime);
          if (!settled && !video.ended) callbackId = video.requestVideoFrameCallback(onVideoFrame);
        };
        const onEnded = () => {
          capture(video.currentTime);
          finish();
        };
        const onError = () => finish(new Error(video.error?.message ?? "视频解码失败"));
        const supportsVideoFrameCallback = typeof (video as HTMLVideoElement & { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback === "function";

        video.addEventListener("ended", onEnded, { once: true });
        video.addEventListener("error", onError, { once: true });
        if (supportsVideoFrameCallback) {
          callbackId = video.requestVideoFrameCallback(onVideoFrame);
        } else {
          // 保留不支持 requestVideoFrameCallback 的 Chromium 构建兼容路径。
          pollId = window.setInterval(() => capture(video.currentTime), 15);
        }
        timeoutId = window.setTimeout(
          () => finish(new Error(`视频解码超时（duration=${durationSeconds.toFixed(3)}s, frames=${frames.length}）`)),
          Math.max(15_000, durationSeconds * 8_000 + 5_000),
        );
        video.currentTime = 0;
        void video.play().catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
      }),
  ).catch((error) => {
    source.decodePromise = null;
    throw error;
  });
  return source.decodePromise;
}

class NativeVideoClip implements IClip {
  private readonly source: NativeVideoSource;
  private readonly sourceStart: number;
  private readonly sourceEnd: number | null;
  private destroyed = false;
  private metadata = { width: 0, height: 0, duration: 0 };

  readonly ready: IClip["ready"];

  constructor(source: Blob | NativeVideoSource, sourceStart = 0, sourceEnd: number | null = null) {
    this.source = source instanceof Blob ? createNativeVideoSource(source) : source;
    retainNativeVideoSource(this.source);
    this.sourceStart = Math.max(0, sourceStart);
    this.sourceEnd = sourceEnd;
    this.ready = this.source.ready.then(({ width, height, duration }) => {
      const fullDuration = duration / 1e6;
      const end = Math.min(this.sourceEnd ?? fullDuration, fullDuration);
      if (!fullDuration || end <= this.sourceStart) throw new Error("视频元数据无效");
      this.metadata = { width, height, duration: (end - this.sourceStart) * 1e6 };
      return { ...this.metadata };
    });
  }

  get meta() {
    return { ...this.metadata };
  }

  async tick(time: number) {
    await this.ready;
    if (this.destroyed || this.source.destroyed || time >= this.metadata.duration) return { audio: [], state: "done" as const };

    const frames = await prepareNativeVideoSource(this.source);
    const sourceTime = this.sourceStart * 1e6 + Math.max(0, time);
    let low = 0;
    let high = frames.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (frames[middle].timestamp <= sourceTime) low = middle;
      else high = middle - 1;
    }
    const sample = frames[Math.max(0, Math.min(low, frames.length - 1))];
    return {
      video: sample.frame.clone(),
      audio: [],
      state: "success" as const,
    };
  }

  async prepareFrames() {
    await prepareNativeVideoSource(this.source);
  }

  releaseFrames() {
    this.source.decodedFrames?.forEach(({ frame }) => frame.close());
    this.source.decodedFrames = null;
    this.source.decodePromise = null;
  }

  async clone() {
    // The source is immutable after pre-decoding, so the visible preview and
    // Combinator clone can safely share its sampled frame index.
    const clip = new NativeVideoClip(this.source, this.sourceStart, this.sourceEnd);
    await clip.ready;
    return clip as this;
  }

  async split(time: number) {
    await this.ready;
    const splitAt = this.sourceStart + Math.max(0, Math.min(time / 1e6, this.metadata.duration / 1e6));
    const end = this.sourceEnd ?? this.sourceStart + this.metadata.duration / 1e6;
    const pre = new NativeVideoClip(this.source, this.sourceStart, splitAt);
    const post = new NativeVideoClip(this.source, splitAt, end);
    try {
      await Promise.all([pre.ready, post.ready]);
    } catch (error) {
      pre.destroy();
      post.destroy();
      throw error;
    }
    return [pre, post] as [this, this];
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    releaseNativeVideoSource(this.source);
  }
}

/** WebAV 的 MP4 音轨编码使用 AAC；开源 Chromium 常常只能解码而不能编码 AAC。 */
async function supportsAacAudioEncoding(): Promise<boolean> {
  const audioEncoder = (globalThis as typeof globalThis & {
    AudioEncoder?: { isConfigSupported?: (config: Record<string, unknown>) => Promise<{ supported?: boolean }> };
  }).AudioEncoder;
  try {
    return !!(await audioEncoder?.isConfigSupported?.({
      codec: "mp4a.40.2",
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 128000,
    }))?.supported;
  } catch {
    return false;
  }
}

export interface LoadTimelineOptions {
  /** 服务端 getTimeline 返回的规划（只取镜头顺序/期望时长/台词，时间以实际媒体重新适配） */
  serverPlan: QuickVideoTimelinePlan;
  /** shotId -> 视频访问地址 */
  videoUrls: Record<string, string | null | undefined>;
  /** 是否启用合成 BGM */
  musicEnabled: boolean;
  /** BGM 音量 0-1 */
  musicVolume: number;
}

export interface ExportProgress {
  active: boolean;
  progress: number; // 0-1
  cancelled: boolean;
}

export function useTimelinePlayer() {
  const containerEl = ref<HTMLElement | null>(null);
  const ready = ref(false);
  const loading = ref(false);
  const playing = ref(false);
  const currentTime = ref(0);
  const duration = ref(0);
  const loadError = ref("");

  let avCanvas: AVCanvas | null = null;
  let plan: QuickVideoTimelinePlan | null = null;
  const clips: NativeVideoClip[] = [];
  /** Source clips plus every split derivative; all own a native-source ref. */
  const ownedClips: NativeVideoClip[] = [];
  const sprites: VisibleSprite[] = [];
  let audioSprite: VisibleSprite | null = null;
  let musicPCM: Float32Array[] | null = null;
  let musicVolume = 0.35;
  let musicEnabled = true;
  let audioEncodingSupported = true;
  let unsubs: (() => void)[] = [];
  let currentPlanInput: PlanInput[] = [];
  let loadGeneration = 0;
  let loadAbortController: AbortController | null = null;
  let activeExport: {
    signal: { cancelled: boolean };
    reader: ReadableStreamDefaultReader<Uint8Array> | null;
    combinator: { destroy?: () => void } | null;
  } | null = null;

  function ownClip(clip: NativeVideoClip) {
    ownedClips.push(clip);
    return clip;
  }

  function assertCurrentLoad(generation: number) {
    if (generation !== loadGeneration) throw new Error("TIMELINE_LOAD_CANCELLED");
  }

  function cancelActiveExport() {
    const current = activeExport;
    if (!current) return;
    current.signal.cancelled = true;
    void current.reader?.cancel().catch(() => {});
    try {
      current.combinator?.destroy?.();
    } catch {}
  }

  interface PlanInput {
    id: string;
    index: number;
    duration: number;
    dialogue?: string;
  }

  async function load(opts: LoadTimelineOptions) {
    const generation = ++loadGeneration;
    loadAbortController?.abort();
    const abortController = new AbortController();
    loadAbortController = abortController;
    loading.value = true;
    loadError.value = "";
    ready.value = false;
    musicEnabled = opts.musicEnabled;
    musicVolume = opts.musicVolume;
    currentPlanInput = [];
    try {
      cancelActiveExport();
      destroyResources();
      assertCurrentLoad(generation);

      // 1. 顺序拉取镜头片段，读真实时长（异常片段直接报错，交由上层提示重试）
      audioEncodingSupported = await supportsAacAudioEncoding();
      const orderedIds = [...opts.serverPlan.clips].sort((a, b) => a.index - b.index).map((c) => c.shotId);
      const dialogueById = new Map(opts.serverPlan.clips.map((c) => [c.shotId, c.subtitleText] as const));
      const actualDurations: Record<string, number> = {};
      for (const shotId of orderedIds) {
        const url = opts.videoUrls[shotId];
        if (!url) throw new Error(`镜头 ${shotId} 缺少视频地址`);
        const resp = await fetch(url, { signal: abortController.signal });
        if (!resp.ok || !resp.body) throw new Error(`镜头 ${shotId} 视频下载失败（${resp.status}）`);
        const clip = ownClip(new NativeVideoClip(await resp.blob()));
        try {
          await clip.ready;
          assertCurrentLoad(generation);
        } catch (error) {
          clip.destroy();
          throw error;
        }
        const planned = opts.serverPlan.clips.find((c) => c.shotId === shotId)?.sourceDuration ?? clip.meta.duration / 1e6;
        actualDurations[shotId] = Math.min(clip.meta.duration / 1e6, planned);
        clips.push(clip);
      }

      // 2. 以真实时长重新适配时间线（与服务端同一套数学）
      currentPlanInput = orderedIds.map((shotId) => ({
        id: shotId,
        index: opts.serverPlan.clips.find((c) => c.shotId === shotId)?.index ?? 1,
        duration: actualDurations[shotId],
        dialogue: dialogueById.get(shotId) ?? "",
      }));
      assertCurrentLoad(generation);
      plan = buildTimelinePlan({
        shots: currentPlanInput,
        targetDuration: opts.serverPlan.targetDuration,
        videoRatio: opts.serverPlan.videoRatio,
        ctaText: opts.serverPlan.tailPad?.text ?? "",
      });

      // 3. AVCanvas 预览画布
      if (!containerEl.value) throw new Error("预览容器未挂载");
      avCanvas = new AVCanvas(containerEl.value, {
        bgColor: "#000",
        width: plan.width,
        height: plan.height,
      });
      unsubs.push(
        avCanvas.on("timeupdate", (time: number) => {
          currentTime.value = time / 1e6;
        }),
        avCanvas.on("playing", () => (playing.value = true)),
        avCanvas.on("paused", () => (playing.value = false)),
      );

      // 4. 视频片段 sprite：裁剪源窗口 + 时间线三件套 + cover 适配 + crossfade 动画
      for (let i = 0; i < plan.clips.length; i++) {
        assertCurrentLoad(generation);
        const clipPlan = plan.clips[i];
        let clip: NativeVideoClip = clips[i];
        let sourceDuration = clip.meta.duration / 1e6;

        // 裁剪：先用原片段 split 保留 [trimStart, trimEnd]（与专业模式同款）
        if (clipPlan.trimEnd < sourceDuration - SPLIT_SAFETY_MARGIN) {
          const [keep, unused] = await clip.split(clipPlan.trimEnd * 1e6);
          unused.destroy();
          clip = ownClip(keep);
          await clip.ready;
          sourceDuration = clip.meta.duration / 1e6;
        }
        if (clipPlan.trimStart > SPLIT_SAFETY_MARGIN && clipPlan.trimStart < sourceDuration - SPLIT_SAFETY_MARGIN) {
          const [unused, keep] = await clip.split(clipPlan.trimStart * 1e6);
          unused.destroy();
          clip = ownClip(keep);
          await clip.ready;
        }

        const sprite = new VisibleSprite(clip);
        const span = clipPlan.end - clipPlan.start;
        sprite.time.offset = clipPlan.start * 1e6;
        sprite.time.duration = span * 1e6;
        sprite.time.playbackRate = clipPlan.playbackRate;
        fitCover(sprite, clip.meta.width, clip.meta.height, plan.width, plan.height);
        applyCrossfade(sprite, i, span);
        sprites.push(sprite);
        await avCanvas.addSprite(sprite);
      }

      // 5. 字幕轨（可见区间避开转场重叠；EmbedSubtitlesClip 的数组入参为微秒）
      const subtitleFontSize = Math.max(24, Math.min(48, Math.round(Math.min(plan.width, plan.height) * 0.05)));
      const maxSubtitleChars = Math.max(12, Math.floor((plan.width * 0.9) / (subtitleFontSize * 1.05)));
      const cues = buildSubtitleCues(plan).map((cue) => ({
        ...cue,
        // EmbedSubtitlesClip wraps text by width, but an unbounded long
        // dialogue can still create dozens of lines and paint above the
        // frame. Keep the subtitle track readable without changing timing.
        text: clampSubtitleText(cue.text, maxSubtitleChars, 3),
      }));
      if (cues.length) {
        const subClip = new EmbedSubtitlesClip(toEmbedSubtitleStructs(cues), {
          videoWidth: plan.width,
          videoHeight: plan.height,
          fontSize: subtitleFontSize,
          bottomOffset: Math.round(plan.height * 0.06),
          color: "#FFF",
          strokeStyle: "#000",
          fontFamily: "Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif",
        });
        await subClip.ready;
        const subSprite = new VisibleSprite(subClip);
        subSprite.time.offset = 0;
        subSprite.time.duration = plan.totalDuration * 1e6;
        subSprite.rect.x = 0;
        subSprite.rect.y = 0;
        subSprite.rect.w = plan.width;
        subSprite.rect.h = plan.height;
        subSprite.zIndex = 5;
        sprites.push(subSprite);
        await avCanvas.addSprite(subSprite);
      }

      // 6. 片尾定版（内容不足补齐时）：纯色底 + CTA 文案
      if (plan.tailPad && plan.tailPad.duration > 0.05) {
        const lastEnd = plan.clips[plan.clips.length - 1].end;
        const bgCanvas = document.createElement("canvas");
        bgCanvas.width = plan.width;
        bgCanvas.height = plan.height;
        const ctx = bgCanvas.getContext("2d")!;
        const gradient = ctx.createLinearGradient(0, 0, plan.width, plan.height);
        gradient.addColorStop(0, "#0f172a");
        gradient.addColorStop(1, "#1e293b");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, plan.width, plan.height);
        const bgBitmap = await createImageBitmap(bgCanvas);
        const bgClip = new ImgClip(bgBitmap);
        await bgClip.ready;
        const bgSprite = new VisibleSprite(bgClip);
        bgSprite.time.offset = lastEnd * 1e6;
        bgSprite.time.duration = plan.tailPad.duration * 1e6;
        bgSprite.rect.x = 0;
        bgSprite.rect.y = 0;
        bgSprite.rect.w = plan.width;
        bgSprite.rect.h = plan.height;
        sprites.push(bgSprite);
        await avCanvas.addSprite(bgSprite);

        const text = plan.tailPad.text;
        if (text) {
          const bitmap = await renderTxt2ImgBitmap(
            text,
            `font-size: ${Math.round(plan.height * 0.07)}px; color: #fff; font-weight: 600; font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif; letter-spacing: 2px;`,
          );
          const txtClip = new ImgClip(bitmap);
          await txtClip.ready;
          const txtSprite = new VisibleSprite(txtClip);
          txtSprite.time.offset = lastEnd * 1e6;
          txtSprite.time.duration = plan.tailPad.duration * 1e6;
          txtSprite.rect.x = (plan.width - bitmap.width) / 2;
          txtSprite.rect.y = (plan.height - bitmap.height) / 2;
          sprites.push(txtSprite);
          await avCanvas.addSprite(txtSprite);
        }
      }

      // 7. BGM（合成音频，循环铺满全片；音量可调）
      if (musicEnabled) await attachMusic(plan.totalDuration);

      duration.value = plan.totalDuration;
      currentTime.value = 0;
      ready.value = true;
      // 首帧按需渲染：避免预览解码器在用户尚未播放时占用 H.264 解码队列，
      // 导出时 Combinator 可以从干净的解码器状态开始。
    } catch (err: any) {
      if (generation === loadGeneration && err?.name !== "AbortError" && err?.message !== "TIMELINE_LOAD_CANCELLED") {
        loadError.value = err?.message ?? String(err);
        destroyResources();
      }
    } finally {
      if (generation === loadGeneration) {
        loading.value = false;
        loadAbortController = null;
      }
    }
  }

  /** cover 模式铺满画布（rect 为左上角坐标 + 宽高，与专业模式约定一致） */
  function fitCover(sprite: VisibleSprite, mw: number, mh: number, cw: number, ch: number) {
    const scale = Math.max(cw / Math.max(1, mw), ch / Math.max(1, mh));
    const w = mw * scale;
    const h = mh * scale;
    sprite.rect.w = w;
    sprite.rect.h = h;
    sprite.rect.x = (cw - w) / 2;
    sprite.rect.y = (ch - h) / 2;
  }

  /** crossfade：与前/后镜头的重叠区做透明度动画（透出/盖住下层片段） */
  function applyCrossfade(sprite: VisibleSprite, index: number, span: number) {
    if (!plan) return;
    const D = plan.transitions[index]?.duration ?? plan.transitions[index - 1]?.duration ?? 0;
    if (!D || span <= D + 0.5) return;
    const fadeInPct = Math.round(((index > 0 ? D : 0) / span) * 10000) / 100;
    const fadeOutPct = Math.round(((index < plan.clips.length - 1 ? D : 0) / span) * 10000) / 100;
    const keyframes: Record<string, { opacity: number }> = { "0%": { opacity: index > 0 ? 0 : 1 }, "100%": { opacity: index < plan.clips.length - 1 ? 0 : 1 } };
    if (fadeInPct > 0 && fadeInPct < 100) keyframes[`${fadeInPct}%`] = { opacity: 1 };
    if (fadeOutPct > 0 && fadeOutPct < 100) keyframes[`${fadeOutPct}%`] = keyframes[`${fadeOutPct}%`] ?? { opacity: 1 };
    sprite.setAnimation(keyframes, { duration: span * 1e6, iterCount: 1 });
  }

  /** 合成 BGM PCM（纯数学合成，16 秒循环；无需 AudioContext，导出/预览一致） */
  function synthesizeMusicPCM(sampleRate = 44100, seconds = 16): Float32Array[] {
    const len = Math.floor(sampleRate * seconds);
    const left = new Float32Array(len);
    const right = new Float32Array(len);
    // C 大调柔和垫音（C4/E4/G4/B4），双耳轻微 detune + 慢速音量起伏
    const freqs = [261.63, 329.63, 392.0, 493.88];
    const gains = [0.16, 0.12, 0.11, 0.07];
    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      const loopT = t % seconds;
      // 循环首尾 0.4s 淡入淡出，避免接缝爆音
      const edge = Math.min(1, Math.min(loopT, seconds - loopT) / 0.4);
      const swell = 0.75 + 0.25 * Math.sin((2 * Math.PI * t) / (seconds / 2));
      let sample = 0;
      for (let f = 0; f < freqs.length; f++) {
        sample += gains[f] * Math.sin(2 * Math.PI * freqs[f] * t) * 0.5;
        sample += gains[f] * Math.sin(2 * Math.PI * freqs[f] * 1.002 * t) * 0.5;
      }
      sample *= edge * swell;
      left[i] = sample * 0.92;
      right[i] = sample * 0.86;
    }
    return [left, right];
  }

  async function attachMusic(totalDuration: number) {
    if (!avCanvas || !plan) return;
    detachMusic();
    if (!musicEnabled || musicVolume <= 0) return;
    if (!musicPCM) musicPCM = synthesizeMusicPCM();
    const audioClip = new AudioClip(musicPCM, { loop: true, volume: musicVolume });
    await audioClip.ready;
    audioSprite = new VisibleSprite(audioClip);
    audioSprite.time.offset = 0;
    audioSprite.time.duration = totalDuration * 1e6;
    sprites.push(audioSprite);
    await avCanvas.addSprite(audioSprite);
  }

  function detachMusic() {
    if (!audioSprite) return;
    try {
      avCanvas?.removeSprite(audioSprite);
      audioSprite.getClip().destroy?.();
    } catch {}
    const idx = sprites.indexOf(audioSprite);
    if (idx >= 0) sprites.splice(idx, 1);
    audioSprite = null;
  }

  /** BGM 音量（0-1）；重建音频 sprite 使音量生效 */
  async function setMusicVolume(v: number) {
    musicVolume = v;
    if (ready.value && plan) await attachMusic(plan.totalDuration);
  }

  function play() {
    if (!avCanvas || !ready.value) return;
    avCanvas.play({ start: Math.round(currentTime.value * 1e6), end: Math.round(duration.value * 1e6) });
  }

  function pause() {
    avCanvas?.pause();
  }

  async function seek(seconds: number) {
    if (!avCanvas || !ready.value) return;
    const wasPlaying = playing.value;
    if (wasPlaying) avCanvas.pause();
    currentTime.value = seconds;
    await avCanvas.previewFrame(Math.round(seconds * 1e6));
    if (wasPlaying) play();
  }

  function destroyResources() {
    unsubs.forEach((off) => off());
    unsubs = [];
    detachMusic();
    for (const clip of ownedClips) {
      try {
        clip.destroy();
      } catch {}
    }
    ownedClips.length = 0;
    clips.length = 0;
    sprites.length = 0;
    try {
      avCanvas?.destroy();
    } catch {}
    avCanvas = null;
    plan = null;
    ready.value = false;
    playing.value = false;
    currentTime.value = 0;
    duration.value = 0;
    musicPCM = null;
  }

  function destroy() {
    loadGeneration += 1;
    loadAbortController?.abort();
    loadAbortController = null;
    cancelActiveExport();
    destroyResources();
  }

  /**
   * 导出 MP4（浏览器端 WebAV 编码）：
   * - progress 回调 0-1；cancel() 中断并释放；结束后 combinator.destroy() 释放内存。
   * - 部分 Chromium 构建没有 AAC AudioEncoder。检测到该环境时关闭音轨，
   *   保证视频仍能导出；在支持 AAC 的浏览器中保留合成 BGM。
   */
  async function exportMp4(opts: { bitrate?: number; onProgress?: (p: number) => void; signal?: { cancelled: boolean } }): Promise<Blob> {
    if (!avCanvas || !plan || !ready.value) throw new Error("时间线未就绪，无法导出");
    const signal = opts.signal ?? { cancelled: false };
    cancelActiveExport();
    const exportRun = {
      signal,
      reader: null as ReadableStreamDefaultReader<Uint8Array> | null,
      combinator: null as { destroy?: () => void } | null,
    };
    activeExport = exportRun;
    let combinator: any = null;
    let offProgress = () => {};
    let offError = () => {};
    let outputError: unknown = null;
    let originalRects: { sprite: VisibleSprite; x: number; y: number; w: number; h: number }[] = [];

    try {
      pause();
      audioEncodingSupported = audioEncodingSupported && (await supportsAacAudioEncoding());
      // Prime every source before Combinator starts. A native HTML video can
      // decode a long-GOP clip sequentially, while asking it to seek once per
      // output frame causes Chromium to repeatedly flush the decoder.
      await Promise.all(clips.map((clip) => clip.prepareFrames()));
      if (signal.cancelled) throw new Error("EXPORT_CANCELLED");

      const exportScale = Math.min(1, EXPORT_MAX_DIMENSION / Math.max(plan.width, plan.height));
      const exportWidth = Math.max(1, Math.round(plan.width * exportScale));
      const exportHeight = Math.max(1, Math.round(plan.height * exportScale));
      originalRects = sprites.map((sprite) => ({
        sprite,
        x: sprite.rect.x,
        y: sprite.rect.y,
        w: sprite.rect.w,
        h: sprite.rect.h,
      }));
      // AVCanvas copies sprite geometry into Combinator. Scale that copy only
      // for the export canvas, then restore the preview geometry immediately.
      sprites.forEach((sprite) => {
        sprite.rect.x *= exportScale;
        sprite.rect.y *= exportScale;
        sprite.rect.w *= exportScale;
        sprite.rect.h *= exportScale;
      });

      try {
        combinator = await avCanvas.createCombinator({
          width: exportWidth,
          height: exportHeight,
          // 低资源浏览器使用 5fps 输出，减少软件 H.264 编码时的队列积压；
          // 预览仍使用 SAMPLE_FPS 的采样缓存，不影响时间线定位。
          fps: EXPORT_FPS,
          bitrate: opts.bitrate ?? Math.min(5e6, Math.max(1.2e6, Math.round(exportWidth * exportHeight * 4.5))),
          ...(audioEncodingSupported ? {} : { audio: false }),
        });
        exportRun.combinator = combinator;
      } finally {
        originalRects.forEach(({ sprite, x, y, w, h }) => {
          sprite.rect.x = x;
          sprite.rect.y = y;
          sprite.rect.w = w;
          sprite.rect.h = h;
        });
      }

      offProgress = combinator.on("OutputProgress", (progress: number) => opts.onProgress?.(progress));
      offError = combinator.on("error", (error: Error) => {
        outputError ??= error;
      });
      const reader = combinator.output().getReader();
      exportRun.reader = reader;
      const chunks: Uint8Array[] = [];
      while (true) {
        if (signal.cancelled) {
          try {
            await reader.cancel();
          } catch {}
          throw new Error("EXPORT_CANCELLED");
        }
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (error) {
          if (signal.cancelled) throw new Error("EXPORT_CANCELLED");
          throw error;
        }
        const { done, value } = result;
        if (done) break;
        if (value) chunks.push(value);
      }
      const output = new Blob(chunks as BlobPart[], { type: "video/mp4" });
      if (outputError) throw outputError;
      return output;
    } finally {
      originalRects.forEach(({ sprite, x, y, w, h }) => {
        sprite.rect.x = x;
        sprite.rect.y = y;
        sprite.rect.w = w;
        sprite.rect.h = h;
      });
      offProgress();
      offError();
      try {
        combinator?.destroy();
      } catch {}
      clips.forEach((clip) => clip.releaseFrames());
      exportRun.reader = null;
      exportRun.combinator = null;
      if (activeExport === exportRun) activeExport = null;
    }
  }

  function cancelExport() {
    cancelActiveExport();
  }

  return { containerEl, ready, loading, playing, currentTime, duration, loadError, plan: { current: () => plan }, load, play, pause, seek, setMusicVolume, exportMp4, cancelExport, destroy };
}
