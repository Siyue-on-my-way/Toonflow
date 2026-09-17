/**
 * SIY-159 方案C 落地 E2E：RunningHub 七模型真实提交 + 必填缺失前置拦截负例。
 * 前置：cd /mnt/a-opensource-tools/Toonflow && ./start.sh --build 已重启服务（http://localhost:2280）。
 * 运行：node scripts/siy159-runninghub-metadata-e2e.mjs
 *
 * 覆盖：
 * 1) 元数据随 fixDB 幂等迁移进 o_vendorConfig.models（设置页/生产入口的真实数据源）
 * 2) 3 个图片模型 + 4 个视频模型各一次真实提交（走 modelTest 路由 → 供应商 DSL → RunningHub）
 * 3) 负例：Kling O1 缺首帧 / seedance 缺提示词，必须被后端 DSL 在提交供应商前拦截
 */
import fs from "node:fs";
import zlib from "node:zlib";

const BASE = process.env.BASE || "http://localhost:2280";
const results = [];
let token = "";

function record(name, ok, extra = "") {
  results.push({ name, ok, extra });
  console.log(`${ok ? "✔" : "✘"} ${name}${extra ? "  -- " + extra : ""}`);
}

async function api(path, body, timeoutMs = 12 * 60 * 1000) {
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

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** 生成 512x512 纯色 PNG（1x1 像素图会被 kling-o1 以 [1523] 拒收：参考图分辨率不符合模型要求） */
function solidPngBase64(size = 512) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) { row[1 + x * 3] = 210; row[2 + x * 3] = 120; row[3 + x * 3] = 90; }
  const idat = zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
function dataUrlPng() {
  return `data:image/png;base64,${solidPngBase64()}`;
}

/** 轮询生成结果（videoTest/imageTest 均为同步长请求，路由内部轮询供应商）
 *  路由成功时返回 oss 相对路径（如 /oss/test.mp4）或完整 URL，均为成功
 *  ONLY=<label关键字> 可只跑匹配的用例（如 ONLY="kling-o1"），避免重跑全部付费提交 */
async function submit(path, body, label) {
  if (process.env.ONLY && !label.includes(process.env.ONLY)) {
    record(`${label} [跳过]`, true, "ONLY 过滤");
    return { ok: true, data: null, err: null };
  }
  const { status, json } = await api(path, body);
  const ok = status === 200 && (json?.code === 200 || json?.code === 0);
  const data = json?.data ?? json;
  const err = json?.message || json?.error || JSON.stringify(json).slice(0, 200);
  record(label, Boolean(ok && typeof data === "string" && data.length > 0), ok ? String(data).slice(0, 80) : err);
  return { ok, data, err };
}

async function main() {
  // 0) 登录
  const login = await api("/login/login", { username: "admin", password: "admin123" }, 30 * 1000);
  token = login.json?.data?.token ?? "";
  record("admin 登录", Boolean(token));

  // 1) 元数据迁移核验（getVendorList 返回 catalogModels）
  const vendorList = await api("/setting/vendorConfig/getVendorList", {});
  const rh = (vendorList.json?.data ?? []).find((v) => v.id === "runninghub");
  record("runninghub 渠道存在", Boolean(rh), `version=${rh?.version}`);
  const catalog = rh?.catalogModels ?? [];
  const byName = (m) => catalog.find((i) => i.modelName === m);

  const nb2 = byName("rhart-image-n-g31-flash");
  record("nano-banana-2: mode 含 text（实测补全）", (nb2?.mode ?? []).includes("text"));
  record("nano-banana-2: 14 档比例", (nb2?.aspectRatioOptions ?? []).length === 14);

  const mini = byName("rhart-video/minimax-h3-oss/fl2va");
  record("minimax fl2va: durationContinuous", mini?.durationContinuous === true);
  record("minimax fl2va: promptLengthRange=[0,20000]", JSON.stringify(mini?.promptLengthRange) === "[0,20000]");

  const fast = byName("seedance-2.0-fast");
  const miniS = byName("seedance-2.0-mini");
  for (const [label, m] of [["seedance-fast", fast], ["seedance-mini", miniS]]) {
    record(`${label}: controls 声明`, JSON.stringify(m?.controls) === JSON.stringify(["generateAudio", "returnLastFrame", "seed"]));
    record(`${label}: promptSlotReferences`, m?.promptSlotReferences === true);
    record(`${label}: 7 档比例(含 adaptive)`, (m?.aspectRatioOptions ?? []).length === 7);
    record(`${label}: resolutionNote 警示`, typeof m?.resolutionNote === "string" && m.resolutionNote.length > 0);
  }

  const klingO1 = byName("kling-video-o1/image-to-video");
  record("kling-o1: qualityOptions", JSON.stringify(klingO1?.qualityOptions) === JSON.stringify(["std", "pro"]));

  // 2) 真实提交（每模型一次，选该模型风险最高的路径）
  const promptText = "一只橘猫在窗台上晒太阳，风吹动窗帘，温暖午后，写实风格";
  const shared = { prompt: promptText };

  // 图片模型
  await submit("/setting/vendorConfig/modelTest/imageTest", { modelName: "rhart-image-n-g31-flash", id: "runninghub", ...shared }, "图片: nano-banana-2 纯文生图（新补端点）");
  await submit("/setting/vendorConfig/modelTest/imageTest", { modelName: "rhart-image-n-pro/edit", id: "runninghub", prompt: "把背景换成夜晚的城市天际线，保持主体不变", imageBase64: dataUrlPng() }, "图片: nano-banana-pro 编辑(参考图必填路径)");
  await submit("/setting/vendorConfig/modelTest/imageTest", { modelName: "rhart-image-g-2", id: "runninghub", ...shared }, "图片: gpt-image-2.0 纯文生图");

  // 视频模型（validateFields 要求 images/videos/audios 三个数组齐全，与前端面板 payload 同构）
  await submit(
    "/setting/vendorConfig/modelTest/videoTest",
    { modelName: "kling-video-o1/image-to-video", id: "runninghub", mode: "singleImage", prompt: "镜头缓缓推进，人物轻微呼吸起伏，发丝随风轻动", images: [{ type: "image", base64: dataUrlPng() }], videos: [], audios: [], aspectRatio: "9:16", duration: 5, quality: "std" },
    "视频: kling-o1 单图+quality=std",
  );
  await submit(
    "/setting/vendorConfig/modelTest/videoTest",
    { modelName: "rhart-video/minimax-h3-oss/fl2va", id: "runninghub", mode: "text", prompt: "蓝色头发动漫少女回眸微笑，花瓣飘落", images: [], videos: [], audios: [], duration: 5.5, aspectRatio: "9:16" },
    "视频: minimax fl2va 文生(连续时长5.5)",
  );
  await submit(
    "/setting/vendorConfig/modelTest/videoTest",
    { modelName: "seedance-2.0-fast", id: "runninghub", mode: "text", prompt: "热气球缓缓升空，掠过雪山之巅", images: [], videos: [], audios: [], duration: -1, resolution: "480p", aspectRatio: "16:9", generateAudio: true },
    "视频: seedance-fast 文生(duration=-1自动+generateAudio)",
  );
  await submit(
    "/setting/vendorConfig/modelTest/videoTest",
    { modelName: "seedance-2.0-mini", id: "runninghub", mode: "text", prompt: "小机器人眨眼，头顶螺旋桨开始旋转", images: [], videos: [], audios: [], duration: 5, resolution: "720p", aspectRatio: "9:16" },
    "视频: seedance-mini 文生",
  );

  // 3) 负例：必填缺失必须被后端 DSL 前置拦截（错误信息与 HTTP 500，均属预期拦截）
  if (!process.env.ONLY) {
    const neg1 = await api("/setting/vendorConfig/modelTest/videoTest", { modelName: "kling-video-o1/image-to-video", id: "runninghub", mode: "singleImage", prompt: "camera pushes in slowly", images: [], videos: [], audios: [] }, 60 * 1000);
    record("负例: kling-o1 缺首帧被拦截", neg1.status === 500 && /首图|首帧|参考图/.test(neg1.json?.message ?? ""), neg1.json?.message ?? "");
    const neg2 = await api("/setting/vendorConfig/modelTest/videoTest", { modelName: "seedance-2.0-fast", id: "runninghub", mode: "text", prompt: "", images: [], videos: [], audios: [] }, 60 * 1000);
    record("负例: seedance 缺提示词被拦截", neg2.status === 500 && /prompt|提示词|不能为空/.test(neg2.json?.message ?? ""), neg2.json?.message ?? "");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== E2E 汇总: ${results.length - failed.length}/${results.length} 通过 ====`);
  if (failed.length) {
    console.log("未通过项:", failed.map((f) => f.name).join(" | "));
    process.exitCode = 1;
  }
  fs.writeFileSync("scripts/siy159-e2e-result.json", JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error("E2E 异常终止:", e?.message ?? e);
  process.exitCode = 1;
});
