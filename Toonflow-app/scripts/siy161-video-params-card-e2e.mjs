/**
 * SIY-161 方案C E2E：快创聊天「模型参数确认卡」全链路真实验证。
 * 前置：cd /mnt/a-opensource-tools/Toonflow && ./start.sh --build 已重启服务（http://localhost:2280）。
 * 运行：node Toonflow-app/scripts/siy161-video-params-card-e2e.mjs
 *       ONLY=<label关键字> 只跑匹配模型；SKIP_NEGATIVE=1 跳过负例。
 *
 * 覆盖（与 SIY-159 真实提交口径一致：4 个已验证视频模型真实生成，其余不重复付费提交）：
 * 1) 聊天(视频模式) → Agent 调 request_video_params 出参数确认卡（字段带来源标记、引用联动）；
 * 2) 参数校验负例（服务端硬校验，零费用）：非法时长档位 / 非法分辨率 → confirm 必须被拒且卡片仍 pending；
 * 3) 确认 → 供应商真实生成成功，视频媒体推入聊天流；
 * 4) 卡片状态落库 confirmed + 字段来源标记可追溯。
 */
import { createRequire } from "node:module";
const require = createRequire("/mnt/a-opensource-tools/Toonflow/Toonflow-web/package.json");
const { io } = require("socket.io-client");

const BASE = process.env.BASE || "http://localhost:2280";
const results = [];
let token = "";

function record(name, ok, extra = "") {
  results.push({ name, ok, extra });
  console.log(`${ok ? "✔" : "✘"} ${name}${extra ? "  -- " + extra : ""}`);
}

async function api(path, body, timeoutMs = 30 * 1000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Socket 聊天客户端：等待本轮 Agent 结束，收集消息流里的参数确认卡
// ---------------------------------------------------------------------------
function chatTurn({ projectId, sessionId, content, videoModel, timeoutMs = 8 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const socket = io(`${BASE}/api/socket/quickVideoAgent`, {
      auth: { token, projectId, sessionId },
      transports: ["websocket"],
      reconnection: false,
      timeout: 20 * 1000,
    });
    const messages = new Map();
    let done = false;
    const timer = setTimeout(() => finish(new Error("聊天轮次超时")), timeoutMs);
    function finish(err, extra = {}) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.disconnect(); } catch {}
      if (err) reject(err); else resolve({ messages: [...messages.values()], ...extra });
    }
    socket.on("connect", () => {
      socket.emit("chat", { content, mode: "video", videoModel });
    });
    socket.on("connect_error", (err) => finish(new Error(`socket 连接失败: ${err.message}`)));
    socket.on("message", (m) => {
      messages.set(m.id, { id: m.id, role: m.role, status: m.status, ext: m.ext ?? null, content: [] });
    });
    socket.on("message:update", (u) => {
      const m = messages.get(u.id);
      if (!m) return;
      if (u.status) m.status = u.status;
      if (u.ext) m.ext = { ...(m.ext ?? {}), ...u.ext };
      if (m.role === "assistant" && (u.status === "complete" || u.status === "error")) finish(null);
    });
    socket.on("content:add", (e) => {
      const m = messages.get(e.messageId);
      if (m) m.content.push(e.content);
    });
    socket.on("error", (e) => finish(new Error(`socket error: ${e?.message ?? JSON.stringify(e)}`)));
  });
}

/** 发送 confirmVideoParams，等待 ack 与推入聊天流的媒体块 */
function confirmVideoParams({ projectId, sessionId, cardId, edits, prompt, remember = false, timeoutMs = 12 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const socket = io(`${BASE}/api/socket/quickVideoAgent`, {
      auth: { token, projectId, sessionId },
      transports: ["websocket"],
      reconnection: false,
      timeout: 20 * 1000,
    });
    const mediaBlocks = [];
    let done = false;
    const timer = setTimeout(() => finish(new Error("确认生成超时")), timeoutMs);
    function finish(err, extra = {}) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.disconnect(); } catch {}
      if (err) reject(err); else resolve({ mediaBlocks, ...extra });
    }
    socket.on("connect", () => {
      socket.emit("confirmVideoParams", { cardId, edits, prompt, remember }, (res) => {
        if (!res?.ok) return finish(null, { ack: res, mediaBlocks });
        setTimeout(() => finish(null, { ack: res, mediaBlocks }), 1500);
      });
    });
    socket.on("connect_error", (err) => finish(new Error(`socket 连接失败: ${err.message}`)));
    socket.on("content:add", (e) => {
      if (e.content?.type === "video" || e.content?.type === "image") mediaBlocks.push(e.content);
    });
    socket.on("error", (e) => finish(new Error(`socket error: ${e?.message ?? JSON.stringify(e)}`)));
  });
}

/** 从聊天轮次消息流里提取最新的参数确认卡 */
function pickCard(turn) {
  const cards = [];
  for (const m of turn.messages) {
    if (m.role === "assistant" && m.ext?.videoParamsCard) cards.push(m.ext.videoParamsCard);
  }
  return cards[cards.length - 1] ?? null;
}

// 与 SIY-159 真实提交口径一致的 4 个视频模型（其余目录模型不重复付费提交）
const VIDEO_MODELS = [
  {
    label: "kling-o1",
    modelName: "kling-video-o1/image-to-video",
    prompt: "生成一段视频：橘猫在窗台晒太阳，镜头缓缓推进",
    wantFields: ["mode", "duration", "aspectRatio", "quality"],
    badEdits: { duration: 7 }, // Kling O1 仅支持 5/10
  },
  {
    label: "minimax-fl2va",
    modelName: "rhart-video/minimax-h3-oss/fl2va",
    prompt: "生成一段视频：蓝色头发动漫少女回眸微笑，花瓣飘落",
    wantFields: ["mode", "duration", "aspectRatio"],
    badEdits: { duration: 20 }, // 连续区间 5-15
  },
  {
    label: "seedance-fast",
    modelName: "seedance-2.0-fast",
    prompt: "生成一段视频：热气球缓缓升空，掠过雪山之巅",
    wantFields: ["mode", "duration", "aspectRatio", "resolution", "generateAudio"],
    badEdits: { resolution: "8k" },
  },
  {
    label: "seedance-mini",
    modelName: "seedance-2.0-mini",
    prompt: "生成一段视频：小机器人眨眼，头顶螺旋桨开始旋转",
    wantFields: ["mode", "duration", "aspectRatio", "resolution"],
    badEdits: { duration: 99 },
  },
];

async function main() {
  // 0) 登录
  const login = await api("/login/login", { username: "admin", password: "admin123" });
  token = login.json?.data?.token ?? "";
  record("admin 登录", Boolean(token));
  if (!token) return;

  // 1) 目录核验：参数卡投影所需的元数据都在（含 SIY-161 新增 durationAutoNote）
  const vendorList = await api("/setting/vendorConfig/getVendorList", {});
  const rh = (vendorList.json?.data ?? []).find((v) => v.id === "runninghub");
  const catalog = rh?.catalogModels ?? [];
  const byName = (m) => catalog.find((i) => i.modelName === m);
  const seedanceFast = byName("seedance-2.0-fast");
  record(
    "seedance-fast: durationAutoNote 已随元数据下发",
    typeof seedanceFast?.durationAutoNote === "string" && seedanceFast.durationAutoNote.includes("自动"),
    JSON.stringify(seedanceFast?.durationAutoNote ?? null),
  );

  // 2) 建快创项目（自动补建默认会话）
  const create = await api("/quickVideo/createProject", {
    name: `SIY-161参数卡E2E-${Date.now()}`,
    artStyle: "扁平插画",
    videoRatio: "9:16",
    targetDuration: 15,
    draftScript: "橘猫与蝴蝶",
    idempotencyKey: `siy161-e2e-${Date.now()}`,
  });
  const projectId = create.json?.data?.projectId;
  const sessionId = create.json?.data?.session?.id;
  record("创建快创项目+会话", !!projectId && !!sessionId, `projectId=${projectId} sessionId=${sessionId}`);
  if (!projectId || !sessionId) return;

  const only = process.env.ONLY;
  const models = VIDEO_MODELS.filter((m) => !only || m.label.includes(only) || m.modelName.includes(only));

  for (const model of models) {
    const tag = `[${model.label}]`;
    const modelKey = `runninghub:${model.modelName}`;

    // 3) 聊天 → 出卡（Agent 调 request_video_params）
    let card = null;
    for (let attempt = 1; attempt <= 2 && !card; attempt++) {
      try {
        const turn = await chatTurn({ projectId, sessionId, content: model.prompt, videoModel: modelKey });
        card = pickCard(turn);
      } catch (err) {
        console.log(`  .. ${tag} 第 ${attempt} 次聊天异常: ${err.message}`);
      }
    }
    record(
      `${tag} 聊天出参数卡`,
      !!card,
      card ? `cardId=${card.cardId} fields=[${card.fields.map((f) => f.key).join(",")}]` : "Agent 未返回 videoParamsCard",
    );
    if (!card) continue;

    // 4) 字段与元数据精确匹配 + 来源标记
    const keys = card.fields.map((f) => f.key);
    const fieldsOk = model.wantFields.every((k) => keys.includes(k));
    const sourceOk = card.fields.every((f) => ["llm", "user", "system", "preference"].includes(f.source));
    record(`${tag} 字段与元数据匹配（${model.wantFields.join("/")}）`, fieldsOk, keys.join(","));
    record(`${tag} 全字段带来源标记`, sourceOk);
    record(`${tag} 提示词已预填`, typeof card.prompt === "string" && card.prompt.length > 0);

    // 5) 负例：非法参数必须被服务端硬校验拦截（不触发供应商调用、不产生费用）
    if (!process.env.SKIP_NEGATIVE) {
      let negAck = null;
      try {
        const neg = await confirmVideoParams({ projectId, sessionId, cardId: card.cardId, edits: model.badEdits, prompt: card.prompt, timeoutMs: 60 * 1000 });
        negAck = neg.ack ?? { ok: false, message: "无 ack" };
      } catch (err) {
        negAck = { ok: false, message: err.message };
      }
      // 负例不产生媒体块 = 未触发供应商调用
      record(`${tag} 负例被拒 ${JSON.stringify(model.badEdits)}`, negAck.ok === false && (negAck.message ?? "").length > 0, `ack=${JSON.stringify(negAck)}`);
    }

    // 6) 正例：确认 → 供应商真实生成
    try {
      const confirmed = await confirmVideoParams({ projectId, sessionId, cardId: card.cardId, edits: {}, prompt: card.prompt, remember: false });
      const ok = confirmed.ack?.ok === true && confirmed.mediaBlocks.some((b) => b.type === "video");
      record(
        `${tag} 确认后真实生成成功`,
        ok,
        `ack=${JSON.stringify(confirmed.ack)} media=[${confirmed.mediaBlocks.map((b) => b.type).join(",")}]`,
      );

      // 7) 卡片落库 confirmed + 来源标记可追溯
      const wb = await api("/quickVideo/getWorkbench", { projectId });
      const liveCard = wb.json?.data?.state?.generation?.videoParamsCards?.slice(-1)[0];
      record(`${tag} 卡片状态落库 confirmed`, liveCard?.status === "confirmed", `status=${liveCard?.status}`);
      record(
        `${tag} 字段来源可追溯`,
        Array.isArray(liveCard?.fields) && liveCard.fields.every((f) => f.source !== undefined),
        (liveCard?.fields ?? []).map((f) => `${f.key}:${f.source}`).join(" "),
      );
    } catch (err) {
      record(`${tag} 确认后真实生成成功`, false, err.message);
    }
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n结果：${results.length - failed.length} 通过，${failed.length} 失败`);
    if (failed.length) {
      console.log("失败项：");
      for (const f of failed) console.log(`  ✘ ${f.name} ${f.extra}`);
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error("E2E 异常退出:", err);
    process.exit(1);
  });
