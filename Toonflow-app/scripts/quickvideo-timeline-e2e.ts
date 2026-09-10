/**
 * QuickVideo / 单视频快创 —— 时间线装配 / 导出 / 指标 API 级 E2E（SIY-111）
 * 运行方式（需先启动服务）：
 *   npx tsx src/app.ts &          # SQLite 模式启动服务（10588）
 *   npx tsx scripts/quickvideo-timeline-e2e.ts
 *
 * 覆盖 SIY-111 验收标准（浏览器端 WebAV 编码本身无法在 Node E2E 中执行，
 * 此处验证服务端装配规划、导出确认门、指标与回归约束；前端编码由组件/单测与构建验证）：
 * 1. getTimeline：阶段门、镜头顺序、目标时长贴合、字幕/转场/尺寸、幂等（重复调用版本有界）
 * 2. o_videoTrack 落库：每镜头一行、复用专业模式轨道表结构
 * 3. 导出确认门（第三道门）：exportInfo 回写、completed 幂等重确认、未就绪拒绝
 * 4. 指标与结构化观测：getMetrics 计数/失败率/装配耗时
 * 5. 回归：专业项目隔离、getMediaUrls 正常、既有阶段门不回归
 */
import u from "@/utils";
import { mutateQuickVideoState } from "@/lib/quickVideo/state";
import { validateStoryboard, type QuickVideoShot } from "@/lib/quickVideo/contract";
import { normalizeShotDuration } from "@/lib/quickVideo/shots";

const BASE = process.env.BASE || "http://localhost:10588";

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
  return `e2e-tl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const getState = (projectId: number) => api("/quickVideo/getWorkbench", { projectId }).then((r) => r.data.state);

/** 模拟 Agent propose_storyboard（与服务端工具同一校验层） */
function agentProposeStoryboard(projectId: number, shotsSpec: { duration: number; description: string; dialogue?: string }[]) {
  return mutateQuickVideoState(projectId, { idempotencyKey: key() }, (s: any) => {
    if (!s.brief) throw new Error("NO_BRIEF");
    if (!["brief_confirmed", "storyboard_draft"].includes(s.stage)) throw new Error(`STAGE_FORBIDDEN:${s.stage}`);
    if (s.storyboard?.status === "confirmed") throw new Error("STORYBOARD_LOCKED");
    const shots: QuickVideoShot[] = shotsSpec.map((shot, i) => ({
      id: `shot-${i + 1}`,
      index: i + 1,
      duration: normalizeShotDuration(shot.duration),
      description: shot.description,
      dialogue: shot.dialogue ?? "",
      camera: "全景",
      assetRefs: [],
      imageState: "pending",
      videoState: "pending",
      imageRef: null,
      videoRef: null,
      errorReason: null,
      imageErrorReason: null,
      videoErrorReason: null,
    }));
    const errors = validateStoryboard(s.targetDuration, shots);
    if (errors.length) throw new Error(`STORYBOARD_INVALID:${errors.join(";")}`);
    if (s.stage === "brief_confirmed") s.stage = "storyboard_draft";
    s.storyboard = { version: (s.storyboard?.version ?? 0) + 1, status: "draft", confirmedAt: null, summary: "装配 E2E 三镜", shots };
  });
}

async function waitFor(desc: string, fn: () => Promise<boolean>, timeoutMs = 60000, intervalMs = 800) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时：${desc}`);
}

/** e2e 进程直写 SQLite（服务端持有另一连接；极小概率 busy，重试即可） */
async function dbWrite(desc: string, fn: () => Promise<any>) {
  let lastErr: any;
  for (let i = 0; i < 6; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (!String(err?.message ?? err).match(/locked|busy/i)) throw err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw lastErr;
}

async function main() {
  console.log("== 等待服务就绪 ==");
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/api/login/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) });
      if (r.status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) throw new Error(`服务未就绪：${BASE}（请先运行 npx tsx src/app.ts）`);

  console.log("== 登录 ==");
  const login = await api("/login/login", { username: "admin", password: "admin123" });
  token = login.data.token;
  assert(!!token, "admin 登录成功");

  console.log("== 1. 创建 30 秒三镜项目并驱动到 ready_to_assemble ==");
  const created = await api("/quickVideo/createProject", {
    name: `E2E装配-${Date.now()}`,
    artStyle: "国潮插画风",
    videoRatio: "16:9",
    targetDuration: 30,
    intro: "装配导出 E2E",
    draftScript: "清晨的街道，一家小店亮起灯",
    idempotencyKey: key(),
  });
  const projectId = created.data.projectId;
  assert(!!projectId, "创建 quick_video 项目成功", JSON.stringify(created).slice(0, 200));

  await api("/quickVideo/updateBrief", {
    projectId,
    expectedVersion: 1,
    idempotencyKey: key(),
    brief: { theme: "奶茶新品", hook: "第一口停不下来", narrative: "清晨小店亮灯，主角喝下第一口奶茶", cta: "新品上市，快来打卡", keywords: [] },
  });
  await api("/quickVideo/confirmStage", { projectId, expectedVersion: (await getState(projectId)).version, idempotencyKey: key(), gate: "brief", action: "confirm" });
  await agentProposeStoryboard(projectId, [
    { duration: 10, description: "清晨小店亮灯远景", dialogue: "清晨的第一杯奶茶" },
    { duration: 10, description: "主角接过奶茶特写" },
    { duration: 10, description: "喝下第一口，世界变明亮", dialogue: "治愈从这一口开始" },
  ]);
  const confirmSb = await api("/quickVideo/confirmStage", { projectId, expectedVersion: (await getState(projectId)).version, idempotencyKey: key(), gate: "storyboard", action: "confirm" });
  assert(confirmSb.code === 200 && confirmSb.data.state.stage === "storyboard_confirmed", "分镜确认成功");
  // 先禁用「空模板」供应商（此前运行可能残留），确保素材确认后进入「无模型 → 整批失败」分支
  await dbWrite("禁用空模板供应商", async () => {
    await u.db("o_vendorConfig").where("id", "null").update({ enable: 0, enabledModels: JSON.stringify([]) });
  });
  const confirmMat = await api("/quickVideo/confirmStage", { projectId, expectedVersion: (await getState(projectId)).version, idempotencyKey: key(), gate: "materials", action: "confirm" });
  assert(confirmMat.code === 200 && confirmMat.data.state.stage === "generating", "素材确认 → generating");
  await waitFor("无模型时全部镜头失败", async () => {
    const st = await getState(projectId);
    return st.storyboard.shots.every((s: any) => s.imageState === "failed" && s.videoState === "failed");
  }, 60000);

  // 配置「空模板」供应商（产物为空文件，链路真实；装配只依赖引用不解析媒体）
  await dbWrite("造空模板供应商", async () => {
    const row = {
      id: "null",
      inputValues: JSON.stringify({ apiKey: "e2e", baseUrl: "https://e2e.local" }),
      models: JSON.stringify([
        { name: "E2E图", modelName: "e2e-img", type: "image", mode: ["text", "singleImage", "multiReference"] },
        { name: "E2E视频", modelName: "e2e-vid", type: "video", mode: ["singleImage", "text"], audio: false, durationResolutionMap: [{ duration: [5, 10, 15], resolution: ["720p"] }] },
      ]),
      enable: 1,
      enabledModels: JSON.stringify(["e2e-img", "e2e-vid"]),
    };
    const existing = await u.db("o_vendorConfig").where("id", "null").first();
    if (existing) await u.db("o_vendorConfig").where("id", "null").update(row);
    else await u.db("o_vendorConfig").insert(row);
    // row.enable = 1（恢复启用，后续运行复用）
    await u.db("o_project").where("id", projectId).update({ imageModel: "null:e2e-img", videoModel: "null:e2e-vid" });
  });
  await api("/quickVideo/retryShot", { projectId, shotIds: ["shot-1", "shot-2", "shot-3"] });
  await waitFor("全部镜头完成并推进 ready_to_assemble", async () => (await getState(projectId)).stage === "ready_to_assemble", 120000);
  assert((await getState(projectId)).stage === "ready_to_assemble", "驱动至 ready_to_assemble");

  console.log("== 2. getTimeline：阶段门与装配规划 ==");
  const notReady = await api("/quickVideo/getTimeline", { projectId: projectId + 999999 });
  assert(notReady.data === null && String(notReady.message).includes("项目不存在"), "不存在的项目返回空", JSON.stringify(notReady).slice(0, 120));

  const tl = await api("/quickVideo/getTimeline", { projectId });
  const plan = tl.data?.timeline;
  assert(tl.code === 200 && !!plan, "getTimeline 返回装配规划", JSON.stringify(tl).slice(0, 300));
  assert(plan.clips.length === 3 && plan.clips.every((c: any) => c.shotId === `shot-${c.index}`), "按镜头顺序 3 个片段");
  assert(Math.abs(plan.totalDuration - 30) < 1e-3, "总时长贴合目标 30s", String(plan.totalDuration));
  assert(plan.targetDuration === 30 && plan.videoRatio === "16:9" && plan.width === 1280 && plan.height === 720, "携带目标/比例/分辨率");
  assert(plan.transitions.length === 2 && plan.transitions.every((t: any) => t.type === "crossfade"), "相邻镜头 2 处 crossfade");
  const rates = plan.clips.map((c: any) => c.playbackRate);
  assert(rates.every((r: number) => r >= 0.75 && r <= 1.5), "变速在 0.75-1.5 合理区间", JSON.stringify(rates));
  assert(tl.data.ctaText === "新品上市，快来打卡", "返回片尾 CTA 文案", JSON.stringify(tl.data.ctaText));
  const cues = tl.data.subtitles ?? [];
  assert(cues.length === 2 && cues.some((c: any) => c.text === "清晨的第一杯奶茶") && cues.some((c: any) => c.text === "治愈从这一口开始"), "字幕时间轴含两条台词");
  assert(Object.keys(tl.data.media ?? {}).length === 3 && Object.values(tl.data.media ?? {}).every((m: any) => m.videoUrl), "三镜头视频访问地址已签名");

  const st1 = await getState(projectId);
  assert(st1.generation.timeline?.storyboardVersion === st1.storyboard.version && st1.generation.timeline.clipCount === 3, "装配元数据落库（版本/片段数）");
  assert(st1.generation.exportInfo === null, "未导出前 exportInfo 为空");

  console.log("== 3. 幂等：重复装配不重复写状态/轨道 ==");
  const versionBefore = st1.version;
  const tracksBefore = await dbWrite("查轨道行数", () => u.db("o_videoTrack").where("projectId", projectId).count("id as c").first());
  const tlAgain = await api("/quickVideo/getTimeline", { projectId });
  assert(tlAgain.code === 200 && Math.abs(tlAgain.data.timeline.totalDuration - plan.totalDuration) < 1e-9, "重复装配规划逐字一致");
  const st2 = await getState(projectId);
  const tracksAfter = await dbWrite("再查轨道行数", () => u.db("o_videoTrack").where("projectId", projectId).count("id as c").first());
  assert(st2.version === versionBefore, "同版本重复装配不写状态（版本有界）", `${versionBefore} -> ${st2.version}`);
  assert(Number(tracksBefore.c) === Number(tracksAfter.c), "重复装配不重复写轨道行", `${tracksBefore.c} -> ${tracksAfter.c}`);

  console.log("== 4. o_videoTrack 落库结构（复用专业模式轨道表） ==");
  const trackRows = await dbWrite("查轨道行", () => u.db("o_videoTrack").where("projectId", projectId).select("*").orderBy("id"));
  assert(trackRows.length === 3, "每镜头 1 行轨道（共 3 行）", String(trackRows.length));
  assert(trackRows.every((r: any) => r.state === "已完成" && r.duration === 10 && !!r.prompt), "轨道行状态/时长/描述与镜头一致");
  const scriptRow = await dbWrite("查脚本", () => u.db("o_script").where("projectId", projectId).select("id").first());
  assert(scriptRow && trackRows.every((r: any) => Number(r.scriptId) === Number(scriptRow.id)), "轨道行挂快创项目草稿脚本");

  console.log("== 5. 第三道确认门：导出确认与 exportInfo 回写 ==");
  const draftExport = await api("/quickVideo/confirmStage", { projectId: projectId, expectedVersion: st2.version, idempotencyKey: key(), gate: "export", action: "reject" });
  assert(draftExport.code === "FORBIDDEN", "导出门不支持撤销", JSON.stringify(draftExport));
  const exportBad = await api("/quickVideo/confirmStage", { projectId, expectedVersion: st2.version + 100, idempotencyKey: key(), gate: "export", action: "confirm" });
  assert(exportBad.code === "VERSION_CONFLICT", "过期版本导出确认被拒（乐观锁）", JSON.stringify(exportBad));
  const exportOk = await api("/quickVideo/confirmStage", {
    projectId,
    expectedVersion: st2.version,
    idempotencyKey: key(),
    gate: "export",
    action: "confirm",
    exportInfo: { fileName: "quick-video-e2e.mp4", sizeBytes: 12345678, durationSeconds: 30 },
  });
  assert(exportOk.code === 200 && exportOk.data.state.stage === "completed", "导出确认 → completed", JSON.stringify(exportOk).slice(0, 200));
  assert(exportOk.data.state.generation.exportInfo?.fileName === "quick-video-e2e.mp4" && exportOk.data.state.generation.exportInfo?.sizeBytes === 12345678 && exportOk.data.state.generation.exportInfo?.exportedAt > 0, "导出结果（文件名/大小/时间）回写状态");

  const completedState = await getState(projectId);
  const reExport = await api("/quickVideo/confirmStage", {
    projectId,
    expectedVersion: completedState.version,
    idempotencyKey: key(),
    gate: "export",
    action: "confirm",
    exportInfo: { fileName: "quick-video-e2e-2.mp4", sizeBytes: 22345678, durationSeconds: 30 },
  });
  assert(reExport.code === 200 && reExport.data.state.stage === "completed" && reExport.data.state.generation.exportInfo?.fileName === "quick-video-e2e-2.mp4", "completed 阶段可幂等重确认并更新导出结果");
  const reExportTl = await api("/quickVideo/getTimeline", { projectId });
  assert(reExportTl.code === 200 && reExportTl.data.exportInfo?.fileName === "quick-video-e2e-2.mp4", "completed 阶段 getTimeline 正常并返回导出结果");

  console.log("== 6. 指标与结构化观测 ==");
  const metrics = await api("/quickVideo/getMetrics", {});
  assert(metrics.code === 200 && !!metrics.data?.counters, "getMetrics 返回指标快照", JSON.stringify(metrics).slice(0, 200));
  assert((metrics.data.counters.timelineAssembled ?? 0) >= 1, "装配次数已累计");
  assert((metrics.data.counters.generationShotDone ?? 0) >= 3, "镜头成功计数 ≥3", JSON.stringify(metrics.data.counters));
  assert((metrics.data.counters.exportConfirmed ?? 0) >= 2, "导出确认计数 ≥2（首次+重确认）");
  assert((metrics.data.counters.shotRetry ?? 0) >= 1, "镜头重试计数 ≥1");
  assert(metrics.data.derived && metrics.data.derived.generationShotTotal >= 3, "镜头生成总数可派生");
  assert(metrics.data.durations?.timelineAssembleMs?.count >= 1 && metrics.data.durations.timelineAssembleMs.avgMs >= 0, "装配耗时指标已记录", JSON.stringify(metrics.data.durations));

  console.log("== 7. 回归：专业项目隔离与既有链路 ==");
  const pro = await api("/project/addProject", {
    projectType: "novel",
    name: `E2E装配专业-${Date.now()}`,
    intro: "e2e",
    type: "玄幻",
    artStyle: "x",
    directorManual: "x",
    videoRatio: "16:9",
    imageModel: "1:img",
    videoModel: "1:vid",
    imageQuality: "1K",
    mode: "text",
  });
  assert(pro.code === 200, "专业模式 addProject 正常", JSON.stringify(pro).slice(0, 200));
  const proProject = await dbWrite("查专业项目", () => u.db("o_project").where("name", "like", "E2E装配专业-%").orderBy("id", "desc").first());
  const proTl = await api("/quickVideo/getTimeline", { projectId: Number(proProject.id) });
  assert(proTl.data === null && String(proTl.message).includes("非单视频快创"), "专业项目访问快创时间线被拒", JSON.stringify(proTl).slice(0, 120));
  const media = await api("/quickVideo/getMediaUrls", { projectId });
  assert(media.code === 200 && Object.keys(media.data?.media ?? {}).length === 3, "getMediaUrls 既有接口不回归");

  // 清理 e2e 写入共享 MinIO 的测试对象（best-effort，不阻塞结果）
  try {
    await u.oss.deleteDirectory(`/${projectId}/quickVideo`);
    console.log("已清理 e2e 测试对象");
  } catch {}

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("E2E 异常终止:", err);
  process.exit(1);
});
