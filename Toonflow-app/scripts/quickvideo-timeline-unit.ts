/**
 * QuickVideo / 单视频快创 —— 时间线装配规划单元测试（SIY-111）
 * 纯函数测试，无需启动服务：
 *   npx tsx scripts/quickvideo-timeline-unit.ts
 *
 * 覆盖 buildTimelinePlan 的适配数学（变速/裁剪/补齐/转场/字幕/尺寸）
 * 与契约 schema 的向后兼容（存量状态缺新字段时补默认值）。
 */
import {
  QUICK_VIDEO_DIMENSIONS,
  QUICK_VIDEO_DURATION_MAX,
  QUICK_VIDEO_DURATION_MIN,
  QUICK_VIDEO_RATIOS,
  quickVideoStateSchema,
  type QuickVideoTimelinePlan,
} from "@/lib/quickVideo/contract";
import { buildSubtitleCues, buildTimelinePlan } from "@/lib/quickVideo/timeline";

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
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const shots = (specs: [string, number, string?][]) =>
  specs.map(([id, duration, dialogue], i) => ({ id, index: i + 1, duration, dialogue: dialogue ?? "" }));

console.log("== 1. 转场重叠下的精确贴合（rate = S/L） ==");
{
  // 3 镜 S=30s，目标 30s：转场占 2×0.5s，需要 L=31s 媒体 → 整体放慢 r = 30/31 ≈ 0.968（约 3% 慢放，无感）
  const plan = buildTimelinePlan({ shots: shots([["shot-1", 10, "第一句"], ["shot-2", 12], ["shot-3", 8, "第三句"]]), targetDuration: 30, videoRatio: "16:9" });
  const r = 30 / 31;
  assert(plan.clips.length === 3, "3 个片段");
  assert(near(plan.totalDuration, 30, 1e-4), "总时长 = 目标 30s（累计舍入 ±0.1ms）", String(plan.totalDuration));
  assert(plan.clips.every((c) => near(c.playbackRate, r)), `整体速率 = S/L = ${r.toFixed(4)}`, JSON.stringify(plan.clips.map((c) => c.playbackRate)));
  assert(plan.transitions.length === 2 && plan.transitions.every((t) => t.type === "crossfade" && near(t.duration, 0.5)), "2 处 0.5s crossfade");
  assert(near(plan.clips[0].end - plan.clips[0].start, 10 / r, 1e-4) && near(plan.clips[1].end - plan.clips[1].start, 12 / r, 1e-4), "片段时长 = 镜头时长/rate", String(plan.clips[0].end - plan.clips[0].start));
  assert(near(plan.clips[1].start, plan.clips[0].end - 0.5, 1e-4), "相邻片段在转场处重叠 0.5s");
  assert(plan.tailPad === null, "无片尾补齐");
}

console.log("== 2. 单镜头精确贴合（rate=1）与净播放时长 ==");
{
  const plan = buildTimelinePlan({ shots: shots([["shot-1", 15, "唯一镜头"]]), targetDuration: 15, videoRatio: "9:16" });
  assert(plan.clips.every((c) => near(c.playbackRate, 1)), "单镜头无转场时原速播放", String(plan.clips[0].playbackRate));
  assert(near(plan.totalDuration, 15, 1e-4), "总时长 = 15s", String(plan.totalDuration));
  assert(plan.transitions.length === 0 && plan.tailPad === null, "无转场无补齐");

  const plan3 = buildTimelinePlan({ shots: shots([["shot-1", 10], ["shot-2", 12], ["shot-3", 8]]), targetDuration: 30, videoRatio: "16:9" });
  const mediaTotal = plan3.clips.reduce((s, c) => s + (c.end - c.start), 0) - 2 * 0.5;
  assert(near(mediaTotal, 30, 1e-4), "去重叠后净播放时长 = 30s", String(mediaTotal));
}

console.log("== 3. 内容过多：整体加速 + 按比例裁剪源窗口 ==");
{
  // 3 镜共 60s 源，目标 15s：L = 16, r0 = 3.75 > 1.5 → r = 1.5, f = 16*1.5/60 = 0.4
  const plan = buildTimelinePlan({ shots: shots([["shot-1", 20], ["shot-2", 20], ["shot-3", 20]]), targetDuration: 15, videoRatio: "9:16" });
  assert(plan.clips.every((c) => near(c.playbackRate, 1.5)), "加速到上限 1.5x", String(plan.clips[0].playbackRate));
  assert(plan.clips.every((c) => near(c.trimStart, 0) && near(c.trimEnd, 8)), "源窗口按比例裁剪到 8s（保留开头）", JSON.stringify(plan.clips.map((c) => c.trimEnd)));
  assert(near(plan.totalDuration, 15), "总时长 = 15s", String(plan.totalDuration));
  assert(plan.tailPad === null, "无需补齐");
}

console.log("== 4. 内容不足：放慢到下限 + 片尾定版补齐 ==");
{
  // 1 镜 8s，目标 15s：r0 = 8/15 < 0.75 → r = 0.75，媒体 10.667s，补 4.333s
  const plan = buildTimelinePlan({ shots: shots([["shot-1", 8]]), targetDuration: 15, videoRatio: "1:1", ctaText: "点击下单" });
  assert(near(plan.clips[0].playbackRate, 0.75), "放慢到下限 0.75x", String(plan.clips[0].playbackRate));
  assert(plan.tailPad !== null, "有片尾补齐");
  assert(near(plan.tailPad!.duration, 15 - 8 / 0.75, 1e-3), `补齐时长 = ${15 - 8 / 0.75}`, String(plan.tailPad!.duration));
  assert(plan.tailPad!.text === "点击下单", "补齐定版携带 CTA 文案");
  assert(near(plan.clips[0].end + plan.tailPad!.duration, 15, 1e-3), "总时长补齐到 15s");
  assert(plan.transitions.length === 0, "单镜头无转场");
}

console.log("== 5. 字幕时间轴（避开转场重叠区） ==");
{
  const plan = buildTimelinePlan({
    shots: shots([["shot-1", 10, " 开场台词 "], ["shot-2", 10, ""], ["shot-3", 10, "结尾台词"]]),
    targetDuration: 30,
    videoRatio: "16:9",
  });
  const r = 30 / 31;
  const dur = (d: number) => d / r;
  const cues = buildSubtitleCues(plan);
  assert(cues.length === 2, "空台词不生成字幕，共 2 条", JSON.stringify(cues));
  const e1 = dur(10);
  assert(near(cues[0].start, 0) && near(cues[0].end, e1 - 0.5, 1e-3), "第一条：0 → 首段结束-0.5s", JSON.stringify(cues[0]));
  const start3 = e1 - 0.5 + dur(10) - 0.5;
  assert(near(cues[1].start, start3 + 0.5, 1e-3), "第二条：第三段开始+0.5s", JSON.stringify(cues[1]));
  assert(near(cues[1].end, plan.totalDuration, 1e-3), "末条字幕到片尾", JSON.stringify(cues[1]));
  assert(cues[0].text === "开场台词", "字幕文本已去首尾空白");
}

console.log("== 6. 尺寸推导与排序稳定性 ==");
{
  assert(QUICK_VIDEO_DIMENSIONS["16:9"].width === 1280 && QUICK_VIDEO_DIMENSIONS["16:9"].height === 720, "16:9 → 1280x720");
  assert(QUICK_VIDEO_DIMENSIONS["9:16"].width === 720 && QUICK_VIDEO_DIMENSIONS["9:16"].height === 1280, "9:16 → 720x1280");
  assert(QUICK_VIDEO_DIMENSIONS["1:1"].width === 960 && QUICK_VIDEO_DIMENSIONS["1:1"].height === 960, "1:1 → 960x960");
  // 乱序输入按 index 排序
  const plan = buildTimelinePlan({
    shots: [{ id: "b", index: 2, duration: 15 }, { id: "a", index: 1, duration: 15 }],
    targetDuration: 30,
    videoRatio: "16:9",
  });
  assert(plan.clips[0].shotId === "a" && plan.clips[1].shotId === "b", "乱序输入按 index 重排");
  const dims = plan.width * plan.height;
  assert(dims === 1280 * 720, "规划携带输出分辨率");
}

console.log("== 7. plan 满足契约 schema ==");
{
  const plan: QuickVideoTimelinePlan = buildTimelinePlan({
    shots: shots([["shot-1", 5, "你好"], ["shot-2", 10]]),
    targetDuration: 15,
    videoRatio: "9:16",
    ctaText: "立即购买",
  });
  // 复用 timelinePlanSchema 校验（通过 quickVideoStateSchema 内部引用，这里直接 parse plan）
  const { timelinePlanSchema } = require("@/lib/quickVideo/contract") as any;
  const parsed = timelinePlanSchema.safeParse(plan);
  assert(parsed.success, "plan 通过 timelinePlanSchema 校验", JSON.stringify(parsed.error?.issues ?? []).slice(0, 200));
}

console.log("== 8. 状态契约向后兼容（存量状态缺新字段） ==");
{
  const legacyState = {
    version: 3,
    stage: "ready_to_assemble",
    targetDuration: 30,
    videoRatio: "16:9",
    artStyle: "国潮",
    createIdempotencyKey: "legacy-0001",
    brief: null,
    storyboard: null,
    appliedKeys: {},
    lastChatAt: null,
    updateTime: 1,
    // 无 generation / schemaVersion 字段
  };
  const parsed = quickVideoStateSchema.safeParse(legacyState);
  assert(parsed.success, "存量状态（缺 generation/schemaVersion）解析通过", JSON.stringify(parsed.error?.issues ?? []).slice(0, 300));
  assert(parsed.success && parsed.data.generation.timeline === null && parsed.data.generation.exportInfo === null, "新字段补默认值 null");
  assert(QUICK_VIDEO_DURATION_MIN === 5 && QUICK_VIDEO_DURATION_MAX === 60 && QUICK_VIDEO_RATIOS.length === 3, "时长范围（5-60 秒，含 15/30/60）与比例枚举不变（不回归）");
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
