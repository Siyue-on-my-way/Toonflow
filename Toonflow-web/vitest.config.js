import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import AutoImport from "unplugin-auto-import/vite";
import { defineConfig } from "vitest/config";
export default defineConfig({
    // 与 vite.config.ts 保持一致的 vue/pinia/vue-router 自动导入，否则被测的 store
    // 源文件里裸写的 defineStore/ref/computed/watch 在 Vitest 转换管线下找不到声明。
    plugins: [vue(), AutoImport({ imports: ["vue", "pinia", "vue-router"], dts: false })],
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
    test: {
        environment: "jsdom",
        include: ["src/**/__tests__/**/*.spec.ts"],
    },
});
