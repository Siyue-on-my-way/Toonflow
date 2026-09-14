<template>
  <div class="shotPreview" data-testid="qv-shot-preview">
    <!-- 图片卡片：生成中占位 / 失败+重试 / 缩略图（骨架屏） / 不可用（点击静默换新地址） / 待生成 -->
    <div
      class="shotMediaCard"
      :class="{ clickable: imageClickable, loading: imageLoadingVisible }"
      data-testid="qv-shot-image-card"
      :title="imageTitle"
      @click="onImageClick">
      <div v-if="shot.imageState === 'generating'" class="shotMediaPlaceholder" data-testid="qv-shot-image-generating">
        <t-loading size="small" :loading="true" />
        <span class="placeholderText">{{ generatingText }}</span>
      </div>
      <template v-else-if="shot.imageState === 'failed'">
        <div class="shotMediaPlaceholder failed" data-testid="qv-shot-image-failed" :title="shot.errorReason || failedText">
          <i-close-circle size="16" />
          <span class="placeholderText">{{ failedText }}</span>
        </div>
        <span v-if="canRetry && !retrying" class="shotRetryBtn" data-testid="qv-shot-image-retry" :title="retryText" @click.stop="$emit('retry')">
          <i-refresh size="12" />
        </span>
        <t-loading v-if="retrying" size="small" :loading="true" class="shotRetryLoading" />
      </template>
      <template v-else-if="urls?.imageUrl">
        <div v-if="imageLoadingVisible" class="shotMediaSkeleton" data-testid="qv-shot-image-skeleton" />
        <img
          v-if="!imageUnavailable"
          :key="`img-${reloadTick}-${urls.imageUrl}`"
          :src="urls.imageUrl"
          class="shotMediaImg"
          data-testid="qv-shot-image-img"
          loading="lazy"
          alt=""
          @load="onImageLoad"
          @error="onImageError" />
        <div v-else class="shotMediaPlaceholder unavailable" data-testid="qv-shot-image-unavailable">
          <i-refresh size="14" />
          <span class="placeholderText">{{ imageUnavailableText }}</span>
        </div>
      </template>
      <div
        v-else-if="shot.imageState === 'done'"
        :class="urlsPending ? 'shotMediaSkeleton' : 'shotMediaPlaceholder unavailable'"
        :data-testid="urlsPending ? 'qv-shot-image-skeleton' : 'qv-shot-image-unavailable'">
        <template v-if="!urlsPending">
          <i-refresh size="14" />
          <span class="placeholderText">{{ imageUnavailableText }}</span>
        </template>
      </div>
      <span v-else class="shotMediaEmpty">-</span>
      <span v-if="hasImageVisual" class="shotMediaBadge image" data-testid="qv-shot-image-badge">{{ imageLabel }}</span>
    </div>

    <!-- 视频卡片：生成中占位 / 失败+重试 / 封面+播放按钮（单元格内不自动播放） / 不可用（保留弹窗入口） / 待生成 -->
    <div
      class="shotMediaCard video"
      :class="{ clickable: videoClickable, loading: posterLoadingVisible }"
      data-testid="qv-shot-video-card"
      :title="videoTitle"
      @click="onVideoClick">
      <div v-if="shot.videoState === 'generating'" class="shotMediaPlaceholder" data-testid="qv-shot-video-generating">
        <t-loading size="small" :loading="true" />
        <span class="placeholderText">{{ generatingText }}</span>
      </div>
      <template v-else-if="shot.videoState === 'failed'">
        <div class="shotMediaPlaceholder failed" data-testid="qv-shot-video-failed" :title="shot.errorReason || failedText">
          <i-close-circle size="16" />
          <span class="placeholderText">{{ failedText }}</span>
        </div>
        <span v-if="canRetry && !retrying" class="shotRetryBtn" data-testid="qv-shot-video-retry" :title="retryText" @click.stop="$emit('retry')">
          <i-refresh size="12" />
        </span>
        <t-loading v-if="retrying" size="small" :loading="true" class="shotRetryLoading" />
      </template>
      <template v-else-if="urls?.videoUrl">
        <!-- 封面三层降级：海报图 -> <video preload="metadata"> 抽首帧（不自动播放） -> 不可用占位 -->
        <template v-if="!posterUnavailable">
          <div v-if="posterLoadingVisible" class="shotMediaSkeleton" data-testid="qv-shot-video-skeleton" />
          <img
            v-if="activePosterUrl && !posterFailed"
            :key="`poster-${reloadTick}-${activePosterUrl}`"
            :src="activePosterUrl"
            class="shotMediaImg"
            data-testid="qv-shot-video-poster"
            loading="lazy"
            alt=""
            @load="onPosterLoad"
            @error="onPosterError" />
          <video
            v-else
            :key="`meta-${reloadTick}-${urls.videoUrl}`"
            :src="urls.videoUrl"
            class="shotMediaImg"
            data-testid="qv-shot-video-meta"
            muted
            playsinline
            preload="metadata"
            @loadeddata="onPosterLoad"
            @error="onVideoMetaError" />
        </template>
        <div v-else class="shotMediaPlaceholder unavailable" data-testid="qv-shot-video-unavailable">
          <i-play-circle size="14" />
          <span class="placeholderText">{{ videoUnavailableText }}</span>
        </div>
        <span v-if="!posterUnavailable" class="shotPlayOverlay" data-testid="qv-shot-video-play"><i-play-circle size="22" /></span>
      </template>
      <div
        v-else-if="shot.videoState === 'done'"
        :class="urlsPending ? 'shotMediaSkeleton' : 'shotMediaPlaceholder unavailable'"
        :data-testid="urlsPending ? 'qv-shot-video-skeleton' : 'qv-shot-video-unavailable'">
        <template v-if="!urlsPending">
          <i-refresh size="14" />
          <span class="placeholderText">{{ videoUnavailableText }}</span>
        </template>
      </div>
      <span v-else class="shotMediaEmpty">-</span>
      <span v-if="hasVideoVisual" class="shotMediaBadge video" data-testid="qv-shot-video-badge">{{ videoLabel }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { QuickVideoShot, QuickVideoShotMediaUrls } from "@/types/quickVideo";

export type { QuickVideoShotMediaUrls };

const props = withDefaults(
  defineProps<{
    shot: QuickVideoShot;
    urls?: QuickVideoShotMediaUrls | null;
    /** 仅 generating 阶段允许单镜头重试（与操作列重试按钮同一门禁） */
    canRetry?: boolean;
    retrying?: boolean;
    /** 父级静默刷新媒体地址后自增：作为 :key 的一部分强制 <img>/<video> 重新挂载重试 */
    reloadTick?: number;
    /** 批量媒体地址请求未返回前，已完成镜头先展示骨架屏而不是"不可用" */
    urlsPending?: boolean;
    imageLabel: string;
    videoLabel: string;
    generatingText: string;
    failedText: string;
    imageUnavailableText: string;
    videoUnavailableText: string;
    retryText: string;
  }>(),
  { urls: null, canRetry: false, retrying: false, reloadTick: 0, urlsPending: false },
);

const emit = defineEmits<{
  /** 点击图片卡片：父级打开大图预览弹窗 */
  "open-image": [url: string];
  /** 点击视频卡片：父级打开视频弹窗播放器（表格单元格内不自动播放） */
  "open-video": [url: string];
  /** 单镜头重试 */
  retry: [];
  /** 地址过期/加载失败：父级静默重新拉取短期有效地址 */
  refresh: [];
}>();

// --- 卡片内部加载态：图片与视频互不阻塞，各自独立展示骨架/失败 ---
const imageLoading = ref(true);
const imageFailed = ref(false);
const posterLoading = ref(true);
const posterFailed = ref(false);
const videoMetaFailed = ref(false);

// shot 产物变化（重新生成/重试回写）或父级刷新媒体地址后，重置卡片内部加载态
watch(
  () => [props.shot.imageRef, props.shot.videoRef, props.shot.imageState, props.shot.videoState, props.urls, props.reloadTick] as const,
  () => {
    imageLoading.value = true;
    imageFailed.value = false;
    posterLoading.value = true;
    posterFailed.value = false;
    videoMetaFailed.value = false;
  },
);

// 同一地址只自动触发一次静默刷新，防止持续 404 时陷入「刷新->重挂载->失败」循环；之后的恢复由用户点击驱动
let autoRefreshedImageUrl: string | null = null;
let autoRefreshedVideoUrl: string | null = null;

const imageUnavailable = computed(() => imageFailed.value);
const activePosterUrl = computed(() => {
  if (posterFailed.value) return null;
  return props.urls?.videoPosterUrl ?? null;
});
const posterUnavailable = computed(() => {
  const hasPoster = Boolean(props.urls?.videoPosterUrl) && !posterFailed.value;
  return !hasPoster && videoMetaFailed.value;
});

const imageLoadingVisible = computed(() => Boolean(props.urls?.imageUrl) && !imageFailed.value && imageLoading.value);
const posterLoadingVisible = computed(
  () => Boolean(props.urls?.videoUrl) && !posterUnavailable.value && posterLoading.value,
);

const hasImageVisual = computed(() => {
  if (props.shot.imageState === "generating" || props.shot.imageState === "failed") return false;
  return Boolean(props.urls?.imageUrl) && !imageFailed.value;
});
const hasVideoVisual = computed(() => {
  if (props.shot.videoState === "generating" || props.shot.videoState === "failed") return false;
  return Boolean(props.urls?.videoUrl) && !posterUnavailable.value;
});

const imageClickable = computed(() => {
  if (props.shot.imageState === "failed" || props.shot.imageState === "generating") return false;
  return Boolean(props.urls?.imageUrl) || props.shot.imageState === "done";
});
const videoClickable = computed(() => {
  if (props.shot.videoState === "failed" || props.shot.videoState === "generating") return false;
  return Boolean(props.urls?.videoUrl) || props.shot.videoState === "done";
});

const imageTitle = computed(() => {
  if (props.shot.imageState === "failed") return props.shot.errorReason || props.failedText;
  if (imageUnavailable.value) return props.imageUnavailableText;
  return "";
});
const videoTitle = computed(() => {
  if (props.shot.videoState === "failed") return props.shot.errorReason || props.failedText;
  if (posterUnavailable.value) return props.videoUnavailableText;
  return "";
});

function onImageLoad() {
  imageLoading.value = false;
  imageFailed.value = false;
}
function onImageError() {
  imageFailed.value = true;
  imageLoading.value = false;
  const url = props.urls?.imageUrl ?? null;
  if (url && autoRefreshedImageUrl !== url) {
    autoRefreshedImageUrl = url;
    emit("refresh");
  }
}
function onPosterLoad() {
  posterLoading.value = false;
  posterFailed.value = false;
}
function onPosterError() {
  // 海报失效不致命：降级到 <video preload="metadata"> 抽首帧
  posterFailed.value = true;
  posterLoading.value = true;
}
function onVideoMetaError() {
  videoMetaFailed.value = true;
  posterLoading.value = false;
  const url = props.urls?.videoUrl ?? null;
  if (url && autoRefreshedVideoUrl !== url) {
    autoRefreshedVideoUrl = url;
    emit("refresh");
  }
}

function onImageClick() {
  if (!imageClickable.value) return;
  if (props.urls?.imageUrl && !imageFailed.value) {
    emit("open-image", props.urls.imageUrl);
    return;
  }
  // 已完成但地址不可用（过期/签名失效）：点击静默换新地址
  emit("refresh");
}
function onVideoClick() {
  if (!videoClickable.value) return;
  if (props.urls?.videoUrl) {
    // 单元格内不播放，统一交给弹窗播放器（弹窗内自动播放）
    emit("open-video", props.urls.videoUrl);
    return;
  }
  // 已完成但地址不可用：点击静默换新地址
  emit("refresh");
}
</script>

<style scoped lang="scss">
.shotPreview {
  display: flex;
  align-items: center;
  gap: 6px;
  // 窄屏/多画幅下双卡片保持最小宽度，允许单元格内横向滚动，避免缩略图被挤压到不可点击
  overflow-x: auto;
  max-width: 100%;
  padding: 1px;
}
.shotMediaCard {
  position: relative;
  flex: 0 0 auto;
  width: 64px;
  height: 40px;
  min-width: 64px;
  border-radius: 6px;
  overflow: hidden;
  background: var(--td-bg-color-secondarycontainer, #f3f3f3);
  border: 1px solid var(--td-component-border, rgba(0, 0, 0, 0.06));
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
  &.clickable {
    cursor: pointer;
    transition: box-shadow 0.15s ease;
    &:hover {
      box-shadow: 0 0 0 2px var(--td-brand-color-focus, rgba(0, 82, 217, 0.24));
    }
  }
  .shotMediaImg {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    background: #000;
  }
  .shotMediaSkeleton {
    position: absolute;
    inset: 0;
    background: linear-gradient(100deg, rgba(255, 255, 255, 0) 30%, rgba(255, 255, 255, 0.45) 50%, rgba(255, 255, 255, 0) 70%),
      var(--td-bg-color-secondarycontainer, #ececec);
    background-size: 200% 100%;
    animation: shotMediaShimmer 1.2s ease-in-out infinite;
  }
  .shotMediaPlaceholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    width: 100%;
    height: 100%;
    color: var(--td-text-color-secondary);
    .placeholderText {
      font-size: 10px;
      line-height: 1.2;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 0 2px;
    }
    &.failed {
      color: var(--td-error-color);
    }
    &.unavailable {
      font-size: 10px;
    }
  }
  .shotMediaEmpty {
    color: var(--td-text-color-placeholder);
    font-size: 12px;
  }
  .shotMediaBadge {
    position: absolute;
    left: 0;
    bottom: 0;
    padding: 0 4px;
    border-radius: 0 4px 0 0;
    font-size: 10px;
    line-height: 14px;
    color: #fff;
    background: rgba(0, 0, 0, 0.45);
    &.video {
      background: rgba(0, 0, 0, 0.6);
    }
  }
  .shotPlayOverlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    background: rgba(0, 0, 0, 0.18);
    pointer-events: none;
  }
  .shotRetryBtn {
    position: absolute;
    right: 2px;
    top: 2px;
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    color: var(--td-warning-color);
    background: rgba(255, 255, 255, 0.85);
    cursor: pointer;
    &:hover {
      background: #fff;
    }
  }
  .shotRetryLoading {
    position: absolute;
    right: 2px;
    top: 2px;
  }
}
@keyframes shotMediaShimmer {
  0% {
    background-position: 120% 0;
  }
  100% {
    background-position: -80% 0;
  }
}
</style>
