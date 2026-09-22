<template>
  <t-select
    :size="props.size"
    v-model="selectValue"
    filterable
    :disabled="props.disabled"
    :placeholder="props.placeholder ?? $t('components.modelSelect.placeholder')"
    @change="onChange"
    @popup-visible-change="onPopupVisibleChange">
    <t-option-group v-for="(list, index) in displayedGroups" :key="index" :label="list.group">
      <t-option
        v-for="item in list.children"
        :key="item.id"
        :value="`${item.id}:${item.value}`"
        :label="item.label"
        :disabled="optionState(item).disabled"
        :title="optionState(item).reason">
        <div class="optionItem">
          <div class="optionMain">
            <t-avatar
              v-if="getProviderLogoByModel(item.label, item.value)"
              size="24px"
              shape="round"
              :image="getProviderLogoByModel(item.label, item.value)!" />
            <t-avatar v-else size="24px" shape="round" class="fallbackAvatar">{{ getFallbackText(item.label) }}</t-avatar>
            <div class="optionLabel">{{ item.label }}</div>
          </div>
          <div class="optionRight">
            <span class="libtvBound" v-if="item.id === 'libtv' && libtvBound === true">
              <span class="boundDot"></span>{{ $t("components.modelSelect.libtv.bound") }}
            </span>
            <t-tag v-else-if="item.id === 'libtv' && libtvBound === false" size="small" theme="warning" variant="light">
              {{ $t("components.modelSelect.libtv.consumeCredits") }}
            </t-tag>
            <span class="optionType">{{ item.type }}</span>
          </div>
        </div>
      </t-option>
    </t-option-group>
    <!-- 无可用模型时，显示跳转设置的按钮 -->
    <template #empty>
      <div class="emptyActionWrap">
        <t-button class="emptyActionButton" size="small" variant="text" theme="primary" @click.stop="goVendorConfig">
          {{ $t("components.modelSelect.goSetting") }}
        </t-button>
      </div>
    </template>
  </t-select>
</template>

<script setup lang="ts">
import { providersLogo, modelProviderRules } from "@/utils/providersLogo";
import { isLibtvModel } from "@/utils/libtvError";
import openLibtvBindDialog from "@/utils/libtvBindDialog";
import { MessagePlugin } from "tdesign-vue-next";
import settingStore from "@/stores/setting";

import axios from "@/utils/axios";
interface VendorChild {
  id: string;
  label: string;
  value: string;
  vendorId: string;
  type: string;
  /** 原始类型（text/image/video），与本地化展示用的 type 分开保留，供场景化引导判断 */
  rawType: string;
  /** 模型目录声明的输入模式（扁平化，如 singleImage/text），供图生视频场景引导（SIY-154 P3） */
  modes: string[];
  disabled?: boolean;
  disabledReason?: string;
}

interface VendorOption {
  group: string;
  id: string;
  children: VendorChild[];
}
const selectValue = defineModel({
  type: String,
  default: "",
});

const selectValueLabel = defineModel("label");

const props = defineProps({
  type: {
    type: String as () => "text" | "image" | "all" | "video",
    default: "all",
  },
  size: {
    type: String as () => "small" | "medium" | "large",
    default: "medium",
  },
  placeholder: {
    type: String,
  },
  changeConfig: {
    type: Boolean,
    default: false,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  /** 图生视频场景引导：置灰不支持单图/首帧输入的视频模型，并把支持的模型排到前面（SIY-154 P3） */
  requireSingleImage: {
    type: Boolean,
    default: false,
  },
});
const emit = defineEmits<{
  change: [value: string, data?: any];
}>();

async function onChange(value: any, { option }: any) {
  selectValue.value = value;
  selectValueLabel.value = option.label;
  // LibTV 渠道消耗的是用户自己绑定账号的积分：未绑定时选中不阻断，
  // 就地弹出绑定小浮层（短信验证码/粘贴凭据），绑定成功自动恢复刚才的选择；
  // 点「换用平台模型」则清掉选择，回到平台模型。
  if (isLibtvModel(value) && libtvBound.value === false) {
    const result = await openLibtvBindDialog({ showSwitchModel: true });
    if (result === true) {
      libtvBound.value = true;
      emit("change", value);
      return;
    }
    if (result === "switch") {
      selectValue.value = "";
      selectValueLabel.value = "";
      MessagePlugin.info(window.$t("components.modelSelect.libtv.switchedToPlatform"));
      emit("change", "");
      return;
    }
    // 直接关闭浮层：保持已选中的 LibTV 模型（不阻断），生成时会再给出引导
    emit("change", value);
    return;
  }
  if (props.changeConfig) {
    const { data } = await axios.post("/modelSelect/getModelDetail", {
      modelId: value,
    });
    emit("change", value, data);
  } else {
    emit("change", value);
  }
}
const optionsData = ref<VendorOption[]>([]);

/** 单个选项的置灰状态：后端 available=false，或 requireSingleImage 引导下不支持首帧输入的视频模型 */
function optionState(item: VendorChild): { disabled: boolean; reason?: string } {
  if (item.disabled) return { disabled: true, reason: item.disabledReason };
  if (props.requireSingleImage && item.rawType === "video" && !item.modes.includes("singleImage")) {
    return { disabled: true, reason: $t("components.modelSelect.singleImageUnsupported") };
  }
  return { disabled: false };
}

/** requireSingleImage 引导开启时，组内把支持首帧输入的视频模型排到前面（稳定排序） */
const displayedGroups = computed<VendorOption[]>(() => {
  if (!props.requireSingleImage) return optionsData.value;
  return optionsData.value.map((group) => {
    const supporting = group.children.filter((item) => !(item.rawType === "video" && !item.modes.includes("singleImage")));
    const rest = group.children.filter((item) => item.rawType === "video" && !item.modes.includes("singleImage"));
    return { ...group, children: [...supporting, ...rest] };
  });
});

// LibTV 用户绑定状态：null=未加载（选项上不显示权益标识），true=已绑定（绿点），false=未绑定（积分提示 + 选中弹绑定浮层）
const libtvBound = ref<boolean | null>(null);
const hasLibtvGroup = computed(() => optionsData.value.some((g) => g.id === "libtv"));
async function refreshLibtvBound() {
  if (!hasLibtvGroup.value) return;
  try {
    const res: any = await axios.post("/setting/vendorConfig/libtv/bindingStatus");
    if (res.code === 200) libtvBound.value = !!res.data?.bound;
  } catch (e) {
    // 状态拿不到就维持原值，不阻塞选择器
  }
}
onMounted(() => {
  handleModelChange();
  refreshLibtvBound();
});

function onPopupVisibleChange(visible: boolean) {
  if (visible) {
    handleModelChange();
    refreshLibtvBound();
  }
}
const titleMap = {
  image: $t("components.modelSelect.type.image"),
  text: $t("components.modelSelect.type.text"),
  video: $t("components.modelSelect.type.video"),
};
//获取模型选择API数据
function handleModelChange() {
  axios
    .post("/modelSelect/getModelList", { type: props.type })
    .then((response) => {
      const groupMap = new Map<string, VendorOption>();
      response.data.forEach((item: any) => {
        const groupKey = item.id;
        if (!groupMap.has(groupKey)) {
          groupMap.set(groupKey, {
            group: item.name,
            id: item.id,
            children: [],
          });
        }
        groupMap.get(groupKey)!.children.push({
          id: item.id,
          label: item.label,
          value: item.value,
          vendorId: item.vendorId,
          type: titleMap[item.type as "image" | "text" | "video"],
          rawType: item.type,
          modes: Array.isArray(item.modes) ? item.modes.filter((m: unknown) => typeof m === "string") : [],
          disabled: item.available === false,
          disabledReason: item.disabledReason,
        });
      });
      optionsData.value = Array.from(groupMap.values());

      if (
        optionsData.value
          .map((i) => i.children)
          .flat()
          .every((i) => `${i.id}:${i.value}` !== selectValue.value)
      ) {
        selectValue.value = "";
      }
    })
    .catch((error) => {
      console.error($t("components.modelSelect.msg.fetchModelFailed"), error);
    });
}

function getProviderLogoByModel(label?: string, value?: string) {
  const source = `${label || ""} ${value || ""}`.trim();
  if (!source) return null;
  const matchedRule = modelProviderRules.find((rule) => rule.pattern.test(source));
  return matchedRule ? providersLogo[matchedRule.provider] : null;
}

function getFallbackText(label: string) {
  return label?.slice(0, 1)?.toUpperCase() || "M";
}

function goVendorConfig() {
  const store = settingStore();
  store.activeMenu = "vendorConfig";
  store.showSetting = true;
}
</script>

<style lang="scss" scoped>
.optionItem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.optionMain {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.optionLabel {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.optionRight {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.libtvBound {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--td-success-color);
  white-space: nowrap;

  .boundDot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--td-success-color);
    display: inline-block;
  }
}

.optionType {
  color: var(--td-text-color-secondary);
  flex-shrink: 0;
}

.fallbackAvatar {
  background: var(--td-brand-color-light);
  color: var(--td-brand-color);
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}
.emptyActionWrap {
  display: flex;
  justify-content: center;
  padding: 8px 12px;
  .emptyActionButton {
    min-width: 140px;
    color: #339af0;
  }
}
</style>
