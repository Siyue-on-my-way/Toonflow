import { describe, expect, it } from "vitest";
import { buildImageFillPrompt, buildVideoFillPrompt, buildShotPromptCopyText, buildMultiShotPrompt } from "../shotPrompts";
import type { QuickVideoShot } from "@/types/quickVideo";

function makeShot(patch: Partial<QuickVideoShot> = {}): QuickVideoShot {
  return {
    id: "shot-1",
    index: 1,
    duration: 5,
    description: "小猫在花园里追蝴蝶",
    dialogue: "",
    camera: "全景",
    imagePrompt: "",
    videoPrompt: "",
    assetRefs: [],
    imageState: "pending",
    videoState: "pending",
    imageRef: null,
    videoRef: null,
    errorReason: null,
    firstFrame: null,
    ...patch,
  };
}

describe("buildImageFillPrompt", () => {
  it("优先使用策划的 imagePrompt", () => {
    const shot = makeShot({ imagePrompt: "特写：橘猫扑蝶，水彩画风，柔和晨光" });
    expect(buildImageFillPrompt(shot)).toBe("特写：橘猫扑蝶，水彩画风，柔和晨光");
  });

  it("imagePrompt 未填写时回退画面描述", () => {
    expect(buildImageFillPrompt(makeShot())).toBe("小猫在花园里追蝴蝶");
  });

  it("纯空白 imagePrompt 视为未填写", () => {
    expect(buildImageFillPrompt(makeShot({ imagePrompt: "   " }))).toBe("小猫在花园里追蝴蝶");
  });
});

describe("buildVideoFillPrompt", () => {
  it("优先使用策划的 videoPrompt", () => {
    const shot = makeShot({ videoPrompt: "镜头缓慢推进，猫跃起扑蝶，蝴蝶四散" });
    expect(buildVideoFillPrompt(shot)).toBe("镜头缓慢推进，猫跃起扑蝶，蝴蝶四散");
  });

  it("videoPrompt 未填写时按画面描述 + 运镜拼装", () => {
    expect(buildVideoFillPrompt(makeShot())).toBe("小猫在花园里追蝴蝶，运镜：全景");
  });

  it("无运镜时只保留画面描述", () => {
    expect(buildVideoFillPrompt(makeShot({ camera: "" }))).toBe("小猫在花园里追蝴蝶");
  });
});

describe("buildShotPromptCopyText", () => {
  it("包含镜号、时长与双提示词", () => {
    const shot = makeShot({
      index: 3,
      duration: 8,
      imagePrompt: "特写：橘猫扑蝶",
      videoPrompt: "镜头缓慢推进",
      dialogue: "看那只猫！",
    });
    const text = buildShotPromptCopyText(shot);
    expect(text).toContain("镜头3（8s）");
    expect(text).toContain("画面：小猫在花园里追蝴蝶");
    expect(text).toContain("生图提示词：特写：橘猫扑蝶");
    expect(text).toContain("生视频提示词：镜头缓慢推进");
    expect(text).toContain("台词：看那只猫！");
  });

  it("无台词时不输出台词行", () => {
    expect(buildShotPromptCopyText(makeShot())).not.toContain("台词：");
  });
});

describe("buildMultiShotPrompt", () => {
  it("按镜头序号输出多镜语法块", () => {
    const shots = [
      makeShot({ index: 1, videoPrompt: "猫扑蝴蝶" }),
      makeShot({ index: 2, description: "猫趴着打盹", camera: "特写" }),
    ];
    expect(buildMultiShotPrompt(shots)).toBe("镜头1：猫扑蝴蝶\n镜头2：猫趴着打盹，运镜：特写");
  });

  it("提示词缺失时使用占位文案", () => {
    const shots = [makeShot({ index: 1, description: "", camera: "" })];
    expect(buildMultiShotPrompt(shots)).toBe("镜头1：（待补充画面描述）");
  });
});
