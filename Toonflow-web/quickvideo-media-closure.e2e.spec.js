import { test, expect, request as playwrightRequest } from "@playwright/test";

/**
 * Quick Video 媒体闭环验收（SIY-134）。
 *
 * 这条用例刻意使用仓库内置的 null:e2e-img / null:e2e-vid fixture：图片和视频
 * 返回固定的本地 base64，不会调用 RunningHub 或消耗供应商额度。文本 Agent 仍
 * 走当前配置的文本模型，用来验证真实聊天工作流；视频聊天请求固定不传长时长，
 * generate_video 默认使用产品允许的最短片段。
 *
 * 运行：
 *   npx --yes playwright@1.55.0 test quickvideo-media-closure.e2e.spec.js --workers=1 --timeout=300000
 */
const BASE = process.env.QV_BASE_URL || "http://localhost:2280";
const IMAGE_MODEL = "null:e2e-img";
const VIDEO_MODEL = "null:e2e-vid";
const TEXT_MODEL = "aibotplatform:gpt-5.4";

test.use({
  viewport: { width: 1600, height: 1200 },
  launchOptions: {
    executablePath: "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  },
});

let apiContext;
let authToken = "";
let projectId = null;
let projectName = "";

async function api(path, body = {}) {
  const response = await apiContext.post(`${BASE}/api${path}`, {
    headers: { Authorization: authToken },
    data: body,
  });
  const payload = await response.json();
  if (!response.ok()) {
    throw new Error(`${path} HTTP ${response.status()}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function unwrap(payload) {
  return payload?.data ?? payload;
}

async function getProjects() {
  return unwrap(await api("/project/getProject")) ?? [];
}

async function getWorkbench() {
  return unwrap(await api("/quickVideo/getWorkbench", { projectId })) ?? {};
}

async function getBoard(kind = "all") {
  return unwrap(await api("/quickVideo/getAssetBoard", { projectId, kind, page: 1, pageSize: 60 })) ?? { items: [] };
}

async function waitForState(predicate, message, timeout = 180000) {
  let latest = null;
  await expect
    .poll(
      async () => {
        latest = await getWorkbench();
        return Boolean(latest?.state && predicate(latest.state));
      },
      { timeout, intervals: [500, 1000, 2000, 4000], message },
    )
    .toBe(true);
  return latest.state;
}

async function waitForNewMedia(kind, previousIds, message, timeout = 120000) {
  let found = null;
  await expect
    .poll(
      async () => {
        const board = await getBoard(kind);
        found = board.items?.find((item) => item.kind === kind && !previousIds.has(item.mediaId) && item.state === "done") ?? null;
        return found?.mediaId ?? 0;
      },
      { timeout, intervals: [500, 1000, 2000, 4000], message },
    )
    .toBeGreaterThan(0);
  return found;
}

async function chooseChatModel(page, mode, modelLabel) {
  const modeInput = page.locator(".modelTypeSelect input");
  const modelInput = page.locator(".modelValueSelect input");
  const modeLabel = mode === "image" ? "图像" : mode === "video" ? "视频" : "文本";

  // The type select renders TDesign options as listitems. Avoid reopening it when
  // the requested mode is already selected (the first text turn starts this way).
  if ((await modeInput.inputValue()) !== modeLabel) {
    await modeInput.click();
    await page.getByRole("listitem", { name: modeLabel, exact: true }).last().click();
  }

  const currentModel = await modelInput.inputValue();
  if (!currentModel.includes(modelLabel)) {
    // The mode change itself does not write preferences, but selecting the model below does.
    const modelResponse = page.waitForResponse(
      (response) => response.url().includes("/quickVideo/updateModels") && response.request().method() === "POST",
      { timeout: 15000 },
    );
    await modelInput.click();
    // modelSelect renders grouped listitems whose accessible name is the whole
    // vendor row; the exact model text is the stable user-facing target.
    await page.getByText(modelLabel, { exact: true }).last().click();
    await modelResponse;
  }
  await expect(modelInput).toHaveValue(new RegExp(modelLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), { timeout: 10000 });
}

async function collectBrowserChatFrames(page, sentChats) {
  const frames = await page.evaluate(() => {
    const allFrames = window.__qvSentFrames || [];
    const cursor = window.__qvSentFrameCursor || 0;
    window.__qvSentFrameCursor = allFrames.length;
    return allFrames.slice(cursor);
  });
  for (const frame of frames) {
    const payload = parseSocketChatFrame(frame);
    if (payload) sentChats.push(payload);
  }
}

async function waitForChatFrame(page, sentChats, predicate, message) {
  await expect
    .poll(
      async () => {
        await collectBrowserChatFrames(page, sentChats);
        return sentChats.some(predicate);
      },
      { timeout: 30000, message },
    )
    .toBe(true);
}

async function sendChat(page, text, sentChats) {
  const input = page.locator(".inputBox textarea");
  await expect(input).toBeEnabled({ timeout: 30000 });
  await input.fill(text);
  await input.press("Enter");
  await expect(input).toHaveValue("", { timeout: 10000 });
  await collectBrowserChatFrames(page, sentChats);
}

async function dismissFirstRunGuide(page) {
  // 新登录会话可能会显示全局首次使用引导；它覆盖项目列表并拦截真实点击。
  // 按用户实际操作关闭，不修改 localStorage 或绕过 UI。
  const guide = page.locator(".helloGuide");
  if (await guide.isVisible({ timeout: 1500 }).catch(() => false)) {
    await guide.getByText("跳过引导", { exact: true }).click();
    await expect(guide).toBeHidden({ timeout: 10000 });
  }
}

function parseSocketChatFrame(frame) {
  const raw = typeof frame === "string" ? frame : frame?.payload ?? frame?.payloadData ?? frame?.data;
  if (typeof raw !== "string" || !raw.startsWith("42")) return null;
  try {
    let packet = raw.slice(2);
    // Socket.IO prefixes namespace packets with `/namespace,` before the JSON
    // event tuple. The quick-video namespace is always present in production.
    if (packet.startsWith("/")) {
      const separator = packet.indexOf(",");
      if (separator < 0) return null;
      packet = packet.slice(separator + 1);
    }
    const [event, payload] = JSON.parse(packet);
    return event === "chat" ? payload : null;
  } catch {
    return null;
  }
}

test.beforeAll(async () => {
  apiContext = await playwrightRequest.newContext();
  const login = await api("/login/login", { username: "admin", password: "admin123" });
  authToken = unwrap(login)?.token;
  if (!authToken) throw new Error("admin 登录未返回 token");

  const vendors = unwrap(await api("/setting/vendorConfig/getVendorList")) ?? [];
  const nullVendor = vendors.find((vendor) => vendor.id === "null");
  if (!nullVendor) throw new Error("缺少 null 测试供应商");
  const catalogNames = new Set((nullVendor.catalogModels ?? []).map((model) => model.modelName));
  if (!catalogNames.has("e2e-img") || !catalogNames.has("e2e-vid")) {
    throw new Error("null 测试供应商缺少 e2e-img/e2e-vid 协议，拒绝改用真实计费渠道");
  }

  // 测试期间只临时打开空模板；afterAll 无论断言是否失败都会关闭它。
  await api("/setting/vendorConfig/enableVendor", { id: "null", enable: 1 });
  const imageModels = unwrap(await api("/modelSelect/getModelList", { type: "image" })) ?? [];
  const videoModels = unwrap(await api("/modelSelect/getModelList", { type: "video" })) ?? [];
  if (!imageModels.some((model) => `${model.id}:${model.value}` === IMAGE_MODEL) || !videoModels.some((model) => `${model.id}:${model.value}` === VIDEO_MODEL)) {
    throw new Error("启用 null 后仍未在模型选择器中出现 e2e image/video 模型");
  }
});

test.afterAll(async () => {
  try {
    let targetId = projectId;
    if (!targetId && projectName) {
      const projects = await getProjects();
      targetId = Number(projects.find((project) => project.name === projectName)?.id) || null;
    }
    if (targetId) {
      await api("/project/delProject", { id: targetId }).catch((error) => console.warn(`[SIY-134] 测试项目清理失败: ${error.message}`));
    }
  } finally {
    // 用户明确要求测试结束后关闭 null 供应商，即使它原先已经关闭也再次写入 0。
    if (authToken) await api("/setting/vendorConfig/enableVendor", { id: "null", enable: 0 }).catch(() => undefined);
    await apiContext?.dispose();
  }
});

test("chat media, asset board, first-frame snapshot, video references and reload stay consistent", async ({ page }) => {
  test.setTimeout(300000);
  const pageErrors = [];
  const sentChats = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketFrameSent", ({ response }) => {
    const payload = parseSocketChatFrame(response?.payloadData);
    if (payload) sentChats.push(payload);
  });
  await page.addInitScript(() => {
    // Capture the exact browser-level Socket.IO frames for protocol assertions.
    // This is installed before the UI mounts, so it also works when the client
    // prefers the websocket transport over polling.
    window.__qvSentFrames = [];
    window.__qvSentFrameCursor = 0;
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string" && data.startsWith("42")) window.__qvSentFrames.push(data);
      return originalSend.call(this, data);
    };
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("websocket", (socket) => {
    console.log("[SIY-134] websocket opened", socket.url());
    socket.on("framesent", (frame) => {
      console.log("[SIY-134] websocket frame", JSON.stringify(frame).slice(0, 240));
      const payload = parseSocketChatFrame(frame);
      if (payload) sentChats.push(payload);
    });
  });
  page.on("request", (request) => {
    if (request.method() === "POST" && (request.url().includes("socket") || request.url().includes("10588"))) {
      console.log("[SIY-134] socket request", request.method(), request.url(), request.postData() || "<empty>");
    }
  });

  projectName = `SIY-134 UI媒体闭环-${Date.now()}`;
  await page.goto(`${BASE}/#/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[autocomplete="username"]').fill("admin");
  await page.locator('input[type="password"]').fill("admin123");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL("**/#/project", { timeout: 30000 });
  await dismissFirstRunGuide(page);

  // 真实 UI 创建 15 秒快创项目，保持生产入口与专业模式完全分离。
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByRole("listitem", { name: "单视频快创", exact: true }).click();
  await page.getByPlaceholder("请输入项目名称").fill(projectName);
  await page.getByPlaceholder(/国潮插画风/).fill("国潮插画风");
  await page.getByPlaceholder(/一句话描述你想创作/).fill("15秒奶茶广告：清晨小店亮灯，主角喝下第一口后微笑");
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await page.waitForURL("**/#/quickVideo", { timeout: 30000 });

  await expect.poll(async () => {
    const projects = await getProjects();
    const project = projects.find((item) => item.name === projectName);
    if (project) projectId = Number(project.id);
    return projectId ?? 0;
  }, { timeout: 30000, message: "快创项目没有出现在项目列表" }).toBeGreaterThan(0);
  await expect(page.locator('[data-testid="qv-session-current"]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-testid="qv-asset-board"]')).toBeVisible({ timeout: 15000 });

  // 先走文本聊天生成简报，再通过右侧确认门让 Agent 生成分镜草稿。
  await chooseChatModel(page, "text", "gpt-5.4");
  const briefPrompt = "请为15秒奶茶广告直接保存一份简报：清晨小店亮灯，主角喝下第一口后微笑，结尾号召新品打卡。";
  await sendChat(page, briefPrompt, sentChats);
  console.log("[SIY-134] captured chat frames", JSON.stringify(sentChats));
  console.log(
    "[SIY-134] socket resources",
    await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => name.includes("socket") || name.includes("10588")).slice(-20)),
  );
  await waitForChatFrame(page, sentChats, (payload) => payload.content === briefPrompt && payload.mode === "text" && payload.textModel === TEXT_MODEL, "文本聊天 Socket 帧缺少 textModel/mode");
  await waitForState((state) => Boolean(state.brief) && state.stage === "collect_brief", "文本聊天没有生成简报");

  await page.getByRole("button", { name: "确认简报", exact: true }).click();
  await waitForState((state) => state.stage === "brief_confirmed" && state.brief?.confirmed === true, "简报确认门没有推进状态");

  const storyboardPrompt = "请调用 propose_storyboard，提交3个镜头，每个5秒，总时长15秒，延续已确认的奶茶广告简报。";
  await sendChat(page, storyboardPrompt, sentChats);
  await waitForChatFrame(page, sentChats, (payload) => payload.content === storyboardPrompt && payload.mode === "text", "分镜请求 Socket 帧缺少 text mode");
  const draft = await waitForState((state) => state.stage === "storyboard_draft" && state.storyboard?.status === "draft" && state.storyboard.shots.length > 0, "文本聊天没有生成分镜草稿");
  expect(draft.storyboard.shots.length).toBeGreaterThan(0);

  const boardBeforeImage = await getBoard();
  const previousMediaIds = new Set((boardBeforeImage.items ?? []).map((item) => item.mediaId));

  // 选择图片模型并发送文生图；断言浏览器实际发出的 Socket chat 帧，不只断言 UI 状态。
  await chooseChatModel(page, "image", "E2E图");
  const imagePrompt = "生成一张国潮插画风的奶茶新品首帧：清晨小店门口，暖色灯光，桌上有一杯奶茶，竖构图。";
  await sendChat(page, imagePrompt, sentChats);
  await waitForChatFrame(page, sentChats, (payload) => payload.content === imagePrompt && payload.mode === "image" && payload.imageModel === IMAGE_MODEL && !payload.references, "文生图 Socket 帧缺少 imageModel");

  const imageRef = await waitForNewMedia("image", previousMediaIds, "图片没有完成落库");
  expect(imageRef.kind).toBe("image");
  expect(imageRef.state).toBe("done");
  await expect(page.locator(`[data-testid="qv-chat-media-${imageRef.mediaId}"]`)).toBeVisible({ timeout: 30000 });
  await expect(page.locator(`[data-testid="qv-asset-cell-${imageRef.mediaId}"]`)).toBeVisible({ timeout: 30000 });

  // 聊天卡片与白板都必须暴露同一个稳定 mediaId；复制只写内部剪贴板，随后从分镜表粘贴。
  const chatCard = page.locator(`[data-testid="qv-chat-media-${imageRef.mediaId}"]`);
  await chatCard.getByRole("button", { name: "复制", exact: true }).click();
  const pasteButton = page.locator(".firstFrameCell button", { hasText: "粘贴" }).first();
  await expect(pasteButton).toBeEnabled({ timeout: 10000 });
  const bindResponsePromise = page.waitForResponse(
    (response) => response.url().includes("/quickVideo/bindShotFirstFrame") && response.request().method() === "POST",
    { timeout: 15000 },
  );
  await pasteButton.click();
  const bindResponse = await bindResponsePromise;
  expect(bindResponse.status()).toBe(200);
  console.log("[SIY-134] first-frame bind response", bindResponse.status(), await bindResponse.text());
  const boundDraft = await waitForState(
    (state) => state.stage === "storyboard_draft" && state.storyboard?.shots[0]?.firstFrame?.mediaId === imageRef.mediaId,
    "复制的图片没有绑定到草稿镜头首帧",
    30000,
  );
  expect(boundDraft.storyboard.shots[0].firstFrame.mediaId).toBe(imageRef.mediaId);

  // 再从右侧白板复制同一引用，并发送图生图，验证两种复制入口共用 references 协议。
  await page.locator(`[data-testid="qv-asset-cell-${imageRef.mediaId}"]`).getByTestId("qv-asset-copy").click();
  const imageIdsBeforeSecond = new Set((await getBoard("image")).items.map((item) => item.mediaId));
  const imageToImagePrompt = "基于刚才复制的奶茶首帧，增加一只手端起奶茶，保持同一画风与构图。";
  await sendChat(page, imageToImagePrompt, sentChats);
  await waitForChatFrame(
    page,
    sentChats,
    (payload) => payload.content === imageToImagePrompt && payload.mode === "image" && payload.imageModel === IMAGE_MODEL && Array.isArray(payload.references) && payload.references.includes(imageRef.mediaId),
    "图生图 Socket chat 帧没有携带内部剪贴板 mediaId",
  );
  const imageRef2 = await waitForNewMedia("image", imageIdsBeforeSecond, "图生图没有生成第二张图片");
  expect(imageRef2.mediaId).not.toBe(imageRef.mediaId);
  await expect(page.locator(`[data-testid="qv-chat-media-${imageRef2.mediaId}"]`)).toBeVisible({ timeout: 30000 });

  // 选择视频模型，仍复用原图片的内部引用；聊天生视频使用最短默认片段，不触发真实供应商。
  await chatCard.getByRole("button", { name: "复制", exact: true }).click();
  await chooseChatModel(page, "video", "E2E视频");
  const mediaIdsBeforeVideo = new Set((await getBoard("all")).items.map((item) => item.mediaId));
  const videoPrompt = "请让复制的奶茶首帧中的蒸汽轻轻上升并缓慢推进镜头，生成最短视频片段。";
  await sendChat(page, videoPrompt, sentChats);
  await waitForChatFrame(
    page,
    sentChats,
    (payload) => payload.content === videoPrompt && payload.mode === "video" && payload.videoModel === VIDEO_MODEL && Array.isArray(payload.references) && payload.references.includes(imageRef.mediaId),
    "图生视频 Socket chat 帧没有携带 videoModel/references",
  );
  const videoRef = await waitForNewMedia("video", mediaIdsBeforeVideo, "聊天生视频没有落入同一资产白板");
  expect(videoRef.kind).toBe("video");
  await expect(page.locator(`[data-testid="qv-chat-media-${videoRef.mediaId}"]`)).toBeVisible({ timeout: 30000 });
  await expect(page.locator(`[data-testid="qv-asset-cell-${videoRef.mediaId}"]`)).toBeVisible({ timeout: 30000 });

  // 用户确认分镜后，首帧必须冻结为带 filePath 的 generation.snapshot，而不是继续引用可变草稿。
  const beforeStoryboardConfirm = await getWorkbench();
  console.log("[SIY-134] state before storyboard confirm", JSON.stringify({ stage: beforeStoryboardConfirm.state?.stage, version: beforeStoryboardConfirm.state?.version, firstFrame: beforeStoryboardConfirm.state?.storyboard?.shots?.[0]?.firstFrame }));
  const storyboardConfirmResponsePromise = page.waitForResponse(
    (response) => response.url().includes("/quickVideo/confirmStage") && response.request().method() === "POST",
    { timeout: 15000 },
  );
  await page.getByRole("button", { name: "确认分镜", exact: true }).click();
  const storyboardConfirmResponse = await storyboardConfirmResponsePromise;
  expect(storyboardConfirmResponse.status()).toBe(200);
  console.log("[SIY-134] storyboard confirm response", storyboardConfirmResponse.status(), await storyboardConfirmResponse.text());
  const afterStoryboardConfirm = await getWorkbench();
  console.log("[SIY-134] state after storyboard confirm", JSON.stringify({ stage: afterStoryboardConfirm.state?.stage, version: afterStoryboardConfirm.state?.version, firstFrame: afterStoryboardConfirm.state?.storyboard?.shots?.[0]?.firstFrame, snapshot: afterStoryboardConfirm.state?.generation?.snapshot?.shots?.[0]?.firstFrame }));
  const frozen = await waitForState(
    (state) => state.stage === "storyboard_confirmed" && state.generation.snapshot?.shots?.[0]?.firstFrame?.mediaId === imageRef.mediaId && Boolean(state.generation.snapshot.shots[0].firstFrame.filePath),
    "分镜确认后没有冻结首帧快照",
    30000,
  );
  expect(frozen.generation.snapshot.shots[0].firstFrame.mediaId).toBe(imageRef.mediaId);

  // 走素材/成本确认门并启动镜头生成；空模板模型立即返回固定媒体，避免计费/长视频。
  await page.getByRole("button", { name: "解析素材", exact: true }).click();
  await expect.poll(async () => (await getWorkbench()).state?.generation?.snapshot ? true : false, { timeout: 30000 }).toBe(true);
  await page.getByRole("button", { name: "确认素材并开始生成", exact: true }).click();
  const generated = await waitForState(
    (state) => state.stage === "ready_to_assemble" && state.storyboard?.shots?.length > 0 && state.storyboard.shots.every((shot) => shot.imageState === "done" && shot.videoState === "done"),
    "首帧绑定后的镜头图片/视频生成没有完成",
    120000,
  );
  expect(generated.generation.snapshot.shots[0].firstFrame.mediaId).toBe(imageRef.mediaId);
  expect(generated.storyboard.shots[0].videoRef).toBeTruthy();

  // 刷新后同时验证聊天媒体历史、白板索引和首帧冻结状态仍然可恢复。
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/#\/quickVideo$/, { timeout: 30000 });
  await expect(page.locator(`[data-testid="qv-chat-media-${imageRef.mediaId}"]`)).toBeVisible({ timeout: 30000 });
  await expect(page.locator(`[data-testid="qv-chat-media-${videoRef.mediaId}"]`)).toBeVisible({ timeout: 30000 });
  await expect(page.locator(`[data-testid="qv-asset-cell-${imageRef.mediaId}"]`)).toBeVisible({ timeout: 30000 });
  await expect(page.locator(`[data-testid="qv-asset-cell-${videoRef.mediaId}"]`)).toBeVisible({ timeout: 30000 });
  const restored = await getWorkbench();
  expect(restored.state.generation.snapshot.shots[0].firstFrame.mediaId).toBe(imageRef.mediaId);
  expect(restored.state.stage).toBe("ready_to_assemble");
  expect(pageErrors).toEqual([]);
});
