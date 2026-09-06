<template>
  <div class="loginPage" :style="{ height: isElectron ? 'calc(100vh - 32px)' : '100vh' }">
    <div class="formBox">
      <div class="logoBox fc">
        <div class="logoImg"></div>
        <div class="fc c">
          <span class="logoText">ToonFlow</span>
          <span class="slogan">{{ $t("register.title") }}</span>
        </div>
      </div>
      <div class="login-form">
        <t-input v-model="state.account" :placeholder="$t('register.accountPlaceholder')" autocomplete="username" size="large"></t-input>
        <t-input v-model="state.password" type="password" :placeholder="$t('register.passwordPlaceholder')" size="large"></t-input>
        <t-input
          v-model="state.confirmPassword"
          type="password"
          :placeholder="$t('register.confirmPasswordPlaceholder')"
          size="large"
          @keyup.enter="handleRegister"></t-input>
        <t-button class="loginBtn" theme="primary" size="large" :loading="registerLoading" @click="handleRegister" block>
          {{ $t("register.registerBtn") }}
        </t-button>
      </div>
      <div class="tips c">
        {{ $t("register.alreadyHaveAccount") }}
        <a class="link" @click="goToLogin">{{ $t("register.goToLogin") }}</a>
      </div>
    </div>
  </div>
</template>

<script setup>
import Router from "@/router/index.ts";
import axios from "@/utils/axios";
import settingStore from "@/stores/setting";
import { storeToRefs } from "pinia";

const store = settingStore();
const { isElectron } = storeToRefs(store);

const PHONE_REGEX = /^1[3-9]\d{9}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const state = ref({
  account: "",
  password: "",
  confirmPassword: "",
});
const registerLoading = ref(false);

function goToLogin() {
  Router.push("/login");
}

const handleRegister = () => {
  const { account, password, confirmPassword } = state.value;
  if (!account) {
    window.$message.warning($t("register.accountRequired"));
    return;
  }
  if (!PHONE_REGEX.test(account) && !EMAIL_REGEX.test(account)) {
    window.$message.warning($t("register.accountInvalid"));
    return;
  }
  if (!password) {
    window.$message.warning($t("register.passwordRequired"));
    return;
  }
  if (!confirmPassword) {
    window.$message.warning($t("register.confirmPasswordRequired"));
    return;
  }
  if (password !== confirmPassword) {
    window.$message.warning($t("register.passwordMismatch"));
    return;
  }

  registerLoading.value = true;
  axios
    .post("/register/register", { account, password, confirmPassword })
    .then(() => {
      window.$message.success($t("register.registerSuccess"));
      Router.push("/login");
    })
    .catch((e) => {
      window.$message.error(e.message);
    })
    .finally(() => {
      registerLoading.value = false;
    });
};
</script>

<style lang="scss" scoped>
.loginPage {
  height: 100vh;
  display: flex;
  justify-content: center;
  align-items: center;

  .formBox {
    width: 380px;
    padding: 40px 40px 30px;
    background: var(--td-bg-color-container);
    border-radius: 20px;
    box-shadow: var(--td-shadow-3);

    .logoBox {
      display: flex;
      justify-content: center;
      align-items: center;
      margin-bottom: 30px;
      gap: 12px;

      .logoImg {
        width: 64px;
        height: 64px;
        background-color: var(--td-text-color-primary);
        mask: url("@/assets/logo.svg") no-repeat center;
        mask-size: contain;
        -webkit-mask: url("@/assets/logo.svg") no-repeat center;
        -webkit-mask-size: contain;
      }

      .logoText {
        font-size: 36px;
        font-weight: 800;
        color: var(--td-text-color-primary);
        letter-spacing: 1px;
      }
      .slogan {
        opacity: 0.5;
        white-space: nowrap;
      }
    }

    .login-form {
      display: flex;
      flex-direction: column;
      gap: 20px;

      :deep(.t-input) {
        border-radius: 8px;
      }
    }
  }
  .tips {
    opacity: 0.7;
    font-size: 12px;
    margin-top: 18px;

    .link {
      color: var(--td-brand-color);
      cursor: pointer;
      margin-left: 4px;
    }
  }
}
</style>
