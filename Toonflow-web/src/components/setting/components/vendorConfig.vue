<template>
  <div class="modelServe">
    <!-- 左侧供应商列表 -->
    <div class="modelList">
      <div class="listFooter">
        <t-button block theme="primary" @click="handleAddVendor">
          <template #icon><t-icon name="add" /></template>
          {{ $t("settings.vendor.addVendor") }}
        </t-button>
      </div>
      <div class="listContent" v-loading="loading">
        <t-menu v-model="activeVendorId" theme="light" v-if="vendorList.length > 0">
          <t-menu-item v-for="(item, index) in vendorList" :key="index" :value="item.id" @click="activeVendorId = item.id" style="position: relative">
            <template #icon v-if="isValidBase64(item.icon)">
              <t-avatar size="24px" shape="round" :image="item.icon" />
            </template>
            <span>{{ item.name }}</span>
            <t-switch
              v-model="item.enable"
              :customValue="[1, 0]"
              :disabled="!canManageVendors"
              @click.stop
              @change="(val: any) => onChange(item, val)"
              style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); z-index: 10"></t-switch>
          </t-menu-item>
        </t-menu>

        <t-empty v-else :title="$t('settings.vendor.noVendor')" style="margin-top: 16px"></t-empty>
      </div>
    </div>
    <!-- 右侧配置面板 -->
    <div v-if="currentVendor" class="modelParameter">
      <div class="configuration">
        <t-form :data="currentVendor" labelAlign="top">
          <div class="infoBox ac jb">
            <span class="idBox">#{{ currentVendor.id }}</span>
            <span class="author">@{{ currentVendor.author }}</span>
          </div>
          <t-alert
            v-if="!canManageVendors"
            theme="info"
            :message="$t('settings.vendor.msg.readOnlyForMember')"
            style="margin-bottom: 12px" />
          <t-alert
            v-if="needsUpdate(currentVendor)"
            theme="warning"
            :message="$t('settings.vendor.msg.vendorNeedsUpdate')"
            style="margin-bottom: 12px" />
          <t-form-item>
            <MdPreview v-model="currentVendor.description" :theme="themeSetting.mode === 'dark' ? 'dark' : 'light'" />
          </t-form-item>
          <t-form-item v-for="input in requiredInputs" :key="input.key" :name="input.key">
            <template #label>
              <span class="requiredLabel">
                {{ input.label }}
                <span class="requiredMark">*</span>
                <span class="requiredText">{{ $t("settings.vendor.required") }}</span>
              </span>
            </template>
            <t-input v-model="currentVendor.inputValues[input.key]" :type="input.type" :disabled="!canManageVendors" clearable @blur="onBlurFn">
              <template #prefix-icon>
                <t-icon :name="getInputIcon(input.type)" />
              </template>
            </t-input>
            <template #help v-if="getInputPlaceholder(input)">
              <span class="inputHelp">{{ getInputPlaceholder(input) }}</span>
            </template>
          </t-form-item>

          <div v-if="optionalInputs.length > 0" class="optionalSection">
            <t-collapse>
              <t-collapse-panel value="optional-inputs" :header="$t('settings.vendor.optionalSection')">
                <t-form-item v-for="input in optionalInputs" :key="input.key" :name="input.key" :label="input.label">
                  <t-input v-model="currentVendor.inputValues[input.key]" :type="input.type" :disabled="!canManageVendors" clearable @blur="onBlurFn">
                    <template #prefix-icon>
                      <t-icon :name="getInputIcon(input.type)" />
                    </template>
                  </t-input>
                  <template #help v-if="getInputPlaceholder(input)">
                    <span class="inputHelp">{{ getInputPlaceholder(input) }}</span>
                  </template>
                </t-form-item>
              </t-collapse-panel>
            </t-collapse>
          </div>

          <div class="jb ac">
            <div>
              <h4 class="sectionTitle">{{ $t("settings.vendor.modelSettings") }}</h4>
              <div class="capabilityNotice">模型模式是渠道协议声明的能力，仅供查看；请在生成页选择本次生成模式。</div>
            </div>
            <t-button v-if="canManageVendors" variant="outline" size="small" @click="handleAddModel">
              <template #icon><i-plus theme="outline" /></template>
              {{ $t("settings.vendor.addModel") }}
            </t-button>
          </div>
          <t-card v-for="(item, index) in vendorModels" :key="index" class="modelCard">
            <div class="topInfo jb ac">
              <div class="modelCardNameWrap">
                <t-avatar v-if="getModelLogo(item.modelName)" size="24px" shape="round" :image="getModelLogo(item.modelName)!" />
                <span class="modelCardName">{{ item.name }}</span>
              </div>
              <div class="actionBtns">
                <t-button size="small" variant="text" @click="handleTestModel(item)">
                  <template #icon><i-lightning theme="outline" /></template>
                  {{ $t("settings.vendor.testModel") }}
                </t-button>
                <t-button variant="text" size="small" @click="handleEditModel(item)">
                  <template #icon><i-pencil theme="outline" /></template>
                  {{ $t("settings.vendor.edit") }}
                </t-button>
                <t-button v-if="canManageVendors" variant="text" size="small" theme="danger" @click="handleDeleteModel(item.modelName)">
                  <template #icon><i-delete theme="outline" /></template>
                  {{ $t("settings.vendor.delete") }}
                </t-button>
              </div>
            </div>
            <div class="tags">
              <t-tag theme="primary">{{ $t(getTypeLabel(item.type)) }}</t-tag>
              <t-tag v-if="item.type === 'text' && (item as any).think" variant="light">{{ $t("settings.vendor.think") }}</t-tag>
              <template v-for="(mode, mIdx) in (item as any).mode" :key="mIdx">
                <t-tag v-if="!Array.isArray(mode)" variant="light">{{ getModeLabel(mode, item.type) }}</t-tag>
                <t-tag v-else variant="light" v-for="(m, mmIdx) in mode" :key="mmIdx">
                  {{ getModeLabel(m, item.type) }}
                </t-tag>
              </template>
            </div>
          </t-card>
        </t-form>
        <div v-if="canManageVendors" class="updateAction">
          <t-button theme="danger" :loading="updating" @click="handleDeleteVendor">{{ $t("settings.vendor.deleteVendor") }}</t-button>
          <t-button theme="default" :loading="updating" @click="handleEditVendorCode">{{ $t("settings.vendor.editCode") }}</t-button>
          <!-- <t-button theme="primary" :loading="updating" @click="handleUpdateVendor">{{ $t("settings.vendor.updateConfig") }}</t-button> -->
        </div>
      </div>
    </div>

    <!-- 选择要启用的模型弹窗：模型的 mode/audio/时长分辨率由渠道协议目录（Layer1，admin 维护）声明，
         这里只负责把目录里尚未加入当前账号的模型启用出来，不允许再自定义这些参数 -->
    <t-dialog
      placement="center"
      width="40vw"
      v-model:visible="enableModelDialogVisible"
      :header="$t('settings.vendor.selectModelToEnable')"
      :footer="false"
      :maskClosable="false">
      <div class="addBox">
        <t-empty v-if="availableCatalogModels.length === 0" :title="$t('settings.vendor.noAvailableModels')" />
        <t-card v-for="(item, index) in availableCatalogModels" :key="index" class="modelCard">
          <div class="topInfo jb ac">
            <div class="modelCardNameWrap">
              <t-avatar v-if="getModelLogo(item.modelName)" size="24px" shape="round" :image="getModelLogo(item.modelName)!" />
              <span class="modelCardName">{{ item.name }}</span>
            </div>
            <t-button size="small" theme="primary" @click="handleEnableModel(item)">
              {{ $t("settings.vendor.enableModel") }}
            </t-button>
          </div>
          <div class="tags">
            <t-tag theme="primary">{{ $t(getTypeLabel(item.type)) }}</t-tag>
            <t-tag v-if="item.type === 'text' && (item as any).think" variant="light">{{ $t("settings.vendor.think") }}</t-tag>
            <template v-for="(mode, mIdx) in (item as any).mode" :key="mIdx">
              <t-tag v-if="!Array.isArray(mode)" variant="light">{{ getModeLabel(mode, item.type) }}</t-tag>
              <t-tag v-else variant="light" v-for="(m, mmIdx) in mode" :key="mmIdx">
                {{ getModeLabel(m, item.type) }}
              </t-tag>
            </template>
          </div>
        </t-card>
      </div>
    </t-dialog>

    <!-- 模型详情弹窗：只读展示协议目录声明的模式/音频/时长分辨率，仅允许切换该模型对当前账号的启用状态 -->
    <t-dialog
      placement="center"
      width="40vw"
      v-model:visible="modelDetailDialogVisible"
      :header="$t('settings.vendor.modelDetail')"
      :footer="false"
      :maskClosable="false">
      <div class="addBox" v-if="viewingModel">
        <div class="detailHeader jb ac">
          <div class="modelCardNameWrap">
            <t-avatar v-if="getModelLogo(viewingModel.modelName)" size="24px" shape="round" :image="getModelLogo(viewingModel.modelName)!" />
            <span class="modelCardName">{{ viewingModel.name }}</span>
            <span class="modelCardId">#{{ viewingModel.modelName }}</span>
          </div>
          <div class="statusSwitch">
            <t-switch
              v-model="modelEnabledSwitch"
              :disabled="!canManageVendors"
              :loading="modelStatusLoading"
              @change="(val: any) => handleToggleModelStatus(val)" />
            <span class="statusText">{{
              modelEnabledSwitch ? $t("settings.vendor.modelStatusEnabled") : $t("settings.vendor.modelStatusDisabled")
            }}</span>
          </div>
        </div>
        <div class="tags" style="margin-top: 12px">
          <t-tag theme="primary">{{ $t(getTypeLabel(viewingModel.type)) }}</t-tag>
          <t-tag v-if="viewingModel.type === 'text' && (viewingModel as any).think" variant="light">{{ $t("settings.vendor.think") }}</t-tag>
          <template v-for="(mode, mIdx) in (viewingModel as any).mode" :key="mIdx">
            <t-tag v-if="!Array.isArray(mode)" variant="light">{{ getModeLabel(mode, viewingModel.type) }}</t-tag>
            <t-tag v-else variant="light" v-for="(m, mmIdx) in mode" :key="mmIdx">
              {{ getModeLabel(m, viewingModel.type) }}
            </t-tag>
          </template>
          <template v-if="viewingModel.type === 'image'">
            <t-tag v-for="ratio in (viewingModel as any).aspectRatioOptions || []" :key="'ratio-' + ratio.value" variant="light">
              {{ ratio.label }}
            </t-tag>
            <t-tag v-for="resolution in (viewingModel as any).resolutionOptions || []" :key="'res-' + resolution" variant="light">
              {{ resolution }}
            </t-tag>
          </template>
        </div>
        <template v-if="viewingModel.type === 'video'">
          <div class="detailField">
            <span class="detailLabel">{{ $t("settings.vendor.audioOutput") }}</span>
            <span>{{ getAudioLabel((viewingModel as any).audio) }}</span>
          </div>
          <div class="detailField" v-if="(viewingModel as any).durationResolutionMap?.length">
            <span class="detailLabel">{{ $t("settings.vendor.durationResolution") }}</span>
            <div class="drmReadonly">
              <div v-for="(row, rowIndex) in (viewingModel as any).durationResolutionMap" :key="rowIndex" class="drmReadonlyRow">
                {{ row.duration.join("s、") }}s → {{ row.resolution.join("、") }}
              </div>
            </div>
          </div>
          <div class="detailField" v-if="(viewingModel as any).aspectRatioOptions?.length">
            <span class="detailLabel">{{ $t("workbench.project.dialog.videoRatio") }}</span>
            <div class="tags detailTags">
              <t-tag v-for="option in (viewingModel as any).aspectRatioOptions" :key="option.value" variant="light">
                {{ option.label }}
              </t-tag>
            </div>
          </div>
        </template>
        <template v-if="viewingModel.type === 'image' && (viewingModel as any).resolutionNote">
          <div class="detailField">
            <span class="detailLabel">{{ $t("settings.vendor.resolutionNote") }}</span>
            <span>{{ (viewingModel as any).resolutionNote }}</span>
          </div>
        </template>
      </div>
    </t-dialog>

    <!-- 文本模型测试弹窗 -->
    <TextModelTest
      v-if="testingModel?.type === 'text' && textTestVisible"
      v-model:modelVisible="textTestVisible"
      :vendorId="currentVendor!.id"
      :modelName="testingModel.modelName" />

    <!-- 图像模型测试弹窗 -->
    <ImageModelTest
      v-if="testingModel?.type === 'image' && imageTestVisible"
      v-model:modelVisible="imageTestVisible"
      :vendorId="currentVendor!.id"
      :modelName="testingModel.modelName"
      :supportedModes="(testingModel as any).mode || []" />

    <!-- 视频模型测试弹窗 -->
    <VideoModelTest
      v-if="testingModel?.type === 'video' && videoTestVisible"
      v-model:modelVisible="videoTestVisible"
      :vendorId="currentVendor!.id"
      :modelName="testingModel.modelName"
      :rawModes="(testingModel as any).mode || []" />

    <!-- 添加供应商弹窗 -->
    <t-dialog
      width="30vw"
      placement="center"
      top="10vh"
      :footer="false"
      v-model:visible="vendorDialogVisible"
      :header="$t('settings.vendor.addVendorDialog')"
      :maskClosable="false">
      <div class="data">
        <t-radio-group variant="default-filled" v-model="addMode">
          <t-radio-button value="importAdd">通过文件导入</t-radio-button>
          <t-radio-button value="linkAdd">通过链接添加</t-radio-button>
          <t-radio-button value="codeAdd">通过代码添加</t-radio-button>
        </t-radio-group>
        <div class="linkAdd" v-if="addMode == 'linkAdd'">
          <t-alert theme="warning" style="margin-bottom: 20px">
            请填写 TypeScript 代码文件的链接（.ts 文件），不要填 API 地址或其他无关链接。 确认后 Toonflow 会自动加载该代码，请确保链接来源可信。
          </t-alert>
          <t-input v-model="link" :placeholder="$t('settings.vendor.linkAddPlaceholder')"></t-input>
          <div style="margin-top: 10px; text-align: right; width: 100%">
            <t-button :loading="linkReading" :disabled="!link.trim()" @click="linkRead">{{ $t("settings.vendor.linkAdd") }}</t-button>
          </div>
        </div>
        <div class="importAdd" v-if="addMode == 'importAdd'">
          <div class="uploadArea" @click="triggerUpload" @dragover.prevent @drop.prevent="handleDrop">
            <t-upload
              ref="uploadRef"
              v-model="fileList"
              theme="file"
              :multiple="false"
              :max="1"
              accept=".ts"
              :before-upload="handleBeforeUpload"
              :request-method="requestMethod"
              style="display: none" />
            <div class="dragIcon">
              <i-upload-one theme="outline" size="32" fill="var(--td-brand-color)" />
            </div>
            <p class="uploadText">{{ $t("workbench.novel.import.importAdd") }}</p>
            <p class="uploadHint">{{ $t("workbench.novel.import.limit") }}</p>
          </div>
        </div>
        <div class="codeAdd" v-if="addMode == 'codeAdd'"></div>
      </div>
    </t-dialog>
    <t-dialog
      width="70vw"
      placement="center"
      top="10vh"
      v-model:visible="codeDialogVisible"
      :header="$t('settings.vendor.code')"
      :maskClosable="false"
      @confirm="handleConfirmVendor">
      <div class="editorToolbar">
        <div class="editorInfo">
          <t-icon name="info-circle" size="16px" />
          <span>{{ $t("settings.vendor.codeEditorInfo") }}</span>
        </div>
        <div class="editorActions">
          <t-button variant="text" size="small" @click="vendorCode = VENDOR_CODE_TEMPLATE">
            <template #icon><t-icon name="rollback" /></template>
            {{ $t("settings.vendor.reset") }}
          </t-button>
          <t-button variant="outline" size="small" @click="fileInputRef?.click()">
            <template #icon><t-icon name="upload" /></template>
            {{ $t("settings.vendor.importFile") }}
          </t-button>
          <input ref="fileInputRef" type="file" accept=".ts,.js,.txt,.json" style="display: none" @change="handleFileChange" />
        </div>
      </div>
      <div class="editorWrapper">
        <CodeEditor v-model:value="vendorCode" language="typescript" theme="vs-dark" :height="600" :options="editorOptions" />
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { MdPreview } from "md-editor-v3";
import { CodeEditor } from "monaco-editor-vue3";
import { DialogPlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";
import VENDOR_CODE_TEMPLATE from "@/lib/vendorTemplate.ts?raw";
import { providersLogo, modelProviderRules } from "@/utils/providersLogo";
import { isAdmin } from "@/utils/auth";
import type { UploadFile } from "tdesign-vue-next";
import { LoadingPlugin } from "tdesign-vue-next";
import settingStore from "@/stores/setting";
import TextModelTest from "./vendorTest/TextModelTest.vue";
import ImageModelTest from "./vendorTest/ImageModelTest.vue";
import VideoModelTest from "./vendorTest/VideoModelTest.vue";
const { themeSetting } = storeToRefs(settingStore());
// 渠道 Key / 模型启用是全局配置，仅 admin 可写（见 SIY-65）；非 admin 在这个页面只能看，不能改
const canManageVendors = isAdmin();

// ── 类型 ──
interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}

interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
}

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: (
    | "singleImage"
    | "startEndRequired"
    | "endFrameOptional"
    | "startFrameOptional"
    | "text"
    | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[]
  )[];
  audio: "always" | "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
  aspectRatioOptions?: { value: string; label: string }[];
}

type VendorModel = TextModel | ImageModel | VideoModel;

interface VendorInput {
  key: string;
  label: string;
  type: "text" | "password" | "url";
  required: boolean;
  placeholder?: string;
}

interface VendorItem {
  id: string; //供应商唯一标识，必须全局唯一
  author: string;
  description?: string; //md5格式
  name: string;
  icon?: string; //仅支持base64格式
  code: string;
  inputs: VendorInput[];
  inputValues: Record<string, string>;
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
  model?: VendorModel[];
  models?: VendorModel[]; //按当前账号启用状态过滤后的模型列表
  catalogModels?: VendorModel[]; //渠道协议目录（Layer1）里声明的全部模型，未按启用状态过滤
  enable: number; //1启用 0禁用
  version?: string;
}

// ── 常量 ──
const TYPE_LABEL_MAP: Record<string, string> = {
  text: "settings.vendor.textModel",
  image: "settings.vendor.imageModel",
  video: "settings.vendor.videoModel",
};

const MODE_LABEL_MAP: Record<string, string> = {
  singleImage: "settings.vendor.singleImage",
  multiReference: "settings.vendor.multiReference",
  startEndRequired: "settings.vendor.startEndRequired",
  endFrameOptional: "settings.vendor.endFrameOptional",
  startFrameOptional: "settings.vendor.startFrameOptional",
  audioReference: "settings.vendor.audioRef",
  videoReference: "settings.vendor.videoRef",
  imageReference: "settings.vendor.imageRef",
};

function getTypeLabel(type: string) {
  return TYPE_LABEL_MAP[type] || type;
}

function getModeLabel(mode: string, type: string) {
  if (mode === "text") return $t(type === "image" ? "settings.vendor.textToImage" : "settings.vendor.textToVideo");
  // Handle reference:number format like "videoReference:2"
  const refMatch = String(mode).match(/^(videoReference|imageReference|audioReference):(\d+)$/);
  if (refMatch) {
    const label = MODE_LABEL_MAP[refMatch[1]];
    return label ? `${$t(label)} ×${refMatch[2]}` : mode;
  }
  return MODE_LABEL_MAP[mode] ? $t(MODE_LABEL_MAP[mode]) : mode;
}

const editorOptions = {
  fontSize: 14,
  automaticLayout: true,
  tabSize: 2,
  scrollBeyondLastLine: false,
  formatOnPaste: true,
  formatOnType: true,
};

const audioOptions: { label: string; value: "always" | "optional" | false | true }[] = [
  { label: "settings.vendor.alwaysAudio", value: "always" },
  { label: "settings.vendor.audioOptional", value: "optional" },
  { label: "settings.vendor.audioOnly", value: true },
  { label: "settings.vendor.noAudio", value: false },
];

function getAudioLabel(audio: "always" | "optional" | boolean) {
  const found = audioOptions.find((o) => o.value === audio);
  return found ? $t(found.label) : String(audio);
}

// ── 供应商列表 ──
const vendorList = ref<VendorItem[]>([]);

const loading = ref(false);
async function getVendorList() {
  loading.value = true;
  try {
    const res = await axios.post("/setting/vendorConfig/getVendorList");
    vendorList.value = res.data.map((item: any) => {
      return {
        ...item,
        enable: item.enable,
      };
    });

    if (vendorList.value.length && !vendorList.value.some((v) => v.id === activeVendorId.value)) {
      activeVendorId.value = vendorList.value[0].id;
    }
  } catch (err: any) {
    window.$message.error(`${$t("settings.vendor.msg.getVendorListFailed")}${err.message}`);
  } finally {
    loading.value = false;
    nextTick(() => {
      lastSavedSnapshot.value = currentVendorSnapshot.value;
      autoSaveReady.value = true;
    });
  }
}

onMounted(() => {
  getVendorList();
});

const activeVendorId = ref<string>();
const currentVendor = computed(() => vendorList.value.find((v) => v.id === activeVendorId.value));
const vendorModels = computed(() => currentVendor.value?.models || currentVendor.value?.model || []);
const availableCatalogModels = computed(() => {
  const enabledNames = new Set(vendorModels.value.map((m) => m.modelName));
  return (currentVendor.value?.catalogModels || []).filter((m) => !enabledNames.has(m.modelName));
});
const requiredInputs = computed(() => currentVendor.value?.inputs?.filter((input) => input.required) || []);
const optionalInputs = computed(() => currentVendor.value?.inputs?.filter((input) => !input.required) || []);

// ── 供应商弹窗 ──
const vendorDialogVisible = ref(false);
const codeDialogVisible = ref(false);
const vendorCode = ref(VENDOR_CODE_TEMPLATE);
const fileInputRef = ref<HTMLInputElement | null>(null);
const updating = ref(false);
const autoUpdating = ref(false);
const autoSaveReady = ref(false);
const lastSavedSnapshot = ref("");
const AUTO_SAVE_DELAY = 700;
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingAutoSave = false;

// ── 测试弹窗状态 ──
const testingModel = ref<VendorModel | null>(null);
const textTestVisible = ref(false);
const imageTestVisible = ref(false);
const videoTestVisible = ref(false);

function getInputIcon(type: VendorInput["type"]) {
  if (type === "password") return "secured";
  if (type === "url") return "link";
  return "edit-1";
}

function getInputPlaceholder(input: VendorInput) {
  return input.placeholder?.trim() || "";
}

/**
 * 检查字符串是否是有效的 base64 格式
 */
function isValidBase64(str?: string): boolean {
  if (!str) return false;
  // 检查是否是 base64 数据 URI 或纯 base64 字符串
  const base64Regex = /^(?:data:[^;]+;base64,)?[A-Za-z0-9+/]*={0,2}$/;
  return base64Regex.test(str) && str.length > 0;
}

function needsUpdate(vendor: VendorItem): boolean {
  if (!vendor.version) return true;
  const ver = parseFloat(vendor.version);
  return isNaN(ver) || ver < 2.0;
}

function getModelLogo(modelName: string): string | null {
  if (!modelName) return null;
  const rule = modelProviderRules.find((r) => r.pattern.test(modelName));
  return rule ? providersLogo[rule.provider] : null;
}

function buildVendorUpdatePayload(vendor: VendorItem) {
  return {
    id: vendor.id,
    inputValues: vendor.inputValues,
  };
}

const currentVendorSnapshot = computed(() => {
  if (!currentVendor.value) return "";
  return JSON.stringify(buildVendorUpdatePayload(currentVendor.value));
});

function scheduleAutoSave() {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
  }
  autoSaveTimer = setTimeout(() => {
    void handleAutoUpdateVendor();
  }, AUTO_SAVE_DELAY);
}

async function handleAutoUpdateVendor() {
  if (!currentVendor.value || !autoSaveReady.value || loading.value) return;

  const snapshot = currentVendorSnapshot.value;
  if (!snapshot || snapshot === lastSavedSnapshot.value) return;

  if (autoUpdating.value) {
    pendingAutoSave = true;
    return;
  }

  autoUpdating.value = true;
  try {
    await axios.post("/setting/vendorConfig/updateVendorInputs", buildVendorUpdatePayload(currentVendor.value));
    lastSavedSnapshot.value = snapshot;
  } catch (err: any) {
    window.$message.error(`${$t("settings.vendor.msg.updateFailed")}${err.message}`);
  } finally {
    autoUpdating.value = false;
    if (pendingAutoSave) {
      pendingAutoSave = false;
      scheduleAutoSave();
    }
  }
}

watch(
  currentVendorSnapshot,
  (snapshot) => {
    if (!snapshot || !autoSaveReady.value || loading.value) return;
    if (snapshot === lastSavedSnapshot.value) return;
    scheduleAutoSave();
  },
  { flush: "post" },
);

watch(
  activeVendorId,
  () => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    pendingAutoSave = false;
    nextTick(() => {
      lastSavedSnapshot.value = currentVendorSnapshot.value;
    });
  },
  { flush: "post" },
);
const id = ref<string>();
function handleAddVendor() {
  addMode.value = "importAdd";
  id.value = undefined;
  vendorCode.value = VENDOR_CODE_TEMPLATE;
  vendorDialogVisible.value = true;
  codeDialogVisible.value = false;
}
function handleConfirmVendor() {
  if (!id.value) {
    const firstConfirm = DialogPlugin.confirm({
      theme: "danger",
      header: $t("settings.vendor.msg.highRiskConfirm"),
      body: $t("settings.vendor.msg.addVendorRiskBody"),
      confirmBtn: { content: $t("settings.vendor.msg.iKnowRisk"), theme: "danger" },
      cancelBtn: $t("settings.vendor.msg.cancel"),
      onConfirm: () => {
        firstConfirm.destroy();
        const secondConfirm = DialogPlugin.confirm({
          theme: "danger",
          header: $t("settings.vendor.msg.confirmAgain"),
          body: $t("settings.vendor.msg.addVendorConfirmBody"),
          confirmBtn: { content: $t("settings.vendor.msg.confirmAndAdd"), theme: "danger" },
          cancelBtn: $t("settings.vendor.msg.goBackCheck"),
          onConfirm: async () => {
            axios
              .post("/setting/vendorConfig/addVendor", { tsCode: vendorCode.value })
              .then((res) => {
                window.$message.success($t("settings.vendor.msg.vendorAdded"));
                vendorDialogVisible.value = false;
                codeDialogVisible.value = false;
                getVendorList();
              })
              .catch((err) => {
                window.$message.error(err.message ?? `${$t("settings.vendor.msg.addFailed")}`);
              })
              .finally(() => {
                secondConfirm.destroy();
              });
          },
          onClose: () => secondConfirm.hide(),
        });
      },
      onClose: () => firstConfirm.hide(),
    });
  } else {
    const firstConfirm = DialogPlugin.confirm({
      theme: "danger",
      header: $t("settings.vendor.msg.highRiskConfirm"),
      body: $t("settings.vendor.msg.updateVendorRiskBody"),
      confirmBtn: { content: $t("settings.vendor.msg.iKnowRisk"), theme: "danger" },
      cancelBtn: $t("settings.vendor.msg.cancel"),
      onConfirm: () => {
        firstConfirm.destroy();
        const secondConfirm = DialogPlugin.confirm({
          theme: "danger",
          header: $t("settings.vendor.msg.confirmAgain"),
          body: $t("settings.vendor.msg.updateVendorConfirmBody"),
          confirmBtn: { content: $t("settings.vendor.msg.confirmAndUpdate"), theme: "danger" },
          cancelBtn: $t("settings.vendor.msg.goBackCheck"),
          onConfirm: async () => {
            axios
              .post("/setting/vendorConfig/updateCode", {
                id: id.value,
                tsCode: vendorCode.value,
              })
              .then((res) => {
                window.$message.success($t("settings.vendor.msg.updateSuccess"));
                vendorDialogVisible.value = false;
                codeDialogVisible.value = false;
                getVendorList();
              })
              .catch((err) => {
                window.$message.error(`${$t("settings.vendor.msg.updateFailed")}${err.message}`);
              })
              .finally(() => {
                secondConfirm.destroy();
              });
          },
          onClose: () => secondConfirm.hide(),
        });
      },
      onClose: () => firstConfirm.hide(),
    });
  }
}
// ── 模型弹窗 ──
// mode/audio/durationResolutionMap 由渠道协议目录（Layer1，admin 维护）声明，
// 这里只做"选择要启用的模型"与"只读展示 + 切换启用状态"，不再允许自定义这些参数
const enableModelDialogVisible = ref(false);
const modelDetailDialogVisible = ref(false);
const viewingModel = ref<VendorModel | null>(null);
const modelEnabledSwitch = ref(true);
const modelStatusLoading = ref(false);

function handleAddModel() {
  if (!currentVendor.value) {
    window.$message.error($t("settings.vendor.msg.selectVendorFirst"));
    return;
  }
  enableModelDialogVisible.value = true;
}

async function handleEnableModel(model: VendorModel) {
  if (!currentVendor.value) return;
  try {
    await axios.post("/setting/vendorConfig/addVendorModel", {
      id: currentVendor.value.id,
      model,
    });
    window.$message.success($t("settings.vendor.msg.modelEnabled"));
    await getVendorList();
  } catch (err: any) {
    window.$message.error(err.message ?? $t("settings.vendor.msg.operationFailed"));
  }
}

function handleEditModel(model: VendorModel) {
  viewingModel.value = model;
  modelEnabledSwitch.value = true;
  modelDetailDialogVisible.value = true;
}

async function handleToggleModelStatus(enabled: boolean) {
  if (!currentVendor.value || !viewingModel.value) return;
  modelStatusLoading.value = true;
  try {
    if (enabled) {
      await axios.post("/setting/vendorConfig/addVendorModel", {
        id: currentVendor.value.id,
        model: viewingModel.value,
      });
      window.$message.success($t("settings.vendor.msg.modelEnabled"));
    } else {
      await axios.post("/setting/vendorConfig/delVendorModel", {
        id: currentVendor.value.id,
        modelName: viewingModel.value.modelName,
      });
      window.$message.success($t("settings.vendor.msg.modelDisabled"));
    }
    await getVendorList();
    modelDetailDialogVisible.value = false;
  } catch (err: any) {
    modelEnabledSwitch.value = !enabled;
    window.$message.error(err.message ?? $t("settings.vendor.msg.operationFailed"));
  } finally {
    modelStatusLoading.value = false;
  }
}

function handleTestModel(item: (typeof vendorModels.value)[number]) {
  testingModel.value = item;
  if (item.type === "text") {
    textTestVisible.value = true;
  } else if (item.type === "image") {
    imageTestVisible.value = true;
  } else if (item.type === "video") {
    videoTestVisible.value = true;
  }
}

function handleDeleteModel(modelName: string) {
  if (!currentVendor.value) return;
  const confirmDialog = DialogPlugin.confirm({
    theme: "danger",
    header: $t("settings.vendor.msg.deleteModelConfirm"),
    body: `${$t("settings.vendor.msg.deleteModelBody", { name: modelName })}`,
    confirmBtn: { content: $t("settings.vendor.msg.confirmDelete"), theme: "danger" },
    cancelBtn: $t("settings.vendor.msg.cancel"),
    onConfirm: async () => {
      try {
        await axios.post("/setting/vendorConfig/delVendorModel", {
          id: currentVendor.value!.id,
          modelName,
        });
        window.$message.success($t("settings.vendor.msg.modelDeleted"));
        getVendorList();
      } catch (err: any) {
        window.$message.error(err.message ?? $t("settings.vendor.msg.operationFailed"));
      } finally {
        confirmDialog.destroy();
      }
    },
  });
}
function handleEditVendorCode() {
  if (!currentVendor.value) return;
  id.value = currentVendor.value.id;
  vendorCode.value = currentVendor.value.code;
  codeDialogVisible.value = true;
}
function handleDeleteVendor() {
  if (!currentVendor.value) return;
  const confirmDialog = DialogPlugin.confirm({
    theme: "danger",
    header: $t("settings.vendor.msg.deleteVendorConfirm"),
    body: `${$t("settings.vendor.msg.deleteVendorBody", { name: currentVendor.value.name })}`,
    confirmBtn: { content: $t("settings.vendor.msg.confirmDelete"), theme: "danger" },
    cancelBtn: $t("settings.vendor.msg.cancel"),
    onConfirm: () => {
      axios
        .post("/setting/vendorConfig/deleteVendor", { id: currentVendor.value?.id })
        .then(() => {
          window.$message.success($t("settings.vendor.msg.vendorDeleted"));
          if (activeVendorId.value === currentVendor.value?.id) {
            activeVendorId.value = undefined;
          }
          getVendorList();
          confirmDialog.destroy();
        })
        .catch((err) => {
          window.$message.error(`${$t("settings.vendor.msg.deleteFailed")}${err.message}`);
        });
    },
  });
}
function onBlurFn() {
  axios
    .post("/setting/vendorConfig/updateVendorInputs", {
      id: currentVendor.value?.id,
      inputValues: currentVendor.value?.inputValues,
    })
    .then(() => {
      window.$message.success($t("settings.vendor.msg.vendorConfigUpdated"));
      getVendorList();
    })
    .catch((err) => {
      window.$message.error(`${$t("settings.vendor.msg.updateFailed")}${err.message}`);
    });
}
//是否启用供应商
function onChange(item: any, val: number) {
  const prevEnable = val === 1 ? 0 : 1;
  axios
    .post("/setting/vendorConfig/enableVendor", {
      id: item.id,
      enable: val,
    })
    .then(() => {})
    .catch((err) => {
      item.enable = prevEnable;
    });
}
const addMode = ref("importAdd");
const link = ref("");
const linkReading = ref(false);

watch(addMode, (val) => {
  if (val == "codeAdd") codeDialogVisible.value = true;
  else codeDialogVisible.value = false;
});

//链接读取
function linkRead() {
  if (linkReading.value) return;
  const firstConfirm = DialogPlugin.confirm({
    theme: "danger",
    header: $t("settings.vendor.msg.highRiskConfirm"),
    body: $t("settings.vendor.msg.linkAddVendorRiskBody"),
    confirmBtn: { content: $t("settings.vendor.msg.iKnowRisk"), theme: "danger" },
    cancelBtn: $t("settings.vendor.msg.cancel"),
    onConfirm: () => {
      firstConfirm.destroy();
      const secondConfirm = DialogPlugin.confirm({
        theme: "danger",
        header: $t("settings.vendor.msg.confirmAgain"),
        body: $t("settings.vendor.msg.addVendorConfirmBody"),
        confirmBtn: { content: $t("settings.vendor.msg.confirmAndAdd"), theme: "danger" },
        cancelBtn: $t("settings.vendor.msg.goBackCheck"),
        onConfirm: async () => {
          const instance = LoadingPlugin({
            fullscreen: true,
            attach: "body",
            preventScrollThrough: false,
          });
          const timer = setTimeout(() => {
            instance.hide();
            clearTimeout(timer);
          }, 1000);
          linkReading.value = true;
          try {
            const { data } = await axios.post("/setting/vendorConfig/getCodeByLink", { link: link.value });
            if (!data.includes("vendor")) {
              let alertBox: any = null;
              if (data.includes("<html>")) {
                alertBox = DialogPlugin.alert({
                  theme: "danger",
                  header: "链接返回了一个网页，添加供应商需要返回TS代码，请确认链接是否正确",
                  body: "请勿输入中转站地址，如需使用中转站请修改OpenAI标准接口的baseUrl使用中转站地址",
                  onConfirm: ({ e }) => {
                    alertBox.hide();
                  },
                });
              } else {
                DialogPlugin.alert({
                  theme: "danger",
                  header: "链接返回的内容不正确，添加供应商需要返回TS代码，请确认链接是否正确",
                  onConfirm: ({ e }) => {
                    alertBox.hide();
                  },
                });
              }
              return;
            }
            if (data) {
              axios.post("/setting/vendorConfig/addVendor", { tsCode: data });
              window.$message.success($t("settings.vendor.msg.vendorAdded"));
              vendorDialogVisible.value = false;
              codeDialogVisible.value = false;
              getVendorList();
            } else {
              window.$message.error($t("settings.vendor.msg.linkAddFailed"));
              codeDialogVisible.value = false;
            }
          } catch (err: any) {
            window.$message.error(`${$t("settings.vendor.msg.addFailed")}${err.message}`);
          } finally {
            clearTimeout(timer);
            instance.hide();
            linkReading.value = false;
            secondConfirm.destroy();
          }
        },
        onClose: () => secondConfirm.hide(),
      });
    },
    onClose: () => firstConfirm.hide(),
  });
}
const uploadRef = ref();
// 上传前校验并解析
async function handleBeforeUpload(file: UploadFile) {
  const rawFile = file.raw;
  if (!rawFile) {
    window.$message.error($t("workbench.novel.import.msg.selectFile"));
    return false;
  }
  LoadingPlugin(true);
  try {
    const firstConfirm = DialogPlugin.confirm({
      theme: "danger",
      header: $t("settings.vendor.msg.highRiskConfirm"),
      body: $t("settings.vendor.msg.importAdd"),
      confirmBtn: { content: $t("settings.vendor.msg.iKnowRisk"), theme: "danger" },
      cancelBtn: $t("settings.vendor.msg.cancel"),
      onConfirm: () => {
        firstConfirm.destroy();
        const secondConfirm = DialogPlugin.confirm({
          theme: "danger",
          header: $t("settings.vendor.msg.confirmAgain"),
          body: $t("settings.vendor.msg.addVendorConfirmBody"),
          confirmBtn: { content: $t("settings.vendor.msg.confirmAndAdd"), theme: "danger" },
          cancelBtn: $t("settings.vendor.msg.goBackCheck"),
          onConfirm: async () => {
            //拿到上传的数据
            const fileReader = new FileReader();
            fileReader.readAsText(rawFile);
            fileReader.onload = () => {
              const content = fileReader.result;
              axios
                .post("/setting/vendorConfig/addVendor", { tsCode: content })
                .then((res) => {
                  window.$message.success($t("settings.vendor.msg.vendorAdded"));
                  vendorDialogVisible.value = false;
                  codeDialogVisible.value = false;
                  getVendorList();
                })
                .catch((err) => {
                  window.$message.error(err.message ?? `${$t("settings.vendor.msg.addFailed")}`);
                })
                .finally(() => {
                  secondConfirm.destroy();
                });
            };
          },
          onClose: () => secondConfirm.hide(),
        });
      },
      onClose: () => firstConfirm.hide(),
    });
  } catch {
    window.$message.error($t("workbench.novel.import.msg.parseFailed"));
  } finally {
    LoadingPlugin(false);
  }
  return false;
}
const fileList = ref<any[]>([]);
// 触发上传
function triggerUpload() {
  uploadRef.value?.triggerUpload();
}
function requestMethod() {
  return Promise.resolve({
    response: {},
    status: "success",
  } as const);
}
// 处理拖拽上传
async function handleDrop(e: DragEvent) {
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    await handleBeforeUpload({ raw: files[0] });
  }
}
function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    vendorCode.value = (ev.target?.result as string) || "";
  };
  reader.readAsText(file);
  input.value = "";
}
</script>

<style lang="scss" scoped>
.modelServe {
  width: 100%;
  height: 100%;
  display: flex;
  .modelList {
    width: 300px;
    height: 90%;
    min-height: 0;
    .listContent {
      flex: 1;
      min-height: 0;
      overflow: auto;
      height: 100%;
    }

    .listFooter {
      padding: 0 10px 10px;
      margin-right: 6px;
    }
  }

  .modelParameter {
    width: 100%;
    height: 100%;
    .infoBox {
      font-size: 12px;
      opacity: 0.6;
    }
    .capabilityNotice {
      margin-top: 4px;
      color: var(--td-text-color-secondary, #888);
      font-size: 12px;
    }
    .configuration {
      height: 95%;
      padding-right: 10px;
      overflow-y: auto;
      .modelCard {
        width: 100%;
        margin-top: 10px;
        .topInfo {
          margin-left: 4px;
          margin-right: 4px;
          .modelCardNameWrap {
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .modelCardName {
            font-size: 15px;
            font-weight: 900;
          }
        }
        .tags {
          margin-top: 16px;
          & > * {
            margin-left: 4px;
            margin-right: 4px;
          }
        }
      }
    }

    .updateAction {
      margin-top: 16px;
      display: flex;
      justify-content: flex-end;
      & > * {
        margin-left: 8px;
      }
    }

    .requiredLabel {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-weight: 600;
    }

    .requiredMark {
      color: #d54941;
      font-size: 16px;
      line-height: 1;
    }

    .requiredText {
      color: #d54941;
      font-size: 12px;
      font-weight: 700;
    }

    .inputHelp {
      color: #666;
    }

    .optionalSection {
      margin-bottom: 12px;
    }
  }

  :deep(.t-default-menu) {
    width: 100% !important;
  }

  .editorToolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;

    .editorInfo {
      display: flex;
      align-items: center;
      gap: 6px;
      color: #666;
      font-size: 13px;
    }

    .editorActions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
  }

  .editorWrapper {
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid #e5e5e5;
  }

  .testResult {
    .resultContent {
      width: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 300px;
      background: #f5f5f5;
      border-radius: 8px;
      padding: 20px;

      img,
      video {
        max-width: 100%;
        max-height: 70vh;
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      }
    }
  }
  .linkAdd,
  .importAdd,
  .codeAdd {
    margin-top: 20px;
    .uploadArea {
      margin-top: 20px;
      padding: 42px 20px;
      border: 2px dashed #969494;
      border-radius: 8px;
      text-align: center;
      cursor: pointer;
      transition: all 0.2s;
      &:hover {
        border-color: #000000;
      }

      .dragIcon {
        margin-bottom: 12px;
      }

      .uploadText {
        font-size: 14px;
        margin: 0 0 8px;
      }

      .uploadHint {
        font-size: 12px;
        margin: 0;
      }
    }
  }
}
.addBox {
  padding-left: 16px;
  padding-right: 16px;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-gutter: stable;
  max-height: 70vh;
  .modelCard {
    margin-bottom: 10px;
  }
  .detailHeader {
    .modelCardNameWrap {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .modelCardId {
      font-size: 12px;
      color: #999;
    }
    .statusSwitch {
      display: flex;
      align-items: center;
      gap: 8px;
      .statusText {
        font-size: 13px;
        color: #666;
      }
    }
  }
  .detailField {
    margin-top: 12px;
    .detailLabel {
      display: block;
      font-size: 12px;
      color: var(--td-text-color-secondary, #888);
      font-weight: 600;
      margin-bottom: 4px;
    }
    .drmReadonly {
      display: flex;
      flex-direction: column;
      gap: 4px;
      .drmReadonlyRow {
        font-size: 13px;
      }
    }
  }
}
</style>
