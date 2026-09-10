/**
 * 快创时间线核心逻辑单元测试（SIY-111）—— 与后端 scripts/quickvideo-timeline-unit.ts 同一套期望值，
 * 保证前端"以实际媒体时长重新适配"的数学与服务端规划一致。
 */
import { describe, expect, it } from "vitest";
import { buildSubtitleCues, buildTimelinePlan, clampSubtitleText, estimateExportBytes, formatBytes, formatTime, toEmbedSubtitleStructs } from "../timelineCore";
import type { QuickVideoDuration, QuickVideoRatio } from "@/types/quickVideo";

const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;
const shots = (specs: [string, number, string?][]) => specs.map(([id, duration, dialogue], i) => ({ id, index: i + 1, duration, dialogue: dialogue ?? "" }));

describe("buildTimelinePlan", () => {
  it("转场重叠下精确贴合：rate = S/L，总时长=目标", () => {
    const plan = buildTimelinePlan({ shots: shots([["shot-1", 10], ["shot-2", 12], ["shot-3", 8]]), targetDuration: 30, videoRatio: "16:9" });
    const r = 30 / 31; // L = 30 + 2*0.5
    expect(plan.clips).toHaveLength(3);
    plan.clips.forEach((c) => expect(c.playbackRate).toBeCloseTo(r, 6));
    expect(plan.totalDuration).toBeCloseTo(30, 3);
    expect(plan.transitions).toHaveLength(2);
    expect(plan.transitions[0]).toMatchObject({ afterShotId: "shot-1", type: "crossfade", duration: 0.5 });
    expect(plan.clips[1].start).toBeCloseTo(plan.clips[0].end - 0.5, 6);
    expect(plan.tailPad).toBeNull();
  });

  it("单镜头无转场，原速播放", () => {
    const plan = buildTimelinePlan({ shots: shots([["shot-1", 15]]), targetDuration: 15, videoRatio: "9:16" });
    expect(plan.clips[0].playbackRate).toBe(1);
    expect(plan.transitions).toHaveLength(0);
    expect(plan.totalDuration).toBeCloseTo(15, 3);
  });

  it("内容过多：按上限 1.5x 加速并按比例裁剪源窗口", () => {
    const plan = buildTimelinePlan({ shots: shots([["shot-1", 20], ["shot-2", 20], ["shot-3", 20]]), targetDuration: 15, videoRatio: "9:16" });
    plan.clips.forEach((c) => {
      expect(c.playbackRate).toBe(1.5);
      expect(c.trimEnd).toBeCloseTo(8, 6);
      expect(c.trimStart).toBe(0);
    });
    expect(plan.totalDuration).toBeCloseTo(15, 3);
    expect(plan.tailPad).toBeNull();
  });

  it("内容不足：按 0.75x 放慢，片尾 CTA 定版补齐", () => {
    const plan = buildTimelinePlan({ shots: shots([["shot-1", 8]]), targetDuration: 15, videoRatio: "1:1", ctaText: "点击下单" });
    expect(plan.clips[0].playbackRate).toBe(0.75);
    expect(plan.tailPad).not.toBeNull();
    expect(plan.tailPad!.duration).toBeCloseTo(15 - 8 / 0.75, 3);
    expect(plan.tailPad!.text).toBe("点击下单");
    expect(plan.clips[0].end + plan.tailPad!.duration).toBeCloseTo(15, 3);
  });

  it("乱序输入按 index 重排；分辨率按比例推导", () => {
    const plan = buildTimelinePlan({
      shots: [{ id: "b", index: 2, duration: 15 }, { id: "a", index: 1, duration: 15 }],
      targetDuration: 30,
      videoRatio: "16:9",
    });
    expect(plan.clips.map((c) => c.shotId)).toEqual(["a", "b"]);
    expect(plan.width).toBe(1280);
    expect(plan.height).toBe(720);
  });
});

describe("buildSubtitleCues / 字幕轨", () => {
  it("空台词跳过；可见区间避开转场重叠", () => {
    const plan = buildTimelinePlan({
      shots: shots([["shot-1", 10, " 开场台词 "], ["shot-2", 10, ""], ["shot-3", 10, "结尾台词"]]),
      targetDuration: 30,
      videoRatio: "16:9",
    });
    const cues = buildSubtitleCues(plan);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe("开场台词");
    expect(cues[0].start).toBe(0);
    const r = 30 / 31;
    expect(cues[0].end).toBeCloseTo(10 / r - 0.5, 3);
    expect(cues[1].start).toBeCloseTo(10 / r - 0.5 + 10 / r, 3);
    expect(cues[1].end).toBeCloseTo(plan.totalDuration, 3);
  });

  it("toEmbedSubtitleStructs 转换为微秒（EmbedSubtitlesClip 数组入参约定）", () => {
    const structs = toEmbedSubtitleStructs([{ start: 1.5, end: 3.25, text: "你好" }]);
    expect(structs[0]).toEqual({ start: 1_500_000, end: 3_250_000, text: "你好" });
  });

  it("clampSubtitleText 限制字幕总字符数并保留 Unicode 字符边界", () => {
    expect(clampSubtitleText("  你好   世界  ", 4, 2)).toBe("你好 世界");
    expect(clampSubtitleText("一二三四五六七八", 4, 2)).toBe("一二三四五六七八");
    expect(clampSubtitleText("一二三四五六七八九十", 4, 2)).toBe("一二三四五六七…");
    expect(clampSubtitleText("", 4, 2)).toBe("");
  });
});

describe("展示辅助", () => {
  it("formatTime 输出 mm:ss", () => {
    expect(formatTime(0)).toBe("00:00");
    expect(formatTime(59.4)).toBe("00:59");
    expect(formatTime(75)).toBe("01:15");
  });

  it("estimateExportBytes 按分辨率夹紧码率", () => {
    const b720 = estimateExportBytes(1280, 720, 30);
    expect(b720).toBeGreaterThan(0);
    expect(estimateExportBytes(1280, 720, 60)).toBeCloseTo(b720 * 2, -1);
    expect(estimateExportBytes(100, 100, 30)).toBe(Math.round((2.5e6 / 8) * 30)); // 低分辨率触底 2.5Mbps
    expect(formatBytes(5_300_000)).toBe("5.3 MB");
  });
});

describe("类型回归", () => {
  it("时长/比例枚举保持 15/30/60 与三种比例", () => {
    const durations: readonly QuickVideoDuration[] = [15, 30, 60];
    const ratios: readonly QuickVideoRatio[] = ["16:9", "9:16", "1:1"];
    expect(durations).toHaveLength(3);
    expect(ratios).toHaveLength(3);
  });
});
