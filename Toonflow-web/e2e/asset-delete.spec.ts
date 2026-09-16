/**
 * SIY-137 审核反馈验证：资产白板「删除」按钮。
 * 覆盖：
 *  1. 白板条目删除（软删除）→ 卡片消失、toast 反馈、再删同条目被拒（MEDIA_NOT_FOUND）
 *  2. 守门 A：已绑定为镜头首帧的图片删除被拒（MEDIA_BOUND_AS_FIRST_FRAME）
 * 运行前提：集成后端 10599（WEB_DIST 指向含本功能的前端构建）；
 *   项目 A（QV_DEL_A_NAME）为空白快创项目（删除主路径），
 *   项目 B（QV_DEL_B_NAME）已预置草稿分镜（首帧守门路径）。
 */
import { expect, test, type Page } from "@playwright/test";

const API_BASE = process.env.QV_API_BASE_URL ?? "http://localhost:10599/api";
const USERNAME = process.env.QV_USERNAME ?? "admin";
const PASSWORD = process.env.QV_PASSWORD ?? "admin123";
const PROJECT_A = process.env.QV_DEL_A_NAME ?? "";
const PROJECT_B = process.env.QV_DEL_B_NAME ?? "";

let token = "";

// 两张不同的 1x1 PNG（SHA-256 幂等：同图重复上传会去重为同一素材，测试需两图不同）
const PNG_A =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_B =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function apiCall(page: Page, path: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ({ apiBase, path: apiPath, body: requestBody, authToken }) => {
      const response = await fetch(`${apiBase}${apiPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authToken ?? "" },
        body: JSON.stringify(requestBody),
      });
      let responseBody: any = null;
      try {
        responseBody = await response.json();
      } catch {
        responseBody = null;
      }
      return { status: response.status, body: responseBody };
    },
    { apiBase: API_BASE, path, body, authToken: token },
  );
}

async function login(page: Page): Promise<void> {
  await page.goto("/#/login", { waitUntil: "domcontentloaded" });
  const username = page.locator('input[autocomplete="username"]');
  await username.waitFor({ state: "visible", timeout: 30_000 });
  await username.fill(USERNAME);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL("**/#/project", { timeout: 30_000 });
  token = await page.evaluate(() => localStorage.getItem("token") ?? "");
  expect(token.length).toBeGreaterThan(0);
  const guide = page.locator(".t-dialog__ctx:visible").filter({ hasText: "欢迎使用 ToonFlow" });
  if (await guide.count()) await guide.getByRole("button", { name: "跳过引导" }).click();
}

async function openProjectAssets(page: Page, name: string): Promise<void> {
  const card = page.locator(".project .card").filter({ hasText: name }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await page.waitForURL("**/#/quickVideo", { timeout: 30_000 });
  await expect(page.locator(".panelHeader").first()).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-testid="quick-video-nav-assets"]').click();
  await expect(page.locator('[data-testid="qv-asset-board"]')).toBeVisible({ timeout: 30_000 });
}

test.describe.serial("资产白板删除（SIY-137 审核反馈）", () => {
  test("删除主路径：白板卡片删除后消失，重复删除被拒", async ({ page }) => {
    test.setTimeout(180_000);
    await login(page);

    // 准备：项目 A 上传两张图片
    await openProjectAssets(page, PROJECT_A);
    const pngs = [PNG_A, PNG_B];
    for (let i = 0; i < 2; i++) {
      const upload = await apiCall(page, "/quickVideo/uploadMedia", {
        projectId: Number(process.env.QV_DEL_A_PID),
        mimeType: "image/png",
        base64Data: pngs[i],
        name: `E2E删除素材${i + 1}`,
      });
      expect(upload.body?.code).toBe(200);
    }
    // 点白板头部的刷新按钮（icon-only，无文字）
    await page.locator('[data-testid="qv-asset-board"] .qvAssetBoardHeaderActions .t-button').first().click();
    await expect(page.locator('[data-testid^="qv-asset-cell-"]')).toHaveCount(2, { timeout: 30_000 });

    // 删除第一张：popconfirm 确认 → 卡片消失
    const firstCell = page.locator('[data-testid^="qv-asset-cell-"]').first();
    const firstMediaId = (await firstCell.getAttribute("data-testid"))!.replace("qv-asset-cell-", "");
    await firstCell.locator('[data-testid="qv-asset-delete"]').click();
    await page.locator(".t-popconfirm__content:visible button").filter({ hasText: /确|确定|OK/i }).first().click();
    await expect(page.locator('[data-testid^="qv-asset-cell-"]')).toHaveCount(1, { timeout: 30_000 });

    // 后端守门：再删同一条目 → MEDIA_NOT_FOUND
    const again = await apiCall(page, "/quickVideo/deleteAsset", {
      projectId: Number(process.env.QV_DEL_A_PID),
      mediaId: Number(firstMediaId),
    });
    expect(String(again.body?.message ?? "")).toContain("未找到该素材");

    // 守门：不存在的 mediaId
    const missing = await apiCall(page, "/quickVideo/deleteAsset", { projectId: Number(process.env.QV_DEL_A_PID), mediaId: 999999999 });
    expect(String(missing.body?.message ?? "")).toContain("未找到该素材");
  });

  test("守门：已绑定为镜头首帧的图片删除被拒", async ({ page }) => {
    test.setTimeout(180_000);
    await login(page);
    const pidB = Number(process.env.QV_DEL_B_PID);

    // 上传一张图并绑定为镜头 1 首帧
    await openProjectAssets(page, PROJECT_B);
    const upload = await apiCall(page, "/quickVideo/uploadMedia", {
      projectId: pidB,
      mimeType: "image/png",
      base64Data: PNG_A,
      name: "E2E首帧守门素材",
    });
    expect(upload.body?.code).toBe(200);
    const mediaId = upload.body?.data?.media?.mediaId ?? upload.body?.data?.mediaId;
    expect(Number(mediaId)).toBeGreaterThan(0);

    const wb = await apiCall(page, "/quickVideo/getWorkbench", { projectId: pidB });
    const version = wb.body?.data?.state?.version;
    const bound = await apiCall(page, "/quickVideo/bindShotFirstFrame", {
      projectId: pidB,
      expectedVersion: version,
      idempotencyKey: `e2e-del-bind-${Date.now()}`,
      shotId: "shot-1",
      mediaId: Number(mediaId),
    });
    expect(bound.body?.code, JSON.stringify(bound.body).slice(0, 160)).toBe(200);

    // UI 删除 → 服务端守门拒绝，卡片仍在
    const cell = page.locator(`[data-testid="qv-asset-cell-${mediaId}"]`);
    await expect(cell).toBeVisible({ timeout: 30_000 });
    await cell.locator('[data-testid="qv-asset-delete"]').click();
    await page.locator(".t-popconfirm__content:visible button").filter({ hasText: /确|确定|OK/i }).first().click();
    await page.waitForTimeout(2_000);
    await expect(cell).toBeVisible({ timeout: 15_000 });

    // 后端响应断言
    const rejected = await apiCall(page, "/quickVideo/deleteAsset", { projectId: pidB, mediaId: Number(mediaId) });
    expect(String(rejected.body?.message ?? "")).toContain("首帧");
  });
});
