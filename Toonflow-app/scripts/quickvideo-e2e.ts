/**
 * QuickVideo / 单视频快创 —— API 级 E2E 测试
 * 运行方式（需先启动服务）：
 *   npx tsx src/app.ts &          # SQLite 模式启动服务（10588）
 *   npx tsx scripts/quickvideo-e2e.ts
 *
 * 覆盖 SIY-108 验收标准：
 * 1. 创建 quick_video 项目 + 专业模式创建不受影响
 * 2. 工作台聚合 API 返回项目基础信息 / Agent 状态 / 简报 / 分镜
 * 3. 状态机与白名单：乐观锁、阶段门、契约校验、幂等键
 *    （Agent 工具与用户编辑接口走同一校验层 mutateQuickVideoState，
 *      这里用该层模拟 propose_storyboard / update_shot 的服务端写入路径）
 */
import u from "@/utils";
import { mutateQuickVideoState } from "@/lib/quickVideo/state";
import { validateStoryboard, type QuickVideoShot } from "@/lib/quickVideo/contract";
import { normalizeShotDuration } from "@/lib/quickVideo/shots";
import { bumpUserMessageCountAndMaybeClaimTitle } from "@/lib/quickVideo/session";
import { generateSessionTitle } from "@/lib/quickVideo/title";

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
  return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const getState = (projectId: number) => api("/quickVideo/getWorkbench", { projectId }).then((r) => r.data.state);

/** 模拟 Agent propose_storyboard：走与工具完全相同的服务端校验与事务保存 */
function agentProposeStoryboard(projectId: number, shotsSpec: { duration: number; description: string }[], summary = "e2e 模拟提交") {
  return mutateQuickVideoState(projectId, { idempotencyKey: key() }, (s: any) => {
    if (!s.brief) throw new Error("NO_BRIEF");
    if (!["brief_confirmed", "storyboard_draft"].includes(s.stage)) throw new Error(`STAGE_FORBIDDEN:${s.stage}`);
    if (s.storyboard?.status === "confirmed") throw new Error("STORYBOARD_LOCKED");
    const shots: QuickVideoShot[] = shotsSpec.map((shot, i) => ({
      id: `shot-${i + 1}`,
      index: i + 1,
      duration: normalizeShotDuration(shot.duration),
      description: shot.description,
      dialogue: "",
      camera: "全景",
      assetRefs: [],
      imageState: "pending",
      videoState: "pending",
      imageRef: null,
      videoRef: null,
      errorReason: null,
      firstFrame: null,
    }));
    // 与 propose_storyboard 工具一致：先跑契约校验
    const errors = validateStoryboard(s.targetDuration, shots);
    if (errors.length) throw new Error(`STORYBOARD_INVALID:${errors.join(";")}`);
    if (s.stage === "brief_confirmed") s.stage = "storyboard_draft";
    s.storyboard = { version: (s.storyboard?.version ?? 0) + 1, status: "draft", confirmedAt: null, summary, shots };
  });
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

  // 环境隔离：历史运行可能在库里启用了「空模板」供应商，会让第 10 节「无模型 → 统一失败」失真。
  // 这里先禁用，第 11 节再按需启用（与脚本自身流程一致，可重复运行）。
  await dbWrite("禁用空模板供应商", async () => {
    const existing = await u.db("o_vendorConfig").where("id", "null").first();
    if (existing) await u.db("o_vendorConfig").where("id", "null").update({ enable: 0, enabledModels: JSON.stringify([]) });
  });

  console.log("== 1. 创建 quick_video 项目（含幂等） ==");
  const createKey = key();
  const created = await api("/quickVideo/createProject", {
    name: `E2E快创-${Date.now()}`,
    artStyle: "国潮插画风",
    videoRatio: "9:16",
    targetDuration: 30,
    intro: "一支 30 秒的奶茶新品宣传视频",
    draftScript: "清晨的街道，一家小店亮起灯，主角喝下第一口奶茶",
    idempotencyKey: createKey,
  });
  const projectId = created.data.projectId;
  const sessionId = created.data.session?.id;
  assert(!!projectId, "创建 quick_video 项目成功", JSON.stringify(created).slice(0, 200));
  assert(!!sessionId, "创建项目时同步创建默认会话", JSON.stringify(created.data.session));
  assert(created.data.state?.stage === "collect_brief", "初始阶段为 collect_brief");
  assert(created.data.state?.version === 1, "初始状态版本为 1");
  assert(created.data.existed === false, "首次创建 existed=false");

  const duplicated = await api("/quickVideo/createProject", {
    name: `E2E快创-重复`,
    artStyle: "国潮插画风",
    videoRatio: "9:16",
    targetDuration: 30,
    idempotencyKey: createKey,
  });
  assert(duplicated.data.existed === true && duplicated.data.projectId === projectId, "同幂等键重复创建返回原项目");

  console.log("== 2. 专业模式创建不受影响 ==");
  const pro = await api("/project/addProject", {
    projectType: "novel",
    name: `E2E专业-${Date.now()}`,
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
  const proProjectId = await u.db("o_project").where("name", "like", `E2E专业-%`).orderBy("id", "desc").first();

  console.log("== 3. 工作台聚合查询 ==");
  const wb1 = await api("/quickVideo/getWorkbench", { projectId });
  assert(wb1.data.project?.id === projectId, "聚合返回项目基础信息");
  assert(wb1.data.script?.content?.includes("清晨的街道"), "聚合返回草稿脚本");
  assert(wb1.data.state?.targetDuration === 30, "聚合返回 Agent 状态（目标时长）");
  assert(wb1.data.shotBounds?.min === 2 && wb1.data.shotBounds?.max === 6, "30 秒目标推导镜头区间 2-6");

  console.log("== 4. 乐观锁与白名单 ==");
  const v0 = await getState(projectId);
  const stale = await api("/quickVideo/updateBrief", {
    projectId,
    expectedVersion: v0.version + 100,
    idempotencyKey: key(),
    brief: { theme: "t", hook: "", narrative: "n", cta: "", keywords: [] },
  });
  assert(stale.code === "VERSION_CONFLICT", "过期版本写入被拒绝（乐观锁）", JSON.stringify(stale));

  const noSb = await api("/quickVideo/confirmStage", { projectId, sessionId, expectedVersion: v0.version, idempotencyKey: key(), gate: "storyboard", action: "confirm" });
  assert(noSb.code === "NO_STORYBOARD", "无分镜时确认分镜被拒", JSON.stringify(noSb));

  const editNoSb = await api("/quickVideo/addShot", {
    projectId,
    expectedVersion: v0.version,
    idempotencyKey: key(),
    shot: { duration: 5, description: "d" },
  });
  assert(editNoSb.code === "NO_STORYBOARD", "无分镜时新增镜头被拒", JSON.stringify(editNoSb));

  console.log("== 5. 简报写入、幂等与确认门 ==");
  const v1 = await getState(projectId);
  const brief = await api("/quickVideo/updateBrief", {
    projectId,
    expectedVersion: v1.version,
    idempotencyKey: key(),
    brief: {
      theme: "奶茶新品 30 秒宣传",
      hook: "第一口停不下来",
      narrative: "清晨小店亮灯，主角路过被香气吸引，喝下第一口后整个世界变明亮，最后举起新品比心",
      cta: "新品上市，快来打卡",
      keywords: ["清新", "治愈"],
    },
  });
  assert(brief.code === 200 && brief.data.state.brief.theme.includes("奶茶"), "简报保存成功", JSON.stringify(brief).slice(0, 200));

  const briefVersion = brief.data.state.version;
  const briefAgain = await api("/quickVideo/updateBrief", {
    projectId,
    expectedVersion: briefVersion,
    idempotencyKey: "dup-brief-key-12345678",
    brief: { theme: "重复提交", hook: "", narrative: "重复内容", cta: "", keywords: [] },
  });
  assert(briefAgain.code === 200 && briefAgain.data.idempotentHit === false, "首次携带新幂等键正常生效");
  const briefThird = await api("/quickVideo/updateBrief", {
    projectId,
    expectedVersion: briefAgain.data.state.version,
    idempotencyKey: "dup-brief-key-12345678",
    brief: { theme: "第二次重复", hook: "", narrative: "内容B", cta: "", keywords: [] },
  });
  assert(briefThird.data.idempotentHit === true && briefThird.data.state.brief.theme === briefAgain.data.state.brief.theme, "同幂等键重复提交被去重且保持首次结果");

  const confirmBrief = await api("/quickVideo/confirmStage", { projectId, sessionId, expectedVersion: briefThird.data.state.version, idempotencyKey: key(), gate: "brief", action: "confirm" });
  assert(confirmBrief.code === 200 && confirmBrief.data.state.stage === "brief_confirmed", "确认简报 -> brief_confirmed", JSON.stringify(confirmBrief).slice(0, 200));

  console.log("== 6. Agent 工具层：propose_storyboard 校验 ==");
  // 6.1 简报确认前（collect_brief）不允许提交分镜
  const pro2 = await api("/quickVideo/createProject", { name: `E2E快创门禁-${Date.now()}`, artStyle: "s", videoRatio: "9:16", targetDuration: 15, idempotencyKey: key() });
  const gateProjectId = pro2.data.projectId;
  const rejectedPropose = await agentProposeStoryboard(gateProjectId, [{ duration: 15, description: "a" }]).catch((e) => e.message);
  assert(String(rejectedPropose).includes("NO_BRIEF"), "无简报时提交分镜被拒", String(rejectedPropose));

  // 6.2 未确认简报（collect_brief 有简报）不允许提交分镜
  await mutateQuickVideoState(gateProjectId, {}, (s: any) => {
    s.brief = { theme: "t", hook: "", narrative: "n", cta: "", keywords: [], confirmed: false, confirmedAt: null };
  });
  const rejectedPropose2 = await agentProposeStoryboard(gateProjectId, [{ duration: 15, description: "a" }]).catch((e) => e.message);
  assert(String(rejectedPropose2).includes("STAGE_FORBIDDEN:collect_brief"), "简报未确认时提交分镜被拒", String(rejectedPropose2));

  // 6.3 镜头时长越界被契约校验拒绝
  const rejectedPropose3 = await agentProposeStoryboard(projectId, [{ duration: 20, description: "a" }]).catch((e) => e.message);
  assert(String(rejectedPropose3).includes("SHOT_DURATION_INVALID") || String(rejectedPropose3).includes("时长需为"), "镜头时长 20 秒被拒", String(rejectedPropose3));

  // 6.4 镜头数量越界被拒（30 秒最多 6 镜）
  const rejectedPropose4 = await agentProposeStoryboard(
    projectId,
    Array.from({ length: 7 }, (_, i) => ({ duration: 5, description: `镜${i}` })),
  ).catch((e) => e.message);
  assert(String(rejectedPropose4).includes("STORYBOARD_INVALID"), "镜头数量超上限被拒", String(rejectedPropose4));

  // 6.5 合法分镜（6 镜 x 5 秒 = 30 秒）提交成功，阶段进入 storyboard_draft
  const proposeOk = await agentProposeStoryboard(
    projectId,
    Array.from({ length: 6 }, (_, i) => ({ duration: 5, description: `第${i + 1}镜：小店亮灯` })),
    "六镜 30 秒方案",
  );
  assert(proposeOk.state.stage === "storyboard_draft" && proposeOk.state.storyboard?.shots.length === 6, "合法分镜提交成功并进入 storyboard_draft");
  assert(proposeOk.state.storyboard?.version === 1, "分镜版本为 v1");

  console.log("== 7. 分镜编辑与确认门 ==");
  // 7.1 update_shot 白名单：修改时长越界被拒
  const v5 = await getState(projectId);
  const badShot = await api("/quickVideo/updateShot", { projectId, expectedVersion: v5.version, idempotencyKey: key(), shotId: "shot-1", patch: { duration: 20 } });
  assert(badShot.code === 400 || String(badShot.message ?? badShot).includes("参数错误"), "updateShot 时长越界被参数校验拒绝", JSON.stringify(badShot));

  // 7.2 合法编辑
  const v6 = await getState(projectId);
  const editShot = await api("/quickVideo/updateShot", { projectId, expectedVersion: v6.version, idempotencyKey: key(), shotId: "shot-1", patch: { dialogue: "新台词", duration: 8 } });
  assert(editShot.code === 200 && editShot.data.state.storyboard.shots.find((s: any) => s.id === "shot-1").duration === 8, "updateShot 合法编辑成功");

  // 7.3 总时长超差时确认被拒（6镜 5+8+5+5+5+5 = 33 → 差 3 秒，容差内 → 应通过；先验证 removeShot 后数量校验）
  const v7 = await getState(projectId);
  const removeShot = await api("/quickVideo/removeShot", { projectId, expectedVersion: v7.version, idempotencyKey: key(), shotId: "shot-2" });
  assert(removeShot.code === 200 && removeShot.data.state.storyboard.shots.length === 5, "removeShot 删除并重排序");

  // 7.4 确认分镜（5 镜 28 秒，容差 6 秒内 → 通过）-> storyboard_confirmed
  const v8 = await getState(projectId);
  const confirmSb = await api("/quickVideo/confirmStage", { projectId, sessionId, expectedVersion: v8.version, idempotencyKey: key(), gate: "storyboard", action: "confirm" });
  assert(confirmSb.code === 200 && confirmSb.data.state.stage === "storyboard_confirmed", "确认分镜 -> storyboard_confirmed", JSON.stringify(confirmSb).slice(0, 300));

  // 7.5 确认后编辑镜头被锁
  const v9 = await getState(projectId);
  const lockedShot = await api("/quickVideo/updateShot", { projectId, expectedVersion: v9.version, idempotencyKey: key(), shotId: "shot-1", patch: { camera: "特写" } });
  assert(lockedShot.code === "STORYBOARD_LOCKED", "已确认分镜编辑被拒（锁定）", JSON.stringify(lockedShot));

  // 7.6 Agent 在锁定后重新提交分镜被拒（阶段白名单：storyboard_confirmed 不允许提交）
  const lockedPropose = await agentProposeStoryboard(projectId, [{ duration: 30, description: "x" }]).catch((e) => e.message);
  assert(String(lockedPropose).includes("STAGE_FORBIDDEN:storyboard_confirmed") || String(lockedPropose).includes("STORYBOARD_LOCKED"), "已确认分镜重新提交被拒", String(lockedPropose));

  // 7.7 撤销确认 -> 回草稿可编辑
  const v10 = await getState(projectId);
  const unconfirm = await api("/quickVideo/confirmStage", { projectId, sessionId, expectedVersion: v10.version, idempotencyKey: key(), gate: "storyboard", action: "reject" });
  assert(unconfirm.code === 200 && unconfirm.data.state.stage === "storyboard_draft", "撤销分镜确认 -> storyboard_draft");

  console.log("== 8. 导出门与刷新恢复 ==");
  const v11 = await getState(projectId);
  const exp = await api("/quickVideo/confirmStage", { projectId, sessionId, expectedVersion: v11.version, idempotencyKey: key(), gate: "export", action: "confirm" });
  assert(exp.code === "STAGE_MISMATCH", "未装配前导出确认被拒", JSON.stringify(exp));

  const wb2 = await api("/quickVideo/getWorkbench", { projectId });
  assert(wb2.data.state?.storyboard?.shots.length === 5, "刷新恢复：分镜数据完整");
  assert(wb2.data.state?.artStyle === "国潮插画风", "刷新恢复：项目配置完整");

  // 非快创项目访问被拒
  const proWb = await api("/quickVideo/getWorkbench", { projectId: proProjectId?.id });
  assert(proWb.data === null && String(proWb.message).includes("非单视频快创"), "专业项目访问快创工作台被拒", JSON.stringify(proWb).slice(0, 200));

  // ===========================================================================
  // 以下覆盖 SIY-109：工作台交互与生成闭环（素材解析、素材/成本确认门、
  // 逐镜头生成、单镜头失败重试隔离、中断恢复）。成功路径使用「空模板」供应商
  // （imageRequest/videoRequest 空实现），零外部依赖地跑通完整任务链路。
  // ===========================================================================

  /** 等待条件成立（工作台轮询场景） */
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
    throw new Error(`dbWrite(${desc}) 失败: ${u.error(lastErr).message}`);
  }

  console.log("== 9. 素材解析与素材/成本预估 ==");
  // 9.1 新项目（15 秒 → 1-3 镜）
  const p2 = await api("/quickVideo/createProject", {
    name: `E2E快创生成-${Date.now()}`,
    artStyle: "赛博朋克",
    videoRatio: "9:16",
    targetDuration: 15,
    idempotencyKey: key(),
  });
  const p2Id = p2.data.projectId;
  const p2SessionId = p2.data.session?.id;
  assert(!!p2Id, "生成链路测试项目创建成功", JSON.stringify(p2).slice(0, 200));

  await api("/quickVideo/updateBrief", {
    projectId: p2Id,
    expectedVersion: 1,
    idempotencyKey: key(),
    brief: { theme: "霓虹奶茶", hook: "雨夜霓虹", narrative: "雨夜霓虹街头，主角接过奶茶，喝下后街头霓虹全部亮起", cta: "", keywords: ["赛博"] },
  });
  await api("/quickVideo/confirmStage", { projectId: p2Id, sessionId: p2SessionId, expectedVersion: (await getState(p2Id)).version, idempotencyKey: key(), gate: "brief", action: "confirm" });
  await agentProposeStoryboard(
    p2Id,
    [
      { duration: 5, description: "雨夜街头主角撑伞走来" },
      { duration: 5, description: "接过奶茶特写" },
      { duration: 5, description: "霓虹全部亮起的远景" },
    ],
    "三镜 15 秒",
  );

  // 9.2 给镜头挂 assetRefs，并在资产库造一个命中资产（有图）与一个未命中资产
  const vA = await getState(p2Id);
  await api("/quickVideo/updateShot", {
    projectId: p2Id,
    expectedVersion: vA.version,
    idempotencyKey: key(),
    shotId: "shot-1",
    patch: { assetRefs: [{ type: "role", name: "小茶", desc: "短发女孩，银色雨衣" }] },
  });
  const vB = await getState(p2Id);
  await api("/quickVideo/updateShot", {
    projectId: p2Id,
    expectedVersion: vB.version,
    idempotencyKey: key(),
    shotId: "shot-2",
    patch: { assetRefs: [{ type: "scene", name: "霓虹奶茶店", desc: "霓虹灯招牌的奶茶店门面" }] },
  });

  await dbWrite("造资产", async () => {
    const imgMax = await u.db("o_image").max("id as maxId").first();
    const imageId = Number(imgMax?.maxId ?? 0) + 1;
    await u.db("o_image").insert({ id: imageId, filePath: `/${p2Id}/quickVideo/e2e-asset-xiaocha.jpg`, type: "jpg", state: "生成完成" });
    const assetMax = await u.db("o_assets").max("id as maxId").first();
    await u.db("o_assets").insert({ id: Number(assetMax?.maxId ?? 0) + 1, name: "小茶", type: "role", projectId: p2Id, imageId });
    await u.db("o_assets").insert({ id: Number(assetMax?.maxId ?? 0) + 2, name: "霓虹奶茶店", type: "scene", projectId: p2Id, imageId: null });
  });

  // 9.3 确认分镜 → 解析素材
  const vC = await getState(p2Id);
  const confirmSb2 = await api("/quickVideo/confirmStage", { projectId: p2Id, sessionId: p2SessionId, expectedVersion: vC.version, idempotencyKey: key(), gate: "storyboard", action: "confirm" });
  assert(confirmSb2.code === 200 && confirmSb2.data.state.stage === "storyboard_confirmed", "P2 分镜确认成功");

  const resolved = await api("/quickVideo/resolveAssets", { projectId: p2Id, expectedVersion: confirmSb2.data.state.version, idempotencyKey: key() });
  assert(resolved.code === 200 && !!resolved.data.state.generation.snapshot, "resolveAssets 生成素材快照", JSON.stringify(resolved).slice(0, 200));
  const materials = resolved.data.materials ?? [];
  const matched = materials.find((m: any) => m.name === "小茶");
  const toGen = materials.find((m: any) => m.name === "霓虹奶茶店");
  assert(matched?.source === "matched" && !!matched.assetId && !!matched.filePath, "资产库命中：小茶 → matched（复用已有资产图）", JSON.stringify(matched));
  assert(toGen?.source === "to_generate", "无图资产：霓虹奶茶店 → to_generate", JSON.stringify(toGen));
  assert(resolved.data.estimate?.estimatedImageCount === 4 && resolved.data.estimate?.estimatedVideoCount === 3, "预估：3 分镜图 + 1 素材图 / 3 视频", JSON.stringify(resolved.data.estimate));
  assert(Math.abs(resolved.data.estimate?.estimatedCostYuan - 8.7) < 0.001, "预估费用 = 4×0.3 + 15×0.5 = 8.7 元", JSON.stringify(resolved.data.estimate));

  // 9.4 分镜未确认时不允许素材确认（用 storyboard_draft 的主项目验证）
  const draftConfirm = await api("/quickVideo/confirmStage", { projectId, sessionId, expectedVersion: (await getState(projectId)).version, idempotencyKey: key(), gate: "materials", action: "confirm" });
  assert(draftConfirm.code === "NO_STORYBOARD", "分镜未确认时素材确认被拒", JSON.stringify(draftConfirm));

  console.log("== 10. 素材确认门与逐镜头生成（无模型 → 统一失败可重试） ==");
  const confirmMat = await api("/quickVideo/confirmStage", { projectId: p2Id, sessionId: p2SessionId, expectedVersion: (await getState(p2Id)).version, idempotencyKey: key(), gate: "materials", action: "confirm" });
  assert(confirmMat.code === 200 && confirmMat.data.state.stage === "generating", "素材确认 → generating", JSON.stringify(confirmMat).slice(0, 200));
  assert(confirmMat.data.state.generation.materialsConfirmed === true, "素材确认门状态由服务端写入");
  assert(confirmMat.data.state.generation.snapshot?.storyboardVersion === 1, "确认快照冻结分镜版本 v1");

  // 未配置图片/视频模型 → 整批标记失败，错误原因可读，阶段停在 generating
  await waitFor("全部镜头失败", async () => {
    const st = await getState(p2Id);
    return st.storyboard.shots.every((s: any) => s.imageState === "failed" && s.videoState === "failed");
  }, 30000);
  const failedState = await getState(p2Id);
  assert(failedState.stage === "generating", "镜头失败后阶段保持在 generating（可重试）");
  const failureReason = String(failedState.storyboard.shots[0].errorReason ?? "").trim();
  assert(failureReason.length > 0, "失败原因可读且已写入", failureReason);

  // 生成阶段重复素材确认被拒（门状态由服务端决定）
  const matAgain = await api("/quickVideo/confirmStage", { projectId: p2Id, sessionId: p2SessionId, expectedVersion: (await getState(p2Id)).version, idempotencyKey: key(), gate: "materials", action: "confirm" });
  assert(matAgain.code === "STAGE_MISMATCH", "generating 阶段重复素材确认被拒", JSON.stringify(matAgain));

  console.log("== 11. 配置空模板供应商，单镜头重试隔离 ==");
  // 11.1 造「空模板」供应商（imageRequest/videoRequest 返回空串，完整走任务记录+保存链路）
  await dbWrite("造空模板供应商", async () => {
    const existing = await u.db("o_vendorConfig").where("id", "null").first();
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
    if (existing) await u.db("o_vendorConfig").where("id", "null").update(row);
    else await u.db("o_vendorConfig").insert(row);
    await u.db("o_project").where("id", p2Id).update({ imageModel: "null:e2e-img", videoModel: "null:e2e-vid" });
  });

  // 11.2 重试 shot-1 → 仅该镜头重建并成功，其余保持失败
  await api("/quickVideo/retryShot", { projectId: p2Id, sessionId: p2SessionId, shotIds: ["shot-1"] });
  await waitFor("shot-1 成功", async () => {
    const st = await getState(p2Id);
    const s1 = st.storyboard.shots.find((s: any) => s.id === "shot-1");
    return s1.imageState === "done" && s1.videoState === "done" && !!s1.imageRef && !!s1.videoRef;
  }, 60000);
  const afterRetry1 = await getState(p2Id);
  const s1 = afterRetry1.storyboard.shots.find((s: any) => s.id === "shot-1");
  const s3Before = afterRetry1.storyboard.shots.find((s: any) => s.id === "shot-3");
  assert(s1.imageRef && s1.videoRef, "shot-1 重试成功且产物落库", JSON.stringify(s1));
  assert(s3Before.imageState === "failed" && s3Before.videoState === "failed", "重试不影响其他镜头（shot-3 保持原状）");

  // 11.3 重试 shot-2 → shot-1 已成功产物不变（失败重试不影响已成功镜头）
  await api("/quickVideo/retryShot", { projectId: p2Id, sessionId: p2SessionId, shotIds: ["shot-2"] });
  await waitFor("shot-2 成功", async () => {
    const st = await getState(p2Id);
    const s2 = st.storyboard.shots.find((s: any) => s.id === "shot-2");
    return s2.imageState === "done" && s2.videoState === "done";
  }, 60000);
  const afterRetry2 = await getState(p2Id);
  const s1After = afterRetry2.storyboard.shots.find((s: any) => s.id === "shot-1");
  assert(s1After.imageRef === s1.imageRef && s1After.videoRef === s1.videoRef, "shot-1 产物引用未被重试改动");

  // 11.4 已完成镜头不可重试
  const retryDone = await api("/quickVideo/retryShot", { projectId: p2Id, sessionId: p2SessionId, shotIds: ["shot-2"] });
  assert(retryDone.code === "SHOT_ALREADY_DONE", "已完成镜头重试被拒", JSON.stringify(retryDone));

  // 11.5 重试最后一个失败镜头 → 全部完成 → 自动推进 ready_to_assemble
  await api("/quickVideo/retryShot", { projectId: p2Id, sessionId: p2SessionId, shotIds: ["shot-3"] });
  await waitFor("全部完成并推进", async () => {
    const st = await getState(p2Id);
    return st.stage === "ready_to_assemble";
  }, 60000);
  const finalState = await getState(p2Id);
  assert(finalState.stage === "ready_to_assemble", "全部镜头完成后自动推进 ready_to_assemble");
  assert(finalState.generation.finishedAt != null && finalState.generation.runId, "生成运行记录（runId/finishedAt）已写入");

  // 11.6 任务记录（复用现有异步任务包装器）
  const taskRows = await dbWrite("查任务记录", () => u.db("o_tasks").where("projectId", p2Id).whereIn("taskClass", ["快创分镜图片", "快创镜头视频"]));
  const imgTasks = taskRows.filter((t: any) => t.taskClass === "快创分镜图片");
  const vidTasks = taskRows.filter((t: any) => t.taskClass === "快创镜头视频");
  const failedImageTasks = imgTasks.filter((t: any) => t.state === "生成失败");
  const completedImageTasks = imgTasks.filter((t: any) => t.state === "已完成");
  const completedVideoTasks = vidTasks.filter((t: any) => t.state === "已完成");
  assert(
    imgTasks.length === 6 && failedImageTasks.length === 3 && completedImageTasks.length === 3 && vidTasks.length === 3,
    "任务记录保留初次失败并新增每镜头图片重试/视频任务",
    `img=${imgTasks.length} (failed=${failedImageTasks.length},done=${completedImageTasks.length}),vid=${vidTasks.length}`,
  );
  assert(completedVideoTasks.length === 3, "重试后的全部视频任务为已完成", `videoDone=${completedVideoTasks.length}`);

  // 11.7 镜头产物访问地址
  const media = await api("/quickVideo/getMediaUrls", { projectId: p2Id });
  const mediaMap = media.data?.media ?? {};
  assert(Object.keys(mediaMap).length === 3 && Object.values(mediaMap).every((m: any) => m.imageUrl && m.videoUrl), "getMediaUrls 返回三镜头图/视频地址", JSON.stringify(media).slice(0, 200));

  console.log("== 12. 导出门（ready_to_assemble -> completed） ==");
  const exportOk = await api("/quickVideo/confirmStage", { projectId: p2Id, sessionId: p2SessionId, expectedVersion: finalState.version, idempotencyKey: key(), gate: "export", action: "confirm" });
  assert(exportOk.code === 200 && exportOk.data.state.stage === "completed", "导出确认 → completed", JSON.stringify(exportOk).slice(0, 200));

  // 状态版本应与真实写入次数同量级（保护：恢复/轮询不得反复空转写状态）
  assert(finalState.version < 60, "状态版本有界（无轮询空转写入）", `version=${finalState.version}`);

  console.log("== 13. Session 会话隔离（SIY-128） ==");
  // 13.1 创建项目时自动带一个默认会话；列表按 updateTime 倒序
  const list1 = await api("/quickVideo/listSessions", { projectId });
  assert(list1.data.sessions.length === 1 && list1.data.sessions[0].id === sessionId, "新项目自动创建默认会话", JSON.stringify(list1.data).slice(0, 200));

  // 13.2 新建第二个会话；列表倒序时最新会话排最前
  const createdSession2 = await api("/quickVideo/createSession", { projectId, title: "会话B" });
  const sessionId2 = createdSession2.data.session.id;
  assert(!!sessionId2 && sessionId2 !== sessionId, "新建第二个会话成功");
  const list2 = await api("/quickVideo/listSessions", { projectId });
  assert(list2.data.sessions.length === 2 && list2.data.sessions[0].id === sessionId2, "会话列表按 updateTime 倒序，最新会话在前", JSON.stringify(list2.data.sessions.map((s: any) => s.id)));

  // 13.3 聊天记忆按 projectId:quickVideoAgent:sessionId 隔离（模拟真实 socket 握手写入的 isolationKey）
  await u.db("memories").insert([
    { id: u.uuid(), isolationKey: `${projectId}:quickVideoAgent:${sessionId}`, type: "message", role: "user", content: "会话A的消息", createTime: Date.now() },
    { id: u.uuid(), isolationKey: `${projectId}:quickVideoAgent:${sessionId2}`, type: "message", role: "user", content: "会话B的消息", createTime: Date.now() },
  ]);
  const historyA = await api("/agents/getMemory", { projectId, agentType: "quickVideoAgent", sessionId });
  const historyB = await api("/agents/getMemory", { projectId, agentType: "quickVideoAgent", sessionId: sessionId2 });
  assert(
    historyA.data.some((m: any) => m.content?.[0]?.data === "会话A的消息") && !historyA.data.some((m: any) => m.content?.[0]?.data === "会话B的消息"),
    "会话A的历史只包含会话A的消息，不串入会话B",
    JSON.stringify(historyA.data).slice(0, 200),
  );
  assert(
    historyB.data.some((m: any) => m.content?.[0]?.data === "会话B的消息") && !historyB.data.some((m: any) => m.content?.[0]?.data === "会话A的消息"),
    "会话B的历史只包含会话B的消息，不串入会话A",
    JSON.stringify(historyB.data).slice(0, 200),
  );

  // 13.4 非法/跨项目 session 被拒绝：用 p2 项目的 sessionId 冒充 projectId 项目的会话
  const crossProject = await api("/agents/getMemory", { projectId, agentType: "quickVideoAgent", sessionId: p2SessionId });
  assert(crossProject.code === 400 && String(crossProject.message ?? "").includes("会话不存在"), "跨项目 sessionId 被拒绝而非静默返回历史", JSON.stringify(crossProject).slice(0, 200));
  const missingSession = await api("/agents/getMemory", { projectId, agentType: "quickVideoAgent" });
  assert(missingSession.code === 400 && String(missingSession.message ?? "").includes("缺少 sessionId"), "quickVideoAgent 缺少 sessionId 被拒绝", JSON.stringify(missingSession));

  // 13.5 模型偏好按 session 隔离保存；互不覆盖
  const modelsA = await api("/quickVideo/updateModels", { projectId, sessionId, textModel: "1:model-a-text", imageModel: "1:model-a-img", videoModel: "1:model-a-vid" });
  assert(modelsA.code === 200 && modelsA.data.session.textModel === "1:model-a-text", "会话A模型偏好保存成功", JSON.stringify(modelsA).slice(0, 200));
  const modelsB = await api("/quickVideo/updateModels", { projectId, sessionId: sessionId2, textModel: "1:model-b-text", imageModel: "1:model-b-img", videoModel: "1:model-b-vid" });
  assert(modelsB.code === 200 && modelsB.data.session.textModel === "1:model-b-text", "会话B模型偏好保存成功", JSON.stringify(modelsB).slice(0, 200));
  const list3 = await api("/quickVideo/listSessions", { projectId });
  const savedA = list3.data.sessions.find((s: any) => s.id === sessionId);
  const savedB = list3.data.sessions.find((s: any) => s.id === sessionId2);
  assert(savedA.textModel === "1:model-a-text" && savedB.textModel === "1:model-b-text", "两个会话的模型偏好互相独立、不覆盖", JSON.stringify({ savedA, savedB }));

  // 13.6 跨项目更新模型偏好被拒绝
  const crossModels = await api("/quickVideo/updateModels", { projectId, sessionId: p2SessionId, textModel: "x", imageModel: "x", videoModel: "x" });
  assert(String(crossModels.message ?? "").includes("会话不存在"), "跨项目 sessionId 更新模型偏好被拒绝", JSON.stringify(crossModels));

  // 13.7 重命名/归档会话：写操作会刷新 updateTime，重新排到列表顶部
  const renamed = await api("/quickVideo/updateSession", { projectId, sessionId, title: "会话A-改名", status: "archived" });
  assert(renamed.code === 200 && renamed.data.session.title === "会话A-改名" && renamed.data.session.status === "archived", "会话重命名与归档成功", JSON.stringify(renamed).slice(0, 200));
  const list4 = await api("/quickVideo/listSessions", { projectId });
  assert(list4.data.sessions[0].id === sessionId, "刚被修改的会话重新排到列表顶部（updateTime 最新）", JSON.stringify(list4.data.sessions.map((s: any) => s.id)));

  // 清理 e2e 写入共享 MinIO 的测试对象（best-effort，不阻塞结果）
  try {
    await u.oss.deleteDirectory(`/${p2Id}/quickVideo`);
    console.log("已清理 e2e 测试对象");
  } catch {}

  console.log("== 14. 会话标题：默认命名序号 + 第 5 条消息触发智能生成（SIY-128 follow-up） ==");
  // 14.1 新建会话默认标题带项目内递增序号，不是固定的"默认会话"
  const list5 = await api("/quickVideo/listSessions", { projectId });
  const sessionASeq = list5.data.sessions.find((s: any) => s.id === sessionId)?.sequence;
  const sessionBSeq = list5.data.sessions.find((s: any) => s.id === sessionId2)?.sequence;
  assert(sessionASeq === 1 && sessionBSeq === 2, "同项目下序号按创建顺序递增，不重复", JSON.stringify({ sessionASeq, sessionBSeq }));

  const createdSession3 = await api("/quickVideo/createSession", { projectId });
  const sessionId3 = createdSession3.data.session.id;
  assert(
    createdSession3.data.session.sequence === 3 && String(createdSession3.data.session.title).endsWith("-session3"),
    "不传标题时使用「项目名称-session序号」默认命名",
    JSON.stringify(createdSession3.data.session),
  );

  // 14.2 归档会话B（序号 2）不会被后续新建会话复用序号
  await api("/quickVideo/updateSession", { projectId, sessionId: sessionId2, status: "archived" });
  const createdSession4 = await api("/quickVideo/createSession", { projectId });
  assert(createdSession4.data.session.sequence === 4, "归档过的序号不复用，序号只会往上走", JSON.stringify(createdSession4.data.session));

  // 14.3 用户消息计数：第 1-4 条不抢占生成资格，第 5 条抢占且只抢占一次
  const claims: boolean[] = [];
  for (let i = 0; i < 6; i++) claims.push(await bumpUserMessageCountAndMaybeClaimTitle(sessionId3));
  assert(
    claims.slice(0, 4).every((c) => c === false) && claims[4] === true && claims[5] === false,
    "第 1-4 条消息不触发，第 5 条触发一次，第 6 条不重复触发",
    JSON.stringify(claims),
  );
  const claimedState = await u.db("o_quickVideoSession").where({ id: sessionId3 }).first();
  assert(claimedState?.userMessageCount === 6 && claimedState?.titleStatus === "running", "计数正确累加到 6；标题生成状态被抢占为 running", JSON.stringify({ count: claimedState?.userMessageCount, status: claimedState?.titleStatus }));

  // 14.4 实际生成一次（真实调用 aibotplatform:gemini-3.1-pro-preview；供应商/网络不可用时按设计降级为 failed，不抛出、不影响聊天主流程）
  await u.db("memories").insert([
    { id: u.uuid(), isolationKey: `${projectId}:quickVideoAgent:${sessionId3}`, type: "message", role: "user", content: "帮我策划一支宠物零食的 15 秒广告", createTime: Date.now() },
  ]);
  await generateSessionTitle({ projectId, sessionId: sessionId3, isolationKey: `${projectId}:quickVideoAgent:${sessionId3}`, userId: 1 });
  const afterGenerate = await u.db("o_quickVideoSession").where({ id: sessionId3 }).first();
  assert(["done", "failed"].includes(String(afterGenerate?.titleStatus)), "生成结束后状态落定为 done 或 failed，不会卡在 running", afterGenerate?.titleStatus ?? "(未找到会话行)");
  if (afterGenerate?.titleStatus === "done") {
    assert(!!afterGenerate.title && afterGenerate.title.length <= 40, "生成成功时标题非空且长度受限", afterGenerate.title ?? "");
    console.log(`  ℹ 生成的标题：${afterGenerate.title}`);
  } else {
    console.log("  ℹ 标题生成失败（供应商/网络不可用属预期降级路径，未影响其他断言）");
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("E2E 异常终止:", err);
  process.exit(1);
});
