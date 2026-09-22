<template>
  <div class="libtvBindDialog">
    <t-loading :loading="loading" show-overlay style="min-height: 200px">
      <!-- 已绑定：状态卡 -->
      <template v-if="status.bound">
        <t-alert theme="success" style="margin-bottom: 14px">
          <template #message>{{ $t("settings.libtv.boundTip") }}</template>
        </t-alert>
        <div class="boundRow">
          <span class="label">{{ $t("settings.libtv.boundPhone") }}</span>
          <span>{{ status.phone || "-" }}</span>
        </div>
        <div class="boundRow">
          <span class="label">{{ $t("settings.libtv.boundAt") }}</span>
          <span>{{ status.boundAt ? new Date(status.boundAt).toLocaleString() : "-" }}</span>
        </div>
      </template>

      <!-- 未绑定：精简两步向导（短信流主打 + 粘贴保底），复用设置页绑定向导的同一组接口 -->
      <template v-else>
        <t-radio-group v-model="mode" variant="default-filled" style="margin-bottom: 16px">
          <t-radio-button value="sms">{{ $t("settings.libtv.modeSms") }}</t-radio-button>
          <t-radio-button value="paste">{{ $t("settings.libtv.modePaste") }}</t-radio-button>
        </t-radio-group>

        <t-form v-if="mode === 'sms'" label-width="90px">
          <t-form-item :label="$t('settings.libtv.phone')" name="phone">
            <div class="phoneRow">
              <t-input v-model="phone" :maxlength="11" :placeholder="$t('settings.libtv.phonePlaceholder')" style="width: 180px" />
              <t-button variant="outline" :disabled="countdown > 0" :loading="sending" @click="onSendSms">
                {{ countdown > 0 ? `${countdown}s` : $t("settings.libtv.sendCode") }}
              </t-button>
            </div>
          </t-form-item>
          <t-form-item :label="$t('settings.libtv.code')" name="code">
            <t-input v-model="code" :maxlength="6" :placeholder="$t('settings.libtv.codePlaceholder')" style="width: 180px" />
          </t-form-item>
        </t-form>

        <template v-else>
          <t-alert theme="warning" style="margin-bottom: 10px">
            <template #message>
              <div class="guideText">
                {{ $t("settings.libtv.pasteGuide") }}
                <pre class="guideCode">libtv login web
libtv account info</pre>
              </div>
            </template>
          </t-alert>
          <t-textarea v-model="credentials" :autosize="{ minRows: 4, maxRows: 8 }" :placeholder="$t('settings.libtv.pastePlaceholder')" />
        </template>

        <div class="switchModelRow" v-if="showSwitchModel && !status.bound">
          <t-button theme="default" variant="text" size="small" @click="emit('switchModel')">
            {{ $t("common.switchPlatformModel") }}
          </t-button>
        </div>
      </template>
    </t-loading>
  </div>
</template>

<script setup lang="ts">
import { MessagePlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";

const props = defineProps<{
  /** 未绑定时是否显示「换用平台模型」次按钮（快创模型选择器场景） */
  showSwitchModel?: boolean;
}>();

const emit = defineEmits<{
  /** 绑定成功（含已是绑定状态），调用方据此恢复之前的模型选择 */
  success: [];
  /** 用户选择放弃 LibTV 模型、改用平台模型 */
  switchModel: [];
}>();

const loading = ref(false);
const sending = ref(false);
const binding = ref(false);
const mode = ref<"sms" | "paste">("sms");
const status = ref<{ bound: boolean; phone?: string; boundAt?: number }>({ bound: false });

const phone = ref("");
const code = ref("");
const credentials = ref("");
const countdown = ref(0);
let countdownTimer: ReturnType<typeof setInterval> | null = null;

async function loadStatus() {
  loading.value = true;
  try {
    const res: any = await axios.post("/setting/vendorConfig/libtv/bindingStatus");
    if (res.code === 200) status.value = res.data ?? { bound: false };
  } catch (err: any) {
    console.error(err);
  } finally {
    loading.value = false;
  }
}

function startCountdown(seconds = 60) {
  countdown.value = seconds;
  countdownTimer && clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0 && countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }, 1000);
}

onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer);
});

async function onSendSms() {
  if (!/^1\d{10}$/.test(phone.value.trim())) return MessagePlugin.warning(window.$t("settings.libtv.phoneInvalid"));
  sending.value = true;
  try {
    const res: any = await axios.post("/setting/vendorConfig/libtv/sendSms", { phone: phone.value.trim() });
    if (res.code === 200) {
      MessagePlugin.success(window.$t("settings.libtv.sendOk"));
      startCountdown();
    } else {
      MessagePlugin.error(res.message || window.$t("settings.libtv.sendFailed"));
    }
  } catch (err: any) {
    MessagePlugin.error(err.message || window.$t("settings.libtv.sendFailed"));
  } finally {
    sending.value = false;
  }
}

async function onBind() {
  binding.value = true;
  try {
    if (mode.value === "sms") {
      if (!/^1\d{10}$/.test(phone.value.trim())) return MessagePlugin.warning(window.$t("settings.libtv.phoneInvalid"));
      if (!/^\d{6}$/.test(code.value.trim())) return MessagePlugin.warning(window.$t("settings.libtv.codeInvalid"));
      const res: any = await axios.post("/setting/vendorConfig/libtv/verifySms", { phone: phone.value.trim(), code: code.value.trim() });
      if (res.code !== 200) throw new Error(res.message || window.$t("settings.libtv.bindFailed"));
    } else {
      if (credentials.value.trim().length < 10) return MessagePlugin.warning(window.$t("settings.libtv.pastePlaceholder"));
      const res: any = await axios.post("/setting/vendorConfig/libtv/bindCredentials", { credentialsJson: credentials.value.trim() });
      if (res.code !== 200) throw new Error(res.message || window.$t("settings.libtv.bindFailed"));
    }
    await loadStatus();
    MessagePlugin.success(window.$t("settings.libtv.bindOk"));
    emit("success");
  } catch (err: any) {
    MessagePlugin.error(err.message || window.$t("settings.libtv.bindFailed"));
  } finally {
    binding.value = false;
  }
}

defineExpose({ loadStatus, onBind, isBound: () => status.value.bound });

onMounted(loadStatus);
</script>

<style lang="scss" scoped>
.libtvBindDialog {
  min-height: 200px;
}
.boundRow {
  display: flex;
  gap: 12px;
  padding: 6px 0;
  .label {
    color: var(--td-text-color-secondary);
    width: 80px;
    flex-shrink: 0;
  }
}
.phoneRow {
  display: flex;
  gap: 8px;
}
.switchModelRow {
  display: flex;
  justify-content: center;
  margin-top: 4px;
}
.guideCode {
  margin: 8px 0 0;
  padding: 8px 10px;
  background: var(--td-bg-color-component);
  border-radius: 6px;
  font-size: 12px;
  white-space: pre-wrap;
}
</style>
