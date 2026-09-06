/**
 * 恢复对账路径验证：模拟服务崩溃遗留的 generating 卡死镜头 → getWorkbench 触发恢复。
 *
 * 直接改写 o_agentWorkData.data JSON 模拟「崩溃时进程内状态已写、运行登记丢失」的库内现场，
 * 不依赖任何 quickVideo 服务端模块（更贴近真实崩溃后的脏状态）。
 */
import u from "@/utils";

const BASE = (process.env.BASE || "http://localhost:10588") + "/api";
let token = "";

async function api(path: string, body: any) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify(body),
  });
  return res.json();
}

const key = () => "rec-" + Math.random().toString(36).slice(2, 12);

async function main() {
  const login = await api("/login/login", { username: "admin", password: "admin123" });
  token = login.data.token;

  // 建项目 → 简报 → 分镜（3×5s）→ 确认 → 素材解析 → 素材确认（无模型 → 全部失败）
  const created = await api("/quickVideo/createProject", {
    name: `E2E恢复-${Date.now()}`,
    artStyle: "x",
    videoRatio: "9:16",
    targetDuration: 15,
    idempotencyKey: key(),
  });
  const pid = created.data.projectId;
  await api("/quickVideo/updateBrief", { projectId: pid, expectedVersion: 1, idempotencyKey: key(), brief: { theme: "t", hook: "", narrative: "n", cta: "", keywords: [] } });
  await api("/quickVideo/confirmStage", { projectId: pid, expectedVersion: 2, idempotencyKey: key(), gate: "brief", action: "confirm" });

  const wb0 = await api("/quickVideo/getWorkbench", { projectId: pid });
  const version = wb0.data.state.version;
  // 直接构造分镜草稿（与 propose_storyboard 同构），提交并确认
  await api("/quickVideo/updateShot", { projectId: pid, expectedVersion: version, idempotencyKey: key(), shotId: "shot-1", patch: { description: "占位" } }).catch(() => {});

  // 用状态层之外的方式落分镜不可行（服务端白名单），改走 API：
  // 1) 让 Agent 语义的分镜经由 updateBrief 后手动构造 —— 这里直接用 confirmStage 前置校验，
  //    因此先用 API 提交分镜：借 addShot 逐镜构造（需已有分镜壳），故改为直接写库构造草稿再走 confirm 门。
  const row = await u.db("o_agentWorkData").where({ projectId: String(pid), key: "quickVideoAgent" }).first();
  const state = JSON.parse(row.data);
  state.storyboard = {
    version: 1,
    status: "draft",
    confirmedAt: null,
    summary: "恢复验证用分镜",
    shots: [1, 2, 3].map((i) => ({
      id: `shot-${i}`,
      index: i,
      duration: 5,
      description: `恢复验证镜头 ${i}`,
      dialogue: "",
      camera: "",
      assetRefs: [],
      imageState: "pending",
      videoState: "pending",
      imageRef: null,
      videoRef: null,
      errorReason: null,
    })),
  };
  if (state.stage === "brief_confirmed") state.stage = "storyboard_draft";
  state.version += 1;
  state.updateTime = Date.now();
  await u.db("o_agentWorkData").where({ id: row.id }).update({ data: JSON.stringify(state), updateTime: Date.now() });

  const st1 = await api("/quickVideo/getWorkbench", { projectId: pid });
  await api("/quickVideo/confirmStage", { projectId: pid, expectedVersion: st1.data.state.version, idempotencyKey: key(), gate: "storyboard", action: "confirm" });
  const st2 = await api("/quickVideo/getWorkbench", { projectId: pid });
  await api("/quickVideo/resolveAssets", { projectId: pid, expectedVersion: st2.data.state.version, idempotencyKey: key() });
  const st3 = await api("/quickVideo/getWorkbench", { projectId: pid });
  const cm = await api("/quickVideo/confirmStage", { projectId: pid, expectedVersion: st3.data.state.version, idempotencyKey: key(), gate: "materials", action: "confirm" });
  console.log("素材确认 →", cm.data.state.stage);

  // 等“无模型”失败落定，然后模拟崩溃遗留：shot-2 卡在 generating（进程内无运行登记）
  await new Promise((r) => setTimeout(r, 1500));
  const row2 = await u.db("o_agentWorkData").where({ projectId: String(pid), key: "quickVideoAgent" }).first();
  const state2 = JSON.parse(row2.data);
  const shot2 = state2.storyboard.shots.find((x: any) => x.id === "shot-2");
  shot2.imageState = "generating";
  state2.version += 1;
  state2.updateTime = Date.now();
  await u.db("o_agentWorkData").where({ id: row2.id }).update({ data: JSON.stringify(state2), updateTime: Date.now() });

  const before = await api("/quickVideo/getWorkbench", { projectId: pid });
  console.log("恢复前 shot-2 imageState:", before.data.state.storyboard.shots.find((s: any) => s.id === "shot-2").imageState, "version:", before.data.state.version);

  // 下一次 getWorkbench 触发 ensureGenerationRecovery 对账
  await new Promise((r) => setTimeout(r, 800));
  const after = await api("/quickVideo/getWorkbench", { projectId: pid });
  const s2 = after.data.state.storyboard.shots.find((s: any) => s.id === "shot-2");
  const s1 = after.data.state.storyboard.shots.find((s: any) => s.id === "shot-1");
  console.log("恢复后 shot-2:", s2.imageState, "|", s2.errorReason);
  console.log("恢复后 shot-1（不受影响）:", s1.imageState, "|", s1.errorReason);
  console.log("阶段保持 generating:", after.data.state.stage === "generating");
  console.log("版本有界:", after.data.state.version < 40, "version:", after.data.state.version);
  process.exit(0);
}

main().catch((err) => {
  console.error("恢复验证失败:", err);
  process.exit(1);
});
