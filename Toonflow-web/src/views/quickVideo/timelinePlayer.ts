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
import { MP4Clip, AudioClip, ImgClip, VisibleSprite, renderTxt2ImgBitmap, EmbedSubtitlesClip } from "@webav/av-cliper";
import type { QuickVideoTimelinePlan } from "@/types/quickVideo";
import { buildSubtitleCues, buildTimelinePlan, toEmbedSubtitleStructs } from "./timelineCore";

/** split 裁剪安全边界（秒），与专业模式一致：过窄的窗口不裁，避免边界抖动 */
const SPLIT_SAFETY_MARGIN = 0.05;

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
  const clips: MP4Clip[] = [];
  const sprites: VisibleSprite[] = [];
  let audioSprite: VisibleSprite | null = null;
  let musicPCM: Float32Array[] | null = null;
  let musicVolume = 0.35;
  let musicEnabled = true;
  let audioEncodingSupported = true;
  let unsubs: (() => void)[] = [];
  let currentPlanInput: PlanInput[] = [];
  let lastLoadOptions: LoadTimelineOptions | null = null;

  interface PlanInput {
    id: string;
    index: number;
    duration: number;
    dialogue?: string;
  }

  async function load(opts: LoadTimelineOptions) {
    loading.value = true;
    loadError.value = "";
    ready.value = false;
    musicEnabled = opts.musicEnabled;
    musicVolume = opts.musicVolume;
    currentPlanInput = [];
    lastLoadOptions = {
      ...opts,
      serverPlan: opts.serverPlan,
      videoUrls: { ...opts.videoUrls },
    };
    try {
      destroy();

      // 1. 顺序拉取镜头片段，读真实时长（异常片段直接报错，交由上层提示重试）
      audioEncodingSupported = await supportsAacAudioEncoding();
      const orderedIds = [...opts.serverPlan.clips].sort((a, b) => a.index - b.index).map((c) => c.shotId);
      const dialogueById = new Map(opts.serverPlan.clips.map((c) => [c.shotId, c.subtitleText] as const));
      const actualDurations: Record<string, number> = {};
      for (const shotId of orderedIds) {
        const url = opts.videoUrls[shotId];
        if (!url) throw new Error(`镜头 ${shotId} 缺少视频地址`);
        const resp = await fetch(url);
        if (!resp.ok || !resp.body) throw new Error(`镜头 ${shotId} 视频下载失败（${resp.status}）`);
        // 没有 AAC 编码器时连源音轨也不解码，避免 Chromium 在导出阶段等待音频帧超时。
        // 某些 Linux Chromium 的硬件解码器在多片段重复 seek 时会卡在 decodeQueue；
        // WebAV 暴露的 software 偏好可避免 MP4Clip.tick 超时，代价仅是导出占用更多 CPU。
        const clip = new MP4Clip(resp.body, {
          ...(audioEncodingSupported ? {} : { audio: false }),
          __unsafe_hardwareAcceleration__: "prefer-software",
        });
        await clip.ready;
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
        const clipPlan = plan.clips[i];
        let clip = clips[i];
        let sourceDuration = clip.meta.duration / 1e6;

        // 裁剪：先用原片段 split 保留 [trimStart, trimEnd]（与专业模式同款）
        if (clipPlan.trimEnd < sourceDuration - SPLIT_SAFETY_MARGIN) {
          const [keep] = await clip.split(clipPlan.trimEnd * 1e6);
          clip = keep;
          await clip.ready;
          sourceDuration = clip.meta.duration / 1e6;
        }
        if (clipPlan.trimStart > SPLIT_SAFETY_MARGIN && clipPlan.trimStart < sourceDuration - SPLIT_SAFETY_MARGIN) {
          const [, keep] = await clip.split(clipPlan.trimStart * 1e6);
          clip = keep;
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
      const cues = buildSubtitleCues(plan);
      if (cues.length) {
        const subClip = new EmbedSubtitlesClip(toEmbedSubtitleStructs(cues), {
          videoWidth: plan.width,
          videoHeight: plan.height,
          fontSize: Math.round(plan.height * 0.05),
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
      await avCanvas.previewFrame(0);
    } catch (err: any) {
      loadError.value = err?.message ?? String(err);
      destroy();
    } finally {
      loading.value = false;
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

  function destroy() {
    unsubs.forEach((off) => off());
    unsubs = [];
    detachMusic();
    for (const clip of clips) {
      try {
        clip.destroy();
      } catch {}
    }
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
  }

  /**
   * Combinator 已经克隆完所有 sprite 后，释放预览用的 VideoDecoder。
   * Chromium 对同时存活的 H.264 解码器数量有限，预览解码器不释放会让
   * 导出副本在多镜头项目中卡在 decodeQueue。导出结束后由 lastLoadOptions
   * 自动恢复预览，保证取消/失败/重复导出仍可继续操作。
   */
  function releasePreviewClips() {
    const released = new Set<object>();
    for (const sprite of sprites) {
      try {
        const clip = sprite.getClip();
        if (clip && !released.has(clip as object)) {
          released.add(clip as object);
          clip.destroy();
        }
      } catch {}
    }
    for (const clip of clips) {
      try {
        if (!released.has(clip as object)) {
          released.add(clip as object);
          clip.destroy();
        }
      } catch {}
    }
  }

  /**
   * 导出 MP4（浏览器端 WebAV 编码）：
   * - progress 回调 0-1；cancel() 中断并释放；结束后 combinator.destroy() 释放内存。
   * - 部分 Chromium 构建没有 AAC AudioEncoder。检测到该环境时关闭音轨，
   *   保证视频仍能导出；在支持 AAC 的浏览器中保留原片音频与合成 BGM。
   */
  async function exportMp4(opts: { bitrate?: number; onProgress?: (p: number) => void; signal?: { cancelled: boolean } }): Promise<Blob> {
    if (!avCanvas || !plan || !ready.value) throw new Error("时间线未就绪，无法导出");
    pause();
    audioEncodingSupported = audioEncodingSupported && (await supportsAacAudioEncoding());
    const combinator = await avCanvas.createCombinator({
      width: plan.width,
      height: plan.height,
      bitrate: opts.bitrate ?? Math.min(8e6, Math.max(2.5e6, Math.round(plan.width * plan.height * 4.5))),
      ...(audioEncodingSupported ? {} : { audio: false }),
    });
    const offProgress = combinator.on("OutputProgress", (progress: number) => opts.onProgress?.(progress));
    const restoreOptions = lastLoadOptions;
    let previewReleased = false;
    let output: Blob | null = null;
    let outputError: unknown = null;
    try {
      // createCombinator 已完成逐个 clone；现在释放预览副本的 decoder，
      // 避免导出副本与预览副本同时占用 Chromium 的 H.264 解码队列。
      releasePreviewClips();
      previewReleased = true;
      const reader = combinator.output().getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        if (opts.signal?.cancelled) {
          try {
            await reader.cancel();
          } catch {}
          throw new Error("EXPORT_CANCELLED");
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      output = new Blob(chunks as BlobPart[], { type: "video/mp4" });
    } catch (err) {
      outputError = err;
    } finally {
      offProgress();
      try {
        combinator.destroy();
      } catch {}
    }
    if (previewReleased && restoreOptions) {
      try {
        await load(restoreOptions);
      } catch (restoreError) {
        if (!outputError) outputError = restoreError;
      }
    }
    if (outputError) throw outputError;
    if (!output) throw new Error("导出未生成文件");
    return output;
  }

  return { containerEl, ready, loading, playing, currentTime, duration, loadError, plan: { current: () => plan }, load, play, pause, seek, setMusicVolume, exportMp4, destroy };
}
