<template>
  <t-dialog
    v-model:visible="visible"
    class="projectModeDialog"
    :header="$t('workbench.project.modeDialog.title')"
    width="720px"
    placement="center"
    :footer="false"
    :close-on-overlay-click="false"
    @close-btn-click="close">
    <div class="modeDialogBody">
      <p class="modeDialogIntro">{{ $t("workbench.project.modeDialog.subtitle") }}</p>

      <div class="modeList" role="list">
        <button
          v-for="mode in modes"
          :key="mode.value"
          class="modeCard"
          type="button"
          role="listitem"
          :aria-label="$t(mode.titleKey)"
          :title="$t(mode.descriptionKey)"
          @click="selectMode(mode.value)">
          <span class="modeIcon" :class="`modeIcon--${mode.value}`" aria-hidden="true">
            <i-notebook v-if="mode.value === 'professional'" theme="outline" size="28" />
            <i-video-one v-else theme="outline" size="28" />
          </span>
          <span class="modeCopy">
            <span class="modeTitle">{{ $t(mode.titleKey) }}</span>
            <span class="modeDescription">{{ $t(mode.descriptionKey) }}</span>
          </span>
          <span class="modeArrow" aria-hidden="true">→</span>
        </button>
      </div>

      <p class="modeDialogHint">{{ $t("workbench.project.modeDialog.hint") }}</p>
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
type ProjectCreateMode = "professional" | "quick";

const visible = defineModel<boolean>();
const emit = defineEmits<{
  (event: "select", mode: ProjectCreateMode): void;
}>();

const modes: Array<{
  value: ProjectCreateMode;
  titleKey: string;
  descriptionKey: string;
}> = [
  {
    value: "professional",
    titleKey: "workbench.project.modeDialog.professional.title",
    descriptionKey: "workbench.project.modeDialog.professional.description",
  },
  {
    value: "quick",
    titleKey: "workbench.project.modeDialog.quick.title",
    descriptionKey: "workbench.project.modeDialog.quick.description",
  },
];

function selectMode(mode: ProjectCreateMode) {
  visible.value = false;
  emit("select", mode);
}

function close() {
  visible.value = false;
}
</script>

<style lang="scss" scoped>
.modeDialogBody {
  padding: 4px 0 8px;
}

.modeDialogIntro,
.modeDialogHint {
  margin: 0;
  color: var(--td-text-color-secondary);
  line-height: 1.6;
}

.modeDialogHint {
  margin-top: 18px;
  font-size: 12px;
  color: var(--td-text-color-placeholder);
}

.modeList {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 22px;
}

.modeCard {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 14px;
  min-height: 154px;
  padding: 22px 42px 22px 20px;
  overflow: hidden;
  text-align: left;
  color: var(--td-text-color-primary);
  background: var(--td-bg-color-container);
  border: 1px solid var(--td-component-border);
  border-radius: 12px;
  cursor: pointer;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    transform 0.2s ease;

  &:hover,
  &:focus-visible {
    border-color: var(--td-brand-color);
    box-shadow: 0 8px 24px rgb(0 82 217 / 12%);
    transform: translateY(-2px);
    outline: none;
  }

  &:focus-visible {
    box-shadow: 0 0 0 3px rgb(0 82 217 / 20%);
  }
}

.modeIcon {
  display: inline-flex;
  flex: 0 0 52px;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: 14px;
  color: var(--td-brand-color);
  background: var(--td-brand-color-light);
}

.modeIcon--quick {
  color: var(--td-success-color);
  background: var(--td-success-color-light);
}

.modeCopy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.modeTitle {
  font-size: 18px;
  font-weight: 600;
}

.modeDescription {
  color: var(--td-text-color-secondary);
  font-size: 13px;
  line-height: 1.65;
}

.modeArrow {
  position: absolute;
  top: 50%;
  right: 18px;
  color: var(--td-text-color-placeholder);
  font-size: 22px;
  transform: translateY(-50%);
  transition:
    color 0.2s ease,
    transform 0.2s ease;
}

.modeCard:hover .modeArrow,
.modeCard:focus-visible .modeArrow {
  color: var(--td-brand-color);
  transform: translate(3px, -50%);
}

@media (max-width: 640px) {
  .modeList {
    grid-template-columns: 1fr;
  }

  .modeCard {
    min-height: 126px;
  }
}
</style>
