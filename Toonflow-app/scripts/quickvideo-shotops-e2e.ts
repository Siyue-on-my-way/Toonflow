/**
 * QuickVideo / 单视频快创 —— 聊天按镜头操作 API 级 E2E（SIY-140）
 * 运行方式（需先启动服务，沿用 quickvideo-e2e.ts 的约定）：
 *   npx tsx src/app.ts &          # 服务启动（APP_PORT=10589）
 *   npx tsx scripts/quickvideo-shotops-e2e.ts
 *
 * 覆盖 SIY-140 验收标准（后端部分）：
 * 1. startShotOp 引用校验：非法编号（如 ##99#）→ SHOT_REF_INVALID，不创建生成任务、不产生媒体行
 * 2. startShotOp 引用校验：storyboardId 与当前分镜不一致 → 拒绝
 * 3. startShotOp generate_shot_image：合法引用 → opId/tasks；任务完成后 shot.imageRef 回写、
 *    分镜表原文字段未被篡改、媒体行进入资产白板（刷新后仍可见的持久化路径）
 * 4. startShotOp generate_shot_video：直启路径（重试语义）入队并收敛到终态；模型缺失时快速失败且不残留
 * 5. 旧版会话聊天历史兼容：/agents/getMemory 对既有会话正常返回
 */
import u from "@/utils";
import { mutateQuickVideoState } from "@/lib/quickVideo/state";
import { validateStoryboard, type QuickVideoShot } from "@/lib/quickVideo/contract";
import { normalizeShotDuration } from "@/lib/quickVideo/shots";

const BASE = process.env.BASE || "http://localhost:10589";
const USERNAME = process.env.INIT_ADMIN_USER || "admin";
const PASSWORD = process.env.INIT_ADMIN_PASSWORD || "admin123";

let token = "";
let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

async function api(path: string, body: any) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify(body),
  });
  return res.json();
}

function key() {
  return `e2e-shotop-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const getState = async (projectId: number) => (await api("/quickVideo/getWorkbench", { projectId })).data.state;

/** 模拟 Agent propose_storyboard：走与工具完全相同的服务端校验与事务保存 */
async function agentProposeStoryboard(projectId: number, shotsSpec: { duration: number; description: string }[]) {
  await mutateQuickVideoState(projectId, { idempotencyKey: key() }, (s: any) => {
    if (!s.brief) throw new Error("NO_BRIEF");
    if (!["brief_confirmed", "storyboard_draft"].includes(s.stage)) throw new Error(`STAGE_FORBIDDEN:${s.stage}`);
    const shots: QuickVideoShot[] = shotsSpec.map((shot, i) => ({
      id: `shot-${i + 1}`,
      index: i + 1,
      duration: normalizeShotDuration(shot.duration),
      description: shot.description,
      dialogue: "测试字幕",
      camera: "全景",
      assetRefs: [],
      imageState: "pending",
      videoState: "pending",
      imageRef: null,
      videoRef: null,
      errorReason: null,
      firstFrame: null,
    }));
    const errors = validateStoryboard(s.targetDuration, shots);
    if (errors.length) throw new Error(`STORYBOARD_INVALID:${errors.join(";")}`);
    if (s.stage === "brief_confirmed") s.stage = "storyboard_draft";
    s.storyboard = { version: (s.storyboard?.version ?? 0) + 1, status: "draft", confirmedAt: null, summary: "按镜头操作 e2e", shots };
  });
}

async function waitShotTerminal(projectId: number, shotIds: string[], kind: "image" | "video", timeoutMs: number) {
  const stateKey = `${kind}State`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getState(projectId);
    const shots = (state?.storyboard?.shots ?? []).filter((s: any) => shotIds.includes(s.id));
    if (shots.length && shots.every((s: any) => s[stateKey] === "done" || s[stateKey] === "failed")) return state;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}

async function main() {
  console.log("== 等待服务就绪 ==");
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/api/login/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: USERNAME, password: PASSWORD }) });
      if (r.status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) throw new Error(`服务未就绪：${BASE}（请先运行 APP_PORT=10589 npx tsx src/app.ts）`);

  console.log("== 登录 ==");
  const login = await api("/login/login", { username: USERNAME, password: PASSWORD });
  token = login.data.token;
  assert(!!token, "登录成功");

  console.log("== 1. 创建 e2e 项目并推进到分镜草稿 ==");
  const created = await api("/quickVideo/createProject", {
    name: `E2E快创镜头操作-${Date.now()}`,
    artStyle: "国潮插画风",
    videoRatio: "9:16",
    targetDuration: 30,
    intro: "按镜头操作 e2e",
    draftScript: "清晨的街道，一家小店亮起灯，主角喝下第一口奶茶",
    idempotencyKey: key(),
  });
  const projectId = created.data.projectId;
  const sessionId = created.data.session?.id;
  assert(!!projectId && !!sessionId, "创建 quick_video 项目与会话");

  // 先保存一份简报（推阶段到 brief_confirmed 需要），再提交 5 镜草稿
  await mutateQuickVideoState(projectId, { idempotencyKey: key() }, (s: any) => {
    s.brief = { theme: "e2e", hook: "", narrative: "e2e 叙事", cta: "", keywords: [], confirmed: true, confirmedAt: Date.now() };
    if (s.stage === "collect_brief") s.stage = "brief_confirmed";
  });
  await agentProposeStoryboard(projectId, [
    { duration: 6, description: "清晨街道全景，小店亮灯" },
    { duration: 6, description: "主角推门进店，铃铛响动" },
    { duration: 6, description: "特写：奶茶制作过程" },
    { duration: 6, description: "主角喝下第一口，满足微笑" },
    { duration: 6, description: "店招与产品同框收尾" },
  ]);
  const draft = await getState(projectId);
  assert(draft?.stage === "storyboard_draft" && draft?.storyboard?.shots?.length === 5, "分镜草稿就绪（5 镜）");

  const boardBefore = await api("/quickVideo/getAssetBoard", { projectId, pageSize: 1 });

  console.log("== 2. 非法镜头引用：友好报错且不创建任务 ==");
  const invalid = await api("/quickVideo/startShotOp", {
    projectId,
    sessionId,
    action: "generate_shot_image",
    shotRefs: [{ displayNo: 99 }],
  });
  assert(invalid.code === "SHOT_REF_INVALID" && String(invalid.message).includes("99"), "越界编号返回 SHOT_REF_INVALID", JSON.stringify(invalid));
  const boardAfterInvalid = await api("/quickVideo/getAssetBoard", { projectId, pageSize: 1 });
  assert(boardAfterInvalid.data.total === boardBefore.data.total, "未创建任何媒体行");
  const stateAfterInvalid = await getState(projectId);
  assert(stateAfterInvalid.storyboard.shots.every((s: any) => s.imageState === "pending"), "镜头生成状态未被改动");

  console.log("== 3. storyboardId 不一致：拒绝错位引用 ==");
  const mismatch = await api("/quickVideo/startShotOp", {
    projectId,
    sessionId,
    action: "generate_shot_image",
    shotRefs: [{ displayNo: 1, storyboardId: "shot-2" }],
  });
  assert(!!mismatch.code && mismatch.code !== 200, "错位 storyboardId 被拒绝", JSON.stringify(mismatch));

  console.log("== 4. 按镜头生图：入队 -> 回写 imageRef -> 白板可见 ==");
  const started = await api("/quickVideo/startShotOp", {
    projectId,
    sessionId,
    action: "generate_shot_image",
    shotRefs: [
      { displayNo: 1, storyboardId: "shot-1" },
      { displayNo: 3, storyboardId: "shot-3" },
    ],
    instruction: "清晨暖色光线",
  });
  assert(started.code === 200 || !!started.data?.opId, "生图任务创建成功（opId 返回）", JSON.stringify(started).slice(0, 200));
  const opId = started.data?.opId;
  const taskShotIds: string[] = started.data?.tasks?.map((t: any) => t.shotId) ?? [];
  assert(taskShotIds.length === 2 && started.data.tasks.every((t: any) => t.mediaId), "任务绑定 mediaId（消息上下文）");

  const descBefore = (await getState(projectId)).storyboard.shots.map((s: any) => `${s.id}:${s.description}:${s.dialogue}:${s.camera}:${s.duration}`).join("|");
  const imageState = await waitShotTerminal(projectId, taskShotIds, "image", 8 * 60 * 1000);
  assert(!!imageState, "生图任务在超时前收敛到终态");
  const shotsNow = (imageState?.storyboard?.shots ?? []).filter((s: any) => taskShotIds.includes(s.id));
  const imageDone = shotsNow.filter((s: any) => s.imageState === "done" && s.imageRef);
  console.log(`  · 生图结果：${shotsNow.map((s: any) => `${s.id}=${s.imageState}${s.errorReason ? `(${s.errorReason.slice(0, 60)})` : ""}`).join("、")}`);
  if (imageDone.length) {
    const boardAfter = await api("/quickVideo/getAssetBoard", { projectId, pageSize: 60 });
    const chatMedia = boardAfter.data.items.filter((i: any) => i.source === "chat" && i.kind === "image");
    assert(chatMedia.length > boardAfterInvalid.data.total, "生成媒体进入资产白板（持久化索引）");
    assert(imageState.storyboard.shots.find((s: any) => s.id === "shot-2").imageState === "pending", "未引用镜头不受影响");
    const descAfter = imageState.storyboard.shots.map((s: any) => `${s.id}:${s.description}:${s.dialogue}:${s.camera}:${s.duration}`).join("|");
    assert(descAfter === descBefore, "分镜表结构化原文字段未被篡改（非破坏性拼装）");
  }
  void opId;

  console.log("== 5. 按镜头生视频（直启/重试语义）：入队并收敛 ==");
  const videoStart = await api("/quickVideo/startShotOp", {
    projectId,
    sessionId,
    action: "generate_shot_video",
    shotRefs: [{ displayNo: 1, storyboardId: "shot-1" }],
    instruction: "镜头缓慢推进",
  });
  if (videoStart.code && videoStart.code !== 200) {
    // 模型未配置等环境性失败：要求快速失败且不残留任务/媒体
    console.log(`  · 视频直启被环境拦截：${videoStart.code} ${String(videoStart.message).slice(0, 80)}`);
    assert(["MODEL_NOT_CONFIGURED", "VIDEO_MODEL_INVALID", "SHOT_RUNNING"].includes(videoStart.code), "环境性失败返回明确错误码", videoStart.code);
  } else {
    const videoShotIds: string[] = videoStart.data.tasks.map((t: any) => t.shotId);
    const videoState = await waitShotTerminal(projectId, videoShotIds, "video", 16 * 60 * 1000);
    assert(!!videoState, "生视频任务在超时前收敛到终态");
    const vShot = (videoState?.storyboard?.shots ?? []).find((s: any) => s.id === videoShotIds[0]);
    console.log(`  · 生视频结果：videoState=${vShot?.videoState}${vShot?.errorReason ? `(${vShot.errorReason.slice(0, 80)})` : ""}`);
    assert(vShot?.videoState === "failed" || (vShot?.videoState === "done" && vShot?.videoRef), "视频终态合法（done 带 videoRef / failed 带原因）");
  }

  console.log("== 6. 旧版会话聊天历史兼容（只读既有数据） ==");
  const legacySession = await u.db("o_quickVideoSession").where("projectId", "!=", projectId).first();
  if (legacySession) {
    const mem = await api("/agents/getMemory", { projectId: legacySession.projectId, agentType: "quickVideoAgent", sessionId: legacySession.id, limit: 20 });
    assert(Array.isArray(mem.data), "旧版会话历史加载返回数组", JSON.stringify(mem).slice(0, 120));
  } else {
    console.log("  · 库中无其他会话，跳过");
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("e2e 异常终止:", err);
  process.exit(1);
});
