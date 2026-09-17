<template>
  <t-dialog
    placement="center"
    width="58vw"
    v-model:visible="visible"
    :header="$t('settings.vendor.test.videoTitle') + ' - ' + modelName"
    :footer="false"
    @closed="handleClose">
    <div class="videoTestDialog">
      <!-- 模式选择 -->
      <div class="modeBar">
        <div class="modeLabel">{{ $t("settings.vendor.test.selectMode") }}</div>
        <t-radio-group v-model="selectedMode" variant="default-filled">
          <t-radio-button v-for="m in parsedModes" :key="m.key" :value="m.key">{{ m.label }}</t-radio-button>
        </t-radio-group>
      </div>

      <!-- 当前模式说明 -->
      <div v-if="currentModeInfo" class="modeDesc">
        <t-icon name="info-circle-filled" size="14px" />
        {{ currentModeInfo.desc }}
      </div>

      <!-- 参数面板（SIY-161）：控件由共享投影组件 VideoParamFields 按元数据渲染，
           与快创聊天参数确认卡共用同一投影，未声明的不出现 -->
      <VideoParamFields v-if="paramFields.length" :fields="paramFields" :model-value="paramValues" :disabled="loading" @update="onParamUpdate" />

      <!-- 动态输入区 -->
      <div class="inputSection" v-if="selectedMode">
        <!-- 文生视频：只需文本 -->
        <template v-if="selectedMode === 'text'">
          <t-form-item :label="$t('settings.vendor.test.prompt')">
            <div class="promptArea">
              <t-textarea
                v-model="prompt"
                :placeholder="promptPlaceholder"
                :maxlength="promptLengthRange?.[1]"
                :autosize="{ minRows: 2, maxRows: 4 }"
                :disabled="loading" />
            </div>
          </t-form-item>
        </template>

        <!-- 单图参考 -->
        <template v-else-if="selectedMode === 'singleImage'">
          <t-form-item :label="$t('settings.vendor.test.referenceImage')">
            <div class="uploadRow">
              <ImageUploadBox v-model="uploadedImages[0]" />
            </div>
          </t-form-item>
          <t-form-item :label="$t('settings.vendor.test.prompt')">
            <div class="promptArea">
              <t-textarea
                v-model="prompt"
                :placeholder="promptPlaceholder"
                :maxlength="promptLengthRange?.[1]"
                :autosize="{ minRows: 2, maxRows: 4 }"
                :disabled="loading" />
            </div>
          </t-form-item>
        </template>

        <!-- 首尾帧（两张必填） -->
        <template v-else-if="selectedMode === 'startEndRequired'">
          <div class="frameRow">
            <t-form-item :label="$t('settings.vendor.test.startFrame')">
              <ImageUploadBox v-model="uploadedImages[0]" />
            </t-form-item>
            <t-form-item :label="$t('settings.vendor.test.endFrame')">
              <ImageUploadBox v-model="uploadedImages[1]" />
            </t-form-item>
          </div>
          <t-form-item :label="$t('settings.vendor.test.prompt')">
            <div class="promptArea">
              <t-textarea
                v-model="prompt"
                :placeholder="promptPlaceholder"
                :maxlength="promptLengthRange?.[1]"
                :autosize="{ minRows: 2, maxRows: 4 }"
                :disabled="loading" />
            </div>
          </t-form-item>
        </template>

        <!-- 首尾帧（尾帧可选） -->
        <template v-else-if="selectedMode === 'endFrameOptional'">
          <div class="frameRow">
            <t-form-item :label="$t('settings.vendor.test.startFrame')">
              <ImageUploadBox v-model="uploadedImages[0]" />
            </t-form-item>
            <t-form-item :label="$t('settings.vendor.test.endFrameOptional')">
              <ImageUploadBox v-model="uploadedImages[1]" :optional="true" />
            </t-form-item>
          </div>
          <t-form-item :label="$t('settings.vendor.test.prompt')">
            <div class="promptArea">
              <t-textarea
                v-model="prompt"
                :placeholder="promptPlaceholder"
                :maxlength="promptLengthRange?.[1]"
                :autosize="{ minRows: 2, maxRows: 4 }"
                :disabled="loading" />
            </div>
          </t-form-item>
        </template>

        <!-- 首尾帧（首帧可选） -->
        <template v-else-if="selectedMode === 'startFrameOptional'">
          <div class="frameRow">
            <t-form-item :label="$t('settings.vendor.test.startFrameOptional')">
              <ImageUploadBox v-model="uploadedImages[0]" :optional="true" />
            </t-form-item>
            <t-form-item :label="$t('settings.vendor.test.endFrame')">
              <ImageUploadBox v-model="uploadedImages[1]" />
            </t-form-item>
          </div>
          <t-form-item :label="$t('settings.vendor.test.prompt')">
            <div class="promptArea">
              <t-textarea
                v-model="prompt"
                :placeholder="promptPlaceholder"
                :maxlength="promptLengthRange?.[1]"
                :autosize="{ minRows: 2, maxRows: 4 }"
                :disabled="loading" />
            </div>
          </t-form-item>
        </template>
        <!-- 多参考模式（multiReference / 数组组合） -->
        <template v-else-if="selectedMode.startsWith('[')">
          <t-form-item :label="$t('settings.vendor.test.prompt')">
            <div class="promptArea">
              <t-textarea
                v-model="prompt"
                :placeholder="promptPlaceholder"
                :maxlength="promptLengthRange?.[1]"
                :autosize="{ minRows: 2, maxRows: 4 }"
                :disabled="loading" />
            </div>
          </t-form-item>
          <!-- @Image N / @Video N 槽位引用 chip：由 promptSlotReferences 元数据驱动 -->
          <div v-if="showSlotChips && slotChips.length" class="slotChipRow">
            <span class="slotChipLabel">{{ $t("settings.vendor.test.slotHint") }}</span>
            <t-tag
              v-for="chip in slotChips"
              :key="chip.token"
              class="slotChip"
              @click="insertSlotToken(chip.token)">
              {{ chip.token }}
            </t-tag>
          </div>
          <div class="multiRefSection">
            <template v-for="(ref, rIdx) in currentMultiRefs" :key="rIdx">
              <t-form-item :label="getRefLabel(ref)">
                <div class="multiRefRow">
                  <template v-if="ref.type === 'imageReference'">
                    <ImageUploadBox
                      v-for="i in ref.count"
                      :key="i"
                      v-model="uploadedImages[rIdx * 10 + i - 1]"
                      :label="`${$t('settings.vendor.test.image')} ${i}`" />
                  </template>
                  <template v-else-if="ref.type === 'videoReference'">
                    <VideoUploadBox
                      v-for="i in ref.count"
                      :key="i"
                      v-model="uploadedVideos[rIdx * 10 + i - 1]"
                      :label="`${$t('settings.vendor.test.video')} ${i}`" />
                  </template>
                  <template v-else-if="ref.type === 'audioReference'">
                    <AudioUploadBox
                      v-for="i in ref.count"
                      :key="i"
                      v-model="uploadedAudios[rIdx * 10 + i - 1]"
                      :label="`${$t('settings.vendor.test.audio')} ${i}`"
                      :disabled="audioDisabled" />
                  </template>
                </div>
                <div v-if="ref.type === 'audioReference' && audioDisabled" class="refHint">
                  {{ $t("settings.vendor.test.audioNeedsVisual") }}
                </div>
              </t-form-item>
            </template>
          </div>
        </template>
      </div>

      <!-- 结果区 -->
      <div v-if="resultUrl" class="resultSection">
        <div class="resultLabel">{{ $t("settings.vendor.test.result") }}</div>
        <video :src="resultUrl" controls autoplay loop class="resultVideo" />
      </div>
      <div v-else-if="loading" class="loadingSection">
        <t-loading size="large" :text="$t('settings.vendor.videoGenerating')" />
      </div>

      <!-- 底部操作 -->
      <div class="dialogFooter">
        <t-button variant="outline" @click="visible = false">{{ $t("settings.vendor.test.cancel") }}</t-button>
        <t-button theme="primary" :loading="loading" :disabled="!canSubmit" @click="handleTest">
          <template #icon><i-lightning theme="outline" /></template>
          {{ $t("settings.vendor.test.startTest") }}
        </t-button>
      </div>
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
/**
 * 视频模型测试面板（SIY-159 方案C：代码即目录的纯投影渲染器）。
 * 控件只认 modelDetail 的字段名（mode / durationResolutionMap / durationContinuous / aspectRatioOptions /
 * qualityOptions / controls / promptLengthRange / promptRequired / resolutionNote / promptSlotReferences），
 * 永不按模型名特判；后端 runninghub-models.ts 的 DSL 是校验权威，本面板校验仅为提交前的前置体验优化。
 */
import axios from "@/utils/axios";
import ImageUploadBox from "./ImageUploadBox.vue";
import VideoUploadBox from "./VideoUploadBox.vue";
import AudioUploadBox from "./AudioUploadBox.vue";
import VideoParamFields from "@/components/VideoParamFields.vue";
import type { VideoParamField } from "@/types/quickVideo";

type VideoRawMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | string // videoReference:N, imageReference:N, audioReference:N
  | string[]; // 数组组合，即 multiReference

interface RefItem {
  type: "videoReference" | "imageReference" | "audioReference";
  count: number;
}

interface ParsedMode {
  key: string;
  label: string;
  desc: string;
  refs?: RefItem[];
}

const props = defineProps<{
  vendorId: string;
  modelName: string;
  /** 模型协议目录条目（含 mode/durationResolutionMap/controls 等全部元数据） */
  modelDetail: any;
}>();
const visible = defineModel<boolean>("modelVisible");

const SIMPLE_MODE_MAP: Record<string, { label: string; desc: string }> = {
  text: {
    label: $t("settings.vendor.test.textToVideo"),
    desc: $t("settings.vendor.test.textToVideoDesc"),
  },
  singleImage: {
    label: $t("settings.vendor.test.singleImageMode"),
    desc: $t("settings.vendor.test.singleImageDesc"),
  },
  startEndRequired: {
    label: $t("settings.vendor.startEndRequired"),
    desc: $t("settings.vendor.test.startEndRequiredDesc"),
  },
  endFrameOptional: {
    label: $t("settings.vendor.endFrameOptional"),
    desc: $t("settings.vendor.test.endFrameOptionalDesc"),
  },
  startFrameOptional: {
    label: $t("settings.vendor.startFrameOptional"),
    desc: $t("settings.vendor.test.startFrameOptionalDesc"),
  },
};

/** 解析 modelDetail.mode，生成可展示的 mode 列表 */
const parsedModes = computed<ParsedMode[]>(() => {
  const result: ParsedMode[] = [];
  let multiRefIdx = 0;
  for (const m of props.modelDetail?.mode ?? []) {
    if (Array.isArray(m)) {
      // multiReference 数组
      const refs: RefItem[] = [];
      for (const ref of m) {
        const match = String(ref).match(/^(videoReference|imageReference|audioReference):(\d+)$/);
        if (match) {
          refs.push({
            type: match[1] as RefItem["type"],
            count: Number(match[2]),
          });
        }
      }
      if (refs.length > 0) {
        multiRefIdx++;
        const labelParts = refs
          .map((r) => {
            const typeLabel =
              r.type === "imageReference"
                ? $t("settings.vendor.imageRef")
                : r.type === "videoReference"
                  ? $t("settings.vendor.videoRef")
                  : $t("settings.vendor.audioRef");
            return `${typeLabel}×${r.count}`;
          })
          .join(" + ");
        result.push({
          key: JSON.stringify(m),
          label: labelParts,
          desc: `${$t("settings.vendor.test.multiRefDesc")}: ${labelParts}`,
          refs,
        });
      }
    } else {
      const info = SIMPLE_MODE_MAP[String(m)];
      if (info) {
        result.push({ key: String(m), label: info.label, desc: info.desc });
      }
    }
  }
  return result;
});

const selectedMode = ref("");

watch(
  parsedModes,
  (modes) => {
    if (modes.length > 0 && !modes.find((m) => m.key === selectedMode.value)) {
      selectedMode.value = modes[0]?.key ?? "";
    }
  },
  { immediate: true },
);

watch(selectedMode, () => {
  resetUploads();
  resultUrl.value = "";
});

const currentModeInfo = computed(() => parsedModes.value.find((m) => m.key === selectedMode.value) ?? null);

const currentMultiRefs = computed<RefItem[]>(() => currentModeInfo.value?.refs ?? []);

// ================
// 参数面板元数据投影（SIY-161：与快创聊天参数确认卡共用 VideoParamFields 渲染）
// ================

/** 把 modelDetail 元数据投影成参数字段（不含输入模式——模式在上方单独选择） */
const paramFields = computed<VideoParamField[]>(() => {
  const detail = props.modelDetail ?? {};
  const fields: VideoParamField[] = [];
  const ratioOptions: { value: string; label: string }[] = detail.aspectRatioOptions ?? [];
  if (ratioOptions.length) {
    fields.push({
      key: "aspectRatio",
      label: $t("settings.vendor.test.aspectRatio"),
      type: "select",
      value: ratioOptions.some((o) => o.value === "9:16") ? "9:16" : ratioOptions[0].value,
      options: ratioOptions.map((o) => ({ value: o.value, label: o.label })),
      advanced: false,
      source: "system",
    });
  }

  const continuous = !!detail.durationContinuous;
  const groups: { duration: number[]; resolution: string[] }[] = detail.durationResolutionMap ?? [];
  if (continuous) {
    const nums = [...(groups[0]?.duration ?? [5, 15])].sort((a, b) => a - b);
    fields.push({
      key: "duration",
      label: $t("settings.vendor.test.duration"),
      type: "slider",
      value: Math.min(15, Math.max(5, nums[0] ?? 5)),
      min: nums[0] ?? 5,
      max: nums[nums.length - 1] ?? 15,
      step: 0.5,
      advanced: false,
      source: "system",
    });
  } else {
    const seen = new Set<number>();
    for (const group of groups) for (const d of group.duration ?? []) seen.add(d);
    const tiers = [...seen].sort((a, b) => a - b);
    if (tiers.length > 1) {
      fields.push({
        key: "duration",
        label: $t("settings.vendor.test.duration"),
        type: "select",
        value: tiers.includes(5) ? 5 : tiers[0],
        options: tiers.map((d) => ({ value: d, label: d === -1 ? $t("settings.vendor.test.durationAuto") : `${d}s` })),
        advanced: false,
        source: "system",
      });
    }
  }

  const qualityOptions: string[] = detail.qualityOptions ?? [];
  if (qualityOptions.length) {
    fields.push({
      key: "quality",
      label: $t("settings.vendor.test.quality"),
      type: "select",
      value: qualityOptions[0],
      options: qualityOptions.map((q) => ({ value: q, label: $t(`settings.vendor.test.quality_${q}`) })),
      advanced: false,
      source: "system",
    });
  }

  // 分辨率档位（跨组去重；"default" 占位与单一固定档不出控件）
  const seenRes = new Set<string>();
  for (const group of groups) for (const r of group.resolution ?? []) seenRes.add(r);
  const resolutions = [...seenRes];
  if (resolutions.length > 1) {
    fields.push({
      key: "resolution",
      label: $t("settings.vendor.test.resolution"),
      type: "select",
      value: resolutions[0],
      options: resolutions.map((r) => ({ value: r, label: r })),
      advanced: false,
      source: "system",
      note: detail.resolutionNote,
    });
  }

  // 高级开关（controls 元数据声明驱动）
  const controls: string[] = detail.controls ?? [];
  if (controls.includes("generateAudio")) {
    fields.push({ key: "generateAudio", label: $t("settings.vendor.test.generateAudio"), type: "switch", value: false, advanced: false, source: "system" });
  }
  if (controls.includes("returnLastFrame")) {
    fields.push({ key: "returnLastFrame", label: $t("settings.vendor.test.returnLastFrame"), type: "switch", value: false, advanced: true, source: "system" });
  }
  if (controls.includes("realPersonMode")) {
    fields.push({ key: "realPersonMode", label: $t("settings.vendor.test.realPersonMode"), type: "switch", value: false, advanced: true, source: "system" });
  }
  if (controls.includes("seed")) {
    fields.push({ key: "seed", label: $t("settings.vendor.test.seed"), type: "number", value: null, min: -1, max: 2147483647, step: 1, advanced: true, source: "system" });
  }
  return fields;
});

/** 受控参数值：key -> 当前值（用户修改经 onParamUpdate 回写） */
const paramValues = ref<Record<string, string | number | boolean | null>>({});

watch(
  paramFields,
  (fields) => {
    const next: Record<string, string | number | boolean | null> = {};
    for (const field of fields) next[field.key] = field.value;
    paramValues.value = next;
  },
  { immediate: true },
);

function onParamUpdate(field: VideoParamField, value: string | number | boolean | null) {
  paramValues.value = { ...paramValues.value, [field.key]: value };
}

// ================
// 提示词与素材
// ================

const prompt = ref("");
const promptLengthRange = computed<[number, number] | null>(() => props.modelDetail?.promptLengthRange ?? null);
const promptRequired = computed<boolean>(() => props.modelDetail?.promptRequired ?? selectedMode.value === "text");

const uploadedImages = ref<(File | null)[]>(Array(30).fill(null));
const uploadedVideos = ref<(File | null)[]>(Array(30).fill(null));
const uploadedAudios = ref<(File | null)[]>(Array(30).fill(null));
const loading = ref(false);
const resultUrl = ref("");

function resetUploads() {
  uploadedImages.value = Array(30).fill(null);
  uploadedVideos.value = Array(30).fill(null);
  uploadedAudios.value = Array(30).fill(null);
}

const promptPlaceholder = computed(() =>
  promptRequired.value ? $t("settings.vendor.test.promptPlaceholder") : $t("settings.vendor.test.videoPromptPlaceholder"),
);

/** @Image N / @Video N 引用 chip（promptSlotReferences 元数据声明后才出现） */
const showSlotChips = computed(() => !!props.modelDetail?.promptSlotReferences && currentMultiRefs.value.length > 0);

const slotChips = computed<{ token: string }[]>(() => {
  if (!showSlotChips.value) return [];
  const chips: { token: string }[] = [];
  for (const ref of currentMultiRefs.value) {
    if (ref.type === "imageReference") {
      const uploaded = countUploaded(uploadedImages.value);
      for (let k = 1; k <= Math.min(ref.count, uploaded); k++) chips.push({ token: `@Image ${k}` });
    } else if (ref.type === "videoReference") {
      const uploaded = countUploaded(uploadedVideos.value);
      for (let k = 1; k <= Math.min(ref.count, uploaded); k++) chips.push({ token: `@Video ${k}` });
    }
  }
  return chips;
});

function countUploaded(list: (File | null)[]): number {
  return list.filter(Boolean).length;
}

function insertSlotToken(token: string) {
  prompt.value = prompt.value.trimEnd() ? `${prompt.value.trimEnd()} ${token}` : token;
}

/** requireVisual 约束（由 mode 含 audioReference 推导）：未传任何视觉素材时音频区禁用 */
const audioDisabled = computed(() => {
  const hasAudio = currentMultiRefs.value.some((r) => r.type === "audioReference");
  if (!hasAudio) return false;
  return countUploaded(uploadedImages.value) + countUploaded(uploadedVideos.value) === 0;
});

const canSubmit = computed(() => {
  if (loading.value || !selectedMode.value) return false;
  if (promptRequired.value && !prompt.value.trim()) return false;
  if (selectedMode.value === "text") return !!prompt.value.trim();
  if (selectedMode.value === "singleImage") return !!uploadedImages.value[0];
  if (selectedMode.value === "startEndRequired") return !!uploadedImages.value[0] && !!uploadedImages.value[1];
  if (selectedMode.value === "endFrameOptional") return !!uploadedImages.value[0];
  if (selectedMode.value === "startFrameOptional") return !!uploadedImages.value[1];
  if (selectedMode.value.startsWith("[")) {
    // 多参考模式：素材均按上限可选；音频必须搭配视觉素材（requireVisual）
    if (audioDisabled.value && countUploaded(uploadedAudios.value) > 0) return false;
    return true;
  }
  return false;
});

/** 提示词中的 @Image N / @Video N 引用与已传素材数量一致性校验（提交前置） */
function validateSlotReferences(): string | null {
  if (!props.modelDetail?.promptSlotReferences) return null;
  const imageCount = countUploaded(uploadedImages.value);
  const videoCount = countUploaded(uploadedVideos.value);
  const invalid: string[] = [];
  for (const match of prompt.value.matchAll(/@(Image|Video)\s+(\d+)/gi)) {
    const kind = match[1].toLowerCase();
    const idx = Number(match[2]);
    const limit = kind === "image" ? imageCount : videoCount;
    if (idx < 1 || idx > limit) invalid.push(`@${match[1]} ${idx}`);
  }
  return invalid.length ? [...new Set(invalid)].join("、") : null;
}

function getRefLabel(ref: RefItem): string {
  if (ref.type === "imageReference") return `${$t("settings.vendor.imageRef")} (×${ref.count})`;
  if (ref.type === "videoReference") return `${$t("settings.vendor.videoRef")} (×${ref.count})`;
  return `${$t("settings.vendor.audioRef")} (×${ref.count})`;
}
function fileToDataURL(file: File) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result); // data:xxx/yyy;base64,....
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function mapTopType(mime = "") {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return ""; // 不认识就空
}
async function encodeFiles(files: File[]) {
  const valid = (files || []).filter(Boolean);
  return Promise.all(
    valid.map(async (f) => ({
      type: mapTopType(f.type),
      base64: await fileToDataURL(f), // 带前缀 data:...;base64,...
    })),
  );
}
async function handleTest() {
  // 提交前置校验（后端 DSL 为准，这里只做体验优化）
  const range = promptLengthRange.value;
  if (range && prompt.value.trim() && (prompt.value.length < range[0] || prompt.value.length > range[1])) {
    window.$message.error($t("settings.vendor.test.promptLengthMsg", { min: range[0], max: range[1] }));
    return;
  }
  if (promptRequired.value && !prompt.value.trim()) {
    window.$message.error($t("settings.vendor.test.promptRequiredMsg"));
    return;
  }
  const invalidSlots = validateSlotReferences();
  if (invalidSlots) {
    window.$message.error($t("settings.vendor.test.slotRefInvalid", { slots: invalidSlots }));
    return;
  }

  loading.value = true;
  resultUrl.value = "";
  try {
    const payload: Record<string, any> = {
      modelName: props.modelName,
      id: props.vendorId,
      mode: selectedMode.value,
      ...(prompt.value.trim() ? { prompt: prompt.value.trim() } : {}),
      images: await encodeFiles(uploadedImages.value.filter(Boolean) as File[]),
      videos: await encodeFiles(uploadedVideos.value.filter(Boolean) as File[]),
      audios: await encodeFiles(uploadedAudios.value.filter(Boolean) as File[]),
    };
    // 参数透传（SIY-161）：直接取共享投影组件的受控值，未声明字段不会出现在 payload
    if (paramValues.value.aspectRatio) payload.aspectRatio = paramValues.value.aspectRatio;
    if (paramValues.value.duration !== undefined && paramValues.value.duration !== null) payload.duration = Number(paramValues.value.duration);
    if (paramValues.value.resolution) payload.resolution = paramValues.value.resolution;
    if (paramValues.value.quality) payload.quality = paramValues.value.quality;
    if (paramValues.value.generateAudio !== undefined) payload.generateAudio = Boolean(paramValues.value.generateAudio);
    if (paramValues.value.returnLastFrame !== undefined) payload.returnLastFrame = Boolean(paramValues.value.returnLastFrame);
    if (paramValues.value.realPersonMode) payload.realPersonMode = true;
    if (paramValues.value.seed !== undefined && paramValues.value.seed !== null) payload.seed = Number(paramValues.value.seed);
    const { data } = await axios.post("/setting/vendorConfig/modelTest/videoTest", payload, {
      timeout: 30 * 60 * 1000,
    });
    resultUrl.value = data;
    window.$message.success($t("settings.vendor.msg.videoGenSuccess"));
  } catch (e: any) {
    window.$message.error(e?.message ?? `${$t("settings.vendor.msg.requestFailed")}`);
  } finally {
    loading.value = false;
  }
}

function handleClose() {
  prompt.value = "";
  resetUploads();
  resultUrl.value = "";
  loading.value = false;
}
</script>

<style lang="scss" scoped>
.videoTestDialog {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 80vh;
  overflow-y: auto;
  padding-right: 2px;

  .modeBar {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;

    .modeLabel {
      font-size: 13px;
      color: var(--td-text-color-secondary);
    }
  }

  .modeDesc {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--td-text-color-secondary);
    background: var(--td-bg-color-container-hover);
    padding: 6px 12px;
    border-radius: 6px;
  }

  .inputSection {
    display: flex;
    flex-direction: column;
    gap: 10px;

    .promptArea {
      width: 100%;

    }

    .frameRow {
      display: flex;
      align-items: flex-start;
      gap: 16px;

      .frameArrow {
        margin-top: 32px;
        font-size: 20px;
        color: var(--td-text-color-placeholder);
        flex-shrink: 0;
      }
    }

    .uploadRow {
      display: flex;
      gap: 12px;
    }

    .slotChipRow {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;

      .slotChipLabel {
        font-size: 12px;
        color: var(--td-text-color-secondary);
      }

      .slotChip {
        cursor: pointer;
        user-select: none;
      }
    }

    .refHint {
      width: 100%;
      margin-top: 4px;
      font-size: 12px;
      color: var(--td-warning-color);
    }

    .multiRefSection {
      display: flex;
      flex-direction: column;
      gap: 12px;

      .multiRefRow {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }
    }
  }

  .advancedCollapse {
    border: 1px solid var(--td-component-border);
    border-radius: 6px;

    .advancedGrid {
      display: flex;
      gap: 24px;
      flex-wrap: wrap;
    }
  }

  .resultSection {
    .resultLabel {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--td-text-color-secondary);
    }

    .resultVideo {
      width: 100%;
      max-height: 40vh;
      border-radius: 8px;
      background: #000;
    }
  }

  .loadingSection {
    display: flex;
    justify-content: center;
    padding: 32px 0;
  }

  .dialogFooter {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    border-top: 1px solid var(--td-component-border);
    padding-top: 12px;
    position: sticky;
    bottom: 0;
    background: var(--td-bg-color-container);
    padding-bottom: 4px;
  }
}
</style>
