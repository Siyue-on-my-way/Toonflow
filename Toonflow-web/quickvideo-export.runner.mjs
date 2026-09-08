import playwright from "/root/.npm/_npx/db89d7302a373f10/node_modules/playwright/index.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const { chromium } = playwright;

const BASE = "http://localhost:2280";
const PROJECT_ID = process.env.PROJECT_ID ?? "52";
const PROJECT_NAME = process.env.PROJECT_NAME ?? "验收快创-30s-1788729454659";
const EXPECTED_DURATION = Number(process.env.EXPECTED_DURATION ?? 30);
const EXPORT_TIMEOUT_MS = Number(process.env.EXPORT_TIMEOUT_MS ?? 600000);
const browser = await chromium.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-accelerated-video-decode"],
});
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1200 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("crash", () => console.log("PAGE_CRASH"));
page.on("close", () => console.log("PAGE_CLOSED"));
browser.on("disconnected", () => console.log("BROWSER_DISCONNECTED"));
page.on("console", (message) => {
  if (message.type() === "error" || /WebAV|Combinator|combinate|OutputProgress|QV_NATIVE|视频/.test(message.text())) console.log(`browser console ${message.type()}: ${message.text()}`);
});

try {
  console.log("open login");
  await page.goto(`${BASE}/#/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[autocomplete="username"]').fill("admin");
  await page.locator('input[type="password"]').fill("admin123");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL("**/#/project", { timeout: 30000 });
  console.log("logged in");

  const skip = page.getByText("跳过引导", { exact: true });
  if (await skip.count() && await skip.first().isVisible().catch(() => false)) await skip.first().click();
  const projectCard = page.locator(".project .card").filter({ hasText: PROJECT_NAME }).first();
  await projectCard.waitFor({ state: "visible", timeout: 30000 });
  await projectCard.click();
  await page.waitForURL("**/#/quickVideo", { timeout: 30000 });
  console.log("opened quick video workspace");

  const exportButton = page.getByRole("button", { name: "导出成片 MP4" });
  await exportButton.waitFor({ state: "visible", timeout: 30000 });
  await exportButton.waitFor({ state: "attached", timeout: 30000 });
  const enableStarted = Date.now();
  while (await exportButton.isDisabled()) {
    if (Date.now() - enableStarted > 180000) throw new Error("导出按钮等待超时");
    await page.waitForTimeout(1000);
  }
  console.log("timeline ready");

  await exportButton.click();
  await page.getByText("成片导出确认", { exact: true }).waitFor({ state: "visible", timeout: 10000 });

  const audioEncoder = await page.evaluate(async () => {
    const encoder = globalThis.AudioEncoder;
    if (!encoder?.isConfigSupported) return false;
    try {
      return Boolean((await encoder.isConfigSupported({
        codec: "mp4a.40.2",
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 128000,
      })).supported);
    } catch {
      return false;
    }
  });
  console.log(`AAC encoder supported: ${audioEncoder}`);

  console.log("EXPORT_BUTTONS", JSON.stringify(await page.locator("button").evaluateAll((buttons) => buttons.filter((button) => button.textContent?.includes("导出")).map((button) => ({ text: button.textContent, disabled: button.disabled, outer: button.outerHTML.slice(0, 500) })) )));
  const downloadPromise = page.waitForEvent("download", { timeout: EXPORT_TIMEOUT_MS });
  const confirmPromise = page.waitForResponse(
    (response) => response.url().includes("/api/quickVideo/confirmStage") && response.request().method() === "POST",
    { timeout: EXPORT_TIMEOUT_MS },
  );
  await page.getByRole("button", { name: "确认并开始导出" }).click();
  console.log("EXPORT_TRIGGERED");
  const debugTimer = setInterval(async () => {
    const snapshot = await page.evaluate(() => ({
      percent: document.querySelector('[data-testid="qv-export-percent"]')?.textContent,
      videos: [...document.querySelectorAll("video")].map((video) => ({ currentTime: video.currentTime, readyState: video.readyState, ended: video.ended, paused: video.paused })),
    })).catch(() => null);
    console.log(`EXPORT_DEBUG ${JSON.stringify(snapshot)}`);
  }, 5000);
  const [download, confirmResponse] = await Promise.all([downloadPromise, confirmPromise]);
  clearInterval(debugTimer);
  const confirmBody = await confirmResponse.json();
  if (!confirmResponse.ok() || confirmBody.code !== 200 || confirmBody.data?.state?.stage !== "completed") {
    throw new Error(`导出确认失败: ${JSON.stringify(confirmBody)}`);
  }

  const downloadedPath = await download.path();
  if (!downloadedPath) throw new Error("未获得下载文件");
  const stat = fs.statSync(downloadedPath);
  const probe = JSON.parse(execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=format_name,duration:stream=codec_type,codec_name",
    "-of", "json",
    downloadedPath,
  ], { encoding: "utf8" }));
  const duration = Number(probe.format.duration);
  const hasVideo = probe.streams.some((stream) => stream.codec_type === "video");
  const hasAudio = probe.streams.some((stream) => stream.codec_type === "audio");
  if (!stat.size || !probe.format.format_name.includes("mp4") || Math.abs(duration - EXPECTED_DURATION) > 1 || !hasVideo) {
    throw new Error(`MP4 校验失败: ${JSON.stringify({ expectedDuration: EXPECTED_DURATION, size: stat.size, probe })}`);
  }
  if (audioEncoder && !hasAudio) throw new Error("浏览器支持 AAC 但导出没有音轨");
  await page.getByText("最近导出", { exact: false }).waitFor({ state: "visible", timeout: 30000 });
  console.log(JSON.stringify({
    fileName: download.suggestedFilename(),
    bytes: stat.size,
    durationSeconds: duration,
    expectedDurationSeconds: EXPECTED_DURATION,
    streams: probe.streams,
    audioEncoder,
    pageErrors,
  }));
  console.log("BROWSER_EXPORT_OK");
} finally {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}
