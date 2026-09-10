<template>
  <div class="project">
    <div class="header">
      <div class="fc">
        <span class="title">{{ $t("workbench.project.title") }}</span>
        <span class="sub">{{ $t("workbench.project.subtitle") }}</span>
      </div>
      <t-button class="addBtn" @click="openCreateProject">
        <template #icon><i-plus class="addIcon" :size="20" /></template>
        {{ $t("workbench.project.newProject") }}
      </t-button>
    </div>
    <div class="list">
      <t-card hoverShadow class="card" v-for="project in allProject" :key="project.id" @click="openProject(project.id)">
        <div class="jb ac">
          <div class="title">
            {{ project.name }}
          </div>
          <div>
            <t-tag shape="round">
              {{
                project.projectType == "novel"
                  ? $t(`workbench.project.type.novel`)
                  : project.projectType == "quick_video"
                    ? $t(`workbench.project.type.quickVideo`)
                    : $t(`workbench.project.type.script`)
              }}
            </t-tag>
          </div>
        </div>
        <t-tag shape="round" v-if="project.artStyle" style="align-self: flex-start">{{ project.artStyle }}</t-tag>
        <div class="intro">
          {{ project.intro }}
        </div>
        <div class="bottomMenu f ac jb">
          <div class="time">
            <span>{{ dayjs(project?.createTime).format("YYYY-MM-DD HH:mm:ss") }}</span>
          </div>
          <div class="actionBtns f ac">
            <div class="editBtn" @click.stop="openEdit(project)">
              <i-edit :size="18" />
            </div>
            <div class="removeBtn" @click.stop="delProjcer(project.id)">
              <i-delete :size="18" />
            </div>
          </div>
        </div>
      </t-card>
    </div>
  </div>
  <projectModeDialog v-model="modeDialogShow" @select="selectCreateMode" />
  <projectDialog
    v-model="dialogShow"
    :projectData="editProjectData"
    :createMode="createMode"
    :submitLoading="quickCreateLoading"
    @add="addProjectFn"
    @edit="editProjectFn" />
</template>

<script setup lang="ts">
import projectDialog from "./components/projectDialog.vue";
import projectModeDialog from "./components/projectModeDialog.vue";
import dayjs from "dayjs";
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import imageListCacheStore from "@/stores/imageListCache";

const { clearProjectCache } = imageListCacheStore();
const { allProject, project } = storeToRefs(projectStore());

const dialogShow = ref(false);
const modeDialogShow = ref(false);
const createMode = ref<"professional" | "quick">("professional");
const quickCreateLoading = ref(false);
const quickCreateIdempotencyKey = ref<string | null>(null);
const editProjectData = ref<{
  id: string;
  name: string;
  intro: string;
  type: string;
  artStyle: string | null;
  videoRatio: string | null;
  imageModel: string;
  videoModel: string;
  textModel: string;
  projectType: string;
  imageQuality: "1K" | "2K" | "4K" | "";
  mode: string;
  directorManual: string;
  targetDuration?: 15 | 30 | 60;
  quickVideoStoryboardConfirmed?: boolean;
  quickVideoConfigLocked?: boolean;
} | null>(null);

async function getAllProject() {
  const response: any = await axios.post("/project/getProject");
  const payload = response?.data ?? response;
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  allProject.value = list;
  return list;
}

onMounted(() => {
  project.value = null;
  getAllProject();
});

const router = useRouter();

function openCreateProject() {
  editProjectData.value = null;
  quickCreateLoading.value = false;
  quickCreateIdempotencyKey.value = null;
  modeDialogShow.value = true;
}

function selectCreateMode(mode: "professional" | "quick") {
  createMode.value = mode;
  editProjectData.value = null;
  quickCreateLoading.value = false;
  quickCreateIdempotencyKey.value = null;
  // 先让模式选择弹窗完成关闭，再打开对应表单，避免两个 Dialog 同时抢占焦点。
  nextTick(() => {
    dialogShow.value = true;
  });
}

async function openProject(projectId: string | undefined) {
  const item = allProject.value.find((p) => p.id === projectId);

  if (!item) return window.$message.error($t("workbench.project.msg.notFound"));

  // 单视频快创：无需预先配置图片/视频模型，直接进入一页式工作台
  if (item.projectType === "quick_video") {
    project.value = item;
    return router.push(`/quickVideo`);
  }

  if (!item.imageModel || !item.videoModel) {
    window.$message.warning($t("workbench.project.msg.modelProviderDisabled"));
    return openEdit(item);
  }

  try {
    if (item.imageModel) {
      await axios.post("/modelSelect/getModelDetail", {
        modelId: item.imageModel,
      });
    }
    if (item.videoModel) {
      await axios.post("/modelSelect/getModelDetail", {
        modelId: item.videoModel,
      });
    }
  } catch {
    window.$message.warning($t("workbench.project.msg.modelProviderDisabled"));
    return openEdit(item);
  }

  project.value = item;
  if (item.projectType === "novel") router.push(`/novel`);
  else if (item.projectType === "script") router.push(`/script`);
}

async function openEdit(item: {
  id: string;
  name: string;
  intro: string;
  type: string;
  artStyle: string | null;
  directorManual: string;
  videoRatio: string | null;
  imageModel: string;
  videoModel: string;
  textModel: string;
  imageQuality: "1K" | "2K" | "4K" | "";
  projectType: string;
  mode: string;
}) {
  let targetDuration: 15 | 30 | 60 | undefined;
  let quickVideoStoryboardConfirmed = false;
  let quickVideoConfigLocked = false;
  if (item.projectType === "quick_video") {
    try {
      const response: any = await axios.post("/quickVideo/getWorkbench", { projectId: Number(item.id) });
      const payload = response?.data ?? response;
      const workbench = payload?.data ?? payload;
      if (workbench?.state) {
        targetDuration = workbench.state.targetDuration;
        quickVideoStoryboardConfirmed = workbench.state.storyboard?.status === "confirmed";
        quickVideoConfigLocked = ["generating", "ready_to_assemble", "completed"].includes(workbench.state.stage);
      } else {
        window.$message.error($t("workbench.project.msg.quickConfigLoadFailed"));
        return;
      }
    } catch {
      window.$message.error($t("workbench.project.msg.quickConfigLoadFailed"));
      return;
    }
  }
  createMode.value = item.projectType === "quick_video" ? "quick" : "professional";
  quickCreateLoading.value = false;
  editProjectData.value = {
    ...item,
    targetDuration,
    quickVideoStoryboardConfirmed,
    quickVideoConfigLocked,
  };
  dialogShow.value = true;
}

function editProjectFn(data: {
  id: string;
  name: string;
  intro: string;
  type: string;
  artStyle: string;
  directorManual: string;
  videoRatio: string;
  imageModel: string;
  videoModel: string;
  textModel: string;
  imageQuality: "1K" | "2K" | "4K" | "";
  mode: string;
  projectType?: string;
  targetDuration?: 15 | 30 | 60;
}) {
  if (data.projectType === "quick_video") {
    axios
      .post("/quickVideo/getWorkbench", { projectId: Number(data.id) })
      .then(async (workbenchResponse: any) => {
        const payload = workbenchResponse?.data ?? workbenchResponse;
        const workbench = payload?.data ?? payload;
        if ((payload?.code && payload.code !== 200) || !workbench?.state) throw new Error("未找到 quickVideoAgent 状态");
        const response: any = await axios.post("/quickVideo/updateConfig", {
          projectId: Number(data.id),
          expectedVersion: workbench.state.version,
          idempotencyKey: `project-config-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          patch: {
            name: data.name,
            artStyle: data.artStyle,
            videoRatio: data.videoRatio,
            targetDuration: data.targetDuration ?? workbench.state.targetDuration,
            intro: data.intro,
          },
        });
        if (response?.code !== 200) throw new Error(response?.message ?? $t("workbench.project.msg.editFailed"));
        window.$message.success($t("workbench.project.msg.editSuccess"));
        await getAllProject();
      })
      .catch((e: any) => {
        window.$message.error(e?.message ?? $t("workbench.project.msg.editFailed"));
      });
    return;
  }
  axios
    .post("/project/editProject", data)
    .then(() => {
      window.$message.success($t("workbench.project.msg.editSuccess"));
      getAllProject();
    })
    .catch((e) => {
      window.$message.error(e.message ?? $t("workbench.project.msg.editFailed"));
    });
}

function makeIdempotencyKey() {
  const runtimeCrypto = globalThis.crypto;
  if (typeof runtimeCrypto?.randomUUID === "function") return runtimeCrypto.randomUUID();
  // crypto.randomUUID 仅在安全上下文可用；普通 HTTP/IP 访问也必须能创建项目。
  return `qv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

async function addProjectFn(data: {
  projectType: string;
  name: string;
  intro: string;
  type: string;
  artStyle: string;
  directorManual: string;
  videoRatio: string;
  imageModel: string;
  videoModel: string;
  textModel: string;
  imageQuality: string;
  mode: string;
  targetDuration?: 15 | 30 | 60;
}) {
  // 单视频快创走专用入口（含幂等键），不影响专业模式创建链路
  if (data.projectType === "quick_video") {
    if (quickCreateLoading.value) return;
    quickCreateLoading.value = true;
    try {
      quickCreateIdempotencyKey.value ??= makeIdempotencyKey();
      const response: any = await axios.post("/quickVideo/createProject", {
        name: data.name,
        artStyle: data.artStyle,
        videoRatio: data.videoRatio,
        targetDuration: data.targetDuration ?? 15,
        intro: data.intro,
        draftScript: data.intro,
        idempotencyKey: quickCreateIdempotencyKey.value,
      });

      // axios 拦截器返回 response.data；兼容旧调用方式下仍包了一层 data 的响应。
      const body = response?.data ?? response;
      if (body?.code && body.code !== 200) throw new Error(body.message ?? $t("workbench.project.msg.addFailed"));
      const res = body?.code === 200 && body.data !== undefined ? body.data : body;

      let created = res?.project;
      if (!created) {
        await getAllProject();
        created = allProject.value.find((item) => String(item.id) === String(res?.projectId));
      } else {
        // 工作台直接使用接口返回的完整项目；列表刷新失败不应阻止进入工作台。
        getAllProject().catch(() => undefined);
      }

      if (!created) throw new Error($t("workbench.project.msg.createdProjectNotFound"));

      project.value = created;
      dialogShow.value = false;
      quickCreateIdempotencyKey.value = null;
      window.$message.success($t("workbench.project.msg.addSuccess"));
      await router.push(`/quickVideo`);
    } catch (e: any) {
      // 保留弹窗和用户已填写的内容，错误信息明确反馈给用户，支持原表单重试。
      window.$message.error(e?.message ?? $t("workbench.project.msg.addFailed"));
    } finally {
      quickCreateLoading.value = false;
    }
    return;
  }
  axios
    .post("/project/addProject", data)
    .then(() => {
      window.$message.success($t("workbench.project.msg.addSuccess"));
      getAllProject();
    })
    .catch((e) => {
      window.$message.error(e.message ?? $t("workbench.project.msg.addFailed"));
    });
}

function delProjcer(projectId: string | undefined) {
  const dialog = DialogPlugin.confirm({
    header: $t("workbench.project.msg.deleteHeader"),
    body: $t("workbench.project.msg.deleteBody"),
    confirmBtn: $t("workbench.project.msg.deleteConfirm"),
    cancelBtn: $t("workbench.project.msg.deleteCancel"),
    onConfirm: () => {
      axios
        .post("/project/delProject", { id: projectId })
        .then(() => {
          clearProjectCache(projectId!);
          window.$message.success($t("workbench.project.msg.deleteSuccess"));
          getAllProject();
        })
        .catch((e) => {
          window.$message.error(e.message ?? $t("workbench.project.msg.deleteFailed"));
        })
        .finally(() => {
          dialog.destroy();
        });
    },
  });
}
</script>

<style lang="scss" scoped>
.project {
  .header {
    padding-top: 32px;
    margin-bottom: 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    .title {
      font-size: 32px;
      font-weight: 600;
      color: var(--td-text-color-primary);
    }
    .sub {
      opacity: 0.5;
      color: var(--td-text-color-secondary);
    }
  }
  .list {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    .card {
      width: 100%;
      height: 100%;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      .title {
        font-size: 20px;
        font-weight: bold;
        margin-bottom: 8px;
      }
      .intro {
        height: 100%;
        margin-top: 5px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .bottomMenu {
        margin-top: 32px;
        .time {
          opacity: 0.5;
        }
        .actionBtns {
          gap: 12px;
        }
        .editBtn {
          cursor: pointer;
          &:hover {
            color: var(--td-brand-color);
          }
        }
        .removeBtn {
          cursor: pointer;
          &:hover {
            color: red;
          }
        }
      }
    }
  }
}
:deep(.t-col) {
  height: auto !important;
}
:deep(.t-card__body) {
  display: flex;
  flex-direction: column;
  flex: 1;
}
</style>
