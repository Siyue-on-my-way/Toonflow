/**
 * SIY-137 审核修复验证：白板「复制」后在聊天窗的免剪贴板粘贴入口。
 * 场景：用户经 HTTP 非 localhost 访问（非安全上下文），navigator.clipboard 不可用，
 * 复制只写入应用内槽位；系统剪贴板为空时浏览器不触发 paste 事件，Ctrl+V 无响应。
 * 修复：聊天输入框上方出现「粘贴引用」条，点击即放入待发送托盘。
 * 运行前提：集成后端 10599（WEB_DIST 指向含本修复的前端构建）。
 */
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const API_BASE = process.env.QV_API_BASE_URL ?? "http://localhost:10599/api";
const USERNAME = process.env.QV_USERNAME ?? "admin";
const PASSWORD = process.env.QV_PASSWORD ?? "admin123";
const PROJECT_NAME = process.env.QV_PROJECT_NAME ?? "雨后发光的小花";

async function captureScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, fullPage: false });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("白板复制 → 聊天窗「粘贴引用」条 → 待发送托盘", async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  // 1. 登录
  await page.goto("/#/login", { waitUntil: "domcontentloaded" });
  const username = page.locator('input[autocomplete="username"]');
  await username.waitFor({ state: "visible", timeout: 30_000 });
  await username.fill(USERNAME);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL("**/#/project", { timeout: 30_000 });
  await page.waitForTimeout(1_000);
  const guide = page.locator(".t-dialog__ctx:visible").filter({ hasText: "欢迎使用 ToonFlow" });
  if (await guide.count()) await guide.getByRole("button", { name: "跳过引导" }).click();

  // 2. 打开有白板资产的项目
  const card = page.locator(".project .card").filter({ hasText: PROJECT_NAME }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await page.waitForURL("**/#/quickVideo", { timeout: 30_000 });
  await expect(page.locator(".panelHeader").first()).toBeVisible({ timeout: 30_000 });

  // 3. 打开资产白板，点击一个已完成资产的「复制」
  await page.locator('[data-testid="quick-video-nav-assets"]').click();
  const copyBtn = page.locator('[data-testid="qv-asset-copy"]').first();
  await expect(copyBtn).toBeVisible({ timeout: 30_000 });
  await copyBtn.click();

  // 4. 修复点：聊天输入框上方出现「粘贴引用」条（data-testid 稳定断言）
  const clipBar = page.locator('[data-testid="quick-video-internal-clipboard"]');
  await expect(clipBar).toBeVisible({ timeout: 15_000 });
  await captureScreenshot(page, testInfo, "10-internal-clipboard-bar.png");

  // 5. 点击「粘贴引用」→ 引用进入待发送托盘（attachTray 出现条目）
  await page.locator('[data-testid="quick-video-internal-clipboard-paste"]').click();
  await expect(page.locator(".attachTray .attachItem").first()).toBeVisible({ timeout: 15_000 });
  await captureScreenshot(page, testInfo, "11-ref-staged-in-tray.png");

  // 6. 清除入口：点击条上的 x 后引用条消失（托盘中的待发送引用保留）
  await page.locator(".internalClipDismiss").click();
  await expect(clipBar).toBeHidden({ timeout: 10_000 });
  await expect(page.locator(".attachTray .attachItem").first()).toBeVisible({ timeout: 10_000 });
  await captureScreenshot(page, testInfo, "12-bar-dismissed-tray-kept.png");
});
