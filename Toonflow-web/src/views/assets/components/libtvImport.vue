<template>
  <div class="libtvImport">
    <!-- 未绑定：引导绑定 -->
    <div class="bindGuide" v-if="bindChecked && !bound">
      <t-empty type="empty">
        <template #title>{{ $t("workbench.assets.libtvImport.needBindTitle") }}</template>
        <template #description>{{ $t("workbench.assets.libtvImport.needBindDesc") }}</template>
      </t-empty>
      <div class="bindActions">
        <t-button theme="primary" @click="onBindClick">{{ $t("common.bindLibtvAccount") }}</t-button>
        <t-button theme="default" variant="outline" :loading="checkingBind" @click="checkBind">{{ $t("common.refresh") }}</t-button>
      </div>
    </div>

    <t-loading :loading="loadingProjects || loadingNodes" show-overlay v-else>
      <div class="toolbar">
        <div class="left">
          <t-select
            v-model="selectedProjectId"
            :placeholder="$t('workbench.assets.libtvImport.selectProjectPh')"
            :loading="loadingProjects"
            style="width: 280px"
            @change="loadNodes">
            <t-option v-for="p in projects" :key="p.id" :value="p.id" :label="projectLabel(p)" />
          </t-select>
          <t-button theme="default" variant="outline" :loading="loadingProjects" @click="loadProjects">
            <template #icon><t-icon name="refresh" /></template>
          </t-button>
        </div>
        <div class="right">
          <t-radio-group v-model="typeFilter" variant="default-filled" size="small">
            <t-radio-button value="all">{{ $t("workbench.assets.libtvImport.filterAll") }}</t-radio-button>
            <t-radio-button value="image">{{ $t("workbench.assets.libtvImport.filterImage") }}</t-radio-button>
            <t-radio-button value="video">{{ $t("workbench.assets.libtvImport.filterVideo") }}</t-radio-button>
            <t-radio-button value="audio">{{ $t("workbench.assets.libtvImport.filterAudio") }}</t-radio-button>
          </t-radio-group>
          <t-button theme="primary" :disabled="selectedKeys.size === 0 || importing" :loading="importing" @click="onImport">
            {{ $t("workbench.assets.libtvImport.importSelected") }}<span v-if="selectedKeys.size">({{ selectedKeys.size }})</span>
          </t-button>
        </div>
      </div>

      <t-alert v-if="importSummary" :theme="importSummary.failed.length ? 'warning' : 'success'" style="margin-bottom: 10px" @close="importSummary = null">
        <template #message>{{ importSummaryText }}</template>
      </t-alert>

      <div class="nodeGrid" v-if="filteredNodes.length">
        <div
          v-for="node in filteredNodes"
          :key="node.key"
          class="nodeCard"
          :class="{ selected: selectedKeys.has(node.key), imported: node.imported }"
          @click="toggleSelect(node)">
          <div class="thumb">
            <img v-if="node.type === 'image'" :src="node.url" fit="cover" loading="lazy" />
            <video v-else-if="node.type === 'video'" :src="node.url" preload="metadata" muted />
            <div v-else-if="node.type === 'audio'" class="audioIcon ac"><t-icon name="music" size="32px" /></div>
            <div v-else class="audioIcon ac"><t-icon name="file-unknown" size="32px" /></div>
            <div class="checkMark ac" v-if="selectedKeys.has(node.key)"><t-icon name="check" size="14px" /></div>
            <t-tag class="typeTag" size="small" theme="default">{{ typeLabel(node.type) }}</t-tag>
            <t-tag class="importedTag" size="small" theme="success" v-if="node.imported">{{ $t("workbench.assets.libtvImport.importedTag") }}</t-tag>
          </div>
          <div class="meta">
            <t-tooltip :content="node.prompt || node.name" theme="light">
              <div class="name">{{ node.name }}</div>
            </t-tooltip>
            <div class="time" v-if="node.createTime">{{ formatTime(node.createTime) }}</div>
          </div>
        </div>
      </div>
      <t-empty v-else-if="!loadingNodes && selectedProjectId" :title="$t('workbench.assets.libtvImport.noNodes')" />
      <t-empty v-else-if="!loadingNodes && !selectedProjectId" :title="$t('workbench.assets.libtvImport.chooseProject')" />
    </t-loading>
  </div>
</template>

<script setup lang="ts">
import { MessagePlugin } from "tdesign-vue-next";
import dayjs from "dayjs";
import axios from "@/utils/axios";
import openLibtvBindDialog from "@/utils/libtvBindDialog";
import projectStore from "@/stores/project";

const { project } = storeToRefs(projectStore());

const props = defineProps<{
  /** 快创会话 id：提供时把图/视频产物同步登记进快创资产白板（素材中心场景不传） */
  sessionId?: number;
}>();

const emit = defineEmits<{
  /** 有节点成功导入，父级切回素材标签并刷新列表 */
  imported: [];
}>();

interface LibtvProject {
  id: string;
  name: string;
  updateTime?: string;
}
interface LibtvNode {
  key: string;
  name: string;
  type: "image" | "video" | "audio" | "other";
  prompt: string;
  url: string;
  createTime?: string;
  imported?: boolean;
}

const bound = ref(false);
const bindChecked = ref(false);
const checkingBind = ref(false);
const projects = ref<LibtvProject[]>([]);
const selectedProjectId = ref("");
const nodes = ref<LibtvNode[]>([]);
const selectedKeys = ref<Set<string>>(new Set());
const typeFilter = ref<"all" | "image" | "video" | "audio">("all");
const loadingProjects = ref(false);
const loadingNodes = ref(false);
const importing = ref(false);
const importSummary = ref<{ importedCount: number; skippedCount: number; failed: { key: string; reason: string }[] } | null>(null);

const filteredNodes = computed(() => (typeFilter.value === "all" ? nodes.value : nodes.value.filter((n) => n.type === typeFilter.value)));

const importSummaryText = computed(() => {
  const s = importSummary.value;
  if (!s) return "";
  const parts = [window.$t("workbench.assets.libtvImport.importedCount", { count: s.importedCount })];
  if (s.skippedCount) parts.push(window.$t("workbench.assets.libtvImport.skippedCount", { count: s.skippedCount }));
  if (s.failed.length) parts.push(window.$t("workbench.assets.libtvImport.failedCount", { count: s.failed.length }));
  return parts.join(window.$t("workbench.assets.libtvImport.summaryJoin"));
});

function projectLabel(p: LibtvProject) {
  return p.updateTime ? `${p.name}（${formatTime(p.updateTime)}）` : p.name;
}
function formatTime(t?: string) {
  const d = dayjs(t);
  return d.isValid() ? d.format("YYYY-MM-DD HH:mm") : String(t ?? "");
}
function typeLabel(t: string) {
  const map: Record<string, string> = {
    image: window.$t("workbench.assets.libtvImport.filterImage"),
    video: window.$t("workbench.assets.libtvImport.filterVideo"),
    audio: window.$t("workbench.assets.libtvImport.filterAudio"),
    other: window.$t("workbench.assets.libtvImport.filterAll"),
  };
  return map[t] ?? t;
}

async function checkBind() {
  checkingBind.value = true;
  try {
    const res: any = await axios.post("/setting/vendorConfig/libtv/bindingStatus");
    if (res.code === 200) {
      bound.value = !!res.data?.bound;
      bindChecked.value = true;
      if (bound.value && !projects.value.length) loadProjects();
    }
  } catch (e) {
    console.error(e);
  } finally {
    checkingBind.value = false;
  }
}

async function onBindClick() {
  const ok = await openLibtvBindDialog();
  if (ok) {
    bound.value = true;
    loadProjects();
  }
}

async function loadProjects() {
  loadingProjects.value = true;
  try {
    const res: any = await axios.post("/setting/vendorConfig/libtv/projects");
    if (res.code === 200) {
      projects.value = res.data ?? [];
      if (!selectedProjectId.value && projects.value.length) {
        selectedProjectId.value = projects.value[0].id;
        loadNodes();
      }
    } else {
      MessagePlugin.error(res.message || window.$t("workbench.assets.libtvImport.loadProjectsFailed"));
    }
  } catch (err: any) {
    MessagePlugin.error(err.message || window.$t("workbench.assets.libtvImport.loadProjectsFailed"));
  } finally {
    loadingProjects.value = false;
  }
}

async function loadNodes() {
  if (!selectedProjectId.value) return;
  loadingNodes.value = true;
  selectedKeys.value = new Set();
  importSummary.value = null;
  try {
    const res: any = await axios.post("/setting/vendorConfig/libtv/projectNodes", {
      projectId: selectedProjectId.value,
      toonflowProjectId: project.value?.id,
    });
    if (res.code === 200) nodes.value = res.data ?? [];
    else MessagePlugin.error(res.message || window.$t("workbench.assets.libtvImport.loadNodesFailed"));
  } catch (err: any) {
    MessagePlugin.error(err.message || window.$t("workbench.assets.libtvImport.loadNodesFailed"));
  } finally {
    loadingNodes.value = false;
  }
}

function toggleSelect(node: LibtvNode) {
  // 已导入过的节点默认不允许再次勾选（一次性收编）；如需重导可在其它项目里导
  if (node.imported) return;
  const next = new Set(selectedKeys.value);
  if (next.has(node.key)) next.delete(node.key);
  else next.add(node.key);
  selectedKeys.value = next;
}

async function onImport() {
  if (!project.value?.id) return MessagePlugin.warning(window.$t("workbench.assets.libtvImport.needProject"));
  importing.value = true;
  try {
    const res: any = await axios.post("/setting/vendorConfig/libtv/importAssets", {
      projectId: selectedProjectId.value,
      toonflowProjectId: project.value?.id,
      nodeKeys: Array.from(selectedKeys.value),
      ...(props.sessionId ? { sessionId: props.sessionId } : {}),
    });
    if (res.code === 200) {
      importSummary.value = res.data;
      selectedKeys.value = new Set();
      if (res.data?.importedCount > 0) {
        MessagePlugin.success(window.$t("workbench.assets.libtvImport.importOk"));
        emit("imported");
      }
      loadNodes(); // 刷新已导入标记
    } else {
      MessagePlugin.error(res.message || window.$t("workbench.assets.libtvImport.importFailed"));
    }
  } catch (err: any) {
    MessagePlugin.error(err.message || window.$t("workbench.assets.libtvImport.importFailed"));
  } finally {
    importing.value = false;
  }
}

onMounted(checkBind);
</script>

<style lang="scss" scoped>
.libtvImport {
  min-height: 320px;

  .bindGuide {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    padding: 48px 0;

    .bindActions {
      display: flex;
      gap: 12px;
    }
  }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
    flex-wrap: wrap;

    .left,
    .right {
      display: flex;
      align-items: center;
      gap: 8px;
    }
  }

  .nodeGrid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 12px;

    .nodeCard {
      border: 1px solid var(--td-component-border);
      border-radius: 8px;
      overflow: hidden;
      cursor: pointer;
      position: relative;
      transition: border-color 0.2s;

      &:hover {
        border-color: var(--td-brand-color);
      }
      &.selected {
        border-color: var(--td-brand-color);
        box-shadow: 0 0 0 1px var(--td-brand-color);
      }
      &.imported {
        opacity: 0.55;
        cursor: default;
      }

      .thumb {
        position: relative;
        height: 110px;
        background: var(--td-bg-color-component);
        display: flex;
        align-items: center;
        justify-content: center;

        img,
        video {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .checkMark {
          position: absolute;
          top: 6px;
          right: 6px;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          background: var(--td-brand-color);
          color: #fff;
        }

        .typeTag {
          position: absolute;
          left: 6px;
          bottom: 6px;
        }

        .importedTag {
          position: absolute;
          right: 6px;
          bottom: 6px;
        }
      }

      .meta {
        padding: 6px 8px;

        .name {
          font-size: 12px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .time {
          font-size: 11px;
          color: var(--td-text-color-secondary);
          margin-top: 2px;
        }
      }
    }
  }
}
</style>
