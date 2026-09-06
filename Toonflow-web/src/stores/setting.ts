// 浏览器部署时默认请求同源 /api（任意域名/IP 都开箱即用，不再写死 localhost）；
// Electron 等非 http 来源保留本地后端默认值，App.vue 挂载后会用 toonflow://getAppUrl 覆盖
export function defaultBaseUrl(): string {
  return window.location.origin.startsWith("http") ? `${window.location.origin}/api` : "http://localhost:10588/api";
}

// 一次性迁移：旧版本把上面的默认值写死为 http://localhost:10588/api 并随 store 持久化，
// 从域名/IP 打开的老用户本地会残留这个地址，导致所有请求打到自己电脑上。
// 必须在 store hydrate 之前改写 localStorage 才能生效，所以放在模块顶层执行
try {
  const raw = localStorage.getItem("setting");
  const saved = raw ? JSON.parse(raw) : {};
  const isLocalOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(window.location.origin);
  if (saved?.baseUrl === "http://localhost:10588/api" && !isLocalOrigin) {
    saved.baseUrl = defaultBaseUrl();
    localStorage.setItem("setting", JSON.stringify(saved));
  }
} catch {}

export default defineStore(
  "setting",
  () => {
    const showSetting = ref(false);
    const isElectron = ref(false);
    const canvasWheelEvent = ref("zoom");
    const activeMenu = ref("ui");

    const baseUrl = ref<string>(defaultBaseUrl());

    const needUpdate = ref(false);

    const otherSetting = ref({
      axiosTimeOut: 60 * 10 * 1000,
      assetsBatchGenereateSize: 5,
      chapterReg: "/第\\s*([0-9０-９零一二三四五六七八九十百千万]+)\\s*[章回节]\\s*([^\\n\\r]*)/g",
      interacting: true,
      scriptEpisodeLength: 5000,
    });

    const themeSetting = ref<{
      mode: "auto" | "light" | "dark";
      primaryColor: string;
      fontSize: number;
    }>({
      mode: "auto",
      primaryColor: "#0052D9",
      fontSize: 16,
    });

    const language = ref<string>("zh-CN");

    return { showSetting, baseUrl, otherSetting, themeSetting, language, activeMenu, isElectron, canvasWheelEvent, needUpdate };
  },
  { persist: { pick: ["baseUrl", "otherSetting", "themeSetting", "language"] } },
);
