<template>
  <div class="libtvAccount">
    <t-loading :loading="loading" show-overlay style="min-height: 240px">
      <!-- 已绑定：状态卡 -->
      <template v-if="status.bound">
        <t-alert theme="success" style="margin-bottom: 16px">
          <template #message>
            {{ $t("settings.libtv.boundTip") }}
          </template>
        </t-alert>
        <div class="boundCard">
          <div class="boundRow">
            <span class="label">{{ $t("settings.libtv.boundPhone") }}</span>
            <span>{{ status.phone || "-" }}</span>
          </div>
          <div class="boundRow">
            <span class="label">{{ $t("settings.libtv.boundAt") }}</span>
            <span>{{ status.boundAt ? new Date(status.boundAt).toLocaleString() : "-" }}</span>
          </div>
          <div class="boundRow">
            <span class="label">{{ $t("settings.libtv.health") }}</span>
            <t-tag v-if="health === 'ok'" theme="success">{{ $t("settings.libtv.healthy") }}</t-tag>
            <t-tag v-else-if="health === 'bad'" theme="danger">{{ $t("settings.libtv.invalid") }}</t-tag>
            <t-tag v-else theme="default">-</t-tag>
          </div>
          <div class="actions">
            <t-button variant="outline" :loading="healthChecking" @click="onCheckHealth">{{ $t("settings.libtv.checkHealth") }}</t-button>
            <t-button theme="danger" variant="outline" @click="onUnbind">{{ $t("settings.libtv.unbind") }}</t-button>
          </div>
        </div>
      </template>

      <!-- 未绑定：向导 -->
      <template v-else>
        <t-alert theme="info" style="margin-bottom: 16px">
          <template #message>
            {{ $t("settings.libtv.desc") }}
          </template>
        </t-alert>

        <t-radio-group v-model="mode" variant="default-filled" style="margin-bottom: 20px">
          <t-radio-button value="sms">{{ $t("settings.libtv.modeSms") }}</t-radio-button>
          <t-radio-button value="paste">{{ $t("settings.libtv.modePaste") }}</t-radio-button>
        </t-radio-group>

        <!-- 方案 A：短信验证码 -->
        <t-form v-if="mode === 'sms'" label-width="90px" @submit="onVerifySms">
          <t-form-item :label="$t('settings.libtv.phone')" name="phone">
            <div class="phoneRow">
              <t-input v-model="phone" :maxlength="11" :placeholder="$t('settings.libtv.phonePlaceholder')" style="width: 220px" />
              <t-button variant="outline" :disabled="countdown > 0" :loading="sending" @click="onSendSms">
                {{ countdown > 0 ? `${countdown}s` : $t("settings.libtv.sendCode") }}
              </t-button>
            </div>
          </t-form-item>
          <t-form-item :label="$t('settings.libtv.code')" name="code">
            <t-input v-model="code" :maxlength="6" :placeholder="$t('settings.libtv.codePlaceholder')" style="width: 220px" />
          </t-form-item>
          <t-form-item>
            <t-button theme="primary" :loading="binding" @click="onVerifySms">{{ $t("settings.libtv.bind") }}</t-button>
          </t-form-item>
        </t-form>

        <!-- 方案 B：粘贴凭据 -->
        <template v-else>
          <t-alert theme="warning" style="margin-bottom: 12px">
            <template #message>
              <div class="guideText">
                {{ $t("settings.libtv.pasteGuide") }}
                <pre class="guideCode">curl -fL "https://liblibai-web-static.liblib.cloud/cli/latest/install-libtv-cli.sh" | sh
libtv login web
libtv account info</pre>
              </div>
            </template>
          </t-alert>
          <t-textarea v-model="credentials" :autosize="{ minRows: 5, maxRows: 10 }" :placeholder="$t('settings.libtv.pastePlaceholder')" />
          <t-button theme="primary" style="margin-top: 12px" :loading="binding" @click="onBindCredentials">{{ $t("settings.libtv.bind") }}</t-button>
        </template>
      </template>
    </t-loading>
  </div>
</template>

<script setup lang="ts">
import { MessagePlugin, DialogPlugin } from "tdesign-vue-next";
import { useI18n } from "vue-i18n";
import axios from "@/utils/axios";

const { t } = useI18n();

const loading = ref(false);
const binding = ref(false);
const sending = ref(false);
const healthChecking = ref(false);
const mode = ref<"sms" | "paste">("sms");
const status = ref<{ bound: boolean; phone?: string; boundAt?: number }>({ bound: false });
const health = ref<"" | "ok" | "bad">("");

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
    else window.$message.error(res.message || t("settings.libtv.statusLoadFailed"));
  } catch (err: any) {
    window.$message.error(`${t("settings.libtv.statusLoadFailed")}: ${err.message}`);
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

async function onSendSms() {
  if (!/^1\d{10}$/.test(phone.value.trim())) {
    window.$message.warning(t("settings.libtv.phoneInvalid"));
    return;
  }
  sending.value = true;
  try {
    const res: any = await axios.post("/setting/vendorConfig/libtv/sendSms", { phone: phone.value.trim() });
    if (res.code === 200) {
      startCountdown(60);
      window.$message.success(t("settings.libtv.sendOk"));
    } else {
      window.$message.error(res.message || t("settings.libtv.sendFailed"));
    }
  } catch (err: any) {
    window.$message.error(`${t("settings.libtv.sendFailed")}: ${err.message}`);
    window.$message.warning(t("settings.libtv.captchaHint"));
  } finally {
    sending.value = false;
  }
}

async function onVerifySms() {
  if (!/^1\d{10}$/.test(phone.value.trim())) {
    window.$message.warning(t("settings.libtv.phoneInvalid"));
    return;
  }
  if (!/^\d{6}$/.test(code.value.trim())) {
    window.$message.warning(t("settings.libtv.codeInvalid"));
    return;
  }
  binding.value = true;
  try {
    const res: any = await axios.post("/setting/vendorConfig/libtv/verifySms", { phone: phone.value.trim(), code: code.value.trim() });
    if (res.code === 200) {
      window.$message.success(t("settings.libtv.bindOk"));
      await loadStatus();
    } else {
      window.$message.error(res.message || t("settings.libtv.bindFailed"));
    }
  } catch (err: any) {
    window.$message.error(`${t("settings.libtv.bindFailed")}: ${err.message}`);
  } finally {
    binding.value = false;
  }
}

async function onBindCredentials() {
  if (credentials.value.trim().length < 10) {
    window.$message.warning(t("settings.libtv.pastePlaceholder"));
    return;
  }
  binding.value = true;
  try {
    const res: any = await axios.post("/setting/vendorConfig/libtv/bindCredentials", { credentials: credentials.value.trim() });
    if (res.code === 200) {
      window.$message.success(t("settings.libtv.bindOk"));
      await loadStatus();
    } else {
      window.$message.error(res.message || t("settings.libtv.bindFailed"));
    }
  } catch (err: any) {
    window.$message.error(`${t("settings.libtv.bindFailed")}: ${err.message}`);
  } finally {
    binding.value = false;
  }
}

async function onCheckHealth() {
  healthChecking.value = true;
  try {
    const res: any = await axios.post("/setting/vendorConfig/libtv/checkHealth");
    if (res.code === 200 && res.data?.healthy) {
      health.value = "ok";
      window.$message.success(t("settings.libtv.checkOk"));
    } else {
      health.value = "bad";
      window.$message.warning(t("settings.libtv.invalid"));
    }
  } catch (err: any) {
    health.value = "bad";
    window.$message.error(`${err.message}`);
  } finally {
    healthChecking.value = false;
  }
}

function onUnbind() {
  const dialog = DialogPlugin.confirm({
    header: t("settings.libtv.unbind"),
    body: t("settings.libtv.unbindConfirm"),
    confirmBtn: { content: t("settings.libtv.unbind"), theme: "danger" },
    cancelBtn: t("settings.libtv.cancel"),
    onConfirm: async () => {
      try {
        const res: any = await axios.post("/setting/vendorConfig/libtv/unbind");
        if (res.code === 200) {
          health.value = "";
          window.$message.success(t("settings.libtv.unbindOk"));
          await loadStatus();
        } else {
          window.$message.error(res.message || t("settings.libtv.unbindFailed"));
        }
      } catch (err: any) {
        window.$message.error(`${t("settings.libtv.unbindFailed")}: ${err.message}`);
      }
      dialog.destroy();
    },
    onClose: () => dialog.destroy(),
  });
}

onMounted(loadStatus);
onBeforeUnmount(() => {
  if (countdownTimer) clearInterval(countdownTimer);
});
</script>

<style lang="scss" scoped>
.libtvAccount {
  max-width: 640px;

  .boundCard {
    border: 1px solid var(--td-component-border);
    border-radius: 6px;
    padding: 16px;

    .boundRow {
      display: flex;
      align-items: center;
      margin-bottom: 12px;

      .label {
        width: 120px;
        color: var(--td-text-color-secondary);
      }
    }

    .actions {
      display: flex;
      gap: 12px;
      margin-top: 4px;
    }
  }

  .phoneRow {
    display: flex;
    gap: 12px;
  }

  .guideText {
    .guideCode {
      margin: 8px 0 0;
      padding: 8px 12px;
      background: var(--td-bg-color-component);
      border-radius: 4px;
      font-family: monospace;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-all;
    }
  }
}
</style>
