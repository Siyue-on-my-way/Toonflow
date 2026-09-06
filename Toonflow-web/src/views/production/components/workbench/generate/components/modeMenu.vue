<template>
  <div class="modeMenu">
    <div class="left f ac">
      <div class="model">
        <modelSelect v-model="modelParmas.model" type="video" size="small" />
      </div>
      <t-select
        size="small"
        class="mode"
        :value="modelParmas.mode"
        :disabled="modeList.length === 0"
        :placeholder="modeList.length ? '选择视频模式' : '请先选择视频模型'"
        :onChange="handleBeforeChange">
        <t-option v-for="(item, index) in modeList" :key="index" :value="item.value" :label="item.label"></t-option>
      </t-select>
      <t-tooltip v-if="selectedModeHint" :content="selectedModeHint" placement="bottom">
        <span class="modeHint">模式说明</span>
      </t-tooltip>
      <t-select
        v-if="modeOptions.qualityOptions?.length"
        v-model="modelParmas.quality"
        size="small"
        class="quality">
        <t-option value="std" label="标准"></t-option>
        <t-option value="pro" label="专业"></t-option>
      </t-select>
      <t-button
        v-if="modeOptions.audio === true || modeOptions.audio === 'optional'"
        size="small"
        variant="outline"
        :theme="modelParmas.audio ? 'success' : 'danger'"
        class="audio"
        @click="modelParmas.audio = !modelParmas.audio">
        <template #icon>
          <i-volume-notice v-if="modelParmas.audio" size="16" />
          <i-volume-mute v-else size="16" />
        </template>
      </t-button>
      <div class="status">
        <t-popup
          trigger="click"
          placement="top"
          overlay-class-name="resDurPickerPopup"
          :overlay-inner-style="{ padding: '16px', borderRadius: '8px' }">
          <t-tag class="btn" variant="outline">{{ modelParmas.aspectRatio }}·{{ modelParmas.resolution }}·{{ modelParmas.duration }}s</t-tag>
          <template #content>
            <div class="resolutionDurationPicker">
              <div v-if="aspectRatioOptions.length > 0" class="pickerSection">
                <div class="pickerLabel">{{ $t("workbench.project.dialog.videoRatio") }}</div>
                <div class="pickerOptions">
                  <div
                    v-for="ratio in aspectRatioOptions"
                    :key="ratio.value"
                    class="pickerOption"
                    :class="{ active: modelParmas.aspectRatio === ratio.value }"
                    @click="modelParmas.aspectRatio = ratio.value">
                    {{ ratio.label }}
                  </div>
                </div>
              </div>
              <div v-if="resolutionOptions.length > 0" class="pickerSection">
                <div class="pickerLabel">{{ $t("workbench.generate.resolution") }}</div>
                <div class="pickerOptions">
                  <div
                    v-for="res in resolutionOptions"
                    :key="res"
                    class="pickerOption"
                    :class="{ active: modelParmas.resolution == res }"
                    @click="modelParmas.resolution = res">
                    {{ res }}
                  </div>
                </div>
              </div>
              <div v-if="durationOptions.length > 0" class="pickerSection">
                <div class="pickerLabel">{{ $t("workbench.generate.duration") }}</div>
                <div class="pickerOptions">
                  <div
                    v-for="dur in durationOptions"
                    :key="dur"
                    class="pickerOption"
                    :class="{ active: modelParmas.duration == dur }"
                    @click="updateDuration(dur)">
                    {{ dur }}s
                  </div>
                </div>
              </div>
            </div>
          </template>
        </t-popup>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import "@/views/production/components/workbench/type/type";
import axios from "@/utils/axios";

const props = defineProps<{
  modeOptions: VideoModel;
  modeList: { value: string; label: string }[];
  trackId: number | undefined;
}>();
const modelParmas = defineModel<ModelSetting>({
  default: {
    mode: "",
    model: "",
    resolution: "480p",
    duration: 8,
    audio: false,
    aspectRatio: "16:9",
    quality: "std",
  },
});
const emit = defineEmits(["modeChange"]);

const DEFAULT_ASPECT_RATIO_OPTIONS: VideoAspectRatioOption[] = [
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
];

const aspectRatioOptions = computed(() => {
  const options = props.modeOptions?.aspectRatioOptions;
  return Array.isArray(options) && options.length > 0 ? options : DEFAULT_ASPECT_RATIO_OPTIONS;
});

const durationResolutionRows = computed(() => {
  const rows = props.modeOptions?.durationResolutionMap;
  return Array.isArray(rows) ? rows : [];
});

const durationOptions = computed(() => [...new Set(durationResolutionRows.value.flatMap((row) => row.duration ?? []))]);

const selectedDurationResolutionRow = computed(() => {
  return (
    durationResolutionRows.value.find((row) => row.duration?.includes(modelParmas.value.duration)) ||
    durationResolutionRows.value[0]
  );
});

const resolutionOptions = computed(() => selectedDurationResolutionRow.value?.resolution ?? []);

const selectedModeHint = computed(() => {
  const hints: Record<string, string> = {
    text: "文生视频：不需要参考帧",
    singleImage: "单图模式：需要 1 张首帧",
    startEndRequired: "首尾帧模式：首帧和尾帧都必填",
    endFrameOptional: "尾帧可选：需要首帧，尾帧可选",
    startFrameOptional: "首帧可选：需要尾帧，首帧可选",
  };
  const selected = props.modeList.find((item) => item.value === modelParmas.value.mode);
  if (!selected) return "";
  return hints[modelParmas.value.mode] || `${selected.label}：请按下方素材槽位上传参考素材`;
});

function handleBeforeChange(newVal: unknown) {
  emit("modeChange", String(newVal ?? ""));
}
function updateDuration(newDuration: number) {
  modelParmas.value.duration = newDuration;
  const row = durationResolutionRows.value.find((item) => item.duration?.includes(newDuration));
  if (row?.resolution?.length && !row.resolution.includes(modelParmas.value.resolution)) {
    modelParmas.value.resolution = row.resolution[0];
  }
  if (props.trackId) axios.post("/production/workbench/updateVideoDuration", { id: props.trackId, duration: newDuration });
}
</script>

<style lang="scss" scoped>
.modeMenu {
  width: 100%;
  .left {
    flex: 1;
    gap: 8px;
    .mode {
      width: 280px;
    }
    .modeHint {
      color: var(--td-text-color-secondary);
      font-size: 12px;
      cursor: help;
      white-space: nowrap;
    }
    .quality {
      width: 104px;
    }
    .status {
      .btn {
        cursor: pointer;
        &:hover {
          background-color: var(--td-bg-color-secondarycontainer);
        }
      }
    }
  }
}
</style>
<style lang="scss">
.resolutionDurationPicker {
  min-width: 240px;
  .pickerSection {
    margin-bottom: 16px;

    &:last-child {
      margin-bottom: 0;
    }

    .pickerLabel {
      font-size: 13px;
      font-weight: 600;
      color: var(--td-text-color-primary);
      margin-bottom: 10px;
    }

    .pickerOptions {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;

      .pickerOption {
        padding: 6px 0;
        border-radius: 8px;
        border: 1.5px solid var(--td-border-level-1-color);
        font-size: 13px;
        color: var(--td-text-color-primary);
        cursor: pointer;
        transition: all 0.15s;
        user-select: none;
        text-align: center;
        background: var(--td-bg-color-container);

        &:hover {
          border-color: var(--td-border-level-2-color);
        }

        &.active {
          border-color: var(--td-text-color-primary);
          color: var(--td-text-color-primary);
          font-weight: 500;
        }
      }
    }
  }
}
</style>
