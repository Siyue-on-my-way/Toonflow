import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

type ModelType = "text" | "image" | "video";

interface ModelOption {
  id: string;
  label: string;
  value: string;
  type: ModelType;
  name: string;
}

interface NetworkRecord {
  kind: string;
  status: number;
  requestBody: Record<string, unknown> | null;
  responseBody: any;
}

interface FixtureModel {
  name: string;
  modelName: string;
  type: "image" | "video";
  mode: string[];
  audio?: boolean;
  durationResolutionMap?: { duration: number[]; resolution: string[] }[];
}

interface FixtureState {
  vendorId: string;
  initialEnable: number;
  changedEnable: boolean;
  addedSpecs: string[];
  addedEnabled: string[];
}

const PROJECT_NAME = process.env.QV_PROJECT_NAME ?? "SIY-136 Playwright模型配置验证";
const PROJECT_INTRO = "SIY-136 专用 E2E 项目";
const API_BASE = process.env.QV_API_BASE_URL ?? "http://localhost:10588/api";
const ENABLE_MEDIA_FIXTURE = process.env.QV_ENABLE_MEDIA_FIXTURE === "1";
const FIXTURE_VENDOR = "minimax";
const FIXTURE_IMAGE: FixtureModel = {
  name: "海螺图像V1",
  modelName: "image-01",
  type: "image",
  mode: ["text", "singleImage"],
};
const FIXTURE_VIDEO: FixtureModel = {
  name: "海螺2.3",
  modelName: "MiniMax-Hailuo-2.3",
  type: "video",
  mode: ["text", "singleImage"],
  audio: false,
  durationResolutionMap: [
    { duration: [6], resolution: ["768P", "1080P"] },
    { duration: [10], resolution: ["768P"] },
  ],
};

function parseJson(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function responseKind(url: string): string | null {
  const pathname = new URL(url).pathname;
  if (pathname.endsWith("/modelSelect/getModelList")) return "modelList";
  if (pathname.endsWith("/quickVideo/updateModels")) return "updateModels";
  if (pathname.endsWith("/quickVideo/getWorkbench")) return "getWorkbench";
  if (pathname.endsWith("/quickVideo/retryShot")) return "retryShot";
  if (pathname.endsWith("/quickVideo/generateShots")) return "generateShots";
  if (pathname.endsWith("/quickVideoSession/create")) return "sessionCreate";
  return null;
}

async function readResponseBody(response: any): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function apiCall(page: Page, path: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ({ apiBase, path: apiPath, body: requestBody }) => {
      const response = await fetch(`${apiBase}${apiPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: localStorage.getItem("token") ?? "",
        },
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
    { apiBase: API_BASE, path, body },
  );
}

async function dismissOnboarding(page: Page): Promise<void> {
  const guide = page.locator(".t-dialog__ctx:visible").filter({ hasText: "欢迎使用 ToonFlow" });
  if (!(await guide.count())) return;
  await guide.getByRole("button", { name: "跳过引导" }).click();
  await expect(guide).toBeHidden({ timeout: 5_000 });
}

async function login(page: Page): Promise<void> {
  await page.goto("/#/login", { waitUntil: "domcontentloaded" });
  const username = page.locator('input[autocomplete="username"]');
  if (await username.count()) {
    await username.fill(process.env.QV_USERNAME ?? "admin");
    await page.locator('input[type="password"]').fill(process.env.QV_PASSWORD ?? "admin123");
    await page.getByRole("button", { name: "登录" }).click();
    await page.waitForURL("**/#/project", { timeout: 30_000 });
  }
}

async function createProjectIfMissing(page: Page): Promise<void> {
  const projectCard = page.locator(".project .card").filter({ hasText: PROJECT_NAME }).first();
  if (await projectCard.isVisible().catch(() => false)) return;

  await page.getByRole("button", { name: "新建项目" }).click();
  const dialog = page.locator(".t-dialog__ctx:visible").filter({ hasText: "项目类型" }).last();
  await dialog.locator(".t-form__item").filter({ hasText: "项目类型" }).locator("input").click();
  await page.locator(".t-popup:visible .t-select-option").filter({ hasText: "单视频快创" }).click();
  await dialog.locator('input[placeholder="请输入项目名称"]').fill(PROJECT_NAME);
  await dialog.locator(".t-form__item").filter({ hasText: "快创画风" }).locator("input").fill("水墨");
  const intro = dialog.locator("textarea").first();
  if (await intro.count()) await intro.fill(PROJECT_INTRO);
  await dialog.getByRole("button", { name: "确定" }).click();
  await expect(projectCard).toBeVisible({ timeout: 30_000 });
}

async function setupMediaFixture(page: Page): Promise<FixtureState | null> {
  if (!ENABLE_MEDIA_FIXTURE) return null;

  const state: FixtureState = {
    vendorId: FIXTURE_VENDOR,
    initialEnable: 0,
    changedEnable: false,
    addedSpecs: [],
    addedEnabled: [],
  };
  const vendorResult = await apiCall(page, "/setting/vendorConfig/getVendorList", {});
  expect(vendorResult.status).toBe(200);
  const vendor = (vendorResult.body?.data ?? []).find((item: any) => item.id === FIXTURE_VENDOR);
  if (!vendor) throw new Error(`媒体 fixture 供应商不存在: ${FIXTURE_VENDOR}`);
  state.initialEnable = Number(vendor.enable ?? 0);

  const models = [FIXTURE_IMAGE, FIXTURE_VIDEO];
  const catalog = Array.isArray(vendor.catalogModels) ? vendor.catalogModels : [];
  let enabledNames: string[] = [];
  try {
    const parsed = JSON.parse(String(vendor.enabledModels ?? "[]"));
    if (Array.isArray(parsed)) enabledNames = parsed;
  } catch {
    enabledNames = [];
  }

  for (const model of models) {
    if (!catalog.some((item: any) => item.modelName === model.modelName)) {
      const added = await apiCall(page, "/setting/vendorConfig/addVendorModelSpec", { id: FIXTURE_VENDOR, model });
      expect(added.status, `添加 fixture 协议失败: ${model.modelName}`).toBe(200);
      expect(added.body?.code, `添加 fixture 协议失败: ${model.modelName}`).toBe(200);
      state.addedSpecs.push(model.modelName);
    }
    if (!enabledNames.includes(model.modelName)) {
      const added = await apiCall(page, "/setting/vendorConfig/addVendorModel", { id: FIXTURE_VENDOR, model });
      expect(added.status, `启用 fixture 模型失败: ${model.modelName}`).toBe(200);
      expect(added.body?.code, `启用 fixture 模型失败: ${model.modelName}`).toBe(200);
      state.addedEnabled.push(model.modelName);
      enabledNames.push(model.modelName);
    }
  }

  if (state.initialEnable !== 1) {
    const enabledVendor = await apiCall(page, "/setting/vendorConfig/enableVendor", { id: FIXTURE_VENDOR, enable: 1 });
    expect(enabledVendor.status).toBe(200);
    expect(enabledVendor.body?.code).toBe(200);
    state.changedEnable = true;
  }
  return state;
}

async function restoreMediaFixture(page: Page, state: FixtureState | null): Promise<void> {
  if (!state) return;
  for (const modelName of state.addedEnabled) {
    await apiCall(page, "/setting/vendorConfig/delVendorModel", { id: state.vendorId, modelName }).catch(() => undefined);
  }
  for (const modelName of [...state.addedSpecs].reverse()) {
    await apiCall(page, "/setting/vendorConfig/deleteVendorModelSpec", { id: state.vendorId, modelName }).catch(() => undefined);
  }
  if (state.changedEnable) {
    await apiCall(page, "/setting/vendorConfig/enableVendor", { id: state.vendorId, enable: state.initialEnable }).catch(() => undefined);
  }
}

async function captureScreenshot(page: Page, testInfo: TestInfo, name: string, locator?: any): Promise<void> {
  const path = testInfo.outputPath(name);
  if (locator) await locator.screenshot({ path });
  else await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

function latestRecord(records: NetworkRecord[], kind: string, predicate?: (record: NetworkRecord) => boolean): NetworkRecord | undefined {
  return [...records].reverse().find((record) => record.kind === kind && (!predicate || predicate(record)));
}

function listModels(records: NetworkRecord[], type: ModelType): ModelOption[] {
  const record = latestRecord(records, "modelList", (item) => item.requestBody?.type === type);
  return Array.isArray(record?.responseBody?.data) ? (record?.responseBody?.data as ModelOption[]) : [];
}

async function waitForNetworkRecords(records: NetworkRecord[], minimum = 1): Promise<void> {
  await expect.poll(() => records.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(minimum);
}

async function selectModel(
  page: Page,
  testInfo: TestInfo,
  modelCard: any,
  fieldIndex: number,
  type: ModelType,
  options: ModelOption[],
): Promise<ModelOption | null> {
  const field = modelCard.locator(".modelField").nth(fieldIndex);
  const input = field.locator('input[placeholder="请选择模型"], input[placeholder="选择模型"]');
  await input.click();
  const dropdown = page.locator(".t-select__dropdown:visible").last();
  await expect(dropdown).toBeVisible({ timeout: 5_000 });

  if (!options.length) {
    await expect(dropdown).toContainText(/模型|设置/);
    await captureScreenshot(page, testInfo, `${type}-model-unavailable.png`);
    await page.keyboard.press("Escape");
    return null;
  }

  const option = options[0];
  await expect(dropdown.locator(".t-select-option-group__header")).toContainText(option.name);
  await captureScreenshot(page, testInfo, `${type}-model-dropdown.png`);
  await dropdown.locator(".t-select-option").filter({ hasText: option.label }).first().click();
  await expect(input).toHaveValue(option.label);
  return option;
}

test("快创模型配置真实加载、保存、刷新回显并保留生成入口契约", async ({ page }, testInfo) => {
  const records: NetworkRecord[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const requestFailures: string[] = [];
  const responsePromises: Promise<void>[] = [];
  let fixtureState: FixtureState | null = null;
  let savePayload: Record<string, unknown> | null = null;
  let saveBody: any = null;
  let preflight: { status: number; body: any } | null = null;
  let retryPreflight: { status: number; body: any } | null = null;
  let invalidSave: { status: number; body: any } | null = null;
  let projectId = 0;
  let sessionId = 0;
  let initialModels: { textModel: string; imageModel: string; videoModel: string } | null = null;

  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => requestFailures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    const kind = responseKind(response.url());
    if (!kind) return;
    responsePromises.push(
      (async () => {
        records.push({
          kind,
          status: response.status(),
          requestBody: parseJson(response.request().postData()),
          responseBody: await readResponseBody(response),
        });
      })(),
    );
  });

  await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  try {
    await login(page);
    await page.waitForTimeout(500);
    await dismissOnboarding(page);
    fixtureState = await setupMediaFixture(page);

    // fixture 修改必须发生在工作台打开前，确保三个 modelSelect 都从真实 API 重新加载。
    await page.goto("/#/project", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    await dismissOnboarding(page);
    await createProjectIfMissing(page);
    const projectCard = page.locator(".project .card").filter({ hasText: PROJECT_NAME }).first();
    await projectCard.click();
    await page.waitForURL("**/#/quickVideo", { timeout: 30_000 });

    const modelCard = page.locator(".modelCard");
    await expect(modelCard).toBeVisible({ timeout: 30_000 });
    await waitForNetworkRecords(records, 3);
    await expect.poll(() => records.filter((record) => record.kind === "getWorkbench").length, { timeout: 15_000 }).toBeGreaterThan(0);
    await captureScreenshot(page, testInfo, "initial-workbench-model-config.png");
    await captureScreenshot(page, testInfo, "initial-model-card.png", modelCard);

    const workbench = latestRecord(records, "getWorkbench")?.responseBody?.data;
    expect(workbench?.project?.name).toBe(PROJECT_NAME);
    projectId = Number(workbench?.project?.id);
    sessionId = Number(workbench?.session?.id);
    expect(projectId).toBeGreaterThan(0);
    expect(sessionId).toBeGreaterThan(0);
    initialModels = {
      textModel: String(workbench?.session?.textModel ?? ""),
      imageModel: String(workbench?.session?.imageModel ?? ""),
      videoModel: String(workbench?.session?.videoModel ?? ""),
    };

    const textModels = listModels(records, "text");
    const imageModels = listModels(records, "image");
    const videoModels = listModels(records, "video");
    expect(textModels.length, "文本模型目录必须至少返回一个供应商模型").toBeGreaterThan(0);
    if (ENABLE_MEDIA_FIXTURE) {
      expect(imageModels.length, "媒体 fixture 启用后图片目录必须可用").toBeGreaterThan(0);
      expect(videoModels.length, "媒体 fixture 启用后视频目录必须可用").toBeGreaterThan(0);
    }

    const selectedText = await selectModel(page, testInfo, modelCard, 0, "text", textModels);
    const selectedImage = await selectModel(page, testInfo, modelCard, 1, "image", imageModels);
    const selectedVideo = await selectModel(page, testInfo, modelCard, 2, "video", videoModels);
    expect(selectedText).not.toBeNull();

    const saveButton = modelCard.getByRole("button", { name: "保存模型" });
    await expect(saveButton).toBeEnabled();
    const sessionCreatesBeforeSave = records.filter((record) => record.kind === "sessionCreate").length;
    const expectedSelections = {
      textModel: selectedText ? `${selectedText.id}:${selectedText.value}` : "",
      imageModel: selectedImage ? `${selectedImage.id}:${selectedImage.value}` : "",
      videoModel: selectedVideo ? `${selectedVideo.id}:${selectedVideo.value}` : "",
    };
    const saveResponsePromise = page.waitForResponse(
      (response) => responseKind(response.url()) === "updateModels" && response.request().method() === "POST",
      { timeout: 15_000 },
    );
    await saveButton.click();
    const saveResponse = await saveResponsePromise;
    saveBody = await saveResponse.json();
    savePayload = parseJson(saveResponse.request().postData());
    expect(saveResponse.status()).toBe(200);
    expect(saveBody?.code).toBe(200);
    expect(savePayload).toMatchObject({ projectId, sessionId, ...expectedSelections });
    expect(saveBody?.data?.session).toMatchObject({ id: sessionId, projectId, ...expectedSelections });
    expect(records.filter((record) => record.kind === "sessionCreate").length).toBe(sessionCreatesBeforeSave);
    await captureScreenshot(page, testInfo, "models-saved.png");
    await captureScreenshot(page, testInfo, "right-panel-model-summary.png", page.locator(".panel"));

    // 当前页面没有分镜时仍验证真实生成入口的前置保护：接口必须携带当前 session，不能静默启动任务。
    preflight = await apiCall(page, "/quickVideo/generateShots", {
      projectId,
      sessionId,
      kind: "image",
      shotIds: [],
    });
    expect(preflight.status).toBe(200);
    expect(["NO_STORYBOARD", "MODEL_NOT_CONFIGURED", "STAGE_MISMATCH"]).toContain(preflight.body?.code);

    retryPreflight = await apiCall(page, "/quickVideo/retryShot", {
      projectId,
      sessionId,
      shotIds: ["missing-e2e-shot"],
    });
    expect(retryPreflight.status).toBe(200);
    expect(["NO_STORYBOARD", "STAGE_MISMATCH", "SHOT_NOT_FOUND"]).toContain(retryPreflight.body?.code);

    // 供应商/模型不可用时服务端应拒绝保存，保留当前 session 选择，禁止静默替换。
    invalidSave = await apiCall(page, "/quickVideo/updateModels", {
      projectId,
      sessionId,
      ...expectedSelections,
      imageModel: "missing-e2e-vendor:missing-e2e-image",
    });
    expect(invalidSave.status).toBe(400);
    expect(String(invalidSave.body?.message ?? "")).toMatch(/图片模型|不可用|模型/);

    const recordCountBeforeReload = records.filter((record) => record.kind === "getWorkbench").length;
    await page.reload({ waitUntil: "domcontentloaded" });
    await dismissOnboarding(page);
    await expect(modelCard).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => records.filter((record) => record.kind === "getWorkbench").length, { timeout: 15_000 })
      .toBeGreaterThan(recordCountBeforeReload);
    await page.waitForTimeout(500);
    const reloadedWorkbench = latestRecord(records, "getWorkbench")?.responseBody?.data;
    expect(reloadedWorkbench?.session).toMatchObject({ id: sessionId, projectId, ...expectedSelections });
    const modelInputs = modelCard.locator('.modelField input[placeholder="请选择模型"], .modelField input[placeholder="选择模型"]');
    await expect(modelInputs.nth(0)).toHaveValue(selectedText!.label);
    if (selectedImage) await expect(modelInputs.nth(1)).toHaveValue(selectedImage.label);
    if (selectedVideo) await expect(modelInputs.nth(2)).toHaveValue(selectedVideo.label);
    await captureScreenshot(page, testInfo, "models-after-reload.png");

    await Promise.all(responsePromises);
    const modelListSummary = ["text", "image", "video"].map((type) => {
      const record = latestRecord(records, "modelList", (item) => item.requestBody?.type === type);
      return {
        type,
        status: record?.status ?? null,
        models: listModels(records, type as ModelType).map((model) => ({
          provider: model.name,
          label: model.label,
          key: `${model.id}:${model.value}`,
        })),
      };
    });
    const networkSummary = {
      baseUrl: process.env.QV_BASE_URL ?? "http://localhost:50188",
      projectId,
      sessionId,
      fixtureEnabled: ENABLE_MEDIA_FIXTURE,
      modelList: modelListSummary,
      savePayload,
      saveResponse: { status: saveResponse.status(), body: saveBody },
      invalidSave,
      preflight,
      retryPreflight,
      reloadedSession: reloadedWorkbench?.session ?? null,
      requestCounts: Object.fromEntries(
        ["modelList", "getWorkbench", "updateModels", "generateShots", "retryShot", "sessionCreate"].map((kind) => [
          kind,
          records.filter((record) => record.kind === kind).length,
        ]),
      ),
      pageErrors,
      consoleErrors,
      requestFailures,
    };
    const networkSummaryPath = testInfo.outputPath("network-summary.json");
    await writeFile(networkSummaryPath, `${JSON.stringify(networkSummary, null, 2)}\n`, "utf8");
    await testInfo.attach("network-summary.json", { path: networkSummaryPath, contentType: "application/json" });

    expect(pageErrors, "不应有未捕获的前端 pageerror").toEqual([]);
    expect(requestFailures, "关键 E2E 期间不应有请求失败").toEqual([]);
  } finally {
    if (projectId > 0 && sessionId > 0 && initialModels) {
      await apiCall(page, "/quickVideo/updateModels", { projectId, sessionId, ...initialModels }).catch(() => undefined);
    }
    await restoreMediaFixture(page, fixtureState);
    const tracePath = testInfo.outputPath("quickvideo-model-config.trace.zip");
    await page
      .context()
      .tracing.stop({ path: tracePath })
      .catch(() => undefined);
    await testInfo.attach("quickvideo-model-config.trace.zip", { path: tracePath, contentType: "application/zip" }).catch(() => undefined);
  }
});
