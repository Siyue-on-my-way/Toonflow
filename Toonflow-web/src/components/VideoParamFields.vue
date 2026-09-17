<template>
  <div class="videoParamFields">
    <!-- 一级核心项：输入模式 / 时长 / 比例 / 画质档或分辨率 / 音频 -->
    <div class="coreGrid">
      <template v-for="field in coreFields" :key="field.key">
        <t-form-item class="fieldItem" :label="field.label">
          <template #label>
            <span class="labelRow">
              {{ field.label }}
              <t-tag v-if="showSource" size="small" variant="outline" :theme="sourceTheme(field.source)" class="sourceTag">{{ sourceLabel(field.source) }}</t-tag>
            </span>
          </template>
          <!-- 枚举下拉 -->
          <t-select
            v-if="field.type === 'select'"
            :value="String(modelValue[field.key] ?? '')"
            :disabled="disabled"
            @change="(v: any) => emitChange(field, v)">
            <t-option
              v-for="option in field.options ?? []"
              :key="String(option.value)"
              :value="String(option.value)"
              :label="option.label"
              :disabled="option.disabled">
              <div class="optionRow" :class="{ deemphasized: option.deemphasized && !option.disabled }">
                <span>{{ option.label }}</span>
                <span v-if="option.hint" class="optionHint">{{ option.hint }}</span>
              </div>
            </t-option>
          </t-select>
          <!-- 连续区间滑条 -->
          <div v-else-if="field.type === 'slider'" class="sliderRow">
            <t-slider
              :value="Number(modelValue[field.key] ?? field.min ?? 0)"
              :min="field.min"
              :max="field.max"
              :step="field.step ?? 0.5"
              :disabled="disabled"
              @change="(v: any) => emitChange(field, Number(v))" />
            <span class="sliderValue">{{ modelValue[field.key] }}s</span>
          </div>
          <!-- 开关 -->
          <t-switch v-else-if="field.type === 'switch'" :value="Boolean(modelValue[field.key])" :disabled="disabled" @change="(v: any) => emitChange(field, Boolean(v))" />
          <!-- 整数输入 -->
          <t-input-number
            v-else
            :value="modelValue[field.key] === null || modelValue[field.key] === undefined ? undefined : Number(modelValue[field.key])"
            :min="field.min"
            :max="field.max"
            :step="field.step ?? 1"
            theme="column"
            :disabled="disabled"
            style="width: 160px"
            @change="(v: any) => emitChange(field, v === undefined || v === null ? null : Number(v))" />
        </t-form-item>
        <div v-if="field.note" :key="`${field.key}-note`" class="fieldNote">{{ field.note }}</div>
      </template>
    </div>

    <!-- 高级参数折叠区：仅渲染 advanced 字段（元数据声明驱动，禁止按模型名特判） -->
    <t-collapse v-if="advancedFields.length" class="advancedCollapse">
      <t-collapse-panel :value="'advanced'" :header="$t('settings.vendor.test.advancedParams')">
        <div class="advancedGrid">
          <template v-for="field in advancedFields" :key="field.key">
            <t-form-item class="fieldItem" :label="field.label">
              <t-select
                v-if="field.type === 'select'"
                :value="String(modelValue[field.key] ?? '')"
                :disabled="disabled"
                @change="(v: any) => emitChange(field, v)">
                <t-option v-for="option in field.options ?? []" :key="String(option.value)" :value="String(option.value)" :label="option.label" :disabled="option.disabled" />
              </t-select>
              <t-switch v-else-if="field.type === 'switch'" :value="Boolean(modelValue[field.key])" :disabled="disabled" @change="(v: any) => emitChange(field, Boolean(v))" />
              <t-input-number
                v-else
                :value="modelValue[field.key] === null || modelValue[field.key] === undefined ? undefined : Number(modelValue[field.key])"
                :min="field.min"
                :max="field.max"
                :step="field.step ?? 1"
                theme="column"
                :disabled="disabled"
                style="width: 160px"
                @change="(v: any) => emitChange(field, v === undefined || v === null ? null : Number(v))" />
            </t-form-item>
          </template>
        </div>
      </t-collapse-panel>
    </t-collapse>
  </div>
</template>

<script setup lang="ts">
/**
 * 视频生成参数控件投影渲染器（SIY-161：从设置页 VideoModelTest.vue 抽出的共享组件）。
 * 输入是后端契约的 VideoParamField[]（模型元数据投影 + 来源标记），输出是控件组与用户修改事件。
 * 只认字段元数据（type/options/min/max/step/advanced/note），永不按模型名特判；
 * 设置页测试面板与快创聊天参数确认卡共用同一投影，保证"卡片 = 元数据"口径一致。
 */
import type { VideoParamField } from "@/types/quickVideo";

const props = defineProps<{
  /** 待渲染的参数字段（核心项 + 高级项由 advanced 标记区分） */
  fields: VideoParamField[];
  /** 当前参数值（key -> value），由父组件持有（受控模式） */
  modelValue: Record<string, string | number | boolean | null>;
  /** 生成中/卡片失效时禁用全部控件 */
  disabled?: boolean;
  /** 渲染参数来源标记（AI 预填 / 我的修改 / 系统默认 / 上次确认），确认卡开启 */
  showSource?: boolean;
}>();

const emit = defineEmits<{
  /** 字段修改；value 为 null 表示清空（如 seed 留空随机） */
  (e: "update", field: VideoParamField, value: string | number | boolean | null): void;
}>();

const coreFields = computed(() => props.fields.filter((f) => !f.advanced));
const advancedFields = computed(() => props.fields.filter((f) => f.advanced));

function emitChange(field: VideoParamField, value: string | number | boolean | null) {
  emit("update", field, value);
}

/** 参数来源标签文案与配色（可追溯：AI 预填 / 我的修改 / 系统默认 / 上次确认） */
function sourceLabel(source: VideoParamField["source"]): string {
  switch (source) {
    case "llm":
      return "AI 预填";
    case "user":
      return "我的修改";
    case "preference":
      return "上次确认";
    default:
      return "系统默认";
  }
}
function sourceTheme(source: VideoParamField["source"]): "primary" | "success" | "warning" | "default" {
  switch (source) {
    case "llm":
      return "primary";
    case "user":
      return "success";
    case "preference":
      return "warning";
    default:
      return "default";
  }
}
</script>

<style lang="scss" scoped>
.videoParamFields {
  display: flex;
  flex-direction: column;
  gap: 10px;

  .coreGrid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px 16px;

    .fieldItem {
      min-width: 0;

      .labelRow {
        display: inline-flex;
        align-items: center;
        gap: 4px;

        .sourceTag {
          font-size: 10px;
        }
      }
    }

    .fieldNote {
      grid-column: 1 / -1;
      font-size: 12px;
      color: var(--td-text-color-secondary);
      line-height: 1.5;
      margin-top: -2px;
    }
  }

  .optionRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;

    .optionHint {
      font-size: 12px;
      color: var(--td-text-color-placeholder);
    }

    &.deemphasized {
      opacity: 0.55;
    }
  }

  .sliderRow {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;

    .sliderValue {
      flex-shrink: 0;
      font-size: 12px;
      color: var(--td-text-color-secondary);
      min-width: 44px;
      text-align: right;
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
}
</style>
