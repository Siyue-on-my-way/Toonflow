import { expect, test, type Page } from "@playwright/test";

/**
 * SIY-138 快创对话式配置 + 生成确认门 E2E（mock 后端，无需真实服务/模型）：
 * 1. 创建不填画风/时长的快创项目（比例保留）并进入工作台，右侧面板显示「未设置」；
 * 2. 配置 12 秒 + 水彩 → 头部实时更新；再改为 18 秒 → 覆盖生效（configVersion 递增）；
 * 3. 出现生成确认卡片（含版本号/时长/画风/分镜摘要），确认版本不一致时被拦截并提示重新确认；
 * 4. 版本一致确认成功 → 进入生成阶段；失败镜头可单独重试。
 */

const PROJECT_ID = 901;
const SESSION_ID = 1;

interface ShotStateOverride {
  id: string;
  index: number;
  duration: number;
  description: string;
  imageState?: string;
  videoState?: string;
  errorReason?: string | null;
}

function shot(id: string, index: number, duration: number, description: string, gen: Partial<ShotStateOverride> = {}) {
  return {
    id,
    index,
    duration,
    description,
    dialogue: "",
    camera: "全景",
    assetRefs: [],
    imageState: gen.imageState ?? "pending",
    videoState: gen.videoState ?? "pending",
    imageRef: null,
    videoRef: null,
    errorReason: gen.errorReason ?? null,
    firstFrame: null,
  };
}

function makeState(overrides: Record<string, any> = {}) {
  return {
    schemaVersion: 1,
    version: 2,
    stage: "collect_brief",
    targetDuration: null,
    videoRatio: "9:16",
    artStyle: "",
    configVersion: 0,
    pendingSnapshot: null,
    confirmationStatus: "none",
    createIdempotencyKey: "e2e-idem-key-01",
    brief: null,
    storyboard: null,
    generation: {
      snapshot: null,
      materialsConfirmed: false,
      materialsConfirmedAt: null,
      runId: null,
      startedAt: null,
      finishedAt: null,
      materialImages: {},
      timeline: null,
      exportInfo: null,
    },
    appliedKeys: {},
    lastChatAt: null,
    updateTime: 1757500000000,
    ...overrides,
  };
}

function makeProject() {
  return {
    id: PROJECT_ID,
    projectType: "quick_video",
    type: "quick_video",
    name: "SIY-138 E2E 快创项目",
    intro: "",
    artStyle: "",
    videoRatio: "9:16",
    imageModel: "",
    videoModel: "",
    textModel: "",
    imageQuality: "",
    mode: "",
    directorManual: "",
    createTime: 1757500000000,
  };
}

function workbenchPayload(state: Record<string, any>) {
  return {
    project: makeProject(),
    script: null,
    state,
    shotBounds: state.targetDuration != null ? { min: 1, max: Math.min(12, Math.floor(state.targetDuration / 5)) } : null,
  };
}

function pendingSnapshot(configVersion: number, targetDuration: number, artStyle: string, shots: { duration: number; description: string }[]) {
  return {
    configVersion,
    targetDuration,
    artStyle,
    videoRatio: "9:16",
    storyboardVersion: 2,
    shotCount: shots.length,
    totalDuration: shots.reduce((sum, s) => sum + s.duration, 0),
    shotSummaries: shots.map((s, i) => ({ index: i + 1, duration: s.duration, description: s.description })),
    estimatedImageCount: shots.length,
    estimatedVideoCount: shots.length,
    estimatedCostYuan: 6.6,
    requestedAt: 1757500100000,
  };
}

async function setupApiMocks(page: Page) {
  // 当前工作台状态（可被测试步骤改写）
  let currentState = makeState();
  const setState = (next: Record<string, any>) => {
    currentState = next;
  };

  // 兜底：未显式 mock 的接口一律返回空成功，避免无关面板报错
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 200, data: [], message: "成功" }) }),
  );

  await page.route("**/api/project/getProject", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 200, data: [makeProject()], message: "成功" }) }),
  );

  await page.route("**/api/quickVideo/getWorkbench", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 200, data: workbenchPayload(currentState), message: "成功" }) }),
  );

  await page.route("**/api/quickVideo/listSessions", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        code: 200,
        data: {
          sessions: [
            { id: SESSION_ID, projectId: PROJECT_ID, title: "默认会话", status: "active", textModel: null, imageModel: null, videoModel: null, sequence: 1, userMessageCount: 0, titleStatus: "idle", createTime: 1, updateTime: 1 },
          ],
        },
        message: "成功",
      }),
    }),
  );

  await page.route("**/api/agents/getMemory", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }),
  );

  await page.route("**/api/quickVideo/getAssetBoard", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 200, data: { items: [], total: 0, page: 1, pageSize: 24 }, message: "成功" }) }),
  );

  return { setState, getState: () => currentState };
}

async function skipLogin(page: Page) {
  // 路由守卫只检查 localStorage.token 的存在性；预置 token 即可直达工作台。
  // helloGuideDone 跳过「欢迎使用 ToonFlow」首次引导弹窗（它会挡住页面点击）。
  await page.addInitScript(() => {
    localStorage.setItem("token", "e2e-fake-token");
    localStorage.setItem("helloGuideDone", "true");
  });
}

test.describe("SIY-138 快创对话式配置与生成确认门", () => {
  test("创建空配置项目 → 未设置回显 → 12秒/水彩 → 改18秒 → 确认卡片 → 过期版本拦截 → 确认生成 → 失败镜头重试", async ({ page }) => {
    const api = await setupApiMocks(page);
    await skipLogin(page);

    const updateConfigCalls: any[] = [];
    await page.route("**/api/quickVideo/updateConfig", async (route) => {
      const body = route.request().postDataJSON() as Record<string, any>;
      updateConfigCalls.push(body);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 200, data: { state: api.getState() }, message: "成功" }) });
    });

    const confirmCalls: any[] = [];
    let confirmResult: { code: number | string; message?: string } = { code: 200 };
    await page.route("**/api/quickVideo/generateConfirm", async (route) => {
      const body = route.request().postDataJSON() as Record<string, any>;
      confirmCalls.push(body);
      if (body.action === "confirm") {
        if (confirmResult.code !== 200) {
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: confirmResult.code, message: confirmResult.message, currentVersion: 3 }) });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ code: 200, data: { started: true, alreadyRunning: false, runId: "run-e2e-1" }, message: "成功" }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 200, data: { state: api.getState(), pendingSnapshot: api.getState().pendingSnapshot, idempotentHit: false }, message: "成功" }) });
    });

    const retryCalls: any[] = [];
    await page.route("**/api/quickVideo/retryShot", async (route) => {
      retryCalls.push(route.request().postDataJSON() as Record<string, any>);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 200, data: {}, message: "成功" }) });
    });

    // —— 1. 项目列表 → 打开快创项目 ——
    await page.goto("/workbench/project");
    await expect(page.getByText("SIY-138 E2E 快创项目")).toBeVisible();
    await page.getByText("SIY-138 E2E 快创项目").first().click();
    await expect(page).toHaveURL(/\/quickVideo/);

    // —— 2. 画布初始态：时长与画风「未设置」——
    const panel = page.getByTestId("quick-video-main-panel");
    await expect(panel.getByText(/目标时长：未设置/)).toBeVisible();
    await expect(panel.getByText(/画风：未设置/)).toBeVisible();

    // —— 3. 配置 12 秒 + 水彩（对话式配置的手动通道；Agent 工具走同一 update_config 服务端逻辑）——
    // 服务端（Agent 同款逻辑）按新配置递增 configVersion：0 -> 1。
    // 注意先改 mock 状态再点保存：updateConfig 成功后 store 会立即刷新工作台。
    api.setState(
      makeState({
        version: 6,
        configVersion: 1,
        targetDuration: 12,
        artStyle: "水彩",
      }),
    );
    await panel.getByRole("button", { name: "编辑配置" }).click();
    const dialog = page.locator(".t-dialog:visible", { hasText: "编辑配置" });
    await expect(dialog).toBeVisible();
    // 时长数字输入（t-input-number 内嵌 input），清空后填 12
    const durationInput = dialog.locator(".t-input-number input").first();
    await durationInput.fill("12");
    await dialog.locator("input[placeholder*='画风']").fill("水彩");
    await dialog.getByRole("button", { name: "保存" }).click();

    await expect(panel.getByText(/目标时长：12s/)).toBeVisible();
    await expect(panel.getByText("水彩").first()).toBeVisible();
    expect(updateConfigCalls[0].patch.targetDuration).toBe(12);

    // —— 4. 改成 18 秒 → 覆盖生效，configVersion 递增到 2 ——
    api.setState(
      makeState({
        version: 8,
        configVersion: 2,
        targetDuration: 18,
        artStyle: "水彩",
      }),
    );
    await panel.getByRole("button", { name: "编辑配置" }).click();
    await durationInput.fill("18");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(panel.getByText(/目标时长：18s/)).toBeVisible();
    expect(updateConfigCalls[1].patch.targetDuration).toBe(18);

    // —— 5. 生成确认卡片（Agent request_generation_confirm 后的状态）：含版本/时长/画风/分镜摘要 ——
    const snapshot = pendingSnapshot(2, 18, "水彩", [
      { duration: 9, description: "清晨湖面白鹭掠过" },
      { duration: 9, description: "湖边小镇苏醒收尾" },
    ]);
    api.setState(
      makeState({
        version: 10,
        configVersion: 2,
        stage: "storyboard_confirmed",
        targetDuration: 18,
        artStyle: "水彩",
        storyboard: {
          version: 2,
          status: "confirmed",
          confirmedAt: 1757500090000,
          summary: "两镜水彩短片",
          shots: [shot("shot-1", 1, 9, "清晨湖面白鹭掠过"), shot("shot-2", 2, 9, "湖边小镇苏醒收尾")],
        },
        confirmationStatus: "pending",
        pendingSnapshot: snapshot,
      }),
    );
    // 模拟 Agent 在聊天中完成 request_generation_confirm 后前端感知：手动触发一次工作台刷新
    await panel.getByTestId("quick-video-refresh").click();
    await page.getByTestId("quick-video-gen-confirm-card").waitFor({ state: "visible" });
    const card = page.getByTestId("quick-video-gen-confirm-card");
    await expect(card.getByText("v2").first()).toBeVisible();
    await expect(card.getByText("18s").first()).toBeVisible();
    await expect(card.getByText("水彩").first()).toBeVisible();
    await expect(card.getByText("清晨湖面白鹭掠过").first()).toBeVisible();

    // —— 6. 版本不一致拦截：确认基于过期 configVersion ——
    confirmResult = { code: "CONFIG_VERSION_MISMATCH", message: "参数已变更，请重新确认生成" };
    await card.getByTestId("quick-video-gen-confirm-yes").click();
    await expect(page.locator(".t-message").getByText("参数已变更，请重新确认生成")).toBeVisible();
    expect(confirmCalls.find((c) => c.action === "confirm")?.configVersion).toBe(2);

    // —— 7. 版本一致确认成功 → 进入生成阶段，确认卡片消失 ——
    confirmResult = { code: 200 };
    api.setState(
      makeState({
        version: 12,
        configVersion: 2,
        stage: "generating",
        targetDuration: 18,
        artStyle: "水彩",
        confirmationStatus: "confirmed",
        generation: {
          snapshot: null,
          materialsConfirmed: true,
          materialsConfirmedAt: 1757500110000,
          runId: "run-e2e-1",
          startedAt: 1757500110000,
          finishedAt: null,
          materialImages: {},
          timeline: null,
          exportInfo: null,
        },
        storyboard: {
          version: 2,
          status: "confirmed",
          confirmedAt: 1757500090000,
          summary: "两镜水彩短片",
          shots: [shot("shot-1", 1, 9, "清晨湖面白鹭掠过"), shot("shot-2", 2, 9, "湖边小镇苏醒收尾")],
        },
      }),
    );
    await card.getByTestId("quick-video-gen-confirm-yes").click();
    await expect(page.getByTestId("quick-video-gen-confirm-card")).toHaveCount(0);

    // —— 8. 失败镜头单独重试 ——
    api.setState(
      makeState({
        version: 14,
        configVersion: 2,
        stage: "generating",
        targetDuration: 18,
        artStyle: "水彩",
        confirmationStatus: "confirmed",
        generation: {
          snapshot: null,
          materialsConfirmed: true,
          materialsConfirmedAt: 1757500110000,
          runId: "run-e2e-1",
          startedAt: 1757500110000,
          finishedAt: null,
          materialImages: {},
          timeline: null,
          exportInfo: null,
        },
        storyboard: {
          version: 2,
          status: "confirmed",
          confirmedAt: 1757500090000,
          summary: "两镜水彩短片",
          shots: [
            shot("shot-1", 1, 9, "清晨湖面白鹭掠过", { imageState: "done", videoState: "done" }),
            shot("shot-2", 2, 9, "湖边小镇苏醒收尾", { imageState: "failed", videoState: "failed", errorReason: "供应商超时" }),
          ],
        },
      }),
    );
    await page.getByTestId("quick-video-nav-preview").click();
    const retryButton = page.getByRole("button", { name: "重试全部失败" });
    await expect(retryButton).toBeVisible();
    await retryButton.click();
    await expect(page.waitForTimeout(300)).resolves.toBeUndefined();
    expect(retryCalls.length).toBeGreaterThan(0);
    expect(retryCalls[0].shotIds).toContain("shot-2");
  });

  test("旧项目回显：存量 30 秒项目正常打开并回显时长与画风", async ({ page }) => {
    const api = await setupApiMocks(page);
    await skipLogin(page);

    api.setState(
      makeState({
        version: 30,
        configVersion: 0,
        stage: "collect_brief",
        targetDuration: 30,
        artStyle: "国潮插画",
        brief: { theme: "主题", hook: "", narrative: "大纲", cta: "", keywords: [], confirmed: false, confirmedAt: null },
      }),
    );

    await page.goto("/workbench/project");
    await page.getByText("SIY-138 E2E 快创项目").first().click();
    await expect(page).toHaveURL(/\/quickVideo/);

    const panel = page.getByTestId("quick-video-main-panel");
    await expect(panel.getByText(/目标时长：30s/)).toBeVisible();
    await expect(panel.getByText("国潮插画").first()).toBeVisible();
    // 存量项目不显示「未设置」
    await expect(panel.getByText(/目标时长：未设置/)).toHaveCount(0);
  });
});
