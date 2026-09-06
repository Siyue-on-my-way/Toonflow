/**
 * GPT Image (rhart-image-g-2) 文生图/图生图 端到端验证
 * 用法: RUNNINGHUB_API_KEY=<key> yarn exec tsx test-gpt-image-live.ts [t2i|i2i|both]
 * 对照文档: docs/runninghub-api/gpt-image-2.0-conomy.md
 */
import axios from "axios";
import sharp from "sharp";

const BASE_URL = "https://www.runninghub.ai/openapi/v2";
const apiKey = process.env.RUNNINGHUB_API_KEY || "";
if (!apiKey) throw new Error("missing RUNNINGHUB_API_KEY");
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

const which = process.argv[2] || "both";

async function submit(endpoint: string, body: any) {
  const { data } = await axios.post(`${BASE_URL}/${endpoint}`, body, { headers, timeout: 60000 });
  if (!data?.taskId) throw new Error(`submit failed: ${JSON.stringify(data).slice(0, 300)}`);
  console.log(`[submit] ${endpoint} -> taskId=${data.taskId} status=${data.status} errorCode=${JSON.stringify(data.errorCode)}`);
  return data.taskId as string;
}

async function poll(taskId: string, timeoutMs = 480000, intervalMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data } = await axios.post(`${BASE_URL}/query`, { taskId }, { headers, timeout: 60000 });
    if (data.status === "SUCCESS") return data.results?.[0]?.url ?? "";
    if (data.status === "FAILED") throw new Error(`[${data.errorCode ?? "-"}] ${data.errorMessage || "任务失败"}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("timeout");
}

async function t2i() {
  console.log("=== rhart-image-g-2/text-to-image (1:1, 1k) ===");
  const taskId = await submit("rhart-image-g-2/text-to-image", {
    prompt: "一只戴着宇航员头盔的橘猫，漂浮在星空中，扁平插画风格",
    aspectRatio: "1:1",
    resolution: "1k",
  });
  const url = await poll(taskId);
  console.log("result url:", url);
  const img = await axios.get(url, { responseType: "arraybuffer", timeout: 60000 });
  console.log(`downloaded bytes: ${img.data.length}`);
}

async function i2i() {
  console.log("=== rhart-image-g-2/image-to-image (1 ref data-uri, 1:1, 1k) ===");
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 60, b: 60 } } }).png().toBuffer();
  const testImage = `data:image/png;base64,${png.toString("base64")}`;
  const taskId = await submit("rhart-image-g-2/image-to-image", {
    prompt: "把这张图的背景改为纯绿色，其余内容保持不变",
    imageUrls: [testImage],
    aspectRatio: "1:1",
    resolution: "1k",
  });
  const url = await poll(taskId);
  console.log("result url:", url);
  const img = await axios.get(url, { responseType: "arraybuffer", timeout: 60000 });
  console.log(`downloaded bytes: ${img.data.length}`);
}

(async () => {
  if (which === "t2i" || which === "both") await t2i();
  if (which === "i2i" || which === "both") await i2i();
  console.log("ALL DONE");
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
