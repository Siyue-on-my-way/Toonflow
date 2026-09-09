import { test, expect } from "@playwright/test";

/**
 * 快创会话隔离 E2E（SIY-128）：创建两个会话，分别聊天，验证互不串线；
 * 返回项目列表重进 / 刷新页面后仍恢复到最近活跃的会话及其历史。
 *
 * 运行方式（与 quickvideo-export.e2e.spec.js 一致，需先起服务与真实浏览器）：
 *   npx playwright test quickvideo-session.e2e.spec.js
 */
const BASE = "http://localhost:2280";

test.use({
  viewport: { width: 1600, height: 1200 },
  launchOptions: {
    executablePath: "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  },
});

test("two sessions in one quick_video project stay isolated across switch and reload", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const projectName = `会话隔离验收-${Date.now()}`;

  await page.goto(`${BASE}/#/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[autocomplete="username"]').fill("admin");
  await page.locator('input[type="password"]').fill("admin123");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL("**/#/project", { timeout: 30000 });

  // 新建一个 quick_video 项目：新建项目 → 选择「单视频快创」模式 → 填表 → 确定
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByRole("listitem", { name: "单视频快创" }).click();
  await page.getByPlaceholder("请输入项目名称").fill(projectName);
  await page.getByPlaceholder(/国潮插画风/).fill("国潮插画风");
  await page.getByRole("button", { name: "确定" }).click();
  await page.waitForURL("**/#/quickVideo", { timeout: 30000 });

  // 新项目自动带一个默认会话
  const sessionItems = page.locator('[data-testid="qv-session-item"]');
  await expect(sessionItems).toHaveCount(1, { timeout: 15000 });

  const chatInput = page.getByPlaceholder(/奶茶新品宣传视频/);

  // 会话A发一条消息
  await chatInput.fill("这是会话A的消息");
  await chatInput.press("Enter");
  await expect(page.getByText("这是会话A的消息", { exact: true })).toBeVisible({ timeout: 10000 });

  // 新建会话B并切换过去；聊天面板不应再看到会话A的消息
  await page.locator('[data-testid="qv-session-create"]').click();
  await expect(sessionItems).toHaveCount(2, { timeout: 15000 });
  await expect(page.getByText("这是会话A的消息", { exact: true })).toHaveCount(0);

  await chatInput.fill("这是会话B的消息");
  await chatInput.press("Enter");
  await expect(page.getByText("这是会话B的消息", { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("这是会话A的消息", { exact: true })).toHaveCount(0);

  // 切回会话A：应看到会话A的消息，看不到会话B的消息
  await sessionItems.filter({ hasText: "默认会话" }).click();
  await expect(page.getByText("这是会话A的消息", { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("这是会话B的消息", { exact: true })).toHaveCount(0);

  // 返回项目列表再重进：应恢复最近活跃的会话（刚聊过天的会话B）及其历史，不产生新的 Agent 回复
  await page.goto(`${BASE}/#/project`, { waitUntil: "domcontentloaded" });
  await page.locator(".project .card").filter({ hasText: projectName }).first().click();
  await page.waitForURL("**/#/quickVideo", { timeout: 30000 });
  await expect(page.getByText("这是会话B的消息", { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("这是会话A的消息", { exact: true })).toHaveCount(0);

  const chatBubbles = page.locator(".t-chat-list .t-chat__message, .t-chat-list .t-chat-message");
  const messageCountAfterReenter = await chatBubbles.count();
  await page.waitForTimeout(3000);
  await expect(chatBubbles).toHaveCount(messageCountAfterReenter);

  console.log(JSON.stringify({ pageErrors }));
  expect(pageErrors).toEqual([]);
});
