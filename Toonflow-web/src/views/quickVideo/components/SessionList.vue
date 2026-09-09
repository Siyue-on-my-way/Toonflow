<template>
  <div class="qvSessionList" data-testid="qv-session-list">
    <div class="qvSessionListHeader">
      <span class="qvSessionListTitle">{{ title }}</span>
      <button class="qvSessionBtn primary" type="button" data-testid="qv-session-create" :disabled="loading" @click="$emit('create')">
        {{ createText }}
      </button>
    </div>

    <div v-if="!sessions.length" class="qvSessionListEmpty" data-testid="qv-session-empty">{{ emptyText }}</div>

    <ul v-else class="qvSessionItems">
      <li
        v-for="session in sessions"
        :key="session.id"
        class="qvSessionItem"
        :class="{ active: session.id === currentSessionId, archived: session.status === 'archived' }"
        data-testid="qv-session-item"
        :data-session-id="session.id"
        :data-active="session.id === currentSessionId"
        @click="$emit('select', session.id)">
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
          <span class="qvSessionItemTitle" data-testid="qv-session-title">{{ session.title || defaultTitleText }}</span>
          <span v-if="session.status === 'archived'" class="qvSessionArchivedTag">{{ archivedText }}</span>
        </template>

        <div class="qvSessionItemActions">
          <button class="qvSessionIconBtn" type="button" data-testid="qv-session-rename" :title="renameText" @click.stop="startRename(session)">
            ✎
          </button>
          <button class="qvSessionIconBtn" type="button" data-testid="qv-session-archive" :title="session.status === 'archived' ? unarchiveText : archiveText" @click.stop="$emit('toggleArchive', session.id)">
            {{ session.status === "archived" ? "↺" : "🗄" }}
          </button>
        </div>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref } from "vue";
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

const renamingId = ref<number | null>(null);
const renameDraft = ref("");
const renameInputRef = ref<HTMLInputElement | HTMLInputElement[] | null>(null);

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
.qvSessionItems {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 160px;
  overflow-y: auto;
}
.qvSessionItem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.qvSessionItem:hover {
  background: var(--td-bg-color-container-hover, #f3f3f3);
}
.qvSessionItem.active {
  background: var(--td-brand-color-light, #e7f0ff);
  color: var(--td-brand-color, #0052d9);
  font-weight: 600;
}
.qvSessionItem.archived {
  opacity: 0.6;
}
.qvSessionItemTitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.qvSessionArchivedTag {
  font-size: 11px;
  color: var(--td-text-color-secondary, #666);
  border: 1px solid var(--td-component-border, #dcdcdc);
  border-radius: 4px;
  padding: 0 4px;
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
