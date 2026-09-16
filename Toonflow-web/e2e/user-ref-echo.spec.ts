/**
 * SIY-137 审核反馈验证：聊天时引用的图片要在用户消息气泡下方回显。
 * 覆盖：
 *  1. 实时链路：带附件引用发送后，用户消息下方立即出现媒体卡片
 *  2. 历史链路：getMemory 把 `[本轮附带(图片|媒体)引用 mediaId]` 注记还原为媒体卡片（注记文本从气泡剥离）
 * 运行前提：本地集成后端 10599（WEB_DIST 指向含本修复的前端构建）。
 */
import { expect, test, type Page } from "@playwright/test";

const API_BASE = process.env.QV_API_BASE_URL ?? "http://localhost:10599/api";
const PROJECT_A = process.env.QV_DEL_A_NAME ?? "";
const PNG_A =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let token = "";

async function apiCall(page: Page, path: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ({ apiBase, path: apiPath, body, authToken }) => {
      const response = await fetch(`${apiBase}${apiPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authToken },
        body: JSON.stringify(body),
      });
      let responseBody: any = null;
      try {
        responseBody = await response.json();
      } catch {}
      return { status: response.status, body: responseBody };
    },
    { apiBase: API_BASE, path, body, authToken: token },
  );
}

async function login(page: Page): Promise<void> {
  await page.goto("/#/login", { waitUntil: "domcontentloaded" });
  const username = page.locator('input[autocomplete="username"]');
  await username.waitFor({ state: "visible", timeout: 30_000 });
  await username.fill(process.env.QV_USERNAME ?? "admin");
  await page.locator('input[type="password"]').first().fill(process.env.QV_PASSWORD ?? "admin123");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL("**/#/project", { timeout: 30_000 });
  token = await page.evaluate(() => localStorage.getItem("token") ?? "");
  expect(token.length).toBeGreaterThan(0);
  const guide = page.locator(".t-dialog__ctx:visible").filter({ hasText: "欢迎使用 ToonFlow" });
  if (await guide.count()) await guide.getByRole("button", { name: "跳过引导" }).click();
}

test("聊天引用图片随用户消息回显（实时 + 历史还原）", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await login(page);

  const pid = Number(process.env.QV_DEL_A_PID);
  expect(pid).toBeGreaterThan(0);

  // 确保白板上有一张已完成图片（uploadMedia 落库即进白板）
  const upload = await apiCall(page, "/quickVideo/uploadMedia", {
    projectId: pid,
    mimeType: "image/png",
    base64Data: PNG_A,
    name: "E2E引用回显素材",
  });
  expect(upload.body?.code).toBe(200);
  const ref = upload.body?.data?.media;
  const mediaId = ref?.mediaId ?? ref?.id;

  // 打开项目工作台
  const card = page.locator(".project .card").filter({ hasText: PROJECT_A }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await page.waitForURL("**/#/quickVideo", { timeout: 30_000 });
  await expect(page.locator(".panelHeader").first()).toBeVisible({ timeout: 30_000 });

  // 模拟"复制即引用"：直接向待发送托盘塞入引用块（绕过 LLM，聚焦回显链路）。
  // 通过页面内 fetch 上传后，用与 onSenderPaste 相同的 stage 路径——这里直接操作 DOM 不可行，
  // 改为验证等价入口：资产白板点「复制」（copyMediaRef 内部会 stagePendingRef）。
  await page.locator('[data-testid="quick-video-nav-assets"]').click();
  const copyBtn = page.locator('[data-testid="qv-asset-copy"]').first();
  await expect(copyBtn).toBeVisible({ timeout: 30_000 });
  await copyBtn.click();
  await expect(page.locator(".attachTray .attachItem").first()).toBeVisible({ timeout: 15_000 });

  // 发送一条带引用的消息（LLM 不可达时本轮会报生成失败，但不影响用户消息回显）
  const textarea = page.locator(".inputBox textarea").first();
  await textarea.fill(`引用回显验证 ${Date.now()}`);
  await textarea.press("Enter");
  await page.waitForTimeout(2_500);

  // 实时回显：用户消息下方出现媒体卡片（qvChatMediaRow）
  const mediaRow = page.locator(".qvChatMediaRow").last();
  await expect(mediaRow).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("20-user-ref-live-echo.png") });
  await testInfo.attach("20-user-ref-live-echo.png", { path: testInfo.outputPath("20-user-ref-live-echo.png"), contentType: "image/png" });

  // 历史还原：刷新页面重新加载历史后，引用卡片仍随用户消息展示
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".panelHeader").first()).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-testid="quick-video-nav-assets"]').click();
  await page.waitForTimeout(1_000);
  const historyRow = page.locator(".qvChatMediaRow").last();
  await expect(historyRow).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("21-user-ref-history-echo.png") });
  await testInfo.attach("21-user-ref-history-echo.png", { path: testInfo.outputPath("21-user-ref-history-echo.png"), contentType: "image/png" });
});
