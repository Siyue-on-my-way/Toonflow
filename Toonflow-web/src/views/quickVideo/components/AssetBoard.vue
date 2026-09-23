<template>
  <div class="qvAssetBoard" data-testid="qv-asset-board">
    <div class="qvAssetBoardHeader" @click="collapsed = !collapsed">
      <span class="qvAssetBoardTitle">
        {{ title }}
        <t-tag v-if="total" size="small" shape="round" style="margin-left: 6px">{{ total }}</t-tag>
      </span>
      <div class="qvAssetBoardHeaderActions" @click.stop>
        <!-- 「从 LibTV 导入」：把用户 LibTV 画布上的存量产物收编进素材库（一次性收编，只读不写回） -->
        <t-button size="small" variant="outline" data-testid="qv-asset-import-libtv" @click="$emit('import-libtv')">
          <template #icon><i-cloud-download size="14" /></template>
          {{ importFromLibtvText }}
        </t-button>
        <t-select v-model="kindFilter" size="small" class="qvAssetBoardFilter" @change="onFilterChange">
          <t-option value="all" :label="allLabel" />
          <t-option value="image" :label="imageLabel" />
          <t-option value="video" :label="videoLabel" />
        </t-select>
        <t-button size="small" variant="outline" :loading="loading" data-testid="qv-asset-refresh" @click="$emit('refresh')">
          <template #icon><i-refresh size="14" /></template>
        </t-button>
        <t-button size="small" variant="text" @click="collapsed = !collapsed">
          {{ collapsed ? expandText : collapseText }}
        </t-button>
      </div>
    </div>

    <div v-show="!collapsed" class="qvAssetBoardBody">
      <t-empty v-if="!items.length && !loading" :title="emptyText" data-testid="qv-asset-empty" />
      <div v-else class="qvAssetBoardGrid">
        <div v-for="item in items" :key="item.mediaId" :ref="setCellRef(item.mediaId)" class="qvAssetBoardCell" :data-testid="'qv-asset-cell-' + item.mediaId">
          <div class="qvAssetThumb" data-testid="qv-asset-zoom" @click="item.state === 'done' && $emit('zoom', item)">
            <template v-if="item.state === 'done' && item.kind === 'image' && item.url">
              <!-- 封面加载队列：src 只在轮到它时才赋值（顺序逐个出现），未轮到显示骨架 -->
              <t-skeleton v-if="coverState(item.mediaId) !== 'ready' && coverState(item.mediaId) !== 'loading'" class="qvAssetCoverSkeleton" :loading="true" :row-col="[{ width: '100%', height: '100%' }]" animation="gradient" />
              <img
                v-else-if="coverSrc(item)"
                class="qvAssetCoverImg"
                :src="coverSrc(item)!"
                :alt="item.promptSummary || ''"
                loading="eager"
                @load="onCoverLoad(item)"
                @error="onCoverError(item)" />
            </template>
            <template v-else-if="item.state === 'done' && item.kind === 'video' && item.url">
              <!-- 视频封面 = 服务端抽帧海报（?size=poster），不再用 <video> 全量拉 MP4；点卡片走 zoom 播原片 -->
              <t-skeleton v-if="coverState(item.mediaId) !== 'ready' && coverState(item.mediaId) !== 'loading'" class="qvAssetCoverSkeleton" :loading="true" :row-col="[{ width: '100%', height: '100%' }]" animation="gradient" />
              <img
                v-else-if="coverSrc(item)"
                class="qvAssetCoverImg"
                :src="coverSrc(item)!"
                :alt="item.promptSummary || ''"
                loading="eager"
                @load="onCoverLoad(item)"
                @error="onCoverError(item)" />
              <div class="qvAssetVideoBadge"><i-play-circle size="16" /></div>
            </template>
            <div v-else-if="item.state === 'generating'" class="qvAssetPlaceholder generating" data-testid="qv-asset-generating">
              <t-loading size="small" :loading="true" />
            </div>
            <div v-else class="qvAssetPlaceholder failed" data-testid="qv-asset-failed">
              <i-close-circle size="20" />
            </div>
          </div>
          <div class="qvAssetMeta">
            <span class="qvAssetPrompt" :title="item.promptSummary || ''">{{ item.promptSummary || "-" }}</span>
            <t-tag size="small" shape="round" :theme="item.kind === 'image' ? 'primary' : 'warning'">{{ item.kind === "image" ? imageLabel : videoLabel }}</t-tag>
          </div>
          <div class="qvAssetActions">
            <template v-if="item.state === 'done'">
              <!-- SIY-165 T8：复制按钮随玩法显隐——图片恒有；视频在全能参考玩法下恢复（allowVideoCopy），点缩略图仍可放大播放 -->
              <t-button v-if="item.kind === 'image' || allowVideoCopy" size="small" variant="text" data-testid="qv-asset-copy" @click="$emit('copy', item)">{{ copyText }}</t-button>
              <t-button v-if="item.kind === 'image'" size="small" variant="text" theme="primary" data-testid="qv-asset-set-first-frame" @click="$emit('set-first-frame', item)">{{ setFirstFrameText }}</t-button>
            </template>
            <t-tooltip v-else-if="item.state === 'failed'" theme="light">
              <t-button size="small" variant="text" theme="danger">{{ failedText }}</t-button>
              <template #content>
                <div style="max-width: 280px">
                  <libtvErrorCard v-if="isLibtvError(item.errorReason)" :reason="item.errorReason" />
                  <span v-else>{{ item.errorReason || "" }}</span>
                </div>
              </template>
            </t-tooltip>
            <span v-else class="qvAssetGenerating">{{ generatingText }}</span>
            <!-- 删除（SIY-137 审核反馈）：白板条目可移除；生成中禁用（服务端同样守门） -->
            <t-popconfirm
              v-if="item.state !== 'generating'"
              :content="deleteConfirmText"
              theme="danger"
              @confirm="$emit('delete', item)">
              <t-button size="small" variant="text" theme="danger" data-testid="qv-asset-delete">{{ deleteText }}</t-button>
            </t-popconfirm>
          </div>
        </div>
      </div>

      <div v-if="totalPages > 1" class="qvAssetBoardPager">
        <t-button size="small" variant="outline" :disabled="page <= 1" @click="$emit('page-change', page - 1)">‹</t-button>
        <span class="qvAssetPagerLabel">{{ page }} / {{ totalPages }}</span>
        <t-button size="small" variant="outline" :disabled="page >= totalPages" @click="$emit('page-change', page + 1)">›</t-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, nextTick } from "vue";
import libtvErrorCard from "@/components/libtvErrorCard.vue";
import { isLibtvError } from "@/utils/libtvError";
import type { MediaRef } from "@/types/quickVideo";

const props = defineProps<{
  title: string;
  items: MediaRef[];
  loading: boolean;
  total: number;
  page: number;
  pageSize: number;
  allLabel: string;
  imageLabel: string;
  videoLabel: string;
  emptyText: string;
  copyText: string;
  setFirstFrameText: string;
  failedText: string;
  generatingText: string;
  deleteText: string;
  deleteConfirmText: string;
  expandText: string;
  collapseText: string;
  /** SIY-165 T8：当前玩法（全能参考）是否放行视频复制引用；缺省 false 维持仅图片 */
  allowVideoCopy?: boolean;
  /** 「从 LibTV 导入」按钮文案 */
  importFromLibtvText: string;
}>();

const emit = defineEmits<{
  refresh: [];
  "import-libtv": [];
  "page-change": [page: number];
  "filter-change": [kind: "all" | "image" | "video"];
  zoom: [item: MediaRef];
  copy: [item: MediaRef];
  "set-first-frame": [item: MediaRef];
  delete: [item: MediaRef];
}>();

const collapsed = ref(false);
const kindFilter = ref<"all" | "image" | "video">("all");

// ============================================================
// 封面加载队列：并发 2 顺序加载（一个一个出现），可视区插队，失败重试 1 次后落占位。
// 背景：封面请求从「整份原始文件」改为小封面（图片 ?size=480x480 / 视频 ?size=poster 抽帧海报），
// 再配顺序队列，保证低带宽下逐个可见且全部最终加载。
// ============================================================
type CoverState = "queued" | "loading" | "ready" | "failed";
const COVER_CONCURRENCY = 2;
const coverStates = ref<Record<number, CoverState>>({});
const coverRetries = new Map<number, number>();
const queue: number[] = [];
let active = 0;
const cellEls = new Map<number, HTMLElement>();
let observer: IntersectionObserver | null = null;

const coverState = (id: number): CoverState => coverStates.value[id] ?? "queued";
/** 封面地址：小图/海报由服务端 /oss 现场生成并缓存（图片 480px，视频抽帧 JPEG） */
const coverSrc = (item: MediaRef): string | null => {
  if (!item.url) return null;
  return `${item.url}?size=${item.kind === "image" ? "480x480" : "poster"}`;
};

function pump() {
  while (active < COVER_CONCURRENCY && queue.length > 0) {
    const id = queue.shift()!;
    if (coverStates.value[id] === "ready" || coverStates.value[id] === "failed") continue;
    if (!props.items.some((i) => i.mediaId === id)) continue; // 已被翻页/筛选移除
    active += 1;
    coverStates.value = { ...coverStates.value, [id]: "loading" };
  }
}

function onCoverLoad(item: MediaRef) {
  active = Math.max(0, active - 1);
  coverStates.value = { ...coverStates.value, [item.mediaId]: "ready" };
  pump();
}

function onCoverError(item: MediaRef) {
  active = Math.max(0, active - 1);
  const retried = coverRetries.get(item.mediaId) ?? 0;
  if (retried < 1) {
    // 瞬时失败重试一次（仍走队列，保持节奏）
    coverRetries.set(item.mediaId, retried + 1);
    coverStates.value = { ...coverStates.value, [item.mediaId]: "queued" };
    queue.unshift(item.mediaId);
  } else {
    // 最终失败落占位，不阻塞队列；点刷新可整体重来
    coverStates.value = { ...coverStates.value, [item.mediaId]: "failed" };
  }
  pump();
}

/** 翻页/筛选/刷新后重建队列：已 ready 的保留（浏览器缓存命中秒出），其余按顺序重新排队 */
function rebuildQueue() {
  const valid = new Set(props.items.filter((i) => i.state === "done" && i.url).map((i) => i.mediaId));
  for (const id of Object.keys(coverStates.value)) {
    if (!valid.has(Number(id))) {
      delete coverStates.value[Number(id)];
      coverRetries.delete(Number(id));
    }
  }
  queue.length = 0;
  for (const it of props.items) {
    if (it.state !== "done" || !it.url) continue;
    const cur = coverStates.value[it.mediaId];
    if (cur === "ready" || cur === "failed" || cur === "loading") continue;
    coverStates.value = { ...coverStates.value, [it.mediaId]: "queued" };
    queue.push(it.mediaId);
  }
  pump();
  observeCells();
}

/** 可视区插队：滚动到哪先加载哪（卡片大多在首屏时等价于从上到下逐个出现） */
function observeCells() {
  if (typeof IntersectionObserver === "undefined") return;
  observer?.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = Number((e.target as HTMLElement).dataset.mediaId);
        const idx = queue.indexOf(id);
        if (idx > 0) {
          queue.splice(idx, 1);
          queue.unshift(id);
          pump();
        }
      }
    },
    { rootMargin: "120px" },
  );
  nextTick(() => {
    for (const [id, el] of cellEls) {
      el.dataset.mediaId = String(id);
      observer!.observe(el);
    }
  });
}

const setCellRef = (id: number) => (el: any) => {
  if (el) cellEls.set(id, el as HTMLElement);
  else cellEls.delete(id);
};

watch(
  () => props.items,
  () => rebuildQueue(),
  { immediate: true },
);

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  queue.length = 0;
});

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / Math.max(1, props.pageSize))));

function onFilterChange() {
  emit("filter-change", kindFilter.value);
}
</script>

<style lang="scss" scoped>
.qvAssetBoard {
  border: 1px solid var(--td-border-level-2-color);
  border-radius: 10px;
  background: var(--td-bg-color-container);
  overflow: hidden;
  .qvAssetBoardHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    background-color: var(--td-bg-color-secondarycontainer);
    font-weight: 600;
    cursor: pointer;
    .qvAssetBoardHeaderActions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .qvAssetBoardFilter {
      width: 88px;
    }
  }
  .qvAssetBoardBody {
    padding: 12px 14px;
  }
  .qvAssetBoardGrid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 10px;
  }
  .qvAssetBoardCell {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border: 1px solid var(--td-border-level-2-color);
    border-radius: 8px;
    padding: 6px;
    .qvAssetThumb {
      width: 100%;
      aspect-ratio: 1 / 1;
      border-radius: 6px;
      overflow: hidden;
      background: var(--td-bg-color-secondarycontainer);
      position: relative;
      .qvAssetCoverImg {
        width: 100%;
        height: 100%;
        object-fit: cover;
        cursor: pointer;
        display: block;
      }
      .qvAssetCoverSkeleton {
        width: 100%;
        height: 100%;
        display: block;
        :deep(.t-skeleton__row) {
          height: 100%;
        }
        :deep(.t-skeleton__col) {
          height: 100%;
        }
      }
      .qvAssetVideoBadge {
        position: absolute;
        right: 4px;
        bottom: 4px;
        color: #fff;
        background: rgba(0, 0, 0, 0.45);
        border-radius: 50%;
        padding: 2px;
        display: flex;
        pointer-events: none;
      }
    }
    .qvAssetPlaceholder {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      &.failed {
        color: var(--td-error-color);
      }
    }
    .qvAssetMeta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
      .qvAssetPrompt {
        flex: 1;
        min-width: 0;
        font-size: 11px;
        opacity: 0.65;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }
    .qvAssetActions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      .qvAssetGenerating {
        font-size: 11px;
        opacity: 0.5;
        padding: 0 4px;
      }
    }
  }
  .qvAssetBoardPager {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    margin-top: 10px;
    .qvAssetPagerLabel {
      font-size: 12px;
      opacity: 0.6;
    }
  }
}
</style>
