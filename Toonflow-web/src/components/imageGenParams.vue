<template>
  <div class="imageGenParams w">
    <div class="paramRow f ac">
      <div class="paramItem f ac">
        <span class="paramLabel">{{ $t("workbench.production.editImage.ratio") }}</span>
        <t-select v-model="ratio" size="small" class="paramSelect" :disabled="disabled">
          <t-option v-for="option in ratioOptions" :key="option.value" :value="option.value" :label="option.label" />
        </t-select>
      </div>
      <div class="paramItem f ac">
        <span class="paramLabel">{{ $t("workbench.production.editImage.quality") }}</span>
        <t-select v-model="resolution" size="small" class="paramSelect" :disabled="disabled">
          <t-option v-for="option in resolutionOptions" :key="option" :value="option" :label="option" />
        </t-select>
      </div>
    </div>
    <t-alert v-if="modelDetail?.resolutionNote" class="noteAlert" theme="warning" :message="modelDetail.resolutionNote" />
    <div v-if="showUpload && maxImages > 0" class="uploadBlock">
      <div class="jb">
        <span class="paramLabel">{{ $t("workbench.assets.gen.uploadRef") }}</span>
        <t-tag>{{ $t("workbench.assets.gen.optional") }}</t-tag>
      </div>
      <t-upload
        v-model="fileList"
        class="upload"
        :autoUpload="false"
        :disabled="disabled"
        theme="image"
        draggable
        action=""
        accept="image/*"
        :max="maxImages"
        :showImageFileName="false"
        @change="handleFilesChange" />
      <div v-if="maxImages > 1" class="uploadTip">{{ $t("workbench.assets.gen.uploadRefLimit", { count: maxImages }) }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 图像生成参数组件：比例 / 分辨率 / 分辨率说明 / 参考图上传。
 * 选项由所选模型的协议目录数据（modelDetail：mode/aspectRatioOptions/resolutionOptions/resolutionNote）驱动，
 * 模型未配置时回退默认值；供素材生成、批量生成等图像生成入口复用。
 */
const props = withDefaults(
  defineProps<{
    modelDetail?: any;
    defaultRatio?: string;
    defaultResolution?: string;
    disabled?: boolean;
    showUpload?: boolean;
  }>(),
  { modelDetail: null, defaultRatio: "", defaultResolution: "", disabled: false, showUpload: true },
);

const ratio = defineModel<string>("ratio", { default: "" });
const resolution = defineModel<string>("resolution", { default: "" });
const images = defineModel<string[]>("images", { default: () => [] });

const DEFAULT_RATIOS = [
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
];
const DEFAULT_RESOLUTIONS = ["1K", "2K", "4K"];
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

const ratioOptions = computed<any[]>(() =>
  props.modelDetail?.aspectRatioOptions?.length ? props.modelDetail.aspectRatioOptions : DEFAULT_RATIOS,
);
const resolutionOptions = computed<string[]>(() =>
  props.modelDetail?.resolutionOptions?.length ? props.modelDetail.resolutionOptions : DEFAULT_RESOLUTIONS,
);
// 参考图张数上限由模型能力决定：多图参考 ≤10，单图参考 1 张，纯文生图不支持上传
const maxImages = computed(() => {
  const modes: string[] = props.modelDetail?.mode ?? [];
  if (modes.includes("multiReference")) return 10;
  if (modes.includes("singleImage")) return 1;
  return 0;
});

watch(
  ratioOptions,
  (options) => {
    if (!options.some((item: any) => item.value === ratio.value)) {
      const preferred = props.defaultRatio && options.some((item: any) => item.value === props.defaultRatio);
      ratio.value = preferred ? props.defaultRatio : options[0]?.value ?? "";
    }
  },
  { immediate: true },
);
watch(
  resolutionOptions,
  (options) => {
    if (!options.includes(resolution.value)) {
      const preferred = props.defaultResolution && options.includes(props.defaultResolution);
      resolution.value = preferred ? props.defaultResolution : options[0] ?? "";
    }
  },
  { immediate: true },
);

const fileList = ref<any[]>([]);
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function handleFilesChange(files: any[]) {
  const list: string[] = [];
  for (const item of files) {
    const file: unknown = item?.raw ?? item;
    if (file instanceof File) {
      if (file.size > MAX_IMAGE_BYTES) {
        window.$message.error($t("workbench.assets.gen.uploadRefTooLarge"));
        continue;
      }
      list.push(await fileToBase64(file));
    }
  }
  images.value = list;
}
</script>

<style lang="scss" scoped>
.imageGenParams {
  .paramRow {
    gap: 10px;
    .paramItem {
      flex: 1;
      .paramLabel {
        font-size: 13px;
        color: #666;
        white-space: nowrap;
      }
      .paramSelect {
        flex: 1;
        min-width: 0;
      }
    }
  }
  .noteAlert {
    margin-top: 8px;
  }
  .uploadBlock {
    margin-top: 10px;
    .upload {
      margin-top: 8px;
    }
    .uploadTip {
      margin-top: 5px;
      font-size: 12px;
      color: #999;
    }
  }
}
</style>
