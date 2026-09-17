<template>
  <div class="vpcCard" :class="[status]" data-testid="quick-video-params-card">
    <div class="vpcHead">
      <span class="vpcTitle">{{ $t("workbench.quickVideo.videoParams.title") }}</span>
      <t-tag size="small" variant="outline">{{ card.modelName }}</t-tag>
      <t-tag v-if="status === 'confirmed'" shape="round" size="small" theme="success">
        {{ $t("workbench.quickVideo.videoParams.confirmedTag") }}
      </t-tag>
      <t-tag v-else-if="status === 'active'" shape="round" size="small" theme="warning">
        {{ $t("workbench.quickVideo.videoParams.pendingTag") }}
      </t-tag>
      <t-tag v-else shape="round" size="small" theme="default">
        {{ $t("workbench.quickVideo.videoParams.staleTag") }}
      </t-tag>
    </div>

    <!-- 生成提示词（LLM 预填，可修改；来源标记） -->
    <div class="vpcPrompt">
      <div class="vpcPromptHead">
        <span>{{ $t("workbench.quickVideo.videoParams.prompt") }}</span>
        <t-tag size="small" variant="outline" :theme="card.promptSource === 'user' ? 'success' : 'primary'">
          {{ sourceLabel(card.promptSource) }}
        </t-tag>
      </div>
      <t-textarea
        v-if="status === 'active'"
        v-model="promptDraft"
        :autosize="{ minRows: 2, maxRows: 4 }"
        :maxlength="4000" />
      <div v-else class="vpcPromptText">{{ card.prompt }}</div>
    </div>

    <!-- 冻结参考图说明（有图自动带图；生成按所选输入模式使用） -->
    <div v-if="card.referenceMediaIds.length" class="vpcRefs">
      <i-image size="14" />
      <span>{{ $t("workbench.quickVideo.videoParams.refNote", { count: card.referenceMediaIds.length }) }}</span>
    </div>

    <!-- 参数控件：与设置页测试面板共用同一元数据投影组件 -->
    <VideoParamFields :fields="card.fields" :model-value="draft" :disabled="status !== 'active' || submitting" show-source @update="onFieldUpdate" />

    <div v-if="status === 'active'" class="vpcOps">
      <t-checkbox v-model="rememberDraft" class="vpcRemember">{{ $t("workbench.quickVideo.videoParams.remember") }}</t-checkbox>
      <t-button size="small" theme="primary" :loading="submitting" data-testid="quick-video-params-confirm" @click="handleConfirm">
        {{ $t("workbench.quickVideo.videoParams.confirm") }}
      </t-button>
    </div>
    <div v-else-if="status === 'stale'" class="vpcStaleHint">{{ $t("workbench.quickVideo.videoParams.staleHint") }}</div>
  </div>
</template>

<script setup lang="ts">
/**
 * 聊天流模型参数确认卡（SIY-161 方案C）。
 * 卡片定义随助手消息 ext 下发（实时 socket / 历史回放同构）；实时状态（待确认/已确认/已失效）
 * 由父组件按 workbench 状态机的 videoParamsCards 判定后传入。确认后经 socket
 * confirmVideoParams 提交，服务端按模型元数据硬校验并直达供应商调用。
 * 参数控件复用共享投影组件 VideoParamFields，禁止按模型名特判。
 */
import type { VideoParamField, VideoParamSource, QuickVideoVideoParamsCard, VideoParamsCardConfirmEdits } from "@/types/quickVideo";

const props = defineProps<{
  card: QuickVideoVideoParamsCard;
  /** active=最新待确认卡；confirmed=已确认落定；stale=已被更新的卡取代 */
  status: "active" | "confirmed" | "stale";
  submitting?: boolean;
}>();

const emit = defineEmits<{
  (e: "confirm", payload: { edits: VideoParamsCardConfirmEdits; remember: boolean; prompt: string }): void;
}>();

/** 草稿态：字段值 + 提示词 + 「不再询问」勾选，只在 active 时可改 */
const draft = ref<Record<string, string | number | boolean | null>>({});
const promptDraft = ref(props.card.prompt);
const rememberDraft = ref(false);

watch(
  () => props.card,
  (card) => {
    const next: Record<string, string | number | boolean | null> = {};
    for (const field of card.fields) next[field.key] = field.value;
    draft.value = next;
    promptDraft.value = card.prompt;
  },
  { immediate: true },
);

function onFieldUpdate(field: VideoParamField, value: string | number | boolean | null) {
  draft.value = { ...draft.value, [field.key]: value };
}

function handleConfirm() {
  if (props.submitting) return;
  // 只提交相对卡片初始值发生过修改的字段，未改动项保持服务端预填（参数可追溯）
  const edits: VideoParamsCardConfirmEdits = {};
  for (const field of props.card.fields) {
    const current = draft.value[field.key];
    const initial = field.value;
    const changed =
      field.type === "number" || field.type === "slider"
        ? Number(current) !== Number(initial)
        : current !== initial;
    if (!changed || current === null || current === undefined || current === "") continue;
    edits[field.key] = current;
  }
  emit("confirm", { edits, remember: rememberDraft.value, prompt: promptDraft.value.trim() });
}

function sourceLabel(source: VideoParamSource): string {
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
</script>

<style lang="scss" scoped>
.vpcCard {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid var(--td-component-border);
  border-radius: 8px;
  padding: 12px;
  background: var(--td-bg-color-container);
  max-width: 560px;

  &.stale {
    opacity: 0.62;
  }

  .vpcHead {
    display: flex;
    align-items: center;
    gap: 8px;

    .vpcTitle {
      font-size: 13px;
      font-weight: 600;
    }
  }

  .vpcPrompt {
    display: flex;
    flex-direction: column;
    gap: 4px;

    .vpcPromptHead {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--td-text-color-secondary);
    }

    .vpcPromptText {
      font-size: 12px;
      color: var(--td-text-color-primary);
      white-space: pre-wrap;
      background: var(--td-bg-color-secondarycontainer);
      border-radius: 6px;
      padding: 6px 8px;
    }
  }

  .vpcRefs {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--td-text-color-secondary);
  }

  .vpcOps {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-top: 1px solid var(--td-component-border);
    padding-top: 8px;

    .vpcRemember {
      font-size: 12px;
    }
  }

  .vpcStaleHint {
    font-size: 12px;
    color: var(--td-text-color-placeholder);
  }
}
</style>
