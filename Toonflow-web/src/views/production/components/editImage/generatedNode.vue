<template>
  <div class="generatedNode">
    <Handle type="target" :position="Position.Left" />
    <div class="data" @click="selectedFn">
      <div class="title ac">
        <i-pic theme="outline" size="16" fill="#000000" />
        <span class="titleText">{{ $t("workbench.production.editImage.imageGeneration") }}</span>
      </div>
      <div class="image">
        <div v-if="generating" class="imageLoading">
          <div class="loadingSpinner"></div>
          <span class="loadingText">{{ $t("workbench.production.editImage.generating") }}</span>
        </div>
        <div v-else class="imageWrapper">
          <t-image class="image" :src="data.generatedImage" fit="contain" :class="['nodeImage', { selected }]">
            <template #overlayContent>
              <div class="imageToolsWrap">
                <ImageTools :src="data.generatedImage ?? ''" position="br" />
              </div>
            </template>
          </t-image>
        </div>
        <t-dropdown :options="options" @click="clickHandler">
          <div class="upload ac">
            <i-upload theme="outline" size="18" fill="#fff" />
            <span style="margin-left: 5px; color: #fff">{{ $t("workbench.production.editImage.upload") }}</span>
          </div>
        </t-dropdown>
        <t-tooltip theme="primary" :content="$t('workbench.production.editImage.deleteNode')">
          <div class="remove ac" @click="removeNodes(props.id)">
            <i-delete theme="outline" size="18" fill="#fff" />
          </div>
        </t-tooltip>
      </div>
    </div>
    <div v-show="selected" class="parameter" @wheel.stop @mousedown.stop>
      <div class="imageRefs f w">
        <div v-for="(item, index) in data.references" :key="index" class="refThumb">
          <t-image :src="item.image" fit="cover" class="refImg" />
        </div>
        <div v-if="referenceLimit" class="refCount" :class="{ over: refCount > referenceLimit.max }">{{ refCount }}/{{ referenceLimit.max }}</div>
      </div>
      <div class="text w">
        <PromptEditor v-model="data.prompt" :references="references" :placeholder="$t('workbench.production.editImage.promptPlaceholder')" />
      </div>
      <div class="operate ac jb">
        <div class="ac">
          <modelSelect v-model="data.model" type="image" size="small" :changeConfig="true" @change="handleModelChange" />
          <t-select v-model="data.ratio" class="paramSelect ml-5" size="small" :placeholder="$t('workbench.production.editImage.ratio')">
            <t-option v-for="option in ratioOptions" :key="option.value" :value="option.value" :label="option.label" />
          </t-select>
          <t-select v-model="data.quality" class="paramSelect ml-5" size="small" :placeholder="$t('workbench.production.editImage.quality')">
            <t-option v-for="option in qualityOptions" :key="option" :value="option" :label="option" />
          </t-select>
        </div>

        <div class="f" style="gap: 5px; margin-left: 5px">
          <t-popup :content="$t('workbench.production.editImage.generateBtn')">
            <t-button theme="primary" size="small" class="generateBtn" :disabled="generating" :loading="generating" @click="handleGenerate">
              <template #icon><i-arrow-up /></template>
            </t-button>
          </t-popup>
          <t-popup :content="$t('workbench.production.save')">
            <t-button theme="primary" size="small" class="keepBtn" :disabled="generating" :loading="generating" @click="handleKeep">
              <template #icon><i-save /></template>
            </t-button>
          </t-popup>
        </div>
      </div>
    </div>
    <Handle type="source" :position="Position.Right" style="z-index: 999999" />
  </div>
</template>

<script setup lang="ts">
import { Handle, useVueFlow, Position } from "@vue-flow/core";
import type { Ref } from "vue";
import modelSelect from "@/components/modelSelect.vue";
import PromptEditor from "@/components/promptEditor.vue";
import axios from "@/utils/axios";
import { type GeneratedNodeData } from "../../utils/editImageType";
import type { DropdownOption } from "tdesign-vue-next/es/dropdown";
import type { Storyboard } from "../../utils/flowBuilder";
import openAssetsSelector from "@/utils/assetsCheck";
import { useFileDialog } from "@vueuse/core";
import projectStore from "@/stores/project";
const { project } = storeToRefs(projectStore());
const openStoryboardCheck = inject<() => Promise<Storyboard[]>>("openStoryboardCheck")!;
const { open, onChange, onCancel } = useFileDialog({ multiple: false, reset: true, accept: ".png,.jpg,.jpeg" });

const selected = ref(true);
const generating = ref(false);
const episodesId = inject<Ref<number>>("episodesId")!;

const emit = defineEmits(["keep"]);
const { removeNodes } = useVueFlow("editImage");

const options = [
  { content: $t("workbench.production.editImage.uploadImage"), value: 1 },
  { content: $t("workbench.production.editImage.uploadStoryboardImage"), value: 2 },
  { content: $t("workbench.production.generatedNode.localUpload"), value: 3 },
];

const references = computed(() => {
  return props.data.references.map((i) => ({ type: "image" as const, src: i.image })).filter(Boolean);
});

const props = defineProps<{
  id: string;
  data: GeneratedNodeData;
  projectId: number;
}>();

const referenceLimit = ref<{ min: number; max: number } | null>(null);
const refCount = computed(() => props.data.references.filter((item) => item.image).length);

function selectedFn() {
  selected.value = !selected.value;
}
function clickHandler(data: DropdownOption) {
  if (data.value == 1) {
    uploadFn();
  } else if (data.value == 2) {
    getStoryboardImage();
  } else if (data.value == 3) {
    lensImage();
  }
}
async function lensImage() {
  const files = await new Promise<FileList | null>((resolve) => {
    open();
    onChange((f) => resolve(f));
    onCancel(() => resolve(null));
  });

  if (!files?.length) return;

  const file = files[0];
  //转成base64显示
  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = reader.result as string;
    try {
      const { data } = await axios.post("/production/editImage/uploadImage", {
        base64Data: base64,
        projectId: props.projectId,
        scriptId: episodesId.value,
      });
      props.data.generatedImage = data;
    } catch (e) {
      return window.$message.error((e as any)?.message || $t("workbench.production.editImage.uploadFailed"));
    }
  };
  reader.readAsDataURL(file);
  // mockStoryboard.value.id = -1; // 新上传的图片没有id，使用-1标识，后端根据filePath处理这种情况
}
async function uploadFn() {
  const selectedAssets = await openAssetsSelector({
    multiple: false,
    title: $t("workbench.production.editImage.selectImage"),
  });
  if (selectedAssets.length > 0) {
    const filePath = selectedAssets[0].src!;
    props.data.generatedImage = filePath;
  }
}
async function getStoryboardImage() {
  const rows = await openStoryboardCheck();
  if (rows.length > 0) {
    const filePath = rows[0].src!;
    props.data.generatedImage = filePath;
  }
}
// 生成
async function handleGenerate() {
  if (!props.data.model) return window.$message.error($t("workbench.production.editImage.selectModel"));
  if (referenceLimit.value) {
    if (refCount.value < referenceLimit.value.min)
      return window.$message.error($t("workbench.production.editImage.refMinRequired", { n: referenceLimit.value.min }));
    if (refCount.value > referenceLimit.value.max)
      return window.$message.error($t("workbench.production.editImage.refMaxExceeded", { n: referenceLimit.value.max }));
  }
  if (props.data.model.includes("rhart-image-n-g31-flash") && refCount.value > 1) {
    return window.$message.error("当前 Nano Banana 2 工作流最多使用 1 张参考图，请减少参考图后重试");
  }
  if (!props.data.quality) return window.$message.error($t("workbench.production.editImage.selectQuality"));
  if (!props.data.ratio) return window.$message.error($t("workbench.production.editImage.selectRatio"));
  generating.value = true;
  try {
    const { data } = await axios.post("/production/editImage/generateFlowImage", {
      references: props.data.references.map((i) => i.image).filter(Boolean),
      model: props.data.model,
      quality: props.data.quality,
      ratio: props.data.ratio,
      prompt: props.data.prompt,
      projectId: props.projectId,
    });
    props.data.generatedImage = data.url;
  } catch (e) {
    return window.$message.error((e as any)?.message || $t("workbench.production.editImage.generateFailed"));
  } finally {
    generating.value = false;
  }
}

function handleKeep() {
  if (!props.data.generatedImage) return window.$message.error($t("workbench.production.editImage.generateFirst"));
  emit("keep", props.data.generatedImage);
}
// 生成参数选项随所选模型（协议目录）变化，模型未配置选项时回退默认值
const modelDetail = ref<any>(null);
function handleModelChange(_val: string, data: any) {
  modelDetail.value = data ?? null;
  referenceLimit.value = data?.maxReferenceImages
    ? { min: data.minReferenceImages ?? 0, max: data.maxReferenceImages }
    : null;
}
const ratioOptions = computed<any[]>(() =>
  modelDetail.value?.aspectRatioOptions?.length
    ? modelDetail.value.aspectRatioOptions
    : [
        { value: "16:9", label: "16:9" },
        { value: "9:16", label: "9:16" },
        { value: "1:1", label: "1:1" },
      ],
);
const qualityOptions = computed<string[]>(() =>
  modelDetail.value?.resolutionOptions?.length ? modelDetail.value.resolutionOptions : ["1K", "2K", "4K"],
);

onMounted(async () => {
  props.data.model = project.value?.imageModel ?? "";
  props.data.quality = project.value?.imageQuality ?? "";
  props.data.ratio = project.value?.videoRatio ?? "16:9";
  // 回填模型详情，让比例/分辨率选项与所选模型能力一致
  if (props.data.model) {
    try {
      const { data: detail } = await axios.post("/modelSelect/getModelDetail", { modelId: props.data.model });
      modelDetail.value = detail ?? null;
      referenceLimit.value = detail?.maxReferenceImages
        ? { min: detail.minReferenceImages ?? 0, max: detail.maxReferenceImages }
        : null;
    } catch {
      modelDetail.value = null;
      referenceLimit.value = null;
    }
  }
});
</script>

<style lang="scss" scoped>
.generatedNode {
  position: relative;
  width: 320px;
  display: flex;
  flex-direction: column;
  align-items: center;

  .data {
    width: 100%;
    cursor: pointer;

    .title {
      height: 30px;
      padding: 5px;

      .titleText {
        margin-left: 5px;
        color: var(--td-text-color-secondary);
      }
    }

    .image {
      height: 320px;
      width: 100%;
      position: relative;
      .remove {
        position: absolute;
        top: 10px;
        right: 10px;
        z-index: 9999;
        padding: 5px;
        border-radius: 10px;
        background-color: rgba(220, 50, 50, 0.7);
        cursor: pointer;
        &:hover {
          background-color: rgba(220, 50, 50, 1);
        }
      }
      .upload {
        position: absolute;
        top: 10px;
        left: 10px;
        z-index: 9999;
        padding: 5px 10px;
        border-radius: 10px;
        background-color: rgba(0, 0, 0, 0.5);
      }
      .imageLoading {
        width: 100%;
        height: 100%;
        background-color: var(--td-bg-color-component);
        border-radius: 10px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;

        .loadingSpinner {
          width: 36px;
          height: 36px;
          border: 3px solid #d0d0d0;
          border-top-color: #5bccb3;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }

        .loadingText {
          font-size: 14px;
          color: var(--td-text-color-secondary);
        }
      }

      .imageWrapper {
        position: relative;
        width: 100%;
        height: 100%;

        :deep(.nodeImage) {
          width: 100%;
          height: 100%;
          border-radius: 10px;
          border: 3px solid transparent;
          box-sizing: border-box;

          &.selected {
            border-color: var(--td-text-color-primary);
          }
        }
      }
      .imageToolsWrap {
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
      }

      &:hover {
        .imageToolsWrap {
          opacity: 1;
          pointer-events: auto;
        }
      }
    }
  }

  .parameter {
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-top: 10px;
    width: 500px;
    border: 1px solid var(--td-border-level-2-color);
    background-color: var(--td-bg-color-container);
    border-radius: 10px;
    z-index: 9999;

    .imageRefs {
      overflow: auto;
      padding: 10px;
      .refThumb {
        margin-left: 8px;
        .refImg {
          width: 45px;
          height: 45px;
          border-radius: 10px;
        }
      }
      .refCount {
        margin-left: 8px;
        font-size: 12px;
        color: var(--td-text-color-secondary);
        align-self: center;
        &.over {
          color: var(--td-error-color);
        }
      }
    }

    .text {
      height: 200px;
      min-height: 100px;
      max-height: 500px;
      display: flex;
      position: relative;
      overflow: auto;
      resize: vertical;
    }

    .operate {
      padding: 10px;
      height: 50px;

      .paramSelect {
        min-width: 100px;
        width: 100px;
      }

      .ml-5 {
        margin-left: 5px;
      }

      .generateBtn {
        margin-left: auto;
        --td-brand-color: #5bccb3;
        --td-brand-color-hover: #4ab8a0;
      }
    }
  }
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
