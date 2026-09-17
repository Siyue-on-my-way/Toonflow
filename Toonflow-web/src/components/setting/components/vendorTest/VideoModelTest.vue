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

      <!-- 参数面板：全部控件由 modelDetail 元数据投影生成，未声明的不出现 -->
      <div class="paramSection" v-if="hasParamControls">
        <div class="paramRow">
          <t-form-item v-if="aspectRatioOptions.length" :label="$t('settings.vendor.test.aspectRatio')" class="paramItem">
            <t-select v-model="aspectRatio" :disabled="loading">
              <t-option v-for="option in aspectRatioOptions" :key="option.value" :value="option.value" :label="option.label" />
            </t-select>
          </t-form-item>
          <t-form-item v-if="!durationContinuous && durationOptions.length > 1" :label="$t('settings.vendor.test.duration')" class="paramItem">
            <t-select v-model="duration" :disabled="loading">
              <t-option v-for="d in durationOptions" :key="d" :value="d" :label="durationLabel(d)" />
            </t-select>
          </t-form-item>
          <t-form-item v-if="qualityOptions.length" :label="$t('settings.vendor.test.quality')" class="paramItem">
            <t-select v-model="quality" :disabled="loading">
              <t-option v-for="q in qualityOptions" :key="q" :value="q" :label="$t(`settings.vendor.test.quality_${q}`)" />
            </t-select>
          </t-form-item>
        </div>
        <!-- 时长连续区间（如 5-15 秒）：滑条 -->
        <t-form-item v-if="durationContinuous" :label="$t('settings.vendor.test.duration')" class="sliderItem">
          <t-slider v-model="duration" :min="durationRange.min" :max="durationRange.max" :step="0.5" :disabled="loading" :label="`${duration}s`" />
        </t-form-item>
        <t-form-item v-if="resolutionOptions.length" :label="$t('settings.vendor.test.resolution')" class="paramItem">
          <t-select v-model="resolution" :disabled="loading">
            <t-option v-for="r in resolutionOptions" :key="r" :value="r" :label="r" />
          </t-select>
        </t-form-item>
        <t-alert v-if="modelDetail?.resolutionNote" class="noteAlert" theme="warning" :message="modelDetail.resolutionNote" />
      </div>

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

      <!-- 高级参数折叠区：仅渲染元数据 controls 声明过的开关 -->
      <t-collapse v-if="advancedControls.length" class="advancedCollapse">
        <t-collapse-panel :value="'advanced'" :header="$t('settings.vendor.test.advancedParams')">
          <div class="advancedGrid">
            <t-form-item v-if="hasControl('generateAudio')" :label="$t('settings.vendor.test.generateAudio')">
              <t-switch v-model="advanced.generateAudio" :disabled="loading" />
            </t-form-item>
            <t-form-item v-if="hasControl('returnLastFrame')" :label="$t('settings.vendor.test.returnLastFrame')">
              <t-switch v-model="advanced.returnLastFrame" :disabled="loading" />
            </t-form-item>
            <t-form-item v-if="hasControl('realPersonMode')" :label="$t('settings.vendor.test.realPersonMode')">
              <t-switch v-model="advanced.realPersonMode" :disabled="loading" />
            </t-form-item>
            <t-form-item v-if="hasControl('seed')" :label="$t('settings.vendor.test.seed')">
              <t-input-number
                v-model="advanced.seed"
                :min="-1"
                :max="2147483647"
                :step="1"
                theme="column"
                :placeholder="$t('settings.vendor.test.seedPlaceholder')"
                :disabled="loading"
                style="width: 160px" />
            </t-form-item>
          </div>
        </t-collapse-panel>
      </t-collapse>

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
// 参数面板元数据投影
// ================

const aspectRatioOptions = computed<{ value: string; label: string }[]>(() => props.modelDetail?.aspectRatioOptions ?? []);
const qualityOptions = computed<string[]>(() => props.modelDetail?.qualityOptions ?? []);
const durationContinuous = computed(() => !!props.modelDetail?.durationContinuous);
const durationGroups = computed<{ duration: number[]; resolution: string[] }[]>(() => props.modelDetail?.durationResolutionMap ?? []);

/** 离散时长档位（跨组去重；-1 为"自动"档） */
const durationOptions = computed<number[]>(() => {
  if (durationContinuous.value) return [];
  const seen = new Set<number>();
  for (const group of durationGroups.value) for (const d of group.duration ?? []) seen.add(d);
  return [...seen].sort((a, b) => a - b);
});

/** 连续时长区间（durationContinuous 时取第一组 [min, max]） */
const durationRange = computed(() => {
  const list = durationGroups.value[0]?.duration ?? [5, 15];
  const nums = [...list].sort((a, b) => a - b);
  return { min: nums[0] ?? 5, max: nums[nums.length - 1] ?? 15 };
});

/** 分辨率档位（跨组去重；"default" 是无分辨率参数模型的占位，不出控件） */
const resolutionOptions = computed<string[]>(() => {
  const seen = new Set<string>();
  for (const group of durationGroups.value) for (const r of group.resolution ?? []) seen.add(r);
  const list = [...seen];
  return list.length === 1 && list[0] === "default" ? [] : list;
});

const hasParamControls = computed(
  () => aspectRatioOptions.value.length > 0 || durationOptions.value.length > 0 || durationContinuous.value || resolutionOptions.value.length > 0 || qualityOptions.value.length > 0,
);

function durationLabel(d: number): string {
  return d === -1 ? $t("settings.vendor.test.durationAuto") : `${d}s`;
}

const aspectRatio = ref("");
const duration = ref<number>(5);
const resolution = ref("");
const quality = ref("");

watch(
  aspectRatioOptions,
  (options) => {
    if (!options.some((o) => o.value === aspectRatio.value)) {
      // 常用默认 9:16，其次取首项
      const preferred = options.find((o) => o.value === "9:16");
      aspectRatio.value = preferred?.value ?? options[0]?.value ?? "";
    }
  },
  { immediate: true },
);
watch(
  durationOptions,
  (options) => {
    if (!options.includes(duration.value)) {
      duration.value = options.includes(5) ? 5 : options[0] ?? 5;
    }
  },
  { immediate: true },
);
watch(durationContinuous, (continuous) => {
  if (continuous && (duration.value < durationRange.value.min || duration.value > durationRange.value.max)) {
    duration.value = Math.min(15, Math.max(5, duration.value));
  }
});
watch(
  resolutionOptions,
  (options) => {
    if (!options.includes(resolution.value)) {
      resolution.value = options[0] ?? "";
    }
  },
  { immediate: true },
);
watch(
  qualityOptions,
  (options) => {
    if (!options.includes(quality.value)) {
      quality.value = options[0] ?? "";
    }
  },
  { immediate: true },
);

// ================
// 高级参数（controls 元数据声明驱动）
// ================

const advancedControls = computed<string[]>(() => props.modelDetail?.controls ?? []);
function hasControl(name: string): boolean {
  return advancedControls.value.includes(name);
}
const advanced = ref({ generateAudio: false, returnLastFrame: false, realPersonMode: false, seed: undefined as number | undefined });
watch(advancedControls, () => {
  advanced.value = { generateAudio: false, returnLastFrame: false, realPersonMode: false, seed: undefined };
});

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
    if (aspectRatio.value) payload.aspectRatio = aspectRatio.value;
    if (durationContinuous.value || durationOptions.value.length > 0) payload.duration = Number(duration.value);
    if (resolutionOptions.value.length) payload.resolution = resolution.value;
    if (qualityOptions.value.length && quality.value) payload.quality = quality.value;
    if (hasControl("generateAudio")) payload.generateAudio = advanced.value.generateAudio;
    if (hasControl("returnLastFrame")) payload.returnLastFrame = advanced.value.returnLastFrame;
    if (hasControl("realPersonMode") && advanced.value.realPersonMode) payload.realPersonMode = true;
    if (hasControl("seed") && advanced.value.seed !== undefined && advanced.value.seed !== null) payload.seed = advanced.value.seed;
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

  .paramSection {
    display: flex;
    flex-direction: column;
    gap: 8px;

    .paramRow {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;

      .paramItem {
        flex: 1;
        min-width: 140px;
      }
    }

    .noteAlert {
      margin-top: 2px;
    }
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
