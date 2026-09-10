<template>
  <div class="quickVideo">
    <Splitpanes class="default-theme data f">
      <Pane :size="30" :min-size="15" class="operate">
        <div class="box pr">
          <SessionList
            :sessions="sessions"
            :current-session-id="currentSessionId"
            :loading="loadingSessions"
            :title="$t('workbench.quickVideo.sessions.title')"
            :create-text="$t('workbench.quickVideo.sessions.create')"
            :empty-text="$t('workbench.quickVideo.sessions.empty')"
            :rename-text="$t('workbench.quickVideo.sessions.rename')"
            :archive-text="$t('workbench.quickVideo.sessions.archive')"
            :unarchive-text="$t('workbench.quickVideo.sessions.unarchive')"
            :archived-text="$t('workbench.quickVideo.sessions.archivedTag')"
            :default-title-text="$t('workbench.quickVideo.sessions.defaultTitle')"
            @select="handleSessionSelect"
            @create="handleSessionCreate"
            @rename="handleSessionRename"
            @toggle-archive="handleSessionToggleArchive" />
          <t-chat-list :clear-history="false">
            <t-chat-message
              v-for="message in messages"
              :key="message.id"
              :message="message"
              :name="(message as any).name"
              :placement="message.role === 'user' ? 'right' : 'left'"
              :variant="message.role === 'user' ? 'base' : 'outline'"
              :handleActions="{}"
              :status="message.status"
              allowContentSegmentCustom></t-chat-message>
          </t-chat-list>
          <t-chat-sender
            class="inputBox"
            :disabled="status === 'pending' || status === 'streaming' || !connected"
            v-model="inputValue"
            :loading="status === 'pending' || status === 'streaming'"
            :placeholder="$t('workbench.quickVideo.inputPlaceholder')"
            @send="handleSend"
            @stop="handleStop">
            <template #footer-prefix>
              <div class="modelPicker" @click.stop>
                <t-select
                  v-model="activeModelType"
                  class="modelTypeSelect"
                  size="small"
                  :disabled="status === 'pending' || status === 'streaming'">
                  <t-option value="text" :label="$t('components.modelSelect.type.text')" />
                  <t-option value="image" :label="$t('components.modelSelect.type.image')" />
                  <t-option value="video" :label="$t('components.modelSelect.type.video')" />
                </t-select>
                <modelSelect
                  :key="activeModelType"
                  v-model="activeModel"
                  class="modelValueSelect"
                  :type="activeModelType"
                  size="small"
                  :disabled="status === 'pending' || status === 'streaming'" />
              </div>
            </template>
          </t-chat-sender>
          <i-dot class="dot" theme="outline" :fill="connected ? 'green' : 'red'" />
        </div>
      </Pane>
      <Pane :size="70" :min-size="30" class="data">
        <div class="panel" v-loading="loadingWorkbench && !state">
          <div class="panelHeader">
            <div class="title">{{ workbench.project?.name }}</div>
            <div class="meta">
              <t-tag shape="round" theme="primary">{{ stageLabel(state?.stage) }}</t-tag>
              <t-tag shape="round">{{ $t("workbench.quickVideo.targetDuration") }}：{{ state?.targetDuration }}s</t-tag>
              <t-tag shape="round">{{ state?.videoRatio }}</t-tag>
              <t-tag shape="round" v-if="state?.artStyle">{{ state.artStyle }}</t-tag>
              <t-button size="small" variant="outline" :disabled="!state" @click="openConfigEdit">
                <template #icon><i-edit size="14" /></template>
                {{ $t("workbench.quickVideo.editConfig") }}
              </t-button>
              <t-button size="small" variant="outline" @click="getWorkbench()">
                <template #icon><i-refresh size="14" /></template>
              </t-button>
            </div>
          </div>
          <div v-if="storyboardRefreshHint" class="configNotice">
            <div class="configNoticeText">
              {{
                $t("workbench.quickVideo.storyboardRefreshHint", {
                  duration: storyboardRefreshHint.targetDuration,
                  min: storyboardRefreshHint.min,
                  max: storyboardRefreshHint.max,
                  lower: storyboardRefreshHint.lower,
                  upper: storyboardRefreshHint.upper,
                })
              }}
            </div>
            <t-button size="small" variant="outline" @click="fillStoryboardRefinePrompt">
              {{ $t("workbench.quickVideo.refineStoryboard") }}
            </t-button>
            <t-button size="small" variant="text" @click="storyboardRefreshHint = null">
              {{ $t("workbench.quickVideo.close") }}
            </t-button>
          </div>
          <div class="panelBody">
            <!-- 简报卡片 -->
            <div class="card">
              <div class="cardHeader">
                <span>{{ $t("workbench.quickVideo.brief") }}</span>
                <div class="actions">
                  <t-tag v-if="state?.brief?.confirmed" shape="round" theme="success">{{ $t("workbench.quickVideo.confirmed") }}</t-tag>
                  <t-button size="small" variant="outline" @click="openBriefEdit" :disabled="!canEditBrief">{{ $t("workbench.quickVideo.edit") }}</t-button>
                  <t-button
                    v-if="state?.stage === 'collect_brief' || state?.stage === 'storyboard_draft'"
                    size="small"
                    theme="primary"
                    :disabled="!state?.brief"
                    @click="confirmGate('brief', 'confirm')">
                    {{ $t("workbench.quickVideo.confirmBrief") }}
                  </t-button>
                  <t-button
                    v-if="state?.stage === 'brief_confirmed'"
                    size="small"
                    variant="outline"
                    @click="confirmGate('brief', 'reject')">
                    {{ $t("workbench.quickVideo.rejectConfirm") }}
                  </t-button>
                </div>
              </div>
              <div class="cardBody" v-if="state?.brief">
                <div class="briefRow"><label>{{ $t("workbench.quickVideo.briefTheme") }}</label><span>{{ state.brief.theme }}</span></div>
                <div class="briefRow"><label>{{ $t("workbench.quickVideo.briefHook") }}</label><span>{{ state.brief.hook || "-" }}</span></div>
                <div class="briefRow"><label>{{ $t("workbench.quickVideo.briefNarrative") }}</label><span>{{ state.brief.narrative }}</span></div>
                <div class="briefRow"><label>{{ $t("workbench.quickVideo.briefCta") }}</label><span>{{ state.brief.cta || "-" }}</span></div>
                <div class="briefRow" v-if="state.brief.keywords?.length">
                  <label>{{ $t("workbench.quickVideo.briefKeywords") }}</label>
                  <t-tag v-for="kw in state.brief.keywords" :key="kw" shape="round" size="small">{{ kw }}</t-tag>
                </div>
              </div>
              <t-empty v-else :title="$t('workbench.quickVideo.noBrief')" />
            </div>

            <!-- 分镜表卡片 -->
            <div class="card">
              <div class="cardHeader">
                <span>
                  {{ $t("workbench.quickVideo.storyboard") }}
                  <t-tag v-if="state?.storyboard" shape="round" size="small" style="margin-left: 6px">
                    v{{ state.storyboard.version }} · {{ state.storyboard.status === "confirmed" ? $t("workbench.quickVideo.confirmed") : $t("workbench.quickVideo.draft") }}
                  </t-tag>
                </span>
                <div class="actions">
                  <t-tag v-if="totalDuration" shape="round">{{ totalDuration }}s / {{ state?.targetDuration }}s</t-tag>
                  <t-button
                    v-if="state?.stage === 'storyboard_draft'"
                    size="small"
                    theme="primary"
                    :disabled="!state?.storyboard"
                    @click="confirmGate('storyboard', 'confirm')">
                    {{ $t("workbench.quickVideo.confirmStoryboard") }}
                  </t-button>
                  <t-button
                    v-if="state?.stage === 'storyboard_confirmed'"
                    size="small"
                    variant="outline"
                    @click="confirmGate('storyboard', 'reject')">
                    {{ $t("workbench.quickVideo.unconfirmStoryboard") }}
                  </t-button>
                </div>
              </div>
              <div class="cardBody" v-if="state?.storyboard">
                <t-table row-key="id" :data="state.storyboard.shots" :columns="shotColumns" :max-height="420" size="small">
                  <template #duration="{ row }">{{ row.duration }}s</template>
                  <template #assetRefs="{ row }">
                    <t-tag v-for="a in row.assetRefs" :key="a.type + a.name" size="small" shape="round" style="margin: 1px 2px">
                      {{ assetTypeLabel(a.type) }}:{{ a.name }}
                    </t-tag>
                    <span v-if="!row.assetRefs?.length">-</span>
                  </template>
                  <template #preview="{ row }">
                    <div class="shotPreview">
                      <t-image
                        v-if="mediaUrls[row.id]?.imageUrl"
                        :src="mediaUrls[row.id].imageUrl!"
                        fit="cover"
                        shape="round"
                        :style="{ width: '56px', height: '36px', cursor: 'pointer' }"
                        @click="openImagePreview(mediaUrls[row.id].imageUrl!)" />
                      <t-button
                        v-if="mediaUrls[row.id]?.videoUrl"
                        size="small"
                        variant="outline"
                        shape="round"
                        @click="openVideoPreview(mediaUrls[row.id].videoUrl!)">
                        <template #icon><i-play-circle size="14" /></template>
                      </t-button>
                      <span v-if="!mediaUrls[row.id]?.imageUrl && !mediaUrls[row.id]?.videoUrl" class="noPreview">-</span>
                    </div>
                  </template>
                  <template #genState="{ row }">
                    <t-tooltip v-if="row.errorReason" :content="row.errorReason">
                      <t-tag size="small" shape="round" :theme="genStateTheme(row.imageState)" style="margin-right: 4px">
                        {{ $t("workbench.quickVideo.image") }}·{{ genStateLabel(row.imageState) }}
                      </t-tag>
                    </t-tooltip>
                    <t-tag v-else size="small" shape="round" :theme="genStateTheme(row.imageState)" style="margin-right: 4px">
                      {{ $t("workbench.quickVideo.image") }}·{{ genStateLabel(row.imageState) }}
                    </t-tag>
                    <t-tooltip v-if="row.errorReason" :content="row.errorReason">
                      <t-tag size="small" shape="round" :theme="genStateTheme(row.videoState)">
                        {{ $t("workbench.quickVideo.video") }}·{{ genStateLabel(row.videoState) }}
                      </t-tag>
                    </t-tooltip>
                    <t-tag v-else size="small" shape="round" :theme="genStateTheme(row.videoState)">
                      {{ $t("workbench.quickVideo.video") }}·{{ genStateLabel(row.videoState) }}
                    </t-tag>
                  </template>
                  <template #op="{ row }">
                    <t-button size="small" variant="text" :disabled="!canEditStoryboard" @click="openShotEdit(row)">
                      <template #icon><i-edit size="14" /></template>
                    </t-button>
                    <t-popconfirm :content="$t('workbench.quickVideo.deleteShotConfirm')" @confirm="removeShot(row.id)">
                      <t-button size="small" variant="text" theme="danger" :disabled="!canEditStoryboard">
                        <template #icon><i-delete size="14" /></template>
                      </t-button>
                    </t-popconfirm>
                    <t-tooltip v-if="isShotFailed(row) && state?.stage === 'generating'" :content="$t('workbench.quickVideo.retryShot')">
                      <t-button size="small" variant="text" theme="warning" :loading="retryingShots.includes(row.id)" @click="retryShots([row.id])">
                        <template #icon><i-refresh size="14" /></template>
                      </t-button>
                    </t-tooltip>
                  </template>
                </t-table>
                <div class="storyboardFooter" v-if="canEditStoryboard">
                  <t-button size="small" variant="outline" @click="openShotAdd">
                    <template #icon><i-plus size="14" /></template>
                    {{ $t("workbench.quickVideo.addShot") }}
                  </t-button>
                  <span v-if="state.storyboard.summary" class="summary">{{ state.storyboard.summary }}</span>
                </div>
              </div>
              <t-empty v-else :title="$t('workbench.quickVideo.noStoryboard')" />
            </div>

            <!-- 素材与成本卡片（分镜确认后展示，素材/成本确认门） -->
            <div class="card" v-if="showMaterialsCard">
              <div class="cardHeader">
                <span>
                  {{ $t("workbench.quickVideo.materials") }}
                  <t-tag v-if="state?.generation?.materialsConfirmed" shape="round" size="small" theme="success" style="margin-left: 6px">
                    {{ $t("workbench.quickVideo.confirmed") }}
                  </t-tag>
                </span>
                <div class="actions">
                  <t-button
                    v-if="state?.stage === 'storyboard_confirmed'"
                    size="small"
                    variant="outline"
                    :loading="resolving"
                    @click="resolveAssets">
                    {{ $t("workbench.quickVideo.resolveMaterials") }}
                  </t-button>
                  <t-button
                    v-if="state?.stage === 'storyboard_confirmed'"
                    size="small"
                    theme="primary"
                    :disabled="!state?.generation?.snapshot"
                    @click="confirmGate('materials', 'confirm')">
                    {{ $t("workbench.quickVideo.confirmMaterials") }}
                  </t-button>
                  <t-button
                    v-if="state?.stage === 'storyboard_confirmed' && state?.generation?.materialsConfirmed"
                    size="small"
                    variant="outline"
                    @click="confirmGate('materials', 'reject')">
                    {{ $t("workbench.quickVideo.rejectConfirm") }}
                  </t-button>
                </div>
              </div>
              <div class="cardBody" v-if="state?.generation?.snapshot">
                <div class="estimateRow">
                  <t-tag shape="round">{{ $t("workbench.quickVideo.estimateImages") }}：{{ snapshot?.estimatedImageCount ?? 0 }}</t-tag>
                  <t-tag shape="round">{{ $t("workbench.quickVideo.estimateVideos") }}：{{ snapshot?.estimatedVideoCount ?? 0 }}</t-tag>
                  <t-tag shape="round" theme="warning">{{ $t("workbench.quickVideo.estimateCost") }}：≈ ¥{{ snapshot?.estimatedCostYuan ?? 0 }}</t-tag>
                  <t-tag shape="round" theme="warning">{{ $t("workbench.quickVideo.estimateTime") }}：≈ {{ estimateMinutes }}</t-tag>
                </div>
                <div class="materialList">
                  <div class="materialItem" v-for="m in snapshot?.materials ?? []" :key="m.type + m.name">
                    <t-tag size="small" shape="round" variant="outline">{{ assetTypeLabel(m.type) }}</t-tag>
                    <span class="materialName">{{ m.name }}</span>
                    <span class="materialDesc">{{ m.desc || "-" }}</span>
                    <t-tag size="small" shape="round" :theme="m.source === 'matched' ? 'success' : 'warning'">
                      {{ m.source === "matched" ? $t("workbench.quickVideo.materialMatched") : $t("workbench.quickVideo.materialToGenerate") }}
                    </t-tag>
                  </div>
                  <div v-if="!snapshot?.materials?.length" class="noMaterials">{{ $t("workbench.quickVideo.noMaterials") }}</div>
                </div>
                <div class="snapshotNote">{{ $t("workbench.quickVideo.snapshotNote") }}</div>
              </div>
              <div class="cardBody" v-else>
                <div class="noMaterials">{{ $t("workbench.quickVideo.materialsHint") }}</div>
              </div>
            </div>

            <!-- 生成进度卡片 -->
            <div class="card" v-if="state?.stage === 'generating' || state?.stage === 'ready_to_assemble'">
              <div class="cardHeader">
                <span>{{ $t("workbench.quickVideo.generation") }}</span>
                <div class="actions">
                  <t-tag v-if="state?.generation?.runId" shape="round" size="small">run: {{ state.generation.runId }}</t-tag>
                  <t-button
                    v-if="failedShotIds.length > 0 && state?.stage === 'generating'"
                    size="small"
                    theme="warning"
                    variant="outline"
                    :loading="retryingShots.length > 0"
                    @click="retryShots(failedShotIds)">
                    {{ $t("workbench.quickVideo.retryAllFailed") }}
                  </t-button>
                </div>
              </div>
              <div class="cardBody">
                <t-progress
                  :percentage="progressPercent"
                  :status="failedShotIds.length > 0 ? 'warning' : progressPercent >= 100 ? 'success' : 'active'"
                  :stroke-width="8" />
                <div class="progressMeta">
                  <span>{{ $t("workbench.quickVideo.image") }} {{ imageDoneCount }}/{{ totalShotCount }}</span>
                  <span>{{ $t("workbench.quickVideo.video") }} {{ videoDoneCount }}/{{ totalShotCount }}</span>
                  <span v-if="failedShotIds.length" class="failedCount">
                    {{ $t("workbench.quickVideo.failedCount") }}：{{ failedShotIds.length }}
                  </span>
                  <span v-if="state?.stage === 'ready_to_assemble'" class="allDone">{{ $t("workbench.quickVideo.allShotsDone") }}</span>
                </div>
              </div>
            </div>

            <!-- 装配与导出卡片（SIY-111：时间线预览 + 第三道确认门导出） -->
            <div class="card" v-if="showAssembleCard">
              <div class="cardHeader">
                <span>
                  {{ $t("workbench.quickVideo.assemble") }}
                  <t-tag v-if="state?.stage === 'completed'" shape="round" size="small" theme="success" style="margin-left: 6px">
                    {{ $t("workbench.quickVideo.stage.completed") }}
                  </t-tag>
                </span>
                <div class="actions">
                  <t-tag v-if="timelineInfo" shape="round">{{ timelineInfo }}</t-tag>
                  <t-button size="small" variant="outline" :loading="timelineReloading" @click="reloadTimeline">
                    {{ $t("workbench.quickVideo.reassemble") }}
                  </t-button>
                </div>
              </div>
              <div class="cardBody">
                <div class="assembleLayout">
                  <div class="previewBox">
                    <div
                      ref="playerContainer"
                      class="playerContainer"
                      v-loading="timelinePlayer.loading.value"
                      :style="{ '--qv-ratio': playerAspectRatio }" />
                    <div class="previewControls" v-if="timelinePlayer.ready.value">
                      <t-button size="small" shape="circle" theme="primary" @click="togglePlay">
                        <template #icon><i-pause v-if="timelinePlayer.playing.value" size="14" /><i-play-circle v-else size="14" /></template>
                      </t-button>
                      <t-slider
                        class="seekSlider"
                        :value="Math.round(timelinePlayer.currentTime.value * 10) / 10"
                        :min="0"
                        :max="Math.max(1, timelinePlayer.duration.value)"
                        :step="0.1"
                        :tooltip-visible="false"
                        @change="(v: any) => timelinePlayer.seek(Number(v))" />
                      <span class="timeLabel">{{ formatTime(timelinePlayer.currentTime.value) }} / {{ formatTime(timelinePlayer.duration.value) }}</span>
                    </div>
                    <t-alert v-if="timelinePlayer.loadError.value" theme="error" :message="timelinePlayer.loadError.value" style="margin-top: 8px" />
                  </div>
                  <div class="assembleSide">
                    <div class="controlRow">
                      <span>{{ $t("workbench.quickVideo.bgm") }}</span>
                      <t-switch v-model="bgmEnabled" size="small" @change="onBgmChange" />
                    </div>
                    <div class="controlRow" v-if="bgmEnabled">
                      <span>{{ $t("workbench.quickVideo.bgmVolume") }}</span>
                      <t-slider class="volumeSlider" v-model="bgmVolume" :min="0" :max="1" :step="0.05" :tooltip-visible="false" @change-end="onBgmChange" />
                    </div>
                    <div class="controlSummary" v-if="timelineSummary">
                      <t-tag size="small" shape="round" style="margin: 1px 2px">{{ $t("workbench.quickVideo.totalDuration") }}：{{ timelineSummary }}</t-tag>
                      <t-tag size="small" shape="round" style="margin: 1px 2px" v-if="timelineClipCount">{{ $t("workbench.quickVideo.clipCount") }}：{{ timelineClipCount }}</t-tag>
                      <t-tag size="small" shape="round" style="margin: 1px 2px">{{ state?.videoRatio }} · {{ timelineSizeLabel }}</t-tag>
                    </div>
                    <div class="exportRow">
                      <t-button theme="primary" :disabled="!timelinePlayer.ready.value" @click="openExportConfirm">
                        {{ $t("workbench.quickVideo.exportBtn") }}
                      </t-button>
                      <span class="exportHint">{{ $t("workbench.quickVideo.exportGateHint") }}</span>
                    </div>
                    <ExportProgress
                      :visible="exportStatus !== 'idle'"
                      :status="exportStatus"
                      :progress="exportProgress"
                      :file-name="exportFileName"
                      :error-message="exportError"
                      :meta-line="exportMeta"
                      :title="$t('workbench.quickVideo.exportProgressTitle')"
                      :cancel-text="$t('workbench.quickVideo.cancel')"
                      :retry-text="$t('workbench.quickVideo.retry')"
                      :close-text="$t('workbench.quickVideo.close')"
                      @cancel="cancelExport"
                      @retry="startExport"
                      @close="exportStatus = 'idle'" />
                    <div class="exportedInfo" v-if="state?.generation?.exportInfo">
                      <span>{{ $t("workbench.quickVideo.exportedAt") }}：{{ formatStamp(state.generation.exportInfo.exportedAt) }}</span>
                      <span>{{ $t("workbench.quickVideo.exportedSize") }}：{{ formatBytes(state.generation.exportInfo.sizeBytes) }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Pane>
    </Splitpanes>

    <!-- 第三道确认门：成片导出确认 -->
    <t-dialog
      v-model:visible="exportConfirmVisible"
      :header="$t('workbench.quickVideo.exportConfirmTitle')"
      width="480px"
      placement="center"
      :confirm-btn="{ content: $t('workbench.quickVideo.exportConfirmYes'), theme: 'primary' }"
      :cancel-btn="{ content: $t('workbench.quickVideo.cancel') }"
      @confirm="startExport">
      <div class="exportConfirmBody">
        <p>{{ $t("workbench.quickVideo.exportConfirmDesc") }}</p>
        <div class="exportConfirmRows">
          <div class="briefRow"><label>{{ $t("workbench.quickVideo.targetDuration") }}</label><span>{{ state?.targetDuration }}s</span></div>
          <div class="briefRow"><label>{{ $t("workbench.quickVideo.totalDuration") }}</label><span>{{ timelineSummary }}</span></div>
          <div class="briefRow"><label>{{ $t("workbench.quickVideo.resolution") }}</label><span>{{ timelineResolution }}</span></div>
          <div class="briefRow"><label>{{ $t("workbench.quickVideo.estimateSize") }}</label><span>{{ timelineSizeLabel }}</span></div>
        </div>
      </div>
    </t-dialog>

    <!-- 项目基础配置编辑 -->
    <t-dialog
      v-model:visible="configEditVisible"
      :header="$t('workbench.quickVideo.editConfig')"
      width="560px"
      placement="center"
      :confirm-btn="{ content: $t('workbench.quickVideo.save'), theme: 'primary', loading: configSaving }"
      :cancel-btn="$t('workbench.quickVideo.cancel')"
      @confirm="saveConfigEdit">
      <div class="editForm">
        <t-form label-align="top">
          <t-form-item :label="$t('workbench.quickVideo.projectName')">
            <t-input v-model="configEditData.name" :maxlength="100" />
          </t-form-item>
          <t-form-item :label="$t('workbench.quickVideo.artStyle')">
            <t-input v-model="configEditData.artStyle" :maxlength="500" :disabled="generationConfigLocked" />
          </t-form-item>
          <t-form-item :label="$t('workbench.quickVideo.videoRatio')">
            <t-select v-model="configEditData.videoRatio" :disabled="generationConfigLocked">
              <t-option value="16:9" label="16:9" />
              <t-option value="9:16" label="9:16" />
              <t-option value="1:1" label="1:1" />
            </t-select>
            <div v-if="generationConfigLocked" class="fieldHint">
              {{ $t("workbench.quickVideo.configAfterGenerationLocked") }}
            </div>
          </t-form-item>
          <t-form-item :label="$t('workbench.quickVideo.targetDuration')">
            <t-select v-model="configEditData.targetDuration" :disabled="targetDurationLocked">
              <t-option :value="15" label="15s" />
              <t-option :value="30" label="30s" />
              <t-option :value="60" label="60s" />
            </t-select>
            <div v-if="targetDurationLocked" class="fieldHint">
              {{ $t("workbench.quickVideo.targetDurationLocked") }}
            </div>
          </t-form-item>
          <div v-if="configDurationPreview" class="configDurationHint">
            <div>
              {{
                $t("workbench.quickVideo.durationStoryboardHint", {
                  duration: configDurationPreview.duration,
                  min: configDurationPreview.min,
                  max: configDurationPreview.max,
                  lower: configDurationPreview.lower,
                  upper: configDurationPreview.upper,
                })
              }}
            </div>
            <div class="fieldHint">{{ $t("workbench.quickVideo.durationStoryboardHintExtra") }}</div>
          </div>
          <t-form-item :label="$t('workbench.quickVideo.projectIntro')">
            <t-textarea v-model="configEditData.intro" :maxlength="2000" :autosize="{ minRows: 3, maxRows: 6 }" />
          </t-form-item>
        </t-form>
      </div>
    </t-dialog>

    <!-- 简报编辑 -->
    <t-dialog
      v-model:visible="briefEditVisible"
      :header="$t('workbench.quickVideo.editBrief')"
      width="640px"
      placement="center"
      :confirm-btn="{ content: $t('workbench.quickVideo.save'), theme: 'primary' }"
      @confirm="saveBriefEdit">
      <div class="editForm">
        <t-form label-align="top">
          <t-form-item :label="$t('workbench.quickVideo.briefTheme')">
            <t-input v-model="briefEditData.theme" />
          </t-form-item>
          <t-form-item :label="$t('workbench.quickVideo.briefHook')">
            <t-textarea v-model="briefEditData.hook" :autosize="{ minRows: 2, maxRows: 4 }" />
          </t-form-item>
          <t-form-item :label="$t('workbench.quickVideo.briefNarrative')">
            <t-textarea v-model="briefEditData.narrative" :autosize="{ minRows: 4, maxRows: 8 }" />
          </t-form-item>
          <t-form-item :label="$t('workbench.quickVideo.briefCta')">
            <t-textarea v-model="briefEditData.cta" :autosize="{ minRows: 2, maxRows: 4 }" />
          </t-form-item>
        </t-form>
      </div>
    </t-dialog>

    <!-- 镜头编辑/新增 -->
    <t-dialog
      v-model:visible="shotEditVisible"
      :header="shotEditIsAdd ? $t('workbench.quickVideo.addShot') : $t('workbench.quickVideo.editShot')"
      width="560px"
      placement="center"
      :confirm-btn="{ content: $t('workbench.quickVideo.save'), theme: 'primary' }"
      @confirm="saveShotEdit">
      <div class="editForm">
        <t-form label-align="top">
          <t-form-item :label="$t('workbench.quickVideo.shotDuration')">
            <t-input-number v-model="shotEditData.duration" :min="5" :max="15" :step="1" style="width: 160px" />
          </t-form-item>
          <t-form-item :label="$t('workbench.quickVideo.shotDescription')">
            <t-textarea v-model="shotEditData.description" :autosize="{ minRows: 3, maxRows: 6 }" />
          </t-form-item>
          <t-form-item :label="$t('workbench.quickVideo.shotDialogue')">
            <t-textarea v-model="shotEditData.dialogue" :autosize="{ minRows: 2, maxRows: 4 }" />
          </t-form-item>
          <t-form-item :label="$t('workbench.quickVideo.shotCamera')">
            <t-input v-model="shotEditData.camera" />
          </t-form-item>
        </t-form>
      </div>
    </t-dialog>

    <!-- 镜头视频预览 -->
    <t-dialog v-model:visible="videoPreviewVisible" :header="$t('workbench.quickVideo.videoPreview')" width="480px" placement="center" :footer="false">
      <video v-if="videoPreviewUrl" :src="videoPreviewUrl" controls autoplay class="videoPreview" />
    </t-dialog>

    <!-- 镜头图预览 -->
    <t-image-viewer v-model="imagePreviewVisible" :images="imagePreviewImages" :closeOnOverlay="true" />
  </div>
</template>

<script setup lang="ts">
import { Splitpanes, Pane } from "splitpanes";
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import quickVideoStore from "@/stores/quickVideo";
import type { QuickVideoDuration, QuickVideoRatio, QuickVideoStage, QuickVideoShot, QuickVideoSession } from "@/types/quickVideo";
import modelSelect from "@/components/modelSelect.vue";
import SessionList from "./components/SessionList.vue";
import dayjs from "dayjs";
import ExportProgress from "./ExportProgress.vue";
import { useTimelinePlayer } from "./timelinePlayer";
import { estimateExportBytes, formatBytes, formatTime } from "./timelineCore";

const { project } = storeToRefs(projectStore());
const quickVideoStoreRef = quickVideoStore();
const { connected, messages, status, workbench, state, loadingWorkbench, sessions, loadingSessions, currentSessionId, modelPreferences } = storeToRefs(quickVideoStoreRef);
const { stopGenerate, getWorkbench, updateConfig, getHistory, getMediaUrls, getTimeline, loadSessions, createSession, updateSession, switchSession, setModelPreference } = quickVideoStoreRef;

const inputValue = ref("");

type QuickVideoModelType = "text" | "image" | "video";

const activeModelType = ref<QuickVideoModelType>("text");
const activeModel = computed<string>({
  get: () => modelPreferences.value[activeModelType.value],
  set: (value) => {
    void setModelPreference(activeModelType.value, value || "");
  },
});

async function handleSessionSelect(sessionId: number) {
  try {
    await switchSession(sessionId);
  } catch (e: any) {
    window.$message.error(e?.message ?? $t("workbench.quickVideo.opFailed"));
  }
}

async function handleSessionCreate() {
  try {
    await createSession();
  } catch (e: any) {
    window.$message.error(e?.message ?? $t("workbench.quickVideo.opFailed"));
  }
}

async function handleSessionRename(sessionId: number, title: string) {
  try {
    await updateSession(sessionId, { title });
  } catch (e: any) {
    window.$message.error(e?.message ?? $t("workbench.quickVideo.opFailed"));
  }
}

async function handleSessionToggleArchive(sessionId: number) {
  const target = sessions.value.find((s: QuickVideoSession) => s.id === sessionId);
  if (!target) return;
  try {
    await updateSession(sessionId, { status: target.status === "archived" ? "active" : "archived" });
  } catch (e: any) {
    window.$message.error(e?.message ?? $t("workbench.quickVideo.opFailed"));
  }
}

onMounted(async () => {
  getWorkbench();
  // 会话列表必须先加载完成、确定当前 session 后才能建立 socket 连接和拉取历史——
  // 否则握手时 sessionId 为空，会被服务端拒绝。
  await loadSessions();
  quickVideoStoreRef.connect();
  // History restoration is a read-only request and is deliberately handled
  // independently from the socket so a chat connection failure cannot block
  // the rest of the workbench.
  void getHistory();
});

const defMsg = [
  {
    id: "welcome",
    role: "assistant",
    content: [{ type: "text", status: "complete", data: $t("workbench.quickVideo.welcomeMsg") }],
  },
];
if (messages.value.length <= 0) messages.value = [...defMsg, ...messages.value] as any;

function handleSend(text: string) {
  // 切换文本模型不会新建或切换 session_id；socket 隔离键由服务端按当前会话固定。
  quickVideoStoreRef.chat(text, undefined, modelPreferences.value.text || undefined);
  inputValue.value = "";
}
function handleStop() {
  quickVideoStoreRef.stopGenerate();
}

// ===== 阶段与状态展示 =====
const stageLabels: Record<QuickVideoStage, string> = {
  collect_brief: $t("workbench.quickVideo.stage.collectBrief"),
  brief_confirmed: $t("workbench.quickVideo.stage.briefConfirmed"),
  storyboard_draft: $t("workbench.quickVideo.stage.storyboardDraft"),
  storyboard_confirmed: $t("workbench.quickVideo.stage.storyboardConfirmed"),
  generating: $t("workbench.quickVideo.stage.generating"),
  ready_to_assemble: $t("workbench.quickVideo.stage.readyToAssemble"),
  completed: $t("workbench.quickVideo.stage.completed"),
};
function stageLabel(stage?: QuickVideoStage) {
  return stage ? stageLabels[stage] : "-";
}

const assetTypeLabels: Record<string, string> = {
  role: $t("workbench.quickVideo.asset.role"),
  scene: $t("workbench.quickVideo.asset.scene"),
  tool: $t("workbench.quickVideo.asset.tool"),
};
function assetTypeLabel(type: string) {
  return assetTypeLabels[type] ?? type;
}

const genStateLabels: Record<string, string> = {
  pending: $t("workbench.quickVideo.gen.pending"),
  generating: $t("workbench.quickVideo.gen.generating"),
  done: $t("workbench.quickVideo.gen.done"),
  failed: $t("workbench.quickVideo.gen.failed"),
};
function genStateLabel(s: string) {
  return genStateLabels[s] ?? s;
}
function genStateTheme(s: string) {
  if (s === "done") return "success" as const;
  if (s === "failed") return "danger" as const;
  if (s === "generating") return "warning" as const;
  return "default" as const;
}
function isShotFailed(row: QuickVideoShot) {
  return row.imageState === "failed" || row.videoState === "failed";
}

const totalDuration = computed(() => state.value?.storyboard?.shots.reduce((sum, s) => sum + s.duration, 0) ?? 0);

const canEditBrief = computed(() => ["collect_brief", "brief_confirmed", "storyboard_draft"].includes(state.value?.stage ?? ""));
const canEditStoryboard = computed(() => state.value?.stage === "storyboard_draft" && state.value?.storyboard?.status === "draft");

// ===== 项目基础配置编辑 =====
interface QuickVideoConfigForm {
  name: string;
  artStyle: string;
  videoRatio: QuickVideoRatio;
  targetDuration: QuickVideoDuration;
  intro: string;
}

interface StoryboardRefreshHint {
  targetDuration: QuickVideoDuration;
  min: number;
  max: number;
  lower: number;
  upper: number;
}

const configEditVisible = ref(false);
const configSaving = ref(false);
const configEditData = ref<QuickVideoConfigForm>({
  name: "",
  artStyle: "",
  videoRatio: "16:9",
  targetDuration: 15,
  intro: "",
});
const configOriginalTargetDuration = ref<QuickVideoDuration>(15);
const storyboardRefreshHint = ref<StoryboardRefreshHint | null>(null);
const targetDurationLocked = computed(() => state.value?.storyboard?.status === "confirmed");
const generationConfigLocked = computed(() => ["generating", "ready_to_assemble", "completed"].includes(state.value?.stage ?? ""));

function getShotBounds(targetDuration: QuickVideoDuration) {
  const max = Math.max(1, Math.min(12, Math.floor(targetDuration / 5)));
  const min = Math.max(1, Math.min(5, Math.floor(targetDuration / 15) || 1));
  const tolerance = Math.max(3, Math.round(targetDuration * 0.2));
  return { min, max, lower: targetDuration - tolerance, upper: targetDuration + tolerance };
}

const configDurationPreview = computed(() => {
  if (!state.value?.storyboard || configEditData.value.targetDuration === configOriginalTargetDuration.value) return null;
  return { duration: configEditData.value.targetDuration, ...getShotBounds(configEditData.value.targetDuration) };
});

function openConfigEdit() {
  const currentState = state.value;
  if (!currentState) return;
  const currentProject = workbench.value.project ?? project.value;
  configEditData.value = {
    name: currentProject?.name ?? "",
    artStyle: currentState.artStyle ?? currentProject?.artStyle ?? "",
    videoRatio: (currentState.videoRatio ?? currentProject?.videoRatio ?? "16:9") as QuickVideoRatio,
    targetDuration: currentState.targetDuration,
    intro: currentProject?.intro ?? "",
  };
  configOriginalTargetDuration.value = currentState.targetDuration;
  configEditVisible.value = true;
}

async function saveConfigEdit() {
  const currentState = state.value;
  if (!currentState) return;
  if (!configEditData.value.name.trim()) return window.$message.warning($t("workbench.project.msg.enterProjectName"));
  if (!configEditData.value.artStyle.trim()) return window.$message.warning($t("workbench.project.msg.enterArtStyle"));

  const previousTargetDuration = currentState.targetDuration;
  const targetDurationChanged = configEditData.value.targetDuration !== previousTargetDuration;
  const hadStoryboard = !!currentState.storyboard;
  configSaving.value = true;
  try {
    const result = await updateConfig({
      name: configEditData.value.name.trim(),
      artStyle: configEditData.value.artStyle.trim(),
      videoRatio: configEditData.value.videoRatio,
      targetDuration: configEditData.value.targetDuration,
      intro: configEditData.value.intro,
    });
    if (!result.ok) {
      window.$message.warning(result.error.message);
      return;
    }

    configEditVisible.value = false;
    if (targetDurationChanged && hadStoryboard) {
      storyboardRefreshHint.value = { targetDuration: configEditData.value.targetDuration, ...getShotBounds(configEditData.value.targetDuration) };
    }
    window.$message.success($t("workbench.quickVideo.configSaved"));
  } catch (error: any) {
    window.$message.error(error?.message ?? $t("workbench.quickVideo.opFailed"));
  } finally {
    configSaving.value = false;
  }
}

function fillStoryboardRefinePrompt() {
  const hint = storyboardRefreshHint.value;
  if (!hint) return;
  inputValue.value = $t("workbench.quickVideo.refineStoryboardPrompt", {
    duration: hint.targetDuration,
    min: hint.min,
    max: hint.max,
    lower: hint.lower,
    upper: hint.upper,
  });
  window.$message.info($t("workbench.quickVideo.refineStoryboardPromptFilled"));
}

const shotColumns = [
  { colKey: "index", title: "#", width: 50 },
  { colKey: "duration", title: $t("workbench.quickVideo.shotDuration"), width: 70 },
  { colKey: "description", title: $t("workbench.quickVideo.shotDescription"), ellipsis: true },
  { colKey: "dialogue", title: $t("workbench.quickVideo.shotDialogue"), ellipsis: true },
  { colKey: "camera", title: $t("workbench.quickVideo.shotCamera"), width: 110, ellipsis: true },
  { colKey: "assetRefs", title: $t("workbench.quickVideo.shotAssets"), width: 150 },
  { colKey: "preview", title: $t("workbench.quickVideo.preview"), width: 110 },
  { colKey: "genState", title: $t("workbench.quickVideo.genState"), width: 175 },
  { colKey: "op", title: "", width: 110 },
];

// ===== 写接口调用（乐观锁 + 幂等键） =====
function newIdemKey() {
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function callQuickVideoApi(url: string, payload: Record<string, any>) {
  try {
    const { data }: any = await axios.post(url, payload);
    if (data && data.code && data.code !== 200 && data.message) {
      window.$message.warning(data.message);
      await getWorkbench();
      return false;
    }
    await getWorkbench();
    return true;
  } catch (e: any) {
    window.$message.error(e?.message ?? $t("workbench.quickVideo.opFailed"));
    await getWorkbench();
    return false;
  }
}

function confirmGate(gate: "brief" | "storyboard" | "materials" | "export", action: "confirm" | "reject") {
  if (!state.value) return;
  callQuickVideoApi("/quickVideo/confirmStage", {
    projectId: Number(project.value?.id),
    sessionId: currentSessionId.value,
    expectedVersion: state.value.version,
    idempotencyKey: newIdemKey(),
    gate,
    action,
  });
}

// ===== 简报编辑 =====
const briefEditVisible = ref(false);
const briefEditData = ref({ theme: "", hook: "", narrative: "", cta: "" });

function openBriefEdit() {
  const brief = state.value?.brief;
  briefEditData.value = {
    theme: brief?.theme ?? "",
    hook: brief?.hook ?? "",
    narrative: brief?.narrative ?? "",
    cta: brief?.cta ?? "",
  };
  briefEditVisible.value = true;
}

async function saveBriefEdit() {
  if (!state.value) return;
  if (!briefEditData.value.theme.trim() || !briefEditData.value.narrative.trim()) {
    return window.$message.warning($t("workbench.quickVideo.briefRequired"));
  }
  const ok = await callQuickVideoApi("/quickVideo/updateBrief", {
    projectId: Number(project.value?.id),
    expectedVersion: state.value.version,
    idempotencyKey: newIdemKey(),
    brief: { ...briefEditData.value, keywords: state.value.brief?.keywords ?? [] },
  });
  if (ok) briefEditVisible.value = false;
}

// ===== 镜头编辑/新增 =====
const shotEditVisible = ref(false);
const shotEditIsAdd = ref(false);
const shotEditId = ref("");
const shotEditData = ref({ duration: 5, description: "", dialogue: "", camera: "" });

function openShotEdit(shot: QuickVideoShot) {
  shotEditIsAdd.value = false;
  shotEditId.value = shot.id;
  shotEditData.value = { duration: shot.duration, description: shot.description, dialogue: shot.dialogue, camera: shot.camera };
  shotEditVisible.value = true;
}

function openShotAdd() {
  shotEditIsAdd.value = true;
  shotEditData.value = { duration: 5, description: "", dialogue: "", camera: "" };
  shotEditVisible.value = true;
}

async function saveShotEdit() {
  if (!state.value) return;
  if (!shotEditData.value.description.trim()) {
    return window.$message.warning($t("workbench.quickVideo.shotRequired"));
  }
  const base = {
    projectId: Number(project.value?.id),
    expectedVersion: state.value.version,
    idempotencyKey: newIdemKey(),
  };
  const ok = shotEditIsAdd.value
    ? await callQuickVideoApi("/quickVideo/addShot", { ...base, shot: { ...shotEditData.value } })
    : await callQuickVideoApi("/quickVideo/updateShot", { ...base, shotId: shotEditId.value, patch: { ...shotEditData.value } });
  if (ok) shotEditVisible.value = false;
}

async function removeShot(shotId: string) {
  if (!state.value) return;
  await callQuickVideoApi("/quickVideo/removeShot", {
    projectId: Number(project.value?.id),
    expectedVersion: state.value.version,
    idempotencyKey: newIdemKey(),
    shotId,
  });
}

// ===== 素材解析与确认（素材/成本确认门） =====
const snapshot = computed(() => state.value?.generation?.snapshot);
const showMaterialsCard = computed(() => {
  const stage = state.value?.stage;
  return !!stage && ["storyboard_confirmed", "generating", "ready_to_assemble", "completed"].includes(stage);
});
const resolving = ref(false);
const estimateMinutes = computed(() => {
  const seconds = snapshot.value?.estimatedSeconds ?? 0;
  return `${Math.max(1, Math.round(seconds / 60))} ${$t("workbench.quickVideo.minutes")}`;
});

async function resolveAssets() {
  if (!state.value) return;
  resolving.value = true;
  try {
    await callQuickVideoApi("/quickVideo/resolveAssets", {
      projectId: Number(project.value?.id),
      expectedVersion: state.value.version,
      idempotencyKey: newIdemKey(),
    });
  } finally {
    resolving.value = false;
  }
}

// ===== 生成进度与重试 =====
const shots = computed(() => state.value?.storyboard?.shots ?? []);
const totalShotCount = computed(() => shots.value.length);
const imageDoneCount = computed(() => shots.value.filter((s) => s.imageState === "done").length);
const videoDoneCount = computed(() => shots.value.filter((s) => s.videoState === "done").length);
const failedShotIds = computed(() => shots.value.filter(isShotFailed).map((s) => s.id));
const progressPercent = computed(() => {
  if (!totalShotCount.value) return 0;
  const done = shots.value.filter((s) => s.imageState === "done" && s.videoState === "done").length;
  return Math.round((done / totalShotCount.value) * 100);
});

const retryingShots = ref<string[]>([]);
async function retryShots(shotIds: string[]) {
  if (!shotIds.length || !state.value) return;
  retryingShots.value = [...shotIds];
  try {
    await callQuickVideoApi("/quickVideo/retryShot", {
      projectId: Number(project.value?.id),
      sessionId: currentSessionId.value,
      shotIds,
    });
  } finally {
    retryingShots.value = retryingShots.value.filter((id) => !shotIds.includes(id));
  }
}

// ===== 镜头产物预览（imageRef/videoRef -> 访问地址） =====
const mediaUrls = ref<Record<string, { imageUrl: string | null; videoUrl: string | null }>>({});
const mediaSignature = computed(() =>
  shots.value
    .map((s) => `${s.id}:${s.imageRef ?? ""}:${s.videoRef ?? ""}`)
    .join("|"),
);
watch(mediaSignature, async (sig, prev) => {
  if (sig === prev) return;
  if (!shots.value.some((s) => s.imageRef || s.videoRef)) {
    mediaUrls.value = {};
    return;
  }
  try {
    mediaUrls.value = await getMediaUrls();
  } catch {
    // 预览地址获取失败不影响工作台
  }
}, { immediate: true });

const videoPreviewVisible = ref(false);
const videoPreviewUrl = ref("");
function openVideoPreview(url: string) {
  videoPreviewUrl.value = url;
  videoPreviewVisible.value = true;
}

const imagePreviewVisible = ref(false);
const imagePreviewImages = ref<string[]>([]);
function openImagePreview(url: string) {
  imagePreviewImages.value = [url];
  imagePreviewVisible.value = true;
}

// ===== 装配与导出（SIY-111：WebAV 时间线 + 第三道确认门） =====
const timelinePlayer = useTimelinePlayer();
const playerContainer = timelinePlayer.containerEl;

const showAssembleCard = computed(() => ["ready_to_assemble", "completed"].includes(state.value?.stage ?? ""));
const bgmEnabled = ref(true);
const bgmVolume = ref(0.35);
const timelineReloading = ref(false);

interface TimelinePayload {
  timeline: {
    targetDuration: number;
    videoRatio: string;
    width: number;
    height: number;
    totalDuration: number;
    clips: { shotId: string; index: number; sourceDuration: number; subtitleText: string; trimStart: number; trimEnd: number; playbackRate: number; start: number; end: number }[];
    transitions: { afterShotId: string; type: string; duration: number }[];
    tailPad: { type: string; duration: number; text: string } | null;
  };
  subtitles: { start: number; end: number; text: string }[];
  media: Record<string, { videoUrl: string | null; imageUrl: string | null }>;
  ctaText: string;
  exportInfo: { exportedAt: number; fileName: string; sizeBytes: number; durationSeconds: number } | null;
}
const timelineData = ref<TimelinePayload | null>(null);

/** 已装配标识（右侧标题 tag）：分镜版本装配出的片段数与总时长 */
const timelineInfo = computed(() => {
  const meta = state.value?.generation?.timeline;
  if (!meta) return "";
  return `${$t("workbench.quickVideo.clipCount")} ${meta.clipCount} · ${formatTime(meta.totalDuration)}`;
});
const timelineSummary = computed(() => (timelinePlayer.duration.value ? formatTime(timelinePlayer.duration.value) : timelineData.value ? formatTime(timelineData.value.timeline.totalDuration) : ""));
const timelineClipCount = computed(() => timelineData.value?.timeline.clips.length ?? 0);
const playerAspectRatio = computed(() => {
  const w = timelineData.value?.timeline.width;
  const h = timelineData.value?.timeline.height;
  return w && h ? `${w} / ${h}` : "16 / 9";
});
const timelineResolution = computed(() => (timelineData.value ? `${timelineData.value.timeline.width}×${timelineData.value.timeline.height}` : "-"));
const timelineSizeLabel = computed(() =>
  timelineData.value ? formatBytes(estimateExportBytes(timelineData.value.timeline.width, timelineData.value.timeline.height, timelineData.value.timeline.totalDuration)) : "-",
);

/** 阶段进入装配/完成时自动加载时间线（切走即销毁释放内存） */
// 签名只含"是否处于装配/完成态 + 装配元数据"：导出确认（ready_to_assemble -> completed）不触发重载，
// 仅分镜版本变化（重新生成后再次装配）或首次进入时加载
const assembledSignature = computed(() => {
  if (!showAssembleCard.value) return "";
  const meta = state.value?.generation?.timeline;
  if (!meta) return "";
  return `${meta.storyboardVersion}:${meta.assembledAt}`;
});
watch(
  assembledSignature,
  async (sig, prev) => {
    if (!sig) {
      timelinePlayer.destroy();
      timelineData.value = null;
      return;
    }
    if (sig === prev) return;
    await reloadTimeline();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  timelinePlayer.destroy();
});

async function reloadTimeline() {
  if (!state.value) return;
  timelineReloading.value = true;
  try {
    const payload: TimelinePayload | null = await getTimeline();
    timelineData.value = payload;
    if (payload?.timeline) {
      await timelinePlayer.load({
        serverPlan: payload.timeline as any,
        videoUrls: Object.fromEntries(Object.entries(payload.media ?? {}).map(([k, v]) => [k, v.videoUrl])),
        musicEnabled: bgmEnabled.value,
        musicVolume: bgmVolume.value,
      });
    }
  } catch (e: any) {
    window.$message.warning(e?.message ?? $t("workbench.quickVideo.opFailed"));
  } finally {
    timelineReloading.value = false;
  }
}

function togglePlay() {
  if (timelinePlayer.playing.value) timelinePlayer.pause();
  else timelinePlayer.play();
}

async function onBgmChange() {
  await timelinePlayer.setMusicVolume(bgmEnabled.value ? bgmVolume.value : 0);
}

// --- 第三道确认门：导出确认 -> 编码 -> 下载 -> 回写导出结果 ---
const exportConfirmVisible = ref(false);
const exportStatus = ref<"idle" | "encoding" | "success" | "error">("idle");
const exportProgress = ref(0);
const exportFileName = ref("");
const exportError = ref("");
const exportMeta = ref("");
const exportSignal = { cancelled: false };

function openExportConfirm() {
  if (!timelinePlayer.ready.value) return;
  exportConfirmVisible.value = true;
}

function formatStamp(ts: number) {
  return dayjs(ts).format("YYYY-MM-DD HH:mm:ss");
}

async function startExport() {
  if (!state.value || !timelineData.value) return;
  exportConfirmVisible.value = false;
  exportStatus.value = "encoding";
  exportProgress.value = 0;
  exportError.value = "";
  exportSignal.cancelled = false;
  const fileName = `quick-video-${project.value?.id ?? "export"}-${dayjs().format("YYYYMMDD-HHmmss")}.mp4`;
  exportFileName.value = fileName;
  const startedAt = Date.now();
  try {
    const blob = await timelinePlayer.exportMp4({
      onProgress: (p) => (exportProgress.value = Math.round(p * 100)),
      signal: exportSignal,
    });
    // 触发浏览器下载
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);

    exportProgress.value = 100;
    exportStatus.value = "success";
    exportMeta.value = `${formatBytes(blob.size)} · ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    // 成片导出确认门：编码成功后回写导出结果并落定 completed
    await callQuickVideoApi("/quickVideo/confirmStage", {
      projectId: Number(project.value?.id),
      sessionId: currentSessionId.value,
      expectedVersion: state.value.version,
      idempotencyKey: newIdemKey(),
      gate: "export",
      action: "confirm",
      exportInfo: { fileName, sizeBytes: blob.size, durationSeconds: Math.round(timelinePlayer.duration.value * 10) / 10 },
    });
  } catch (e: any) {
    if (e?.message === "EXPORT_CANCELLED") {
      exportStatus.value = "idle";
      window.$message.info($t("workbench.quickVideo.exportCancelled"));
      return;
    }
    exportStatus.value = "error";
    exportError.value = e?.message ?? String(e);
    window.$message.error($t("workbench.quickVideo.exportFailed"));
  }
}

function cancelExport() {
  exportSignal.cancelled = true;
}
</script>

<style lang="scss" scoped>
.quickVideo {
  height: calc(100% - 16px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  :deep(.splitpanes__pane) {
    background-color: transparent !important;
  }
  :deep(.splitpanes__splitter) {
    border-left: none;
    margin-left: 1px;
  }
  .operate {
    .box {
      padding-top: 8px;
      flex: 1;
      display: flex;
      flex-direction: column;
      border-radius: 10px;
      border: 1px solid var(--td-border-level-1-color);
      background-color: var(--td-bg-color-container);
      overflow: hidden;
      position: relative;
      width: 100%;
      height: 100%;
      padding-left: 8px;
      .inputBox {
        padding-right: 8px;
        padding-bottom: 8px;
      }
      .modelPicker {
        display: flex;
        align-items: center;
        gap: 5px;
        width: 100%;
        min-width: 0;
        .modelTypeSelect {
          width: 72px;
          flex-shrink: 0;
        }
        .modelValueSelect {
          min-width: 0;
          flex: 1;
        }
      }
      .dot {
        position: absolute;
        top: 10px;
        left: 10px;
      }
    }
  }
  .panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 8px 4px 0 12px;
    box-sizing: border-box;
    overflow: hidden;
    .panelHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 4px 12px;
      .title {
        font-size: 18px;
        font-weight: 600;
      }
      .meta {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
    }
    .configNotice {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0 4px 12px;
      padding: 10px 12px;
      border: 1px solid var(--td-warning-color-3);
      border-radius: 8px;
      background: var(--td-warning-color-1);
      .configNoticeText {
        flex: 1;
        font-size: 13px;
        line-height: 1.6;
      }
    }
    .panelBody {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding-bottom: 12px;
      &::-webkit-scrollbar-thumb {
        background-color: var(--td-border-level-2-color);
        border-radius: 4px;
      }
    }
  }
  .card {
    border: 1px solid var(--td-border-level-2-color);
    border-radius: 10px;
    background: var(--td-bg-color-container);
    overflow: hidden;
    .cardHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background-color: var(--td-bg-color-secondarycontainer);
      font-weight: 600;
      .actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }
    }
    .cardBody {
      padding: 12px 14px;
      .briefRow {
        display: flex;
        gap: 10px;
        margin-bottom: 10px;
        align-items: baseline;
        &:last-child {
          margin-bottom: 0;
        }
        label {
          width: 70px;
          flex-shrink: 0;
          font-size: 13px;
          opacity: 0.6;
        }
        span {
          font-size: 13px;
          line-height: 1.6;
          white-space: pre-wrap;
          word-break: break-word;
        }
      }
      .storyboardFooter {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-top: 10px;
        .summary {
          font-size: 12px;
          opacity: 0.6;
        }
      }
      .shotPreview {
        display: flex;
        align-items: center;
        gap: 4px;
        .noPreview {
          opacity: 0.4;
        }
      }
      .estimateRow {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 10px;
      }
      .materialList {
        display: flex;
        flex-direction: column;
        gap: 6px;
        .materialItem {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          .materialName {
            font-weight: 600;
          }
          .materialDesc {
            flex: 1;
            opacity: 0.6;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
        }
        .noMaterials {
          font-size: 13px;
          opacity: 0.5;
        }
      }
      .snapshotNote {
        margin-top: 10px;
        font-size: 12px;
        opacity: 0.45;
      }
      .progressMeta {
        display: flex;
        gap: 16px;
        margin-top: 8px;
        font-size: 13px;
        opacity: 0.8;
        .failedCount {
          color: var(--td-error-color);
        }
        .allDone {
          color: var(--td-success-color);
          font-weight: 600;
        }
      }
    }
  }
  .editForm {
    padding: 4px 0;
    .fieldHint {
      margin-top: 6px;
      color: var(--td-text-color-secondary);
      font-size: 12px;
      line-height: 1.5;
    }
    .configDurationHint {
      margin: -4px 0 16px;
      padding: 10px 12px;
      border-radius: 6px;
      background: var(--td-bg-color-secondarycontainer);
      font-size: 13px;
      line-height: 1.6;
    }
  }
  .videoPreview {
    width: 100%;
    border-radius: 8px;
    background: #000;
  }
  .assembleLayout {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    .previewBox {
      flex: 1.4;
      min-width: 0;
      .playerContainer {
        width: 100%;
        aspect-ratio: var(--qv-ratio, 16 / 9);
        max-height: 460px;
        border-radius: 8px;
        overflow: hidden;
        background: #000;
        position: relative;
      }
      .previewControls {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 8px;
        .seekSlider {
          flex: 1;
        }
        .timeLabel {
          font-size: 12px;
          font-variant-numeric: tabular-nums;
          opacity: 0.75;
        }
      }
    }
    .assembleSide {
      flex: 1;
      min-width: 220px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      .controlRow {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 13px;
        .volumeSlider {
          flex: 1;
        }
      }
      .controlSummary {
        display: flex;
        flex-wrap: wrap;
      }
      .exportRow {
        display: flex;
        align-items: center;
        gap: 10px;
        .exportHint {
          font-size: 12px;
          opacity: 0.6;
        }
      }
      .exportedInfo {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 12px;
        opacity: 0.7;
      }
    }
  }
  .exportConfirmBody {
    p {
      margin: 0 0 10px;
      line-height: 1.6;
    }
    .exportConfirmRows {
      .briefRow {
        display: flex;
        gap: 12px;
        margin-bottom: 6px;
        label {
          min-width: 88px;
          opacity: 0.65;
        }
      }
    }
  }
}
</style>
