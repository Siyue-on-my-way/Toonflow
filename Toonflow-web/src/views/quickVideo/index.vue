<template>
  <div class="quickVideo" :class="{ narrow: isNarrow, dragging: layoutDragging }">
    <div ref="workspaceLayoutRef" class="workspaceLayout">
      <aside class="chatSidebar operate" aria-label="Quick Video conversation" data-testid="quick-video-chat-sidebar" :style="chatSidebarStyle">
        <div class="chatSidebarHeader">
          <div class="chatSidebarTitleRow">
            <div class="chatSidebarTitle">
              <i-chat class="chatSidebarIcon" size="18" />
              <span>{{ $t("workbench.quickVideo.sessions.title") }}</span>
            </div>
            <i-dot class="chatSidebarStatus" theme="outline" :fill="connected ? 'green' : 'red'" />
            <button
              v-if="isNarrow"
              type="button"
              class="chatSidebarClose"
              :aria-label="$t('workbench.quickVideo.closeChat')"
              data-testid="quick-video-drawer-close"
              @click="closeDrawer">
              <i-close size="16" />
            </button>
          </div>
          <div class="chatSidebarProject" :title="workbench.project?.name || ''">
            {{ workbench.project?.name || $t("workbench.quickVideo.sessions.defaultTitle") }}
          </div>
          <div class="chatSidebarHint">{{ $t("workbench.quickVideo.chatSidebarHint") }}</div>
        </div>

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
            <template v-for="message in messages" :key="message.id">
              <!-- SIY-143：气泡只承载文本/Markdown/思考等内容，媒体统一由下方 qvChatMediaCard 渲染；
                   t-chat-item 对 image 块固定渲染默认图片气泡且无法用插槽关闭，直接传完整消息会双重渲染 -->
              <t-chat-message
                v-if="hasBubbleContent(message)"
                :message="bubbleMessageOf(message)"
                :name="(message as any).name"
                :placement="message.role === 'user' ? 'right' : 'left'"
                :variant="message.role === 'user' ? 'base' : 'outline'"
                :handleActions="{}"
                :status="message.status"
                allowContentSegmentCustom></t-chat-message>
              <div v-if="mediaCardsOf(message).length" class="qvChatMediaRow">
                <div v-for="card in mediaCardsOf(message)" :key="card.key" class="qvChatMediaCard">
                  <div class="qvChatMediaThumb" @click="card.ext.state === 'done' && openMediaPreview(toMediaRefFromCard(card))">
                    <t-image v-if="card.ext.state === 'done' && card.ext.kind === 'image' && card.url" :src="card.url" fit="cover" :style="{ width: '100%', height: '100%', cursor: 'pointer' }" />
                    <video v-else-if="card.ext.state === 'done' && card.ext.kind === 'video' && card.url" :src="card.url" muted class="qvChatMediaVideo" />
                    <div v-else-if="card.ext.state === 'generating'" class="qvChatMediaPlaceholder"><t-loading size="small" :loading="true" /></div>
                    <div v-else class="qvChatMediaPlaceholder failed"><i-close-circle size="18" /></div>
                  </div>
                  <div class="qvChatMediaOps" v-if="card.ext.state === 'done'">
                    <t-button size="small" variant="text" @click="copyMediaRef(toMediaRefFromCard(card))">{{ $t("workbench.quickVideo.copy") }}</t-button>
                    <t-button v-if="card.ext.kind === 'image'" size="small" variant="text" theme="primary" @click="openFirstFramePicker(toMediaRefFromCard(card))">
                      {{ $t("workbench.quickVideo.setFirstFrame") }}
                    </t-button>
                  </div>
                  <div class="qvChatMediaOps" v-else-if="card.ext.state === 'failed'">
                    <span class="qvChatMediaError">{{ card.ext.errorReason || $t("workbench.quickVideo.gen.failed") }}</span>
                  </div>
                </div>
              </div>
            </template>
            <!-- 最终生成参数确认卡片（分镜确认后聊天回显，仅含时长/画风/分镜数量/分镜摘要） -->
            <div v-if="finalParamsCardsView.length" class="qvFinalParamsList" data-testid="quick-video-final-params">
              <div
                v-for="card in finalParamsCardsView"
                :key="card.cardId"
                class="qvFinalParamsCard"
                :class="{ active: card.active, confirmed: card.confirmed, stale: !card.active && !card.confirmed }">
                <div class="qvFinalParamsHead">
                  <span class="qvFinalParamsTitle">{{ $t("workbench.quickVideo.finalParams.title") }}</span>
                  <t-tag v-if="card.confirmed" shape="round" size="small" theme="success">
                    {{ $t("workbench.quickVideo.finalParams.confirmedTag") }}
                  </t-tag>
                  <t-tag v-else-if="card.active" shape="round" size="small" theme="warning">
                    {{ $t("workbench.quickVideo.finalParams.pendingTag") }}
                  </t-tag>
                  <t-tag v-else shape="round" size="small" theme="default">
                    {{ $t("workbench.quickVideo.finalParams.staleTag") }}
                  </t-tag>
                </div>
                <div class="qvFinalParamsRow"><label>{{ $t("workbench.quickVideo.finalParams.duration") }}</label><span>{{ card.targetDuration }}s</span></div>
                <div class="qvFinalParamsRow"><label>{{ $t("workbench.quickVideo.finalParams.artStyle") }}</label><span>{{ card.artStyle || "-" }}</span></div>
                <div class="qvFinalParamsRow"><label>{{ $t("workbench.quickVideo.finalParams.shotCount") }}</label><span>{{ card.shotCount }}</span></div>
                <div class="qvFinalParamsRow">
                  <label>{{ $t("workbench.quickVideo.finalParams.summary") }}</label>
                  <span>{{ card.summary || $t("workbench.quickVideo.finalParams.noSummary") }}</span>
                </div>
                <div class="qvFinalParamsOps" v-if="card.active">
                  <t-button size="small" theme="primary" :loading="confirmingFinalParams" data-testid="quick-video-confirm-generate" @click="confirmFinalParams">
                    {{ $t("workbench.quickVideo.finalParams.confirmGenerate") }}
                  </t-button>
                </div>
                <div class="qvFinalParamsStaleHint" v-else-if="!card.confirmed">{{ $t("workbench.quickVideo.finalParams.staleHint") }}</div>
              </div>
            </div>
          </t-chat-list>
          <!-- 待发送附件托盘（SIY-144）：粘贴/截图上传的缩略图、上传中状态、失败重试与单个移除 -->
          <div class="attachTray" v-if="pendingAttachments.length">
            <div
              v-for="(p, i) in pendingAttachments"
              :key="p.localId"
              class="attachItem"
              :class="{ failed: p.status === 'failed' }">
              <div class="attachThumb">
                <img v-if="p.previewUrl" :src="p.previewUrl" alt="" />
                <div v-else class="attachLoading"><t-loading size="small" :text="$t('workbench.quickVideo.attach.uploading')" /></div>
                <t-tag v-if="p.status === 'failed'" theme="danger" size="small" class="attachState">{{ $t("workbench.quickVideo.attach.failed") }}</t-tag>
                <!-- 右上角删除 x：上传中/就绪/失败任何状态都可见可点，点击仅从托盘移除（不动已入库资产） -->
                <button
                  class="attachRemove"
                  type="button"
                  :title="$t('workbench.quickVideo.attach.remove')"
                  :aria-label="$t('workbench.quickVideo.attach.remove')"
                  data-testid="quick-video-attach-remove"
                  @click.stop="removePendingAttachment(i)">
                  <i-close size="10" />
                </button>
              </div>
              <div class="attachMeta">
                <div class="attachName" :title="p.name">{{ p.name }}</div>
                <t-button v-if="p.status === 'failed'" size="small" variant="text" class="attachRetry" :title="$t('workbench.quickVideo.attach.retry')" @click="retryPendingAttachment(i)">
                  <template #icon><i-refresh size="12" /></template>
                </t-button>
              </div>
            </div>
          </div>
          <div class="senderWrap" @paste="onSenderPaste">
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
          </div>
        </div>
      </aside>
      <!-- 可调节分隔线（SIY-141）：Pointer Events 拖拽 + 键盘方向键 / Home / End，窄屏降级为抽屉后隐藏 -->
      <div
        v-if="!isNarrow"
        class="layoutResizer"
        :class="{ active: layoutDragging }"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        :aria-label="$t('workbench.quickVideo.resizeChat')"
        :aria-valuemin="resizerAria.min"
        :aria-valuemax="resizerAria.max"
        :aria-valuenow="resizerAria.now"
        data-testid="quick-video-layout-resizer"
        @pointerdown="onResizerPointerdown"
        @pointermove="onResizerPointermove"
        @pointerup="onResizerPointerup"
        @pointercancel="onResizerPointercancel"
        @keydown="onResizerKeydown"></div>
      <nav class="quickNav" aria-label="Quick Video workspace navigation" data-testid="quick-video-workspace-nav">
        <button
          v-for="item in navigationItems"
          :key="item.key"
          type="button"
          class="quickNavButton"
          :class="{ active: activePanel === item.key }"
          :aria-current="activePanel === item.key ? 'page' : undefined"
          :data-testid="`quick-video-nav-${item.key}`"
          :title="item.label"
          @click="activePanel = item.key">
          <component :is="item.icon" class="quickNavIcon" />
          <span class="quickNavLabel">{{ item.label }}</span>
        </button>
      </nav>

      <div class="workspacePanels">
        <div class="data modulePane" data-testid="quick-video-main-panel">
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
          <t-alert v-if="workbenchError" theme="warning" :message="workbenchError" class="workbenchError" />
          <div v-if="storyboardRefreshHint && (activePanel === 'brief' || activePanel === 'storyboard')" class="configNotice">
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
          <AssetBoard
            v-if="activePanel === 'assets'"
            class="assetBoardBlock"
            :title="$t('workbench.quickVideo.assetBoard')"
            :items="assetBoardItems"
            :loading="assetBoardLoading"
            :total="assetBoardTotal"
            :page="assetBoardPage"
            :page-size="assetBoardPageSize"
            :all-label="$t('workbench.quickVideo.all')"
            :image-label="$t('workbench.quickVideo.image')"
            :video-label="$t('workbench.quickVideo.video')"
            :empty-text="$t('workbench.quickVideo.assetBoardEmpty')"
            :copy-text="$t('workbench.quickVideo.copy')"
            :set-first-frame-text="$t('workbench.quickVideo.setFirstFrame')"
            :failed-text="$t('workbench.quickVideo.gen.failed')"
            :generating-text="$t('workbench.quickVideo.gen.generating')"
            :expand-text="$t('workbench.quickVideo.expand')"
            :collapse-text="$t('workbench.quickVideo.collapse')"
            @refresh="loadAssetBoard"
            @page-change="handleAssetBoardPageChange"
            @filter-change="handleAssetBoardFilterChange"
            @zoom="openMediaPreview"
            @copy="copyMediaRef"
            @set-first-frame="openFirstFramePicker" />
          <div class="panelBody">
            <!-- 简报卡片 -->
            <div v-if="activePanel === 'brief'" class="card">
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
            <div v-if="activePanel === 'storyboard'" class="card">
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
                  <template #firstFrame="{ row }">
                    <div class="firstFrameCell">
                      <template v-if="row.firstFrame">
                        <t-image
                          v-if="mediaUrls[row.id]?.firstFrameUrl"
                          :src="mediaUrls[row.id].firstFrameUrl!"
                          fit="cover"
                          shape="round"
                          :style="{ width: '48px', height: '32px', cursor: 'pointer' }"
                          @click="openImagePreview(mediaUrls[row.id].firstFrameUrl!)" />
                        <span v-else class="noPreview">-</span>
                        <div class="firstFrameOps" v-if="canEditStoryboard">
                          <t-button size="small" variant="text" :disabled="!clipboardMediaRef" @click="pasteFirstFrameFromClipboard(row.id)">
                            {{ $t("workbench.quickVideo.replaceFirstFrame") }}
                          </t-button>
                          <t-button size="small" variant="text" theme="danger" @click="unbindFirstFrame(row.id)">
                            {{ $t("workbench.quickVideo.unbindFirstFrame") }}
                          </t-button>
                        </div>
                      </template>
                      <template v-else>
                        <t-button
                          v-if="canEditStoryboard"
                          size="small"
                          variant="outline"
                          :disabled="!clipboardMediaRef"
                          @click="pasteFirstFrameFromClipboard(row.id)">
                          {{ $t("workbench.quickVideo.pasteFirstFrame") }}
                        </t-button>
                        <span v-else class="noPreview">-</span>
                      </template>
                    </div>
                  </template>
                  <template #preview="{ row }">
                    <ShotPreviewCell
                      :shot="row"
                      :urls="mediaUrls[row.id]"
                      :urls-pending="mediaUrlsLoading"
                      :can-retry="state?.stage === 'generating'"
                      :retrying="retryingShots.includes(row.id)"
                      :reload-tick="mediaReloadTick"
                      :image-label="$t('workbench.quickVideo.image')"
                      :video-label="$t('workbench.quickVideo.video')"
                      :generating-text="$t('workbench.quickVideo.gen.generating')"
                      :failed-text="$t('workbench.quickVideo.gen.failed')"
                      :image-unavailable-text="$t('workbench.quickVideo.imagePreviewUnavailable')"
                      :video-unavailable-text="$t('workbench.quickVideo.videoPreviewUnavailable')"
                      :retry-text="$t('workbench.quickVideo.retryShot')"
                      @open-image="openImagePreview"
                      @open-video="(url: string) => openVideoPreview(url, row.id)"
                      @retry="retryShots([row.id])"
                      @refresh="refreshMediaUrls()" />
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

            <!-- 生成进度卡片 -->
            <div class="card" v-if="activePanel === 'preview' && (state?.stage === 'generating' || state?.stage === 'ready_to_assemble')">
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
            <div class="card" v-if="activePanel === 'preview' && showAssembleCard">
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
        </div>
      </div>
    </div>

    <!-- 窄屏抽屉兜底（SIY-141）：遮罩 + 浮动"打开聊天"按钮；聊天组件始终挂载，仅做位移不重建 -->
    <div v-if="isNarrow && narrowDrawerOpen" class="drawerScrim" data-testid="quick-video-drawer-scrim" @click="closeDrawer"></div>
    <button
      v-if="isNarrow && !narrowDrawerOpen"
      type="button"
      class="chatDrawerFab"
      data-testid="quick-video-chat-fab"
      @click="toggleDrawer">
      <i-chat size="16" />
      <span>{{ $t("workbench.quickVideo.openChat") }}</span>
    </button>

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
    <t-dialog v-model:visible="videoPreviewVisible" :header="$t('workbench.quickVideo.videoPreview')" width="640px" placement="center" :footer="false">
      <video
        v-if="videoPreviewUrl"
        :key="`qv-dialog-video-${mediaReloadTick}-${videoPreviewUrl}`"
        :src="videoPreviewUrl"
        controls
        autoplay
        playsinline
        class="videoPreview"
        @error="onVideoDialogError" />
      <div v-else class="videoPreviewEmpty">{{ $t("workbench.quickVideo.videoPreviewUnavailable") }}</div>
    </t-dialog>

    <!-- 镜头图预览 -->
    <t-image-viewer v-model="imagePreviewVisible" :images="imagePreviewImages" :closeOnOverlay="true" />

    <!-- 设为镜头首帧：选择目标草稿镜头 -->
    <t-dialog
      v-model:visible="firstFramePickerVisible"
      :header="$t('workbench.quickVideo.setFirstFrame')"
      width="480px"
      placement="center"
      :footer="false">
      <div class="firstFramePickerBody">
        <div class="firstFramePickerPreview" v-if="firstFramePickerTarget?.url">
          <t-image :src="firstFramePickerTarget.url" fit="cover" :style="{ width: '100%', height: '160px', borderRadius: '8px' }" />
        </div>
        <t-empty v-if="!draftShots.length" :title="$t('workbench.quickVideo.noDraftShots')" />
        <div v-else class="firstFramePickerList">
          <div v-for="shot in draftShots" :key="shot.id" class="firstFramePickerItem" @click="confirmFirstFramePicker(shot.id)">
            <span class="firstFramePickerIndex">#{{ shot.index }}</span>
            <span class="firstFramePickerDesc">{{ shot.description }}</span>
            <i-check v-if="shot.firstFrame?.mediaId === firstFramePickerTarget?.mediaId" size="16" />
          </div>
        </div>
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import quickVideoStore from "@/stores/quickVideo";
import type { QuickVideoDuration, QuickVideoRatio, QuickVideoStage, QuickVideoShot, QuickVideoSession, QuickVideoFinalParamsCard, MediaRef, ChatMediaExt, QuickVideoShotMediaUrls } from "@/types/quickVideo";
import modelSelect from "@/components/modelSelect.vue";
import SessionList from "./components/SessionList.vue";
import AssetBoard from "./components/AssetBoard.vue";
import dayjs from "dayjs";
import ExportProgress from "./ExportProgress.vue";
import { useTimelinePlayer } from "./timelinePlayer";
import { estimateExportBytes, formatBytes, formatTime } from "./timelineCore";
import { QUICK_VIDEO_SPLIT_CONSTRAINTS, quickVideoLayoutStorageKey, useQuickVideoSplitLayout } from "./splitLayout";
import ShotPreviewCell from "./components/ShotPreviewCell.vue";
import { createBubbleMessageView } from "./chatMedia";
import { readMediaRefsFromText } from "./chatPaste";

const { project } = storeToRefs(projectStore());
const quickVideoStoreRef = quickVideoStore();
const { connected, messages, status, workbench, state, loadingWorkbench, workbenchError, sessions, loadingSessions, currentSessionId, modelPreferences, isGenerating, clipboardMediaRef } =
  storeToRefs(quickVideoStoreRef);
const { stopGenerate, getWorkbench, updateConfig, getHistory, getMediaUrls, getTimeline, loadSessions, createSession, updateSession, switchSession, setModelPreference, getAssetBoard, bindShotFirstFrame, uploadChatMedia } =
  quickVideoStoreRef;

type QuickVideoPanel = "brief" | "storyboard" | "assets" | "preview";

const activePanel = ref<QuickVideoPanel>("brief");
const navigationItems: { key: QuickVideoPanel; label: string; icon: string }[] = [
  { key: "brief", label: $t("workbench.quickVideo.brief"), icon: "i-file" },
  { key: "storyboard", label: $t("workbench.quickVideo.storyboard"), icon: "i-view-list" },
  { key: "assets", label: $t("workbench.quickVideo.assetBoard"), icon: "i-image" },
  { key: "preview", label: $t("workbench.quickVideo.preview"), icon: "i-play-circle" },
];

const inputValue = ref("");

// ===== 可调节双栏布局（SIY-141）—— 纯布局层：只改样式与交互，不触碰分镜数据流 / Socket / WebAV =====
const workspaceLayoutRef = ref<HTMLElement | null>(null);
// LocalStorage 键按项目隔离：同一浏览器里各快创项目记忆各自的栏宽比例
const layoutStorageKey = computed(() => quickVideoLayoutStorageKey(project.value?.id));
const {
  containerWidth: layoutContainerWidth,
  appliedWidth: layoutAppliedWidth,
  leftBounds: layoutLeftBounds,
  dragging: layoutDragging,
  isNarrow,
  narrowDrawerOpen,
  onResizerPointerdown,
  onResizerPointermove,
  onResizerPointerup,
  onResizerPointercancel,
  onResizerKeydown,
  toggleDrawer,
  closeDrawer,
} = useQuickVideoSplitLayout(workspaceLayoutRef, layoutStorageKey, QUICK_VIDEO_SPLIT_CONSTRAINTS);

// 窄屏抽屉模式下宽度交给样式接管（min(360px, 88vw)），内联 width 置空避免覆盖
const chatSidebarStyle = computed(() =>
  isNarrow.value || layoutAppliedWidth.value === null ? {} : { width: `${layoutAppliedWidth.value}px` },
);
const resizerAria = computed(() => {
  const bounds = layoutLeftBounds.value;
  const fallbackMax = Math.floor(QUICK_VIDEO_SPLIT_CONSTRAINTS.maxLeftRatio * (layoutContainerWidth.value || 0));
  return {
    min: bounds?.min ?? QUICK_VIDEO_SPLIT_CONSTRAINTS.minLeft,
    max: bounds?.max ?? Math.max(QUICK_VIDEO_SPLIT_CONSTRAINTS.minLeft, fallbackMax),
    now: layoutAppliedWidth.value ?? Math.round(QUICK_VIDEO_SPLIT_CONSTRAINTS.defaultRatio * layoutContainerWidth.value),
  };
});

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
  quickVideoStoreRef.resume();
  getWorkbench();
  void loadAssetBoard();
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

// ===== 聊天输入框粘贴/上传附件（SIY-144） =====
interface PendingAttachment {
  localId: string;
  name: string;
  status: "uploading" | "ready" | "failed";
  previewUrl?: string;
  /** 本地预览对象 URL，移除/发送后需 revoke */
  objectUrl?: string;
  file?: File;
  mediaRef?: MediaRef;
}
const pendingAttachments = ref<PendingAttachment[]>([]);
const pendingAttachmentLimit = 4;

function addPendingFile(file: File) {
  if (pendingAttachments.value.length >= pendingAttachmentLimit) {
    window.$message.warning($t("workbench.quickVideo.attach.tooMany", { max: pendingAttachmentLimit }));
    return;
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    window.$message.warning($t("workbench.quickVideo.attach.mimeRejected"));
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    window.$message.warning($t("workbench.quickVideo.attach.tooLarge"));
    return;
  }
  const item: PendingAttachment = {
    localId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || $t("workbench.quickVideo.attach.pastedImage"),
    status: "uploading",
    objectUrl: URL.createObjectURL(file),
    file,
  };
  item.previewUrl = item.objectUrl;
  pendingAttachments.value.push(item);
  uploadPendingAttachment(item);
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error($t("workbench.quickVideo.attach.readFailed")));
    reader.readAsDataURL(file);
  });
}

async function uploadPendingAttachment(item: PendingAttachment) {
  if (!item.file) return;
  item.status = "uploading";
  try {
    const base64Data = (await readAsDataURL(item.file)).replace(/^data:[^;]+;base64,/, "");
    const media = await uploadChatMedia({
      base64Data,
      mimeType: item.file.type,
      name: item.file.name ? item.file.name.replace(/\.[^.]+$/, "") : undefined,
    });
    item.mediaRef = media;
    item.name = media.promptSummary || item.name;
    // 服务端短期预览地址优先；不可用时保留本地 objectURL 预览
    if (media.url) item.previewUrl = media.url;
    item.status = "ready";
  } catch (err: any) {
    item.status = "failed";
    window.$message.error(err?.message ?? $t("workbench.quickVideo.attach.failed"));
  }
}

function retryPendingAttachment(index: number) {
  const item = pendingAttachments.value[index];
  if (item) uploadPendingAttachment(item);
}

function removePendingAttachment(index: number) {
  const item = pendingAttachments.value[index];
  if (item?.objectUrl) URL.revokeObjectURL(item.objectUrl);
  pendingAttachments.value.splice(index, 1);
}

function clearPendingAttachments() {
  for (const p of pendingAttachments.value) {
    if (p.objectUrl) URL.revokeObjectURL(p.objectUrl);
  }
  pendingAttachments.value = [];
}

/** 把稳定媒体引用放入待发送托盘（按 mediaId 去重） */
function stagePendingRef(ref: MediaRef) {
  if (pendingAttachments.value.some((p) => p.mediaRef?.mediaId === ref.mediaId)) return;
  if (pendingAttachments.value.length >= pendingAttachmentLimit) {
    window.$message.warning($t("workbench.quickVideo.attach.tooMany", { max: pendingAttachmentLimit }));
    return;
  }
  pendingAttachments.value.push({
    localId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: ref.promptSummary || "图片引用",
    status: "ready",
    previewUrl: ref.url ?? undefined,
    mediaRef: ref,
  });
}

// 输入框粘贴（SIY-144）：优先二进制图片（截图/本地图）→ 上传落库；
// 其次剪贴板文本中的稳定 MediaRef JSON；最后消费应用内剪贴板选中的引用。
function onSenderPaste(e: ClipboardEvent) {
  const files: File[] = [];
  for (const item of e.clipboardData?.items ?? []) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length) {
    e.preventDefault();
    files.forEach((f) => addPendingFile(f));
    return;
  }

  const text = e.clipboardData?.getData("text/plain") ?? "";
  const refsFromText = readMediaRefsFromText(text);
  if (refsFromText?.length) {
    e.preventDefault();
    refsFromText.forEach(stagePendingRef);
    window.$message.success($t("workbench.quickVideo.attach.refPasted", { count: refsFromText.length }));
    return;
  }

  if (!text.trim() && clipboardMediaRef.value) {
    e.preventDefault();
    stagePendingRef(clipboardMediaRef.value);
    window.$message.success($t("workbench.quickVideo.attach.refPasted", { count: 1 }));
  }
}

function handleSend(text: string) {
  const mode = activeModelType.value === "image" ? "image" : activeModelType.value === "video" ? "video" : "text";
  if (mode === "image" && !modelPreferences.value.image) {
    window.$message.warning($t("workbench.quickVideo.selectImageModelFirst"));
    return;
  }
  if (mode === "video" && !modelPreferences.value.video) {
    window.$message.warning($t("workbench.quickVideo.selectVideoModelFirst"));
    return;
  }
  // 上传未完成/有失败项时不允许发送，避免引用缺位或静默丢图（SIY-144）
  if (pendingAttachments.value.some((p) => p.status === "uploading")) {
    window.$message.warning($t("workbench.quickVideo.attach.stillUploading"));
    return;
  }
  if (pendingAttachments.value.some((p) => p.status === "failed")) {
    window.$message.warning($t("workbench.quickVideo.attach.failedBlock"));
    return;
  }
  // 应用内部剪贴板选中的引用媒体与粘贴上传的附件一并带上，供图生图/图生视频使用（SIY-134/SIY-144）；
  // 切换文本模型不会新建或切换 session_id，socket 隔离键由服务端按当前会话固定。
  const referenceIds: number[] = [];
  for (const p of pendingAttachments.value) {
    if (p.mediaRef && !referenceIds.includes(p.mediaRef.mediaId)) referenceIds.push(p.mediaRef.mediaId);
  }
  if (clipboardMediaRef.value && !referenceIds.includes(clipboardMediaRef.value.mediaId)) {
    referenceIds.push(clipboardMediaRef.value.mediaId);
  }
  quickVideoStoreRef.chat(text, undefined, modelPreferences.value.text || undefined, {
    mode,
    imageModel: mode === "image" ? modelPreferences.value.image : undefined,
    videoModel: mode === "video" ? modelPreferences.value.video : undefined,
    references: referenceIds.length ? referenceIds.slice(0, 4) : undefined,
  });
  clearPendingAttachments();
  inputValue.value = "";
}
function handleStop() {
  quickVideoStoreRef.stopGenerate();
}

// ===== 资产白板（SIY-132） =====
const assetBoardItems = ref<MediaRef[]>([]);
const assetBoardTotal = ref(0);
const assetBoardPage = ref(1);
const assetBoardPageSize = 24;
const assetBoardLoading = ref(false);
const assetBoardKind = ref<"all" | "image" | "video">("all");

async function loadAssetBoard() {
  assetBoardLoading.value = true;
  try {
    const result = await getAssetBoard({ kind: assetBoardKind.value, page: assetBoardPage.value, pageSize: assetBoardPageSize });
    assetBoardItems.value = result.items;
    assetBoardTotal.value = result.total;
  } catch (e: any) {
    console.error("[quickVideo] 加载资产白板失败", e);
  } finally {
    assetBoardLoading.value = false;
  }
}

function handleAssetBoardPageChange(page: number) {
  assetBoardPage.value = page;
  void loadAssetBoard();
}

function handleAssetBoardFilterChange(kind: "all" | "image" | "video") {
  assetBoardKind.value = kind;
  assetBoardPage.value = 1;
  void loadAssetBoard();
}

// 聊天一轮结束后刷新一次白板：本轮如果生成了新图片，此时已经落库完成
watch(isGenerating, (generating, prev) => {
  if (prev && !generating) void loadAssetBoard();
});

// ===== 聊天图片卡片 / 白板卡片：复制、放大、设为首帧（共用同一套逻辑与绑定接口） =====

interface ChatMediaCard {
  key: string;
  ext: ChatMediaExt;
  url: string | null;
  promptSummary: string | null;
}

// 气泡展示副本：剥离 image/video 块交给 t-chat-message，媒体统一由 qvChatMediaCard 渲染（SIY-143）
const { bubbleMessageOf, hasBubbleContent } = createBubbleMessageView(messages);

function mediaCardsOf(message: any): ChatMediaCard[] {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const seenMediaIds = new Set<string | number>();
  const cards: ChatMediaCard[] = [];
  for (const c of content) {
    if (!(c.type === "image" || c.type === "video") || !c.ext?.mediaId) continue;
    // 同一 mediaId 只出一张卡片：实时链路极端情况（重连重放）下的兜底，与历史恢复去重同一判据
    if (seenMediaIds.has(c.ext.mediaId)) continue;
    seenMediaIds.add(c.ext.mediaId);
    cards.push({ key: `${message.id}-${c.id ?? c.ext.mediaId}`, ext: c.ext as ChatMediaExt, url: c.data?.url ?? null, promptSummary: c.ext?.promptSummary ?? null });
  }
  return cards;
}

function toMediaRefFromCard(card: ChatMediaCard): MediaRef {
  return {
    mediaId: card.ext.mediaId,
    projectId: Number(project.value?.id),
    kind: card.ext.kind,
    assetId: card.ext.assetId,
    imageId: card.ext.imageId,
    videoId: card.ext.videoId ?? null,
    state: card.ext.state,
    model: card.ext.model,
    promptSummary: card.promptSummary,
    source: card.ext.source,
    errorReason: card.ext.errorReason ?? null,
    url: card.url,
    createTime: Date.now(),
  };
}

async function copyMediaRef(ref: MediaRef) {
  clipboardMediaRef.value = ref;
  let systemCopyOk = false;
  try {
    if (ref.url && ref.kind === "image" && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      const resp = await fetch(ref.url);
      const blob = await resp.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      systemCopyOk = true;
    }
  } catch {
    // 系统剪贴板受限（权限/浏览器不支持）时静默降级为仅应用内部复制，不阻断流程
  }
  window.$message.success(systemCopyOk ? $t("workbench.quickVideo.copiedBoth") : $t("workbench.quickVideo.copiedInternalOnly"));
}

const firstFramePickerVisible = ref(false);
const firstFramePickerTarget = ref<MediaRef | null>(null);

function openFirstFramePicker(ref: MediaRef) {
  if (ref.state !== "done" || ref.kind !== "image") return;
  firstFramePickerTarget.value = ref;
  firstFramePickerVisible.value = true;
}

async function confirmFirstFramePicker(shotId: string) {
  const target = firstFramePickerTarget.value;
  if (!target) return;
  const result = await bindShotFirstFrame(shotId, target.mediaId);
  if (!result.ok) {
    window.$message.warning(result.error.message);
    return;
  }
  firstFramePickerVisible.value = false;
  window.$message.success($t("workbench.quickVideo.firstFrameBound"));
}

async function pasteFirstFrameFromClipboard(shotId: string) {
  const ref = clipboardMediaRef.value;
  if (!ref) return;
  const result = await bindShotFirstFrame(shotId, ref.mediaId);
  if (!result.ok) {
    window.$message.warning(result.error.message);
    return;
  }
  window.$message.success($t("workbench.quickVideo.firstFrameBound"));
}

async function unbindFirstFrame(shotId: string) {
  const result = await bindShotFirstFrame(shotId, null);
  if (!result.ok) window.$message.warning(result.error.message);
}

function openMediaPreview(ref: MediaRef) {
  if (!ref.url) return;
  if (ref.kind === "video") openVideoPreview(ref.url);
  else openImagePreview(ref.url);
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
/** 首帧选择器可选目标：仅草稿阶段的镜头允许粘贴/替换首帧 */
const draftShots = computed(() => (canEditStoryboard.value ? state.value?.storyboard?.shots ?? [] : []));

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
  { colKey: "firstFrame", title: $t("workbench.quickVideo.firstFrame"), width: 130 },
  { colKey: "preview", title: $t("workbench.quickVideo.preview"), width: 168 },
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

// ===== 最终生成参数确认卡片（分镜确认后聊天回显；参数变更后旧卡片失效） =====
const confirmingFinalParams = ref(false);
const finalParamsCards = computed(() => state.value?.generation?.finalParamsCards ?? []);
const latestCardId = computed(() => finalParamsCards.value[finalParamsCards.value.length - 1]?.cardId ?? "");

/** 卡片是否仍与当前实时参数一致（分镜版本/时长/画风/分镜数量/分镜摘要） */
function cardMatchesLiveParams(card: QuickVideoFinalParamsCard): boolean {
  const sb = state.value?.storyboard;
  if (!sb) return false;
  return (
    sb.version === card.storyboardVersion &&
    state.value?.targetDuration === card.targetDuration &&
    (state.value?.artStyle ?? "") === card.artStyle &&
    sb.shots.length === card.shotCount &&
    (sb.summary ?? "") === card.summary
  );
}

interface FinalParamsCardView extends QuickVideoFinalParamsCard {
  confirmed: boolean;
  active: boolean;
}

const finalParamsCardsView = computed<FinalParamsCardView[]>(() => {
  const cards = finalParamsCards.value.map((card) => {
    const isLatest = card.cardId === latestCardId.value;
    const matches = cardMatchesLiveParams(card);
    const confirmed = isLatest && matches && !!state.value?.generation?.materialsConfirmed;
    const active =
      isLatest && matches && state.value?.stage === "storyboard_confirmed" && !state.value?.generation?.materialsConfirmed;
    return { ...card, confirmed, active };
  });
  // 兼容存量项目：已处于待确认状态但从未回显过卡片（旧版本状态机推进）时，现场合成一张当前参数卡片
  if (!cards.some((c) => c.active) && state.value?.stage === "storyboard_confirmed" && !state.value?.generation?.materialsConfirmed && state.value.storyboard) {
    cards.push({
      cardId: "live",
      storyboardVersion: state.value.storyboard.version,
      targetDuration: state.value.targetDuration,
      artStyle: state.value.artStyle,
      shotCount: state.value.storyboard.shots.length,
      summary: state.value.storyboard.summary ?? "",
      echoedAt: 0,
      confirmed: false,
      active: true,
    });
  }
  // 聊天流内最多展示最近 3 张卡片（最新在前），更早的回显历史不占空间
  return cards.reverse().slice(0, 3);
});

async function confirmFinalParams() {
  if (!state.value) return;
  confirmingFinalParams.value = true;
  try {
    const ok = await callQuickVideoApi("/quickVideo/confirmStage", {
      projectId: Number(project.value?.id),
      sessionId: currentSessionId.value,
      expectedVersion: state.value.version,
      idempotencyKey: newIdemKey(),
      gate: "materials",
      action: "confirm",
    });
    // 确认后无缝进入逐镜头生成：切到预览面板实时展示各镜头进度
    if (ok) activePanel.value = "preview";
  } finally {
    confirmingFinalParams.value = false;
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

// ===== 镜头产物预览（imageRef/videoRef -> 访问地址，SIY-147 双卡片预览） =====
const mediaUrls = ref<Record<string, QuickVideoShotMediaUrls>>({});
const mediaUrlsLoading = ref(false);
/** 静默刷新媒体地址后自增：作为 <img>/<video> :key 的一部分，强制重新挂载以重试同一地址 */
const mediaReloadTick = ref(0);
let lastMediaRefreshAt = 0;

/** 按需重新拉取短期媒体地址：产物回写（force）或卡片地址失效（点击/加载失败）时调用 */
async function refreshMediaUrls(force = false) {
  if (mediaUrlsLoading.value) return;
  // 防抖：多个卡片同时报错只触发一次静默刷新
  const now = Date.now();
  if (!force && now - lastMediaRefreshAt < 2000) return;
  mediaUrlsLoading.value = true;
  try {
    mediaUrls.value = await getMediaUrls();
    mediaReloadTick.value++;
    lastMediaRefreshAt = Date.now();
  } catch {
    // 预览地址获取失败不影响工作台
  } finally {
    mediaUrlsLoading.value = false;
  }
}

const mediaSignature = computed(() =>
  shots.value
    .map((s) => `${s.id}:${s.imageRef ?? ""}:${s.videoRef ?? ""}:${s.firstFrame?.mediaId ?? ""}`)
    .join("|"),
);
watch(mediaSignature, (sig, prev) => {
  if (sig === prev) return;
  if (!shots.value.some((s) => s.imageRef || s.videoRef || s.firstFrame)) {
    mediaUrls.value = {};
    return;
  }
  // 监听 imageRef/videoRef 变更（分镜重新生成、单镜头重试回写）自动刷新预览缓存
  refreshMediaUrls(true);
}, { immediate: true });

const videoPreviewVisible = ref(false);
const videoPreviewUrl = ref("");
const videoPreviewShotId = ref<string | null>(null);
// 同一地址只在弹窗内自动静默刷新一次，避免持续失效时反复重拉
let dialogAutoRefreshedUrl: string | null = null;
function openVideoPreview(url: string, shotId?: string) {
  videoPreviewUrl.value = url;
  videoPreviewShotId.value = shotId ?? null;
  dialogAutoRefreshedUrl = null;
  videoPreviewVisible.value = true;
}
/** 弹窗内播放失败（地址过期/403）：静默换新地址后借 reloadTick 重挂载重试一次 */
async function onVideoDialogError() {
  const url = videoPreviewUrl.value;
  if (!url || dialogAutoRefreshedUrl === url) return;
  dialogAutoRefreshedUrl = url;
  await refreshMediaUrls(true);
  const fresh = (videoPreviewShotId.value ? mediaUrls.value[videoPreviewShotId.value]?.videoUrl : null) ?? null;
  if (fresh) {
    videoPreviewUrl.value = fresh;
  } else {
    videoPreviewVisible.value = false;
    window.$message.warning($t("workbench.quickVideo.videoPreviewUnavailable"));
  }
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

const showAssembleCard = computed(() => activePanel.value === "preview" && ["ready_to_assemble", "completed"].includes(state.value?.stage ?? ""));
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
  { immediate: true, flush: "post" },
);

onBeforeUnmount(() => {
  timelinePlayer.destroy();
  quickVideoStoreRef.dispose();
});

async function reloadTimeline() {
  if (!state.value) return;
  timelineReloading.value = true;
  try {
    const payload: TimelinePayload | null = await getTimeline();
    // Leaving the preview while media is loading must not recreate a player
    // in a detached container or retain decoded frames after the panel is gone.
    if (!showAssembleCard.value) return;
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
    if (e?.message !== "TIMELINE_LOAD_CANCELLED") {
      window.$message.warning(e?.message ?? $t("workbench.quickVideo.opFailed"));
    }
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
  timelinePlayer.cancelExport();
}
</script>

<style lang="scss" scoped>
.quickVideo {
  height: calc(100% - 16px);
  min-width: 0;
  overflow: hidden;
  position: relative;
  .workspaceLayout {
    height: 100%;
    min-width: 0;
    min-height: 0;
    display: flex;
    gap: 8px;
  }
  .layoutResizer {
    flex: 0 0 8px;
    width: 8px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    position: relative;
    cursor: col-resize;
    /* 触屏拖动时不触发页面滚动 */
    touch-action: none;
    outline: none;
    &::before {
      content: "";
      position: absolute;
      left: 50%;
      top: 4px;
      bottom: 4px;
      width: 2px;
      transform: translateX(-50%);
      border-radius: 1px;
      background: var(--td-border-level-1-color);
      transition: background-color 0.15s ease, width 0.15s ease;
    }
    &:hover::before,
    &.active::before {
      width: 3px;
      background: var(--td-brand-color);
    }
    &:focus-visible::before {
      background: var(--td-brand-color);
    }
    &:focus-visible {
      box-shadow: inset 0 0 0 2px var(--td-brand-color-light);
    }
    &.active {
      background: var(--td-brand-color-1);
    }
  }
  .workspacePanels {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .chatSidebar {
    /* SIY-141：可调节双栏 —— 宽度由 splitLayout 内联接管（默认 35%，300px~55% 且右栏 ≥420px），
       此处仅保留无 JS 测量前的兜底与边界护栏 */
    flex: 0 0 auto;
    width: 35%;
    min-width: 300px;
    max-width: 55%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--td-border-level-1-color);
    border-radius: 10px;
    background: var(--td-bg-color-container);
    .chatSidebarHeader {
      flex: 0 0 auto;
      padding: 14px 14px 12px;
      border-bottom: 1px solid var(--td-border-level-1-color);
      background: linear-gradient(135deg, var(--td-brand-color-1), var(--td-bg-color-container) 68%);
    }
    .chatSidebarTitleRow {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .chatSidebarTitle {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-size: 14px;
      font-weight: 650;
    }
    .chatSidebarIcon {
      color: var(--td-brand-color);
    }
    .chatSidebarStatus {
      flex-shrink: 0;
    }
    .chatSidebarClose {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      color: var(--td-text-color-secondary);
      background: transparent;
      cursor: pointer;
      &:hover {
        color: var(--td-text-color-primary);
        background: var(--td-bg-color-secondarycontainer);
      }
    }
    .chatSidebarProject {
      margin-top: 8px;
      overflow: hidden;
      color: var(--td-text-color-primary);
      font-size: 13px;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chatSidebarHint {
      margin-top: 5px;
      color: var(--td-text-color-secondary);
      font-size: 12px;
      line-height: 1.5;
    }
    .box {
      min-height: 0;
      min-width: 0;
      max-width: 100%;
      padding: 0 8px 8px;
      border: 0;
      border-radius: 0;
      background: transparent;
    }
    .box :deep(.t-chat-list) {
      min-height: 0;
      min-width: 0;
      max-width: 100%;
      /* 长链接 / 长连续字符不允许撑出横向滚动，横向溢出一律在栏内消化 */
      overflow-x: hidden;
    }
    .box :deep(.t-chat-message) {
      min-width: 0;
      max-width: 100%;
      overflow-wrap: anywhere;
    }
  }
  .quickNav {
    flex: 0 0 72px;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    padding: 8px 5px;
    border: 1px solid var(--td-border-level-1-color);
    border-radius: 10px;
    background: var(--td-bg-color-container);
  }
  .quickNavButton {
    min-height: 58px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 6px 3px;
    border: 0;
    border-radius: 8px;
    color: var(--td-text-color-secondary);
    background: transparent;
    cursor: pointer;
    transition: color 0.15s ease, background 0.15s ease;
    &:hover {
      color: var(--td-brand-color);
      background: var(--td-bg-color-secondarycontainer);
    }
    &.active {
      color: var(--td-brand-color);
      background: var(--td-brand-color-1);
      font-weight: 600;
    }
    .quickNavIcon {
      flex-shrink: 0;
      font-size: 19px;
    }
    .quickNavLabel {
      max-width: 64px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      line-height: 1.2;
    }
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
      // 待发送附件托盘（SIY-144）
      .attachTray {
        display: flex;
        gap: 8px;
        padding: 0 8px 6px;
        overflow-x: auto;
        .attachItem {
          position: relative;
          width: 76px;
          flex-shrink: 0;
          border: 1px solid var(--td-border-level-1-color);
          border-radius: 8px;
          padding: 4px;
          &.failed {
            border-color: var(--td-error-color);
          }
          .attachThumb {
            position: relative;
            width: 100%;
            height: 48px;
            border-radius: 6px;
            overflow: hidden;
            background-color: var(--td-bg-color-secondarycontainer);
            img {
              width: 100%;
              height: 100%;
              object-fit: cover;
              display: block;
            }
            .attachLoading {
              width: 100%;
              height: 100%;
              display: flex;
              align-items: center;
              justify-content: center;
            }
            .attachState {
              position: absolute;
              top: 2px;
              left: 2px;
            }
            // 右上角删除 x：深色圆形底 + 白色 x，明暗主题都清晰可见；任何状态都可点
            .attachRemove {
              position: absolute;
              top: 2px;
              right: 2px;
              z-index: 2;
              width: 16px;
              height: 16px;
              padding: 0;
              border: none;
              border-radius: 50%;
              background-color: rgba(0, 0, 0, 0.55);
              color: #fff;
              display: flex;
              align-items: center;
              justify-content: center;
              cursor: pointer;
              &:hover {
                background-color: var(--td-error-color);
              }
            }
          }
          .attachMeta {
            display: flex;
            align-items: center;
            gap: 2px;
            margin-top: 2px;
            min-width: 0;
          }
          .attachName {
            flex: 1;
            min-width: 0;
            font-size: 11px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .attachRetry {
            flex-shrink: 0;
          }
        }
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
      .qvChatMediaRow {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: -4px 12px 10px 44px;
        max-width: 100%;
        min-width: 0;
      }
      .qvChatMediaCard {
        width: 96px;
        display: flex;
        flex-direction: column;
        gap: 3px;
        .qvChatMediaThumb {
          width: 96px;
          height: 96px;
          border-radius: 8px;
          overflow: hidden;
          background: var(--td-bg-color-secondarycontainer);
          display: flex;
          align-items: center;
          justify-content: center;
          .qvChatMediaVideo {
            width: 100%;
            height: 100%;
            object-fit: cover;
          }
        }
        .qvChatMediaPlaceholder {
          display: flex;
          align-items: center;
          justify-content: center;
          &.failed {
            color: var(--td-error-color);
          }
        }
        .qvChatMediaOps {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .qvChatMediaError {
          font-size: 11px;
          color: var(--td-error-color);
          line-height: 1.4;
        }
      }
      .qvFinalParamsList {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin: 4px 12px 12px;
        min-width: 0;
        max-width: 100%;
      }
      .qvFinalParamsCard {
        border: 1px solid var(--td-component-border);
        border-radius: 10px;
        padding: 10px 12px;
        background: var(--td-bg-color-container);
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 13px;
        &.active {
          border-color: var(--td-brand-color);
          box-shadow: 0 0 0 1px var(--td-brand-color-light);
        }
        &.stale {
          opacity: 0.55;
          background: var(--td-bg-color-secondarycontainer);
        }
        .qvFinalParamsHead {
          display: flex;
          align-items: center;
          justify-content: space-between;
          .qvFinalParamsTitle {
            font-weight: 600;
          }
        }
        .qvFinalParamsRow {
          display: flex;
          gap: 8px;
          label {
            flex-shrink: 0;
            opacity: 0.55;
          }
          span {
            flex: 1;
            min-width: 0;
            overflow-wrap: anywhere;
            word-break: break-all;
          }
        }
        .qvFinalParamsOps {
          display: flex;
          justify-content: flex-end;
          margin-top: 2px;
        }
        .qvFinalParamsStaleHint {
          font-size: 12px;
          opacity: 0.6;
        }
      }
    }
  }
  .chatSidebar .box {
    height: auto;
    padding: 0 8px 8px;
    border: 0;
    border-radius: 0;
    background: transparent;
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
    .workbenchError {
      margin: 0 4px 12px;
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
    .assetBoardBlock {
      margin: 0 4px 12px;
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
  .modulePane {
    height: 100%;
    min-width: 0;
    min-height: 0;
    .panelBody {
      padding-right: 4px;
    }
  }
  .card {
    border: 1px solid var(--td-border-level-2-color);
    border-radius: 10px;
    background: var(--td-bg-color-container);
    overflow: hidden;
    min-width: 0;
    max-width: 100%;
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
      min-width: 0;
      max-width: 100%;
      /* SIY-141：分镜表等超宽内容的横向滚动收在卡片内部闭环，页面禁止出现全局横向滚动条 */
      overflow-x: auto;
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
      .firstFrameCell {
        display: flex;
        flex-direction: column;
        gap: 4px;
        .noPreview {
          opacity: 0.4;
        }
        .firstFrameOps {
          display: flex;
          gap: 2px;
        }
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
  .videoPreviewEmpty {
    padding: 48px 0;
    text-align: center;
    color: var(--td-text-color-secondary);
  }
  .firstFramePickerBody {
    .firstFramePickerPreview {
      margin-bottom: 12px;
    }
    .firstFramePickerList {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 320px;
      overflow-y: auto;
    }
    .firstFramePickerItem {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 6px;
      cursor: pointer;
      &:hover {
        background: var(--td-bg-color-secondarycontainer);
      }
      .firstFramePickerIndex {
        flex-shrink: 0;
        opacity: 0.6;
        font-size: 12px;
      }
      .firstFramePickerDesc {
        flex: 1;
        min-width: 0;
        font-size: 13px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }
  }
  .assembleLayout {
    display: flex;
    flex-wrap: wrap;
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

  /* 拖拽全程锁定光标与文字选中，防止跨元素拖拽丢帧（body 级 user-select 由 splitLayout 兜底） */
  &.dragging {
    cursor: col-resize;
    user-select: none;
  }

  /* SIY-141 窄屏兜底：两栏最小宽度无法并存（容器 < 约824px）时，主体铺满、聊天栏降级为抽屉覆盖层。
     聊天组件始终挂载（无 v-if 切换），仅做 transform 位移 —— 输入内容与 Socket 状态不受影响 */
  &.narrow {
    .layoutResizer {
      display: none;
    }
    .chatSidebar {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      z-index: 40;
      width: min(360px, 88vw);
      min-width: 0;
      max-width: none;
      transform: translateX(calc(-100% - 16px));
      transition: transform 0.22s ease;
      box-shadow: var(--td-shadow-2, 0 4px 16px rgba(0, 0, 0, 0.16));
    }
    .chatSidebarHint {
      display: none;
    }
    &.drawerOpen .chatSidebar {
      transform: translateX(0);
    }
    /* 主体工作区铺满剩余空间 */
    .workspacePanels {
      flex: 1 1 auto;
    }
  }
  .drawerScrim {
    position: absolute;
    inset: 0;
    z-index: 30;
    background: rgba(0, 0, 0, 0.4);
  }
  .chatDrawerFab {
    position: absolute;
    left: 12px;
    bottom: 12px;
    z-index: 35;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 9px 16px;
    border: 0;
    border-radius: 999px;
    color: #fff;
    font-size: 13px;
    background: var(--td-brand-color);
    box-shadow: var(--td-shadow-1, 0 2px 8px rgba(0, 0, 0, 0.2));
    cursor: pointer;
    &:hover {
      background: var(--td-brand-color-hover);
    }
  }
}

@media (max-width: 960px) {
  .quickVideo {
    .panel {
      .panelHeader {
        align-items: flex-start;
        flex-direction: column;
        .meta {
          width: 100%;
        }
      }
    }
  }
}

@media (max-width: 720px) {
  .quickVideo {
    .quickNav {
      flex-basis: 54px;
      padding: 6px 3px;
    }
    .quickNavButton {
      min-height: 48px;
      .quickNavLabel {
        display: none;
      }
    }
    .panel {
      padding-left: 6px;
      .panelHeader {
        align-items: flex-start;
        flex-direction: column;
        .meta {
          width: 100%;
        }
      }
    }
  }
}
</style>
