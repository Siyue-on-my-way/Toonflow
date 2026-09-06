/**
 * Minimax H3 (rhart-video/minimax-h3-oss/fl2va) 真实生成验收脚本
 *
 * 用法: npx tsx test-h3-live.ts <apiKey> <case>
 *   case = probe | text | singleImage | startEndRequired | startFrameOptional | endFrameOptional
 *
 * 走仓库里真实的 RunningHubModelSpec 解释器拼请求体（与线上一致），
 * 提交 -> 轮询 -> 校验结果 URL 可下载。每个 case 单独运行，便于控制耗时与费用。
 */
import axios from "axios";
import sharp from "sharp";
import { buildRunningHubRequestBody, findRunningHubModelSpec } from "./src/vendors/runninghub-models";

const BASE_URL = "https://www.runninghub.ai/openapi/v2";
const SPEC = findRunningHubModelSpec("rhart-video/minimax-h3-oss/fl2va", "video")!;

function headers(apiKey: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}

async function makeFrame(r: number, g: number, b: number, label: string): Promise<string> {
  // 16:9 实拍尺寸的简单渐变图，模拟首/尾帧
  const svg = `<svg width="1024" height="576"><rect width="1024" height="576" fill="rgb(${r},${g},${b})"/>
    <text x="512" y="300" font-size="72" fill="white" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function submit(apiKey: string, body: Record<string, any>): Promise<string> {
  const printable = JSON.stringify(body, (k, v) =>
    typeof v === "string" && v.startsWith("data:image") ? `<base64 ${v.length} chars>` : v,
  );
  console.log(`[submit] POST ${BASE_URL}/${SPEC.endpoint}`);
  console.log(`[submit] body keys: ${Object.keys(body).join(", ")}`);
  console.log(`[submit] body: ${printable}`);
  const response = await axios.post(`${BASE_URL}/${SPEC.endpoint}`, body, { headers: headers(apiKey), timeout: 30000 });
  console.log(`[submit] resp: ${JSON.stringify(response.data).slice(0, 500)}`);
  if (response.data?.taskId) return response.data.taskId;
  throw new Error(`任务提交失败: ${response.data?.errorMessage || JSON.stringify(response.data)}`);
}

async function poll(apiKey: string, taskId: string, timeoutMs = 540000, intervalMs = 10000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data } = await axios.post(`${BASE_URL}/query`, { taskId }, { headers: headers(apiKey), timeout: 30000 });
    console.log(`[poll] ${new Date().toISOString()} taskId=${taskId} status=${data.status} elapsed=${Math.round((Date.now() - start) / 1000)}s`);
    if (data.status === "SUCCESS") {
      if (data.results?.length > 0 && data.results[0].url) {
        console.log(`[poll] result url: ${data.results[0].url}`);
        console.log(`[poll] usage: ${JSON.stringify(data.usage)}`);
        return data.results[0].url;
      }
      throw new Error("任务成功，但未返回结果 URL");
    }
    if (data.status === "FAILED") throw new Error(`FAILED: ${data.errorMessage || JSON.stringify(data.failedReason)}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`TIMEOUT after ${Math.round(timeoutMs / 1000)}s (taskId=${taskId}, 可用 query 重试)`);
}

async function main() {
  const apiKey = process.argv[2];
  const which = process.argv[3] || "text";
  if (!apiKey) throw new Error("usage: tsx test-h3-live.ts <apiKey> <case>");

  const first = await makeFrame(200, 60, 60, "START");
  const last = await makeFrame(60, 60, 200, "END");

  // 5 类模式 -> 4 种线上请求形态（endFrameOptional 与 singleImage 线上同形，均只发首帧）
  const cases: Record<string, { config: Record<string, any>; refs: (string | undefined)[]; expectKeys: string[]; forbidKeys: string[] }> = {
    text: {
      config: { prompt: "一朵红色的花慢慢绽放，背景纯白，镜头固定", aspectRatio: "1:1", duration: 5, mode: ["text"], resolution: "720p", audio: true },
      refs: [],
      expectKeys: ["prompt", "aspectRatio", "duration"],
      forbidKeys: ["firstFrameUrl", "lastFrameUrl"],
    },
    singleImage: {
      config: { prompt: "镜头缓缓向右平移，画面中的蓝色逐渐亮起", aspectRatio: "16:9", duration: 5, mode: ["singleImage"], resolution: "720p", audio: true },
      refs: [first],
      expectKeys: ["prompt", "aspectRatio", "duration", "firstFrameUrl"],
      forbidKeys: ["lastFrameUrl"],
    },
    startEndRequired: {
      config: { prompt: "红色渐变过渡到蓝色，画面平滑变化", aspectRatio: "16:9", duration: 5, mode: ["startEndRequired"], resolution: "720p", audio: true },
      refs: [first, last],
      expectKeys: ["prompt", "aspectRatio", "duration", "firstFrameUrl", "lastFrameUrl"],
      forbidKeys: [],
    },
    startFrameOptional: {
      config: { prompt: "蓝色画面逐渐扩散，微粒漂浮", aspectRatio: "16:9", duration: 5, mode: ["startFrameOptional"], resolution: "720p", audio: true },
      refs: [undefined, last], // 首帧可选模式下用户未提供首帧
      expectKeys: ["prompt", "aspectRatio", "duration", "lastFrameUrl"],
      forbidKeys: ["firstFrameUrl"],
    },
    endFrameOptional: {
      config: { prompt: "红色画面逐渐收缩成一个点", aspectRatio: "16:9", duration: 5, mode: ["endFrameOptional"], resolution: "720p", audio: true },
      refs: [first, undefined], // 尾帧可选模式下用户未提供尾帧
      expectKeys: ["prompt", "aspectRatio", "duration", "firstFrameUrl"],
      forbidKeys: ["lastFrameUrl"],
    },
  };

  const tc = cases[which];
  if (!tc) throw new Error(`unknown case: ${which}`);

  console.log(`\n===== H3 live test: ${which} =====`);
  const body = buildRunningHubRequestBody(SPEC, tc.config, tc.refs);

  // 请求体形态断言：期望键都在、禁止键都不在
  const missing = tc.expectKeys.filter((k) => !(k in body));
  const leaked = tc.forbidKeys.filter((k) => k in body);
  if (missing.length) throw new Error(`请求体缺少期望字段: ${missing.join(", ")}; keys=${Object.keys(body).join(", ")}`);
  if (leaked.length) throw new Error(`请求体出现了不该发送的字段: ${leaked.join(", ")}`);

  const taskId = await submit(apiKey, body);
  const url = await poll(apiKey, taskId);

  // 结果 URL 可下载性（Content-Length/类型），模拟 urlToBase64 的下载环节
  const head = await axios.get(url, { timeout: 60000, responseType: "stream" });
  const size = Number(head.headers["content-length"] || 0);
  const type = head.headers["content-type"] || "";
  console.log(`[download] content-type=${type} content-length=${size}`);
  head.data.destroy();
  if (!type.includes("video") && !type.includes("octet-stream")) {
    throw new Error(`结果 URL 不是视频: content-type=${type}`);
  }

  console.log(`\n===== ${which}: SUCCESS =====`);
}

main().catch((e) => {
  console.error(`\n===== FAILED =====\n${e.message}`);
  process.exitCode = 1;
});
