<template>
  <div class="qvAssetBoard" data-testid="qv-asset-board">
    <div class="qvAssetBoardHeader" @click="collapsed = !collapsed">
      <span class="qvAssetBoardTitle">
        {{ title }}
        <t-tag v-if="total" size="small" shape="round" style="margin-left: 6px">{{ total }}</t-tag>
      </span>
      <div class="qvAssetBoardHeaderActions" @click.stop>
        <t-select v-model="kindFilter" size="small" class="qvAssetBoardFilter" @change="onFilterChange">
          <t-option value="all" :label="allLabel" />
          <t-option value="image" :label="imageLabel" />
          <t-option value="video" :label="videoLabel" />
        </t-select>
        <t-button size="small" variant="outline" :loading="loading" @click="$emit('refresh')">
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
        <div v-for="item in items" :key="item.mediaId" class="qvAssetBoardCell" :data-testid="'qv-asset-cell-' + item.mediaId">
          <div class="qvAssetThumb" data-testid="qv-asset-zoom" @click="item.state === 'done' && $emit('zoom', item)">
            <t-image
              v-if="item.state === 'done' && item.kind === 'image' && item.url"
              :src="item.url"
              fit="cover"
              :style="{ width: '100%', height: '100%', cursor: 'pointer' }" />
            <video v-else-if="item.state === 'done' && item.kind === 'video' && item.url" :src="item.url" muted class="qvAssetVideoThumb" />
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
              <t-button size="small" variant="text" data-testid="qv-asset-copy" @click="$emit('copy', item)">{{ copyText }}</t-button>
              <t-button v-if="item.kind === 'image'" size="small" variant="text" theme="primary" data-testid="qv-asset-set-first-frame" @click="$emit('set-first-frame', item)">{{ setFirstFrameText }}</t-button>
            </template>
            <t-tooltip v-else-if="item.state === 'failed'" :content="item.errorReason || ''">
              <t-button size="small" variant="text" theme="danger">{{ failedText }}</t-button>
            </t-tooltip>
            <span v-else class="qvAssetGenerating">{{ generatingText }}</span>
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
import { ref, computed } from "vue";
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
  expandText: string;
  collapseText: string;
}>();

const emit = defineEmits<{
  refresh: [];
  "page-change": [page: number];
  "filter-change": [kind: "all" | "image" | "video"];
  zoom: [item: MediaRef];
  copy: [item: MediaRef];
  "set-first-frame": [item: MediaRef];
}>();

const collapsed = ref(false);
const kindFilter = ref<"all" | "image" | "video">("all");

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
      .qvAssetVideoThumb {
        width: 100%;
        height: 100%;
        object-fit: cover;
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
