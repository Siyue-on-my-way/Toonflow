<template>
  <div v-if="visible" class="qvExportProgress" data-testid="qv-export-progress">
    <div class="qvExportHeader">
      <span class="qvExportTitle">{{ title }}</span>
      <span class="qvExportFile" data-testid="qv-export-file">{{ fileName }}</span>
    </div>

    <div class="qvExportBarWrap" data-testid="qv-export-bar">
      <div class="qvExportBar">
        <div class="qvExportBarFill" :style="{ width: progress + '%' }" :class="{ error: status === 'error' }"></div>
      </div>
      <span class="qvExportPercent" data-testid="qv-export-percent">{{ Math.round(progress) }}%</span>
    </div>

    <div class="qvExportMeta" v-if="metaLine">{{ metaLine }}</div>
    <div class="qvExportError" v-if="status === 'error'" data-testid="qv-export-error">{{ errorMessage }}</div>

    <div class="qvExportActions">
      <button
        v-if="status === 'encoding'"
        class="qvBtn ghost"
        type="button"
        data-testid="qv-export-cancel"
        @click="$emit('cancel')">
        {{ cancelText }}
      </button>
      <button
        v-if="status === 'error'"
        class="qvBtn primary"
        type="button"
        data-testid="qv-export-retry"
        @click="$emit('retry')">
        {{ retryText }}
      </button>
      <button
        v-if="status === 'success' || status === 'error'"
        class="qvBtn ghost"
        type="button"
        data-testid="qv-export-close"
        @click="$emit('close')">
        {{ closeText }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

/** 快创导出进度条（纯展示组件，无 UI 库依赖，便于组件测试） */
const props = defineProps<{
  visible: boolean;
  status: "idle" | "encoding" | "success" | "error";
  progress: number;
  fileName: string;
  errorMessage?: string;
  metaLine?: string;
  title: string;
  cancelText: string;
  retryText: string;
  closeText: string;
}>();

defineEmits<{ (e: "cancel"): void; (e: "retry"): void; (e: "close"): void }>();

const progress = computed(() => Math.max(0, Math.min(100, props.progress || 0)));
const metaLine = computed(() => props.metaLine ?? "");
</script>

<style scoped>
.qvExportProgress {
  border: 1px solid var(--td-component-border, #e7e7e7);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--td-bg-color-container, #fff);
}
.qvExportHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.qvExportTitle {
  font-weight: 600;
  font-size: 13px;
}
.qvExportFile {
  font-size: 12px;
  color: var(--td-text-color-secondary, #666);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}
.qvExportBarWrap {
  display: flex;
  align-items: center;
  gap: 8px;
}
.qvExportBar {
  flex: 1;
  height: 8px;
  border-radius: 4px;
  background: var(--td-bg-color-component, #e7e7e7);
  overflow: hidden;
}
.qvExportBarFill {
  height: 100%;
  border-radius: 4px;
  background: var(--td-brand-color, #0052d9);
  transition: width 0.2s ease;
}
.qvExportBarFill.error {
  background: var(--td-error-color, #d54941);
}
.qvExportPercent {
  min-width: 38px;
  text-align: right;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.qvExportMeta,
.qvExportError {
  font-size: 12px;
  color: var(--td-text-color-secondary, #666);
}
.qvExportError {
  color: var(--td-error-color, #d54941);
}
.qvExportActions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.qvBtn {
  border-radius: 6px;
  padding: 4px 14px;
  font-size: 13px;
  cursor: pointer;
  border: 1px solid transparent;
}
.qvBtn.primary {
  background: var(--td-brand-color, #0052d9);
  color: #fff;
}
.qvBtn.ghost {
  background: transparent;
  border-color: var(--td-component-border, #dcdcdc);
  color: var(--td-text-color-primary, #333);
}
</style>
