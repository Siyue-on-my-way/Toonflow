<template>
  <div class="qvSessionList" data-testid="qv-session-list">
    <div class="qvSessionListHeader">
      <span class="qvSessionListTitle">{{ title }}</span>
      <button class="qvSessionBtn primary" type="button" data-testid="qv-session-create" :disabled="loading" @click="$emit('create')">
        {{ createText }}
      </button>
    </div>

    <div v-if="!visibleSessions.length" class="qvSessionListEmpty" data-testid="qv-session-empty">{{ emptyText }}</div>

    <details v-else ref="pickerRef" class="qvSessionPicker" data-testid="qv-session-picker">
      <summary class="qvSessionPickerTrigger" data-testid="qv-session-trigger">
        <span class="qvSessionCurrentTitle" data-testid="qv-session-current">{{ currentSession?.title || defaultTitleText }}</span>
        <span class="qvSessionChevron" aria-hidden="true">⌄</span>
      </summary>

      <div class="qvSessionMenu" role="listbox" :aria-label="title">
        <div
          v-for="session in visibleSessions"
          :key="session.id"
          class="qvSessionOption"
          :class="{ active: session.id === currentSessionId }"
          data-testid="qv-session-option"
          :data-session-id="session.id"
          :data-active="session.id === currentSessionId"
          role="option"
          :aria-selected="session.id === currentSessionId"
          tabindex="0"
          @click="selectSession(session.id)"
          @keydown.enter.prevent="selectSession(session.id)"
          @keydown.space.prevent="selectSession(session.id)">
          <template v-if="renamingId === session.id">
            <input
              ref="renameInputRef"
              v-model="renameDraft"
              class="qvSessionRenameInput"
              data-testid="qv-session-rename-input"
              type="text"
              @click.stop
              @keyup.enter="confirmRename(session.id)"
              @keyup.esc="cancelRename"
              @blur="confirmRename(session.id)" />
          </template>
          <template v-else>
            <span class="qvSessionOptionTitle" data-testid="qv-session-title">{{ session.title || defaultTitleText }}</span>
          </template>

          <div class="qvSessionItemActions">
            <button class="qvSessionIconBtn" type="button" data-testid="qv-session-rename" :title="renameText" @click.stop="startRename(session)">
              ✎
            </button>
            <button class="qvSessionIconBtn" type="button" data-testid="qv-session-archive" :title="archiveText" @click.stop="$emit('toggleArchive', session.id)">
              🗄
            </button>
          </div>
        </div>
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import type { QuickVideoSession } from "@/types/quickVideo";

/**
 * 快创工作台会话列表（纯展示组件，无 UI 库依赖，便于组件测试）。
 * 排序由调用方保证（服务端已按 update_time 倒序返回）；本组件只负责展示与交互事件。
 */
const props = defineProps<{
  sessions: QuickVideoSession[];
  currentSessionId: number | null;
  loading?: boolean;
  title: string;
  createText: string;
  emptyText: string;
  renameText: string;
  archiveText: string;
  unarchiveText: string;
  archivedText: string;
  defaultTitleText: string;
}>();

const emit = defineEmits<{
  (e: "select", sessionId: number): void;
  (e: "create"): void;
  (e: "rename", sessionId: number, title: string): void;
  (e: "toggleArchive", sessionId: number): void;
}>();

const pickerRef = ref<HTMLDetailsElement | null>(null);
const renamingId = ref<number | null>(null);
const renameDraft = ref("");
const renameInputRef = ref<HTMLInputElement | HTMLInputElement[] | null>(null);
const visibleSessions = computed(() => props.sessions.filter((session) => session.status !== "archived"));
const currentSession = computed(() => visibleSessions.value.find((session) => session.id === props.currentSessionId) ?? null);

function selectSession(sessionId: number) {
  emit("select", sessionId);
  pickerRef.value?.removeAttribute("open");
}

function startRename(session: QuickVideoSession) {
  renamingId.value = session.id;
  renameDraft.value = session.title || "";
  nextTick(() => {
    const el = Array.isArray(renameInputRef.value) ? renameInputRef.value[0] : renameInputRef.value;
    el?.focus();
  });
}

function cancelRename() {
  renamingId.value = null;
  renameDraft.value = "";
}

function confirmRename(sessionId: number) {
  if (renamingId.value !== sessionId) return;
  const title = renameDraft.value.trim();
  renamingId.value = null;
  if (title) emit("rename", sessionId, title);
}
</script>

<style scoped>
.qvSessionList {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--td-component-border, #e7e7e7);
}
.qvSessionListHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.qvSessionListTitle {
  font-weight: 600;
  font-size: 13px;
}
.qvSessionListEmpty {
  font-size: 12px;
  color: var(--td-text-color-secondary, #666);
  padding: 4px 2px;
}
.qvSessionPicker {
  position: relative;
  min-width: 0;
}
.qvSessionPickerTrigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 30px;
  padding: 5px 8px;
  border: 1px solid var(--td-component-border, #dcdcdc);
  border-radius: 6px;
  background: var(--td-bg-color-container, #fff);
  cursor: pointer;
  list-style: none;
  font-size: 13px;
}
.qvSessionPickerTrigger::-webkit-details-marker {
  display: none;
}
.qvSessionPickerTrigger:hover,
.qvSessionPicker[open] .qvSessionPickerTrigger {
  border-color: var(--td-brand-color, #0052d9);
}
.qvSessionCurrentTitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.qvSessionChevron {
  flex: 0 0 auto;
  color: var(--td-text-color-secondary, #666);
  font-size: 14px;
  line-height: 1;
  transform: translateY(-2px);
}
.qvSessionMenu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  right: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  padding: 4px;
  overflow-y: auto;
  border: 1px solid var(--td-component-border, #dcdcdc);
  border-radius: 6px;
  background: var(--td-bg-color-container, #fff);
  box-shadow: var(--td-shadow-2, 0 4px 12px rgb(0 0 0 / 12%));
}
.qvSessionOption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-height: 30px;
  padding: 5px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}
.qvSessionOption:hover,
.qvSessionOption:focus-visible {
  outline: none;
  background: var(--td-bg-color-container-hover, #f3f3f3);
}
.qvSessionOption.active {
  background: var(--td-brand-color-light, #e7f0ff);
  color: var(--td-brand-color, #0052d9);
  font-weight: 600;
}
.qvSessionOptionTitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.qvSessionItemActions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.qvSessionIconBtn {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 4px;
  line-height: 1;
}
.qvSessionIconBtn:hover {
  background: var(--td-bg-color-component, #e7e7e7);
}
.qvSessionRenameInput {
  flex: 1;
  font-size: 13px;
  border: 1px solid var(--td-brand-color, #0052d9);
  border-radius: 4px;
  padding: 2px 4px;
}
.qvSessionBtn {
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid transparent;
}
.qvSessionBtn.primary {
  background: var(--td-brand-color, #0052d9);
  color: #fff;
}
.qvSessionBtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
