<template>
  <div class="libtvErrorCard" :class="`tone-${card.tone}`">
    <div class="head">
      <span class="icon ac"><t-icon :name="card.icon" size="16px" /></span>
      <span class="title">{{ card.title }}</span>
    </div>
    <div class="reason" v-if="parsed.reason">{{ parsed.reason }}</div>
    <div class="actions">
      <t-button v-for="(action, i) in card.actions" :key="i" size="small" :theme="i === 0 ? 'primary' : 'default'" variant="outline" @click="runAction(action)">
        {{ action.label }}
      </t-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from "vue-router";
import openLibtvBindDialog from "@/utils/libtvBindDialog";
import { parseLibtvError, type LibtvErrorCode } from "@/utils/libtvError";

/**
 * LibTV 失败 → 带动作的卡片。后端失败消息带 [LIBTV:<CODE>] 前缀（随 errorReason 下发），
 * 这里映射成说人话的标题 + 下一步动作；非 LibTV 错误不渲染（父级自行走原有错误展示）。
 */

const props = defineProps<{ reason?: string | null }>();
const emit = defineEmits<{
  /** 换平台模型/换模型：父级清掉当前 LibTV 模型选择，引导改选 */
  switchModel: [];
  /** 替换参考图：父级清空参考图/首帧选择 */
  replaceRef: [];
}>();

const router = useRouter();
const parsed = computed(() => parseLibtvError(props.reason));

interface CardAction {
  key: "rebind" | "recharge" | "switchModel" | "replaceRef" | "taskCenter";
  label: string;
}
interface CardConfig {
  title: string;
  icon: string;
  tone: "danger" | "warning" | "info";
  actions: CardAction[];
}

const CONFIG: Record<LibtvErrorCode, CardConfig> = {
  NOT_BOUND: {
    title: window.$t("common.libtvError.needBindTitle"),
    icon: "error-circle",
    tone: "warning",
    actions: [
      { key: "rebind", label: window.$t("common.libtvError.actionRebind") },
      { key: "switchModel", label: window.$t("common.libtvError.actionSwitchModel") },
    ],
  },
  AUTH_EXPIRED: {
    title: window.$t("common.libtvError.expiredTitle"),
    icon: "error-circle",
    tone: "danger",
    actions: [
      { key: "rebind", label: window.$t("common.libtvError.actionRebind") },
      { key: "switchModel", label: window.$t("common.libtvError.actionSwitchModel") },
    ],
  },
  INSUFFICIENT_CREDITS: {
    title: window.$t("common.libtvError.creditsTitle"),
    icon: "wallet",
    tone: "warning",
    actions: [
      { key: "recharge", label: window.$t("common.libtvError.actionRecharge") },
      { key: "switchModel", label: window.$t("common.libtvError.actionSwitchModel") },
    ],
  },
  COMPLIANCE_REJECTED: {
    title: window.$t("common.libtvError.complianceTitle"),
    icon: "close-circle",
    tone: "danger",
    actions: [
      { key: "replaceRef", label: window.$t("common.libtvError.actionReplaceRef") },
      { key: "switchModel", label: window.$t("common.libtvError.actionSwitchModel") },
    ],
  },
  GENERATION_TIMEOUT: {
    title: window.$t("common.libtvError.timeoutTitle"),
    icon: "time",
    tone: "info",
    actions: [{ key: "taskCenter", label: window.$t("common.libtvError.actionTaskCenter") }],
  },
  UNKNOWN: {
    title: window.$t("common.libtvError.unknownTitle"),
    icon: "error-circle",
    tone: "danger",
    actions: [{ key: "rebind", label: window.$t("common.libtvError.actionRebind") }],
  },
};

const card = computed(() => CONFIG[parsed.value.code] ?? CONFIG.UNKNOWN);

async function runAction(action: CardAction) {
  switch (action.key) {
    case "rebind": {
      const ok = await openLibtvBindDialog();
      if (ok) window.$message?.success(window.$t("settings.libtv.bindOk"));
      break;
    }
    case "recharge":
      // LibTV 积分充值入口在其官网（平台没有可编程的充值接口）
      window.open("https://liblib.tv", "_blank");
      break;
    case "switchModel":
      emit("switchModel");
      break;
    case "replaceRef":
      emit("replaceRef");
      break;
    case "taskCenter":
      router.push("/task");
      break;
  }
}
</script>

<style lang="scss" scoped>
.libtvErrorCard {
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;

  &.tone-danger {
    background: var(--td-error-color-1, rgba(226, 70, 70, 0.08));
  }
  &.tone-warning {
    background: var(--td-warning-color-1, rgba(237, 123, 47, 0.08));
  }
  &.tone-info {
    background: var(--td-brand-color-light, rgba(0, 82, 217, 0.08));
  }

  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;

    .icon {
      color: var(--td-text-color-secondary);
    }
  }

  .reason {
    color: var(--td-text-color-secondary);
    font-size: 12px;
    word-break: break-all;
    max-height: 60px;
    overflow: hidden;
  }

  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
}
</style>
