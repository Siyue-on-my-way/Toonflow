import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const BASE = "http://localhost:2280";
const PROJECT_NAME = "验收快创-30s-1788729454659";

test.use({
  acceptDownloads: true,
  viewport: { width: 1600, height: 1200 },
  launchOptions: {
    executablePath: "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  },
});

test("existing 30s quick video exports a playable MP4", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(`${BASE}/#/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[autocomplete="username"]').fill("admin");
  await page.locator('input[type="password"]').fill("admin123");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL("**/#/project", { timeout: 30000 });

  const projectCard = page.locator(".project .card").filter({ hasText: PROJECT_NAME }).first();
  await expect(projectCard).toBeVisible({ timeout: 30000 });
  await projectCard.click();
  await page.waitForURL("**/#/quickVideo", { timeout: 30000 });

  const exportButton = page.getByRole("button", { name: "导出成片 MP4" });
  await expect(exportButton).toBeEnabled({ timeout: 180000 });

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

  await exportButton.click();
  await expect(page.getByText("成片导出确认", { exact: true })).toBeVisible({ timeout: 10000 });

  const downloadPromise = page.waitForEvent("download", { timeout: 180000 });
  const confirmPromise = page.waitForResponse(
    (response) => response.url().includes("/api/quickVideo/confirmStage") && response.request().method() === "POST",
    { timeout: 180000 },
  );
  await page.getByRole("button", { name: "确认并开始导出" }).click();
  const [download, confirmResponse] = await Promise.all([downloadPromise, confirmPromise]);
  expect(confirmResponse.ok()).toBeTruthy();
  const confirmBody = await confirmResponse.json();
  expect(confirmBody.code).toBe(200);
  expect(confirmBody.data.state.stage).toBe("completed");

  const downloadedPath = await download.path();
  expect(downloadedPath).toBeTruthy();
  const stat = fs.statSync(downloadedPath);
  expect(stat.size).toBeGreaterThan(1000);
  const probe = JSON.parse(execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=format_name,duration:stream=codec_type,codec_name",
    "-of", "json",
    downloadedPath,
  ], { encoding: "utf8" }));
  expect(probe.format.format_name).toContain("mp4");
  expect(Number(probe.format.duration)).toBeGreaterThan(29);
  expect(Number(probe.format.duration)).toBeLessThan(31);
  expect(probe.streams.some((stream) => stream.codec_type === "video")).toBeTruthy();
  const hasAudio = probe.streams.some((stream) => stream.codec_type === "audio");
  console.log(JSON.stringify({
    fileName: download.suggestedFilename(),
    bytes: stat.size,
    durationSeconds: Number(probe.format.duration),
    streams: probe.streams,
    audioEncoder,
    pageErrors,
  }));
  if (audioEncoder) expect(hasAudio).toBeTruthy();

  await expect(page.getByText("最近导出", { exact: false })).toBeVisible({ timeout: 30000 });
});
