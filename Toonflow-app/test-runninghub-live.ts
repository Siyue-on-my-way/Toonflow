import sharp from "sharp";
import axios from "axios";
import { buildRunningHubRequestBody, findRunningHubModelSpec } from "./src/vendors/runninghub-models";

const BASE_URL = "https://www.runninghub.ai/openapi/v2";

function headers(apiKey: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}

async function submitTask(apiKey: string, endpoint: string, data: any): Promise<string> {
  const url = `${BASE_URL}/${endpoint}`;
  console.log(`[submit] POST ${url}\n  body: ${JSON.stringify(data).slice(0, 300)}`);
  const response = await axios.post(url, data, { headers: headers(apiKey) });
  if (response.data && response.data.taskId) {
    console.log(`[submit] taskId=${response.data.taskId} status=${response.data.status}`);
    return response.data.taskId;
  }
  throw new Error(`任务提交失败: ${response.data?.errorMessage || JSON.stringify(response.data)}`);
}

async function queryTask(apiKey: string, taskId: string, timeoutMs = 600000, intervalMs = 5000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = await axios.post(`${BASE_URL}/query`, { taskId }, { headers: headers(apiKey) });
    const data = response.data;
    console.log(`[query] taskId=${taskId} status=${data.status}`);
    if (data.status === "SUCCESS") {
      if (data.results?.length > 0 && data.results[0].url) return data.results[0].url;
      throw new Error("任务成功，但未返回结果 URL");
    } else if (data.status === "FAILED") {
      throw new Error(data.errorMessage || JSON.stringify(data.failedReason) || "任务生成失败");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("timeout");
}

async function main() {
  const apiKey = process.argv[2];
  const which = process.argv[3] || "both";
  if (!apiKey) throw new Error("usage: tsx test-runninghub-live.ts <apiKey> [image|video|both|fl2va]");

  const png = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 60, b: 60 } },
  })
    .png()
    .toBuffer();
  const testImage = `data:image/png;base64,${png.toString("base64")}`;

  const videoPng = await sharp({
    create: { width: 720, height: 1280, channels: 3, background: { r: 60, g: 140, b: 220 } },
  })
    .png()
    .toBuffer();
  const videoTestImage = `data:image/png;base64,${videoPng.toString("base64")}`;

  if (which === "image" || which === "both") {
    console.log("\n=== Test 1: rhart-image-n-g31-flash (array imageInput) ===");
    const spec = findRunningHubModelSpec("rhart-image-n-g31-flash", "image")!;
    const config = { prompt: "a small blue circle on the red square", aspectRatio: "1:1", size: "1K" };
    const body = buildRunningHubRequestBody(spec, config, [testImage]);
    try {
      const taskId = await submitTask(apiKey, spec.endpoint, body);
      const url = await queryTask(apiKey, taskId);
      console.log("Test 1 SUCCESS, result URL:", url);
    } catch (e: any) {
      console.error("Test 1 FAILED:", e.message);
      process.exitCode = 1;
    }
  }

  if (which === "video" || which === "both") {
    console.log("\n=== Test 2: kling-v3.0-pro (namedSlots imageInput) ===");
    const spec = findRunningHubModelSpec("kling-v3.0-pro", "video")!;
    const config = { prompt: "the camera slowly zooms in", aspectRatio: "9:16", duration: 5, audio: false, mode: ["singleImage"] };
    const body = buildRunningHubRequestBody(spec, config, [videoTestImage]);
    try {
      const taskId = await submitTask(apiKey, spec.endpoint, body);
      const url = await queryTask(apiKey, taskId);
      console.log("Test 2 SUCCESS, result URL:", url);
    } catch (e: any) {
      console.error("Test 2 FAILED:", e.message);
      process.exitCode = 1;
    }
  }

  if (which === "fl2va") {
    // rhart-video/minimax-h3-oss/fl2va：同一 endpoint 靠"是否传帧"区分文生/图生（SIY-60 真实 Key 验证记录）
    const spec = findRunningHubModelSpec("rhart-video/minimax-h3-oss/fl2va", "video")!;
    console.log("\n=== Test 3: rhart-video/minimax-h3-oss/fl2va (text-to-video, 16:9) ===");
    const textBody = buildRunningHubRequestBody(
      spec,
      { prompt: "一只橘猫趴在窗台上晒太阳，尾巴轻轻摆动，镜头缓慢推近", aspectRatio: "16:9", duration: 5, mode: ["text"] },
      [],
    );
    try {
      const taskId = await submitTask(apiKey, spec.endpoint, textBody);
      const url = await queryTask(apiKey, taskId);
      console.log("Test 3 SUCCESS, result URL:", url);
    } catch (e: any) {
      console.error("Test 3 FAILED:", e.message);
      process.exitCode = 1;
    }

    console.log("\n=== Test 4: rhart-video/minimax-h3-oss/fl2va (first-frame image-to-video, 9:16) ===");
    const frameBody = buildRunningHubRequestBody(
      spec,
      { prompt: "蓝色背景像水面一样缓缓流动，光影微微变化，镜头缓慢推近", aspectRatio: "9:16", duration: 5, mode: ["startFrameOptional"] },
      [videoTestImage],
    );
    try {
      const taskId = await submitTask(apiKey, spec.endpoint, frameBody);
      const url = await queryTask(apiKey, taskId);
      console.log("Test 4 SUCCESS, result URL:", url);
    } catch (e: any) {
      console.error("Test 4 FAILED:", e.message);
      process.exitCode = 1;
    }
  }
}

main();
