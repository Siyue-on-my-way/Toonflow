import { buildRunningHubRequestBody, findRunningHubModelSpec } from "./src/vendors/runninghub-models";

function assertEqual(actual: any, expected: any, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL ${label}\n  actual:   ${a}\n  expected: ${e}`);
    process.exitCode = 1;
  } else {
    console.log(`OK   ${label}`);
  }
}

// rhart-image-n-g31-flash: replicate old imageRequest branch
{
  const spec = findRunningHubModelSpec("rhart-image-n-g31-flash", "image")!;
  const config = { prompt: "p1", aspectRatio: "16:9", size: "1K", referenceList: [{ type: "image", base64: "data:image/png;base64,AAA" }] };
  const imageRefs = config.referenceList.map(r => r.base64);
  const body = buildRunningHubRequestBody(spec, config, imageRefs);
  assertEqual(body, { prompt: "p1", aspectRatio: "16:9", resolution: "1k", imageUrls: ["data:image/png;base64,AAA"] }, "rhart-image-n-g31-flash");
}

// kling-video-o3-pro text-to-video, audio undefined -> sound:false
{
  const spec = findRunningHubModelSpec("kling-video-o3-pro", "video")!;
  const config = { prompt: "p2", aspectRatio: "16:9", duration: 5, mode: ["text"] };
  const body = buildRunningHubRequestBody(spec, config, []);
  assertEqual(body, { prompt: "p2", aspectRatio: "16:9", duration: "5", sound: false, multiShot: false, shotType: "customize" }, "kling-video-o3-pro (no audio)");
}

// kling-video-o3-pro with audio true, wrong mode -> should throw
{
  const spec = findRunningHubModelSpec("kling-video-o3-pro", "video")!;
  const config = { prompt: "p2", aspectRatio: "16:9", duration: 5, audio: true, mode: ["singleImage"] };
  try {
    buildRunningHubRequestBody(spec, config, []);
    console.error("FAIL kling-video-o3-pro should throw on non-text mode");
    process.exitCode = 1;
  } catch (e: any) {
    assertEqual(e.message, "该模型仅支持文生视频模式", "kling-video-o3-pro mode guard");
  }
}

// kling-v3.0-pro singleImage with 1 ref
{
  const spec = findRunningHubModelSpec("kling-v3.0-pro", "video")!;
  const config = { prompt: "p3", aspectRatio: "9:16", duration: 5, audio: true, mode: ["singleImage"] };
  const body = buildRunningHubRequestBody(spec, config, ["img0"]);
  assertEqual(body, { prompt: "p3", aspectRatio: "9:16", duration: "5", sound: true, firstImageUrl: "img0", cfgScale: 0.5, multiShot: false, shotType: "customize" }, "kling-v3.0-pro singleImage");
}

// kling-v3.0-pro startEndRequired with 2 refs
{
  const spec = findRunningHubModelSpec("kling-v3.0-pro", "video")!;
  const config = { prompt: "p3", aspectRatio: "9:16", duration: 10, audio: false, mode: ["startEndRequired"] };
  const body = buildRunningHubRequestBody(spec, config, ["img0", "img1"]);
  assertEqual(body, { prompt: "p3", aspectRatio: "9:16", duration: "10", sound: false, firstImageUrl: "img0", lastImageUrl: "img1", cfgScale: 0.5, multiShot: false, shotType: "customize" }, "kling-v3.0-pro startEndRequired");
}

// kling-v3.0-pro no refs -> throw
{
  const spec = findRunningHubModelSpec("kling-v3.0-pro", "video")!;
  const config = { prompt: "p3", aspectRatio: "9:16", duration: 10, audio: false, mode: ["singleImage"] };
  try {
    buildRunningHubRequestBody(spec, config, []);
    console.error("FAIL kling-v3.0-pro should throw when no images");
    process.exitCode = 1;
  } catch (e: any) {
    assertEqual(e.message, "图生视频模式需要提供参考图片", "kling-v3.0-pro required image guard");
  }
}

// rhart-video/minimax-h3-oss/fl2va, long-format aspectRatio + float duration, no images
{
  const spec = findRunningHubModelSpec("rhart-video/minimax-h3-oss/fl2va", "video")!;
  const config = { prompt: "p4", aspectRatio: "9:16", duration: 5 };
  const body = buildRunningHubRequestBody(spec, config, []);
  assertEqual(body, { prompt: "p4", aspectRatio: "9:16 (Portrait Widescreen)", duration: 5 }, "fl2va no images");
}

// rhart-video/minimax-h3-oss/fl2va with both frames
{
  const spec = findRunningHubModelSpec("rhart-video/minimax-h3-oss/fl2va", "video")!;
  const config = { prompt: "p4", aspectRatio: "16:9", duration: 8 };
  const body = buildRunningHubRequestBody(spec, config, ["f0", "f1"]);
  assertEqual(body, { prompt: "p4", aspectRatio: "16:9 (Widescreen)", duration: 8, firstFrameUrl: "f0", lastFrameUrl: "f1" }, "fl2va both frames");
}

// rhart-video-v3.1-fast, array imageUrls max 3
{
  const spec = findRunningHubModelSpec("rhart-video-v3.1-fast", "video")!;
  const config = { prompt: "p5", aspectRatio: "16:9", duration: 8, resolution: "720p" };
  const body = buildRunningHubRequestBody(spec, config, ["a", "b", "c", "d"]);
  assertEqual(body, { prompt: "p5", aspectRatio: "16:9", duration: "8", resolution: "720p", imageUrls: ["a", "b", "c"] }, "rhart-video-v3.1-fast array cap at 3");
}

// rhart-video-v3.1-fast requires at least 1 image
{
  const spec = findRunningHubModelSpec("rhart-video-v3.1-fast", "video")!;
  const config = { prompt: "p5", aspectRatio: "16:9", duration: 8, resolution: "720p" };
  try {
    buildRunningHubRequestBody(spec, config, []);
    console.error("FAIL rhart-video-v3.1-fast should throw when no images");
    process.exitCode = 1;
  } catch (e: any) {
    assertEqual(e.message, "图生视频模式需要提供参考图片", "rhart-video-v3.1-fast required image guard");
  }
}

// rhart-image-g-2 文生图：不带参考图，不下发 imageUrls，resolution 小写映射
{
  const spec = findRunningHubModelSpec("rhart-image-g-2", "image")!;
  const config = { prompt: "p6", aspectRatio: "16:9", size: "2K", mode: ["text"] };
  const body = buildRunningHubRequestBody(spec, config, []);
  assertEqual(body, { prompt: "p6", aspectRatio: "16:9", resolution: "2k" }, "g-2 text mode no imageUrls");
}

// rhart-image-g-2 图生图：参考图写入 imageUrls（doc: imageUrls 必填，<=10 张）
{
  const spec = findRunningHubModelSpec("rhart-image-g-2", "image")!;
  const config = { prompt: "p6", aspectRatio: "9:16", size: "1K", mode: ["singleImage"] };
  const body = buildRunningHubRequestBody(spec, config, ["data:image/png;base64,AAA", "data:image/png;base64,BBB"]);
  assertEqual(
    body,
    { prompt: "p6", aspectRatio: "9:16", resolution: "1k", imageUrls: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"] },
    "g-2 image mode imageUrls",
  );
}

// rhart-image-g-2 多图上限 10 张
{
  const spec = findRunningHubModelSpec("rhart-image-g-2", "image")!;
  const refs = Array.from({ length: 12 }, (_, i) => `img${i}`);
  const body = buildRunningHubRequestBody(spec, { prompt: "p6", mode: ["multiReference"] }, refs);
  assertEqual(body.imageUrls.length, 10, "g-2 imageUrls cap at 10");
}

// rhart-image-g-2 prompt 长度 1-20000
{
  const spec = findRunningHubModelSpec("rhart-image-g-2", "image")!;
  try {
    buildRunningHubRequestBody(spec, { prompt: "", mode: ["text"] }, []);
    console.error("FAIL g-2 should throw on empty prompt");
    process.exitCode = 1;
  } catch (e: any) {
    assertEqual(e.message, "Prompt 长度必须在 1-20000 个字符之间", "g-2 prompt min length");
  }
  try {
    buildRunningHubRequestBody(spec, { prompt: "x".repeat(20001), mode: ["text"] }, []);
    console.error("FAIL g-2 should throw on 20001-char prompt");
    process.exitCode = 1;
  } catch (e: any) {
    assertEqual(e.message, "Prompt 长度必须在 1-20000 个字符之间", "g-2 prompt max length");
  }
}

// rhart-image-g-2 比例 / 分辨率枚举校验
{
  const spec = findRunningHubModelSpec("rhart-image-g-2", "image")!;
  try {
    buildRunningHubRequestBody(spec, { prompt: "p6", aspectRatio: "7:5", mode: ["text"] }, []);
    console.error("FAIL g-2 should throw on invalid aspectRatio");
    process.exitCode = 1;
  } catch (e: any) {
    assertEqual(e.message, "不支持的图像比例: 7:5", "g-2 ratio guard");
  }
  try {
    buildRunningHubRequestBody(spec, { prompt: "p6", size: "8K", mode: ["text"] }, []);
    console.error("FAIL g-2 should throw on invalid resolution");
    process.exitCode = 1;
  } catch (e: any) {
    assertEqual(e.message, "不支持的图像分辨率: 8K", "g-2 resolution guard");
  }
}

// Seedance 2.0 Fast / Mini 共用字段规则，但 endpoint 各自独立
{
  const fast = findRunningHubModelSpec("seedance-2.0-fast", "video")!;
  const mini = findRunningHubModelSpec("seedance-2.0-mini", "video")!;
  assertEqual(fast.endpoint, "rhart-video/sparkvideo-2.0-fast/multimodal-video", "seedance fast endpoint");
  assertEqual(mini.endpoint, "rhart-video/sparkvideo-2.0-mini/multimodal-video", "seedance mini endpoint");
}

// Seedance Mini 纯文本请求：duration 转字符串，不下发空素材数组
{
  const spec = findRunningHubModelSpec("seedance-2.0-mini", "video")!;
  const body = buildRunningHubRequestBody(spec, {
    prompt: "A gentle camera push-in over a calm blue ocean at sunrise",
    resolution: "480p", duration: 4, aspectRatio: "16:9", generateAudio: false,
  }, []);
  assertEqual(
    body,
    { prompt: "A gentle camera push-in over a calm blue ocean at sunrise", resolution: "480p", duration: "4", ratio: "16:9", generateAudio: false },
    "seedance mini text-only body",
  );
}

// Seedance Mini 图片/视频/音频分别落到三个数组（与 videoRequest 分流后的 config 形状一致）
{
  const spec = findRunningHubModelSpec("seedance-2.0-mini", "video")!;
  const body = buildRunningHubRequestBody(spec, {
    prompt: "p", resolution: "1080p", duration: 8, aspectRatio: "adaptive",
    imageUrls: ["i1", "i2"], videoUrls: ["v1"], audioUrls: ["a1"],
  }, []);
  assertEqual(
    body,
    {
      prompt: "p", resolution: "1080p", duration: "8", ratio: "adaptive",
      imageUrls: ["i1", "i2"], videoUrls: ["v1"], audioUrls: ["a1"],
    },
    "seedance mini media arrays",
  );
}

// Seedance Mini 参数边界在请求发出前报错
{
  const spec = findRunningHubModelSpec("seedance-2.0-mini", "video")!;
  const cases: Array<[Record<string, any>, string]> = [
    [{ prompt: "", resolution: "480p", duration: 4 }, "seedance mini empty prompt"],
    [{ prompt: "p", resolution: "480p", duration: 3 }, "seedance mini duration below range"],
    [{ prompt: "p", resolution: "360p", duration: 4 }, "seedance mini invalid resolution"],
    [{ prompt: "p", resolution: "480p", duration: 4, aspectRatio: "2:1" }, "seedance mini invalid ratio"],
  ];
  for (const [config, label] of cases) {
    try {
      buildRunningHubRequestBody(spec, config, []);
      console.error(`FAIL ${label} should throw`);
      process.exitCode = 1;
    } catch {
      console.log(`OK   ${label}`);
    }
  }
}

// Seedance Fast 回归：纯文本请求体保持不变
{
  const spec = findRunningHubModelSpec("seedance-2.0-fast", "video")!;
  const body = buildRunningHubRequestBody(spec, { prompt: "p", resolution: "720p", duration: -1, aspectRatio: "9:16" }, []);
  assertEqual(body, { prompt: "p", resolution: "720p", duration: "-1", ratio: "9:16" }, "seedance fast text-only regression");
}

// unknown model -> undefined spec
{
  const spec = findRunningHubModelSpec("does-not-exist", "video");
  assertEqual(spec, undefined, "unknown model spec lookup");
}

if (process.exitCode) {
  console.log("\nSome checks FAILED");
} else {
  console.log("\nAll checks passed");
}
