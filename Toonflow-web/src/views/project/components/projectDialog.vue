<template>
  <div class="addProject">
    <t-dialog
      placement="center"
      v-model:visible="addProjectShow"
      :header="isEdit ? $t('workbench.project.dialog.editTitle') : $t('workbench.project.dialog.addTitle')"
      width="60%"
      @confirm="handleOk"
      @close-btn-click="handleCancel"
      @cancel="handleCancel"
      :confirm-loading="submitLoading"
      :confirm-btn="isEdit ? $t('workbench.project.dialog.save') : $t('workbench.project.dialog.ok')"
      :cancel-btn="$t('workbench.project.dialog.cancel')">
      <div class="formColumns">
        <div class="formLeft">
          <t-form :data="formState" label-align="top">
            <t-form-item v-if="!isQuickForm" :label="$t('workbench.project.dialog.projectType')">
              <t-select v-model="formState.projectType" :placeholder="$t('workbench.project.dialog.selectType')">
                <t-option key="基于小说原文" :label="$t('workbench.project.dialog.basedOnNovel')" value="novel" />
                <t-option key="基于剧本" :label="$t('workbench.project.dialog.basedOnScript')" value="script" />
              </t-select>
            </t-form-item>
            <t-form-item :label="$t('workbench.project.dialog.projectName')">
              <t-input v-model="formState.name" :placeholder="$t('workbench.project.dialog.projectNamePh')" />
            </t-form-item>
            <template v-if="formState.projectType === 'quick_video'">
              <t-form-item :label="$t('workbench.project.dialog.quickArtStyle')">
                <t-input v-model="formState.artStyle" :placeholder="$t('workbench.project.dialog.quickArtStylePh')" />
              </t-form-item>
              <t-form-item :label="$t('workbench.project.dialog.targetDuration')">
                <t-select v-model="formState.targetDuration">
                  <t-option :value="15" label="15s" />
                  <t-option :value="30" label="30s" />
                  <t-option :value="60" label="60s" />
                </t-select>
              </t-form-item>
              <t-form-item :label="$t('workbench.project.dialog.videoRatio')">
                <t-select v-model="formState.videoRatio" :options="QUICK_RATIO_OPTIONS" />
              </t-form-item>
              <t-form-item :label="$t('workbench.project.dialog.novelIntro')">
                <t-textarea
                  v-model="formState.intro"
                  :autosize="{ minRows: 3, maxRows: 6 }"
                  :placeholder="$t('workbench.project.dialog.quickIntroPh')" />
              </t-form-item>
            </template>
            <template v-else>
              <t-form-item :label="$t('workbench.project.dialog.novelType')">
                <t-input v-model="formState.type" :placeholder="$t('workbench.project.dialog.novelTypePh')" />
              </t-form-item>
              <t-form-item :label="$t('workbench.project.dialog.textModelData')">
                <modelSelect v-model="formState.textModel" type="text" />
              </t-form-item>
              <t-form-item :label="$t('workbench.project.dialog.modelData')">
                <div class="ac" style="gap: 5px; width: 100%">
                  <modelSelect v-model="formState.imageModel" type="image" />
                  <t-select v-model="formState.imageQuality" class="paramSelect ml-5" :placeholder="$t('workbench.production.editImage.quality')">
                    <t-option value="1K" label="1K" />
                    <t-option value="2K" label="2K" />
                    <t-option value="4K" label="4K" />
                  </t-select>
                </div>
              </t-form-item>
              <t-form-item :label="$t('workbench.project.dialog.videoModelData')">
                <div class="ac" style="gap: 5px; width: 100%">
                  <modelSelect v-model="formState.videoModel" type="video" @change="changeFn" :changeConfig="true" />
                  <t-select v-model="formState.mode" class="paramSelect ml-5" :placeholder="$t('workbench.production.editImage.mode')">
                    <t-option v-for="value in mode" :key="value.value" :value="value.value" :label="value.label" />
                  </t-select>
                </div>
              </t-form-item>
              <t-form-item :label="$t('workbench.project.dialog.videoRatio')">
                <t-select v-model="formState.videoRatio" :options="videoRatioOptions" />
              </t-form-item>
              <t-form-item :label="$t('workbench.project.dialog.novelIntro')">
                <t-textarea
                  v-model="formState.intro"
                  :autosize="{ minRows: 3, maxRows: 6 }"
                  :placeholder="$t('workbench.project.dialog.novelIntroPh')" />
              </t-form-item>
            </template>
          </t-form>
        </div>
        <div class="formRight" v-if="formState.projectType !== 'quick_video'">
          <t-form label-align="top">
            <t-form-item>
              <div class="artStylePicker">
                <div class="artStyleHeader">
                  <span>{{ $t("workbench.project.dialog.visualManual") }}</span>
                  <t-button size="small" variant="outline" @click="openVisualManualDialog()">
                    <template #icon><i-plus size="14" /></template>
                    {{ $t("workbench.project.dialog.newVisualManual") }}
                  </t-button>
                </div>
                <div class="artStyleContent">
                  <t-loading :loading="visualManualLoading" :text="$t('workbench.project.dialog.loading')">
                    <div class="gridContainer">
                      <div
                        v-for="(item, index) in visualManualOptions"
                        :key="item.stylePath || index"
                        class="gridItem"
                        :class="{ active: !!item.stylePath && formState.artStyle === item.stylePath }"
                        @click="selectVisualManual(item)">
                        <div class="imageWrapper">
                          <img :src="item.images && item.images[0]" :alt="item.name" class="artImage" loading="lazy" />
                          <div class="text">{{ item.name }}</div>
                        </div>
                        <t-button class="editBtn" shape="square" @click.stop="openVisualManualDialog(item)">
                          <i-edit theme="outline" size="14" />
                        </t-button>
                        <t-button class="delBtn" shape="square" @click.stop="deleteVisualManual(item)">
                          <i-delete theme="outline" size="14" />
                        </t-button>
                        <t-button class="preview" shape="square" @click.stop="handlePreview(item.images && item.images[0])">
                          <i-preview-open theme="outline" size="14" />
                        </t-button>
                      </div>
                    </div>
                  </t-loading>
                </div>
              </div>
            </t-form-item>
            <t-form-item>
              <div class="directorManual">
                <div class="directorManualHeader">
                  <span>{{ $t("workbench.project.dialog.directorManual") }}</span>
                  <t-button size="small" variant="outline" @click="openDirectorManualDialog()">
                    <template #icon><i-plus size="14" /></template>
                    {{ $t("workbench.project.dialog.addDirectorManual") }}
                  </t-button>
                </div>
                <div class="artStyleContent">
                  <t-loading :loading="directorManualLoading" :text="$t('workbench.project.dialog.loading')">
                    <div class="gridContainer">
                      <div
                        v-for="(item, index) in directorManualOptions"
                        :key="item.directorManual || index"
                        class="gridItem"
                        :class="{ active: !!item.directorManual && formState.directorManual === item.directorManual }"
                        @click="selectDirectorManual(item)">
                        <div class="imageWrapper">
                          <img :src="item.images && item.images[0]" :alt="item.name" class="artImage" loading="lazy" />
                          <div class="text">{{ item.name }}</div>
                        </div>
                        <t-button class="editBtn" shape="square" @click.stop="openDirectorManualDialog(item)">
                          <i-edit theme="outline" size="14" />
                        </t-button>
                        <t-button class="delBtn" shape="square" @click.stop="deleteDirectorManual(item)">
                          <i-delete theme="outline" size="14" />
                        </t-button>
                        <t-button class="preview" shape="square" @click.stop="handlePreview(item.images && item.images[0])">
                          <i-preview-open theme="outline" size="14" />
                        </t-button>
                      </div>
                    </div>
                  </t-loading>
                </div>
              </div>
            </t-form-item>
          </t-form>
        </div>
      </div>
    </t-dialog>
    <!-- 新建/编辑视觉手册弹窗 -->
    <t-dialog
      class="artStyleDialog"
      v-model:visible="visualManualDialogVisible"
      :header="editingVisualManual ? $t('workbench.project.dialog.editVisualManualTitle') : $t('workbench.project.dialog.newVisualManualTitle')"
      width="90vw"
      placement="center"
      @confirm="handleVisualManualSubmit"
      @close-btn-click="resetDirectorManualDialog"
      @cancel="resetDirectorManualDialog"
      :confirm-btn="$t('workbench.project.dialog.ok')"
      :cancel-btn="$t('workbench.project.dialog.cancel')">
      <t-loading :loading="loading">
        <t-form label-align="top">
          <t-form-item>
            <div class="nameAndCoverRow">
              <div class="nameField">
                <label class="fieldLabel">{{ $t("workbench.project.dialog.visualManualName") }}</label>
                <t-input v-model="visualManualForm.name" :placeholder="$t('workbench.project.dialog.visualManualNamePh')" />
              </div>
              <div class="mdFileLocation">
                <label class="fieldLabel">{{ $t("workbench.project.dialog.mdFile") }}</label>
                <t-input v-model="visualManualForm.stylePath" :disabled="!!editingVisualManual" />
              </div>
              <div class="coverField">
                <label class="fieldLabel">{{ $t("workbench.project.dialog.visualManualCover") }}</label>
                <div class="coverUploadArea multiCoverUploadArea">
                  <div v-for="(img, idx) in visualManualForm.images" :key="idx" class="coverPreview">
                    <img :src="img" class="coverImg" @click.stop="handlePreview(img && img)" style="cursor: pointer" />
                    <div class="coverImgRemove" @click="removeVisualManualCover(idx)">
                      <i-close size="10" />
                    </div>
                  </div>
                  <div class="coverUploadTrigger" @click="triggerVisualManualCoverUpload">
                    <input
                      ref="visualManualCoverInputRef"
                      type="file"
                      accept="image/*"
                      multiple
                      style="display: none"
                      @change="handleVisualManualCoverFileChange" />
                    <i-plus size="24" />
                    <span>{{ $t("workbench.project.dialog.uploadCover") }}</span>
                  </div>
                </div>
              </div>
            </div>
          </t-form-item>
          <t-form-item :label="$t('workbench.project.dialog.visualManualPrompt')">
            <div class="promptEditorWrapper">
              <div class="promptEditorHeader">
                <div class="aiExtractInline">
                  <t-tabs :value="visualManualTabValue" size="medium" @change="(v) => (visualManualTabValue = v)">
                    <t-tab-panel v-for="tab in visualManualTabData" :key="tab.value" :value="tab.value" :label="tab.label">
                      <MdEditor
                        v-model="tab.data"
                        :theme="themeSetting.mode === 'dark' ? 'dark' : 'light'"
                        :toolbars="promptToolbars"
                        :footers="[]"
                        :placeholder="$t('workbench.project.dialog.promptPlaceholder')"
                        style="height: 30vh; margin-top: 5px"
                        @onUploadImg="() => {}" />
                    </t-tab-panel>
                  </t-tabs>
                </div>
              </div>
            </div>
          </t-form-item>
        </t-form>
      </t-loading>
    </t-dialog>
    <!-- 新建/编辑导演手册弹窗 -->
    <t-dialog
      class="artStyleDialog"
      v-model:visible="directorDialogVisible"
      :header="editingDirectorManual ? $t('workbench.project.dialog.editingDirectorManual') : $t('workbench.project.dialog.newDirecorManualTitle')"
      width="90vw"
      placement="center"
      @confirm="handleDirectorManualSubmit"
      @close-btn-click="resetVisualManualDialog"
      @cancel="resetVisualManualDialog"
      :confirm-btn="$t('workbench.project.dialog.ok')"
      :cancel-btn="$t('workbench.project.dialog.cancel')">
      <t-loading :loading="loading">
        <t-form label-align="top">
          <t-form-item>
            <div class="nameAndCoverRow">
              <div class="nameField">
                <label class="fieldLabel">{{ $t("workbench.project.dialog.directorManualName") }}</label>
                <t-input v-model="directorManualForm.name" :placeholder="$t('workbench.project.dialog.directorManualNamePh')" />
              </div>
              <div class="mdFileLocation">
                <label class="fieldLabel">{{ $t("workbench.project.dialog.directorFile") }}</label>
                <t-input v-model="directorManualForm.directorManual" :disabled="!!editingDirectorManual" />
              </div>
              <div class="coverField">
                <label class="fieldLabel">{{ $t("workbench.project.dialog.directorManualCover") }}</label>
                <div class="coverUploadArea multiCoverUploadArea">
                  <div v-for="(img, idx) in directorManualForm.images" :key="idx" class="coverPreview">
                    <img :src="img" class="coverImg" />
                    <div class="coverImgRemove" @click="removeVisualManualCover(idx)">
                      <i-close size="10" />
                    </div>
                  </div>
                  <div class="coverUploadTrigger" @click="triggerDirectorManualCoverUpload">
                    <input
                      ref="visualManualCoverInputRef"
                      type="file"
                      accept="image/*"
                      multiple
                      style="display: none"
                      @change="handleDirectorManualCoverFileChange" />
                    <i-plus size="24" />
                    <span>{{ $t("workbench.project.dialog.uploadCover") }}</span>
                  </div>
                </div>
              </div>
            </div>
          </t-form-item>
          <t-form-item :label="$t('workbench.project.dialog.directorManualPrompt')">
            <div class="promptEditorWrapper">
              <div class="promptEditorHeader">
                <div class="aiExtractInline">
                  <t-tabs :value="directorManualTabValue" size="medium" @change="(v) => (directorManualTabValue = v)">
                    <t-tab-panel v-for="tab in directorManualTabData" :key="tab.value" :value="tab.value" :label="tab.label">
                      <MdEditor
                        v-model="tab.data"
                        :theme="themeSetting.mode === 'dark' ? 'dark' : 'light'"
                        :toolbars="promptToolbars"
                        :footers="[]"
                        :placeholder="$t('workbench.project.dialog.promptPlaceholder')"
                        style="height: 30vh; margin-top: 5px"
                        @onUploadImg="() => {}" />
                    </t-tab-panel>
                  </t-tabs>
                </div>
              </div>
            </div>
          </t-form-item>
        </t-form>
      </t-loading>
    </t-dialog>
    <t-image-viewer v-model="visible" :images="[trigger]" :closeOnOverlay="true" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from "vue";
import axios from "@/utils/axios";
import { MdEditor } from "md-editor-v3";
import settingStore from "@/stores/setting";
const { themeSetting } = storeToRefs(settingStore());
import type { ToolbarNames } from "md-editor-v3";
import modelSelect from "@/components/modelSelect.vue";
import type { TabValue } from "tdesign-vue-next";
import { DialogPlugin } from "tdesign-vue-next";

const addProjectShow = defineModel<boolean>();
const props = defineProps<{
  projectData?: ProjectData | null;
  /** 新建项目时由上游的二选一入口指定创作模式；编辑项目仍以 projectData 为准。 */
  createMode?: "professional" | "quick";
  /** 快创项目提交期间锁定确认按钮，避免重复创建。 */
  submitLoading?: boolean;
}>();
const emit = defineEmits<{
  (e: "add", data: ProjectFormData): void;
  (
    e: "edit",
    data: {
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
      projectType: string;
      imageQuality: "1K" | "2K" | "4K" | "";
      mode: string;
      targetDuration: 15 | 30 | 60;
    },
  ): void;
}>();

// ===== 类型定义 =====
interface ProjectData {
  id: string;
  name: string;
  intro: string;
  type: string;
  artStyle: string | null;
  directorManual: string | null;
  videoRatio: string | null;
  imageModel: string;
  videoModel: string;
  textModel: string;
  projectType: string;
  imageQuality: "1K" | "2K" | "4K" | "";
  visualManual?: string;
  mode: string;
}

interface ProjectFormData {
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
  imageQuality: "1K" | "2K" | "4K" | "";
  mode: string;
  targetDuration: 15 | 30 | 60;
}
interface VisualManualItem {
  name: string;
  images?: string[];
  data?: Data[];
  stylePath: string;
}
interface Data {
  label: string;
  value: string;
  data: string;
}
//预览
const trigger = ref();
const visible = ref(false);
function handlePreview(src: string | undefined) {
  visible.value = true;
  trigger.value = src;
}

const DEFAULT_TAB_DATA: () => Data[] = () => [
  { label: "README", value: "README", data: "" },
  { label: "前缀", value: "prefix", data: "" },
  { label: "角色", value: "art_character", data: "" },
  { label: "角色衍生", value: "art_character_derivative", data: "" },
  { label: "道具", value: "art_prop", data: "" },
  { label: "道具衍生", value: "art_prop_derivative", data: "" },
  { label: "场景", value: "art_scene", data: "" },
  { label: "场景衍生", value: "art_scene_derivative", data: "" },
  { label: "分镜", value: "director_storyboard", data: "" },
  { label: "分镜视频", value: "art_storyboard_video", data: "" },
  { label: "技法-导演规划", value: "director_planning_style", data: "" },
  { label: "技法-分镜表设计", value: "director_storyboard_table_style", data: "" },
];

const isEdit = computed(() => !!props.projectData);
const isQuickForm = computed(() => formState.value.projectType === "quick_video");
const isQuickCreate = computed(() => !isEdit.value && props.createMode === "quick");

// ===== 常量 =====
const DEFAULT_VIDEO_RATIO_OPTIONS = [
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
];
const videoRatioOptions = ref([...DEFAULT_VIDEO_RATIO_OPTIONS]);

const QUICK_RATIO_OPTIONS = [
  { value: "9:16", label: "9:16" },
  { value: "16:9", label: "16:9" },
  { value: "1:1", label: "1:1" },
];

const DEFAULT_FORM: (projectType?: "novel" | "quick_video") => ProjectFormData & { id: number; era: string; createTime: number; userId: number } = (
  projectType = "novel",
) => ({
  id: 0,
  projectType,
  name: "",
  intro: "",
  type: "",
  artStyle: "",
  era: "",
  videoRatio: "16:9",
  createTime: 0,
  userId: 0,
  imageModel: "",
  videoModel: "",
  textModel: "",
  imageQuality: "",
  mode: "",
  directorManual: "",
  targetDuration: 15,
});

// ===== 表单 =====
const formState = ref(DEFAULT_FORM());

function resetForm(projectType: "novel" | "quick_video" = isQuickCreate.value ? "quick_video" : "novel") {
  formState.value = DEFAULT_FORM(projectType);
  videoRatioOptions.value = [...DEFAULT_VIDEO_RATIO_OPTIONS];
  imageModelDetail.value = null;
}

function handleCancel() {
  addProjectShow.value = false;
  resetForm();
}

function handleOk() {
  // Keep the submitted values aligned with the selected manual cards.
  if (!formState.value.artStyle) {
    const visual = visualManualOptions.value.find((item) => item.stylePath);
    if (visual) formState.value.artStyle = visual.stylePath;
  }
  if (!formState.value.directorManual) {
    const director = directorManualOptions.value.find((item) => item.directorManual);
    if (director) formState.value.directorManual = director.directorManual;
  }
  if (!formState.value.name) return window.$message.warning($t("workbench.project.msg.enterProjectName"));
  if (formState.value.projectType === "quick_video") {
    // 单视频快创：画风/比例/目标时长必填，图片/视频模型可后续在设置中补充
    if (!formState.value.artStyle) return window.$message.warning($t("workbench.project.msg.enterArtStyle"));
    if (!formState.value.videoRatio) return window.$message.warning($t("workbench.project.msg.enterVideoRatio"));
    if (isEdit.value) {
      emit("edit", {
        id: formState.value.id as unknown as string,
        name: formState.value.name,
        intro: formState.value.intro,
        type: "",
        artStyle: formState.value.artStyle,
        videoRatio: formState.value.videoRatio,
        imageModel: "",
        videoModel: "",
        textModel: "",
        projectType: "quick_video",
        directorManual: "",
        imageQuality: "",
        mode: "",
        targetDuration: formState.value.targetDuration,
      });
    } else {
      emit("add", {
        projectType: "quick_video",
        name: formState.value.name,
        intro: formState.value.intro,
        type: "",
        artStyle: formState.value.artStyle,
        videoRatio: formState.value.videoRatio || "9:16",
        imageModel: "",
        videoModel: "",
        textModel: "",
        imageQuality: "",
        directorManual: "",
        mode: "",
        targetDuration: formState.value.targetDuration,
      });
      // 快创项目的创建请求由父组件负责；请求成功前保留表单，失败时用户可以直接重试。
      return;
    }
    resetForm();
    addProjectShow.value = false;
    return;
  }
  if (!formState.value.type) return window.$message.warning($t("workbench.project.msg.enterProjectType"));
  if (!formState.value.imageModel) return window.$message.warning($t("workbench.project.msg.enterImageModel"));
  if (!formState.value.videoModel) return window.$message.warning($t("workbench.project.msg.enterVideoModel"));
  if (!formState.value.artStyle) return window.$message.warning($t("workbench.project.msg.enterArtStyle"));
  if (!formState.value.directorManual) return window.$message.warning($t("workbench.project.msg.directorManual"));
  if (!formState.value.videoRatio) return window.$message.warning($t("workbench.project.msg.enterVideoRatio"));
  if (!formState.value.intro) return window.$message.warning($t("workbench.project.msg.enterProjectIntro"));
  if (!formState.value.imageQuality) return window.$message.warning($t("workbench.project.msg.enterProjectQuality"));
  if (!formState.value.mode) return window.$message.warning($t("workbench.project.msg.selectMode"));
  if (isEdit.value) {
    emit("edit", {
      id: formState.value.id as unknown as string,
      name: formState.value.name,
      intro: formState.value.intro,
      type: formState.value.type,
      artStyle: formState.value.artStyle,
      videoRatio: formState.value.videoRatio,
      imageModel: formState.value.imageModel,
      videoModel: formState.value.videoModel,
      textModel: formState.value.textModel,
      projectType: formState.value.projectType || "novel",
      directorManual: formState.value.directorManual,
      imageQuality: formState.value.imageQuality,
      mode: formState.value.mode,
      targetDuration: formState.value.targetDuration,
    });
  } else {
    emit("add", {
      projectType: formState.value.projectType || "novel",
      name: formState.value.name,
      intro: formState.value.intro,
      type: formState.value.type,
      artStyle: formState.value.artStyle,
      videoRatio: formState.value.videoRatio || "16:9",
      imageModel: formState.value.imageModel,
      videoModel: formState.value.videoModel,
      textModel: formState.value.textModel,
      imageQuality: formState.value.imageQuality,
      directorManual: formState.value.directorManual,
      mode: formState.value.mode,
      targetDuration: formState.value.targetDuration,
    });
  }
  resetForm();
  addProjectShow.value = false;
}

// ===== 视觉手册 Prompt 工具栏 =====

const promptToolbars: ToolbarNames[] = [
  "bold",
  "italic",
  "strikeThrough",
  "-",
  "unorderedList",
  "orderedList",
  "-",
  "revoke",
  "next",
  "=",
  "preview",
];

watch(addProjectShow, async (visible) => {
  if (visible) {
    if (props.projectData) {
      formState.value = {
        ...DEFAULT_FORM(),
        id: props.projectData.id as unknown as number,
        name: props.projectData.name || "",
        intro: props.projectData.intro || "",
        type: props.projectData.type || "",
        artStyle: props.projectData.artStyle || "",
        videoRatio: props.projectData.videoRatio || "16:9",
        imageModel: props.projectData.imageModel || "",
        videoModel: props.projectData.videoModel || "",
        textModel: props.projectData.textModel || "",
        imageQuality: props.projectData.imageQuality || "",
        projectType: props.projectData.projectType || "novel",
        mode: props.projectData.mode || "text",
        directorManual: props.projectData.directorManual || "",
      };
      // 编辑模式下主动获取视频模型详情，填充 mode 列表以回显 label
      if (props.projectData.videoModel) {
        try {
          const { data } = await axios.post("/modelSelect/getModelDetail", {
            modelId: props.projectData.videoModel,
          });
          applyVideoModelDetails(data);
        } catch (e) {
          // 获取失败不影响其他功能
        }
      }
      // 编辑模式下获取图像模型详情，回显分辨率选项与分辨率说明
      if (props.projectData.imageModel) {
        await loadImageModelDetail(props.projectData.imageModel);
      }
    } else {
      resetForm(props.createMode === "quick" ? "quick_video" : "novel");
    }
    fetchVisualManuals();
    queryDirectorManual();
  }
});

// ===== 视觉手册 =====
const visualManualOptions = ref<VisualManualItem[]>([]);
const visualManualLoading = ref(false);
const visualManualDialogVisible = ref(false);
const editingVisualManual = ref<VisualManualItem | null>(null);
const visualManualForm = ref({ name: "", images: [] as string[], stylePath: "" });
const visualManualCoverInputRef = ref<HTMLInputElement>();
const visualManualTabValue = ref<TabValue>("README");
const visualManualTabData = ref<Data[]>(DEFAULT_TAB_DATA());

function fetchVisualManuals() {
  visualManualLoading.value = true;
  axios
    .post("/project/getVisualManual")
    .then(({ data }) => {
      visualManualOptions.value = data.map(
        (item: { id?: string | number; name: string; image?: string | string[]; images?: string[]; data?: Data[]; stylePath: string }) => ({
          id: item.id,
          name: item.name,
          stylePath: item.stylePath || item.name,
          images: item.images ?? (Array.isArray(item.image) ? item.image : item.image ? [item.image] : []),
          data: item.data,
        }),
      );
    })
    .finally(() => {
      visualManualLoading.value = false;
    });
}

function selectVisualManual(item: VisualManualItem) {
  formState.value.artStyle = item.stylePath;
}

function selectDirectorManual(item: DirectorManualItem) {
  formState.value.directorManual = item.directorManual;
}

function openVisualManualDialog(item?: VisualManualItem) {
  editingVisualManual.value = item ?? null;
  if (item) {
    visualManualForm.value.name = item.name;
    visualManualForm.value.stylePath = item.stylePath;
    visualManualForm.value.images = item.images ? [...item.images] : [];
    const existingData: Data[] = Array.isArray(item.data) ? item.data : [];
    visualManualTabData.value = DEFAULT_TAB_DATA().map((tab) => {
      const found = existingData.find((d) => d.value === tab.value);
      return found ? { ...tab, data: found.data } : { ...tab };
    });
  } else {
    visualManualForm.value = { name: "", images: [], stylePath: "" };
    visualManualTabData.value = DEFAULT_TAB_DATA();
  }
  visualManualTabValue.value = "README";
  visualManualDialogVisible.value = true;
}

function resetVisualManualDialog() {
  visualManualDialogVisible.value = false;
  editingVisualManual.value = null;
  visualManualForm.value = { name: "", images: [], stylePath: "" };
  visualManualTabData.value = DEFAULT_TAB_DATA();
  visualManualTabValue.value = "README";
}

function triggerVisualManualCoverUpload() {
  visualManualCoverInputRef.value?.click();
}

function handleVisualManualCoverFileChange(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (!files || files.length === 0) return;
  Array.from(files).forEach((file) => {
    const reader = new FileReader();
    reader.onload = () => {
      visualManualForm.value.images.push(reader.result as string);
    };
    reader.readAsDataURL(file);
  });
  (e.target as HTMLInputElement).value = "";
}

function removeVisualManualCover(idx: number) {
  visualManualForm.value.images.splice(idx, 1);
}
const loading = ref(false);
async function handleVisualManualSubmit() {
  if (!visualManualForm.value.name.trim()) {
    window.$message.warning($t("workbench.project.msg.enterVisualManualName"));
    return;
  }
  if (!visualManualForm.value.images.length) {
    window.$message.warning($t("workbench.project.msg.enterVisualManualImage"));
    return;
  }
  const emptyTab = visualManualTabData.value.find((tab) => !tab.data.trim());
  if (emptyTab) return window.$message.warning(`「${emptyTab.label}」${$t("workbench.project.msg.enterVisualManualTabData")}`);
  try {
    loading.value = true;
    if (editingVisualManual.value) {
      await axios.post("/project/editVisualManual", {
        name: visualManualForm.value.name,
        images: visualManualForm.value.images,
        data: visualManualTabData.value,
        stylePath: visualManualForm.value.stylePath,
      });
    } else {
      await axios.post("/project/addVisualManual", {
        name: visualManualForm.value.name,
        images: visualManualForm.value.images,
        data: visualManualTabData.value,
        stylePath: visualManualForm.value.stylePath,
      });
    }

    loading.value = false;
    if (editingVisualManual.value) {
      window.$message.success($t("workbench.project.msg.visualManualUpdated"));
    } else {
      window.$message.success($t("workbench.project.msg.visualManualAdded"));
    }
    resetVisualManualDialog();
    fetchVisualManuals();
  } catch (e: any) {
    loading.value = false;
    window.$message.error(e.message ?? $t("workbench.project.msg.operationFailed"));
  }
}
function deleteVisualManual(item: VisualManualItem) {
  const dialog = DialogPlugin.confirm({
    header: $t("workbench.project.msg.deleteVisualManualHeader"),
    body: $t("workbench.project.msg.deleteVisualManualBody", { name: item.stylePath }),
    confirmBtn: $t("workbench.project.msg.deleteVisualManualConfirm"),
    cancelBtn: $t("workbench.project.msg.deleteVisualManualCancel"),
    onConfirm: () => {
      axios
        .post("/project/deleteVisualManual", { name: item.stylePath })
        .then(() => {
          fetchVisualManuals();
          resetVisualManualDialog();
          window.$message.success($t("workbench.project.msg.visualManualDeleted"));
        })
        .catch((e) => {
          window.$message.error(e.message ?? $t("workbench.project.msg.operationFailed"));
        })
        .finally(() => {
          fetchVisualManuals();
          dialog.destroy();
        });
    },
  });
}
type VideoMode =
  | "singleImage" //单图参考
  | "startEndRequired" //首尾帧（两张都得有）
  | "endFrameOptional" //首尾帧（尾帧可选）
  | "startFrameOptional" //首尾帧（首帧可选）
  | "text" //文本
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[]; //多参考（数字代表限制数量）
const mode = ref<{ label: string; value: string }[]>([]);
const MODE_LABEL: Record<string, string> = {
  singleImage: $t("workbench.production.generate.modeSingleImage"),
  startEndRequired: $t("settings.vendor.startEndRequired"),
  endFrameOptional: $t("settings.vendor.endFrameOptional"),
  startFrameOptional: $t("settings.vendor.startFrameOptional"),
  text: $t("workbench.production.generate.modeText"),
  videoReference: $t("workbench.production.generate.modeVideoRef"),
  imageReference: $t("workbench.production.generate.modeImageRef"),
  audioReference: $t("workbench.production.generate.modeAudioRef"),
};
// 模式转换为统一的 key 形式，方便后续处理
function getModeLabel(mode?: VideoMode): string {
  if (!mode) return "";
  if (Array.isArray(mode)) return mode.map((r) => MODE_LABEL[r.replace(/:.*$/, "")] ?? r).join("、");
  return MODE_LABEL[mode] ?? mode;
}
//模式数组转换为字符串 key，方便在前端使用和比较
function modeToKey(m: VideoMode): string {
  return Array.isArray(m) ? JSON.stringify(m) : m;
}

function applyVideoModelDetails(data: any) {
  const modelModes = Array.isArray(data?.mode) ? data.mode : [];
  mode.value = modelModes.map((item: VideoMode) => ({
    label: getModeLabel(item),
    value: modeToKey(item),
  }));
  if (!mode.value.some((item) => item.value === formState.value.mode)) {
    formState.value.mode = mode.value[0]?.value ?? "";
  }

  const configuredRatios = Array.isArray(data?.aspectRatioOptions)
    ? data.aspectRatioOptions.filter((item: any) => item?.value && item?.label)
    : [];
  videoRatioOptions.value = configuredRatios.length ? configuredRatios : [...DEFAULT_VIDEO_RATIO_OPTIONS];

  if (!videoRatioOptions.value.some((item) => item.value === formState.value.videoRatio)) {
    formState.value.videoRatio = videoRatioOptions.value[0].value;
  }
}

//获取模式
function changeFn(val: string, data: any) {
  applyVideoModelDetails(data);
}

// ===== 图像模型详情（分辨率选项 / 分辨率说明） =====
const DEFAULT_IMAGE_QUALITY_OPTIONS = ["1K", "2K", "4K"];
const imageModelDetail = ref<any>(null);
const imageResolutionOptions = computed(() => {
  const options = imageModelDetail.value?.resolutionOptions;
  return options?.length ? options : [...DEFAULT_IMAGE_QUALITY_OPTIONS];
});

function applyImageModelDetails(data: any) {
  imageModelDetail.value = data;
  if (data?.resolutionOptions?.length && !data.resolutionOptions.includes(formState.value.imageQuality)) {
    formState.value.imageQuality = data.resolutionOptions[0];
  }
}

async function loadImageModelDetail(modelId: string) {
  try {
    const { data } = await axios.post("/modelSelect/getModelDetail", { modelId });
    applyImageModelDetails(data);
  } catch (e) {
    // 获取失败不影响其他功能
    imageModelDetail.value = null;
  }
}

function handleImageModelChange(_val: string, data: any) {
  applyImageModelDetails(data);
}
//导演手册
interface DirectorManualItem {
  name: string;
  images?: string[];
  data?: Data[];
  directorManual: string;
}
const DIRECTOR_DEFAULT_TAB_DATA: () => Data[] = () => [
  { label: "README", value: "README", data: "" },
  { label: "导演规划", value: "director_planning_narrative", data: "" },
  { label: "分镜表", value: "director_storyboard_table_narrative", data: "" },
];
const directorManualForm = ref({ name: "", images: [] as string[], directorManual: "" });
const directorManualLoading = ref(false);
const editingDirectorManual = ref<DirectorManualItem | null>(null);
const directorDialogVisible = ref(false);
const directorManualOptions = ref<DirectorManualItem[]>([]);
const directorManualTabValue = ref<TabValue>("README");
const directorManualTabData = ref<Data[]>(DIRECTOR_DEFAULT_TAB_DATA());
//查询导演手册
function queryDirectorManual() {
  directorManualLoading.value = true;
  axios
    .post("/project/queryDirectorManual")
    .then(({ data }) => {
      directorManualOptions.value = data.map(
        (item: { id?: string | number; name: string; image?: string | string[]; images?: string[]; data?: Data[]; directorManual: string }) => ({
          id: item.id,
          name: item.name,
          directorManual: item.directorManual || item.name,
          images: item.images ?? (Array.isArray(item.image) ? item.image : item.image ? [item.image] : []),
          data: item.data,
        }),
      );
    })
    .finally(() => {
      directorManualLoading.value = false;
    });
}
//新建导演手册
function openDirectorManualDialog(item?: DirectorManualItem) {
  editingDirectorManual.value = item ?? null;
  if (item) {
    directorManualForm.value.name = item.name;
    directorManualForm.value.directorManual = item.directorManual;
    directorManualForm.value.images = item.images ? [...item.images] : [];
    const existingData: Data[] = Array.isArray(item.data) ? item.data : [];
    directorManualTabData.value = DIRECTOR_DEFAULT_TAB_DATA().map((tab) => {
      const found = existingData.find((d) => d.value === tab.value);
      return found ? { ...tab, data: found.data } : { ...tab };
    });
  } else {
    directorManualForm.value = { name: "", images: [], directorManual: "" };
    directorManualTabData.value = DIRECTOR_DEFAULT_TAB_DATA();
  }
  directorManualTabValue.value = "README";
  directorDialogVisible.value = true;
}
function resetDirectorManualDialog() {
  directorDialogVisible.value = false;
  editingDirectorManual.value = null;
  directorManualForm.value = { name: "", images: [], directorManual: "" };
  directorManualTabData.value = DIRECTOR_DEFAULT_TAB_DATA();
  directorManualTabValue.value = "README";
}
function deleteDirectorManual(item: DirectorManualItem) {
  const dialog = DialogPlugin.confirm({
    header: $t("workbench.project.msg.deleteDirectorManualHeader"),
    body: $t("workbench.project.msg.deleteDirectorManualBody", { name: item.directorManual }),
    confirmBtn: $t("workbench.project.msg.deleteVisualManualConfirm"),
    cancelBtn: $t("workbench.project.msg.deleteVisualManualCancel"),
    onConfirm: () => {
      axios
        .post("/project/deleteDirectorManual", { name: item.directorManual })
        .then(() => {
          queryDirectorManual();
          resetDirectorManualDialog();
          window.$message.success($t("workbench.project.msg.visualManualDeleted"));
        })
        .catch((e) => {
          window.$message.error(e.message ?? $t("workbench.project.msg.operationFailed"));
        })
        .finally(() => {
          queryDirectorManual();
          dialog.destroy();
        });
    },
  });
}
//导演手册编辑和新增保存
async function handleDirectorManualSubmit() {
  if (!directorManualForm.value.name.trim()) {
    window.$message.warning($t("workbench.project.msg.enterVisualManualName"));
    return;
  }
  if (!directorManualForm.value.images.length) {
    window.$message.warning($t("workbench.project.msg.enterVisualManualImage"));
    return;
  }
  const emptyTab = directorManualTabData.value.find((tab) => !tab.data.trim());
  if (emptyTab) return window.$message.warning(`「${emptyTab.label}」${$t("workbench.project.msg.enterVisualManualTabData")}`);
  try {
    loading.value = true;
    if (editingDirectorManual.value) {
      await axios.post("/project/editDirectorlManual", {
        name: directorManualForm.value.name,
        images: directorManualForm.value.images,
        data: directorManualTabData.value,
        directorManual: directorManualForm.value.directorManual,
      });
    } else {
      await axios.post("/project/addDirectorManual", {
        name: directorManualForm.value.name,
        images: directorManualForm.value.images,
        data: directorManualTabData.value,
        directorManual: directorManualForm.value.directorManual,
      });
    }

    loading.value = false;
    if (editingDirectorManual.value) {
      window.$message.success($t("workbench.project.msg.directorManualUpdated"));
    } else {
      window.$message.success($t("workbench.project.msg.directorManualAdded"));
    }
    resetDirectorManualDialog();
    queryDirectorManual();
  } catch (e: any) {
    loading.value = false;
    window.$message.error(e.message ?? $t("workbench.project.msg.operationFailed"));
  }
}
function triggerDirectorManualCoverUpload() {
  visualManualCoverInputRef.value?.click();
}

function handleDirectorManualCoverFileChange(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (!files || files.length === 0) return;
  Array.from(files).forEach((file) => {
    const reader = new FileReader();
    reader.onload = () => {
      directorManualForm.value.images.push(reader.result as string);
    };
    reader.readAsDataURL(file);
  });
  (e.target as HTMLInputElement).value = "";
}
</script>

<style lang="scss" scoped>
.formColumns {
  display: flex;
  gap: 24px;

  .formLeft {
    flex: 1;
    min-width: 0;
  }

  .formRight {
    flex: 1;
    min-width: 0;
  }
}
.directorManual {
  width: 100%;
  height: 50%;
  .directorManualHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .artStyleContent {
    height: 300px;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px;
  }
}
.artStylePicker {
  width: 100%;
  height: 50%;
  .artStyleHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .artStyleContent {
    height: 300px;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px;
  }
}

.gridContainer {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 12px;

  .gridItem {
    cursor: pointer;
    transition: transform 0.2s ease;
    border: 2px solid transparent;
    border-radius: 6px;
    position: relative;

    &:hover {
      transform: scale(1.03);
      .editBtn {
        z-index: 2;
        opacity: 1;
      }
      .delBtn {
        z-index: 2;
        opacity: 1;
      }
      .preview {
        z-index: 2;
        opacity: 1;
      }
    }

    &.active {
      border-color: var(--td-brand-color);
      position: relative;
      &::after {
        content: "";
        position: absolute;
        inset: 0;
        background-color: #0000006b;
        color: rgb(109, 226, 109);
        line-height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 3rem;
        height: 100%;
      }
    }

    .imageWrapper {
      position: relative;
      overflow: hidden;
      border-radius: 4px;

      .artImage {
        width: 100%;
        aspect-ratio: 1;
        object-fit: cover;
        display: block;
      }

      .text {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        background: rgba(0, 0, 0, 0.5);
        color: #fff;
        text-align: center;
        padding: 6px;
        font-size: 12px;
        line-height: 1;
      }
    }
    .editBtn {
      position: absolute;
      top: 6px;
      left: 6px;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.2s;
    }
    .delBtn {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.2s;
    }
    .preview {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.2s;
    }
  }
}

// 视觉手册名称与封面同行布局
.nameAndCoverRow {
  gap: 16px;
  width: 100%;
  .nameField {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .mdFileLocation {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 10px;
  }

  .coverField {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 20px;
  }

  .fieldLabel {
    font-size: 14px;
    color: var(--td-text-color-primary);
  }
}

// 画风弹窗样式
.coverUploadArea {
  width: 100%;

  .coverPreview {
    display: flex;
    align-items: center;
    gap: 12px;

    .coverImg {
      width: 80px;
      height: 80px;
      object-fit: cover;
      border-radius: 6px;
      border: 1px solid var(--td-component-border);
    }
  }

  &.multiCoverUploadArea {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: flex-start;

    .coverPreview {
      position: relative;
      flex-shrink: 0;

      .coverImg {
        width: 80px;
        height: 80px;
        object-fit: cover;
        border-radius: 6px;
        border: 1px solid var(--td-component-border);
        display: block;
      }

      .coverImgRemove {
        position: absolute;
        top: -6px;
        right: -6px;
        width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--td-error-color);
        color: #fff;
        border-radius: 50%;
        cursor: pointer;
        font-size: 10px;
        z-index: 1;

        &:hover {
          background: var(--td-error-color-hover);
        }
      }
    }
  }

  .coverUploadTrigger {
    width: 80px;
    height: 80px;
    border: 2px dashed var(--td-component-border);
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--td-text-color-placeholder);
    gap: 4px;
    font-size: 12px;
    transition: border-color 0.2s;
    white-space: nowrap;

    &:hover {
      border-color: var(--td-brand-color);
      color: var(--td-brand-color);
    }
  }
}

.promptEditorWrapper {
  width: 100%;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;

  .promptEditorHeader {
    display: flex;
    margin-bottom: 8px;

    .aiExtractInline {
      width: 100%;
      .aiImageList {
        display: flex;
        align-items: center;
        gap: 4px;

        .aiImageItem {
          position: relative;
          width: 36px;
          height: 36px;

          .aiImg {
            width: 100%;
            height: 100%;
            object-fit: cover;
            border-radius: 4px;
            border: 1px solid var(--td-component-border);
          }

          .aiImgRemove {
            position: absolute;
            top: -5px;
            right: -5px;
            width: 16px;
            height: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--td-error-color);
            color: #fff;
            border-radius: 50%;
            cursor: pointer;
            font-size: 9px;
          }
        }

        .aiImageAdd {
          width: 36px;
          height: 36px;
          border: 2px dashed var(--td-component-border);
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          color: var(--td-text-color-placeholder);
          transition: border-color 0.2s;

          &:hover {
            border-color: var(--td-brand-color);
            color: var(--td-brand-color);
          }
        }
      }
    }
  }
}

// MdEditor 在弹窗内的样式调整
:deep(.md-editor) {
  border-radius: 6px;
}

// 画风弹窗整体高度72vh
:deep(.artStyleDialog) {
  .t-dialog__body {
    height: 75vh;
    overflow-y: auto;
  }
}
</style>
