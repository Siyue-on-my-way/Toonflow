/** 玩法选择器纯函数测试（SIY-165）：mode 元数据解析、素材类型守门、发送前收集 */
import { describe, expect, it } from "vitest";
import { collectReferenceIdsByPlaymode, isOmniReferenceId, parsePlaymodeOptions, playmodeAllowsKind, playmodeRawModeValue, playmodeRefCap } from "../playmode";

describe("parsePlaymodeOptions（按模型 mode 元数据生成玩法选项）", () => {
  it("字符串模式映射为具名玩法，组合数组映射为全能参考并携带各类型上限", () => {
    const options = parsePlaymodeOptions([
      "text",
      "singleImage",
      "startEndRequired",
      ["imageReference:9", "videoReference:3", "audioReference:3"],
      "unknownMode",
      ["bogus"],
    ]);
    expect(options.map((o) => o.id)).toEqual(["text", "singleImage", "startEndRequired", "omniReference"]);
    expect(options[3].refs).toEqual([
      { type: "imageReference", count: 9 },
      { type: "videoReference", count: 3 },
      { type: "audioReference", count: 3 },
    ]);
  });

  it("多个组合模式 id 唯一化（omniReference / omniReference:2…），菜单项可区分（反馈：同名截断不可辨）", () => {
    const options = parsePlaymodeOptions([
      "text",
      ["imageReference:9"],
      ["videoReference:3"],
      ["imageReference:9", "videoReference:3", "audioReference:3"],
    ]);
    const ids = options.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["text", "omniReference", "omniReference:2", "omniReference:3"]);
    expect(isOmniReferenceId("omniReference")).toBe(true);
    expect(isOmniReferenceId("omniReference:3")).toBe(true);
    expect(isOmniReferenceId("text")).toBe(false);
    // 全部组合类玩法放行视频引用，守门与唯一 id 兼容
    for (const id of ids.filter((i) => String(i).startsWith("omniReference"))) {
      expect(playmodeAllowsKind(id as never, "video")).toBe(true);
    }
  });

  it("非数组输入返回空", () => {
    expect(parsePlaymodeOptions(null)).toEqual([]);
    expect(parsePlaymodeOptions("text")).toEqual([]);
  });

  it("startFrameOptional/endFrameOptional 有独立玩法", () => {
    const options = parsePlaymodeOptions(["startFrameOptional", "endFrameOptional"]);
    expect(options.map((o) => o.labelKey)).toEqual(["firstFrameOptional", "firstFrameTailOptional"]);
  });
});

describe("playmodeAllowsKind（素材类型守门随玩法动态判定）", () => {
  it("图片在所有玩法下恒放行", () => {
    for (const id of ["auto", "text", "singleImage", "startEndRequired", "omniReference", "imageEdit"] as const) {
      expect(playmodeAllowsKind(id, "image")).toBe(true);
    }
  });

  it("视频/音频仅在全能参考玩法放行，智能模式维持仅图片（SIY-164 口径）", () => {
    expect(playmodeAllowsKind("auto", "video")).toBe(false);
    expect(playmodeAllowsKind("text", "video")).toBe(false);
    expect(playmodeAllowsKind("singleImage", "audio")).toBe(false);
    expect(playmodeAllowsKind("omniReference", "video")).toBe(true);
    expect(playmodeAllowsKind("omniReference", "audio")).toBe(true);
  });
});

describe("playmodeRefCap / playmodeRawModeValue", () => {
  it("组合玩法返回各类型上限，未声明为 0", () => {
    const omni = parsePlaymodeOptions([["imageReference:9", "videoReference:3", "audioReference:3"]])[0];
    expect(playmodeRefCap(omni, "image")).toBe(9);
    expect(playmodeRefCap(omni, "video")).toBe(3);
    expect(playmodeRefCap(omni, "audio")).toBe(3);
    const text = parsePlaymodeOptions(["text"])[0];
    expect(playmodeRefCap(text, "video")).toBe(0);
    expect(playmodeRefCap(null, "image")).toBe(0);
  });

  it("raw 值序列化：字符串原样、数组 JSON（与确认卡 mode 字段值同构）", () => {
    expect(playmodeRawModeValue(parsePlaymodeOptions(["text"])[0])).toBe('"text"');
    const omni = parsePlaymodeOptions([["imageReference:9", "videoReference:3", "audioReference:3"]])[0];
    expect(playmodeRawModeValue(omni)).toBe(JSON.stringify(["imageReference:9", "videoReference:3", "audioReference:3"]));
  });
});

describe("collectReferenceIdsByPlaymode（发送前兜底收集）", () => {
  const refs = [
    { kind: "image", mediaId: 11 },
    { kind: "image", mediaId: 11 },
    { kind: "video", mediaId: 12 },
    { kind: "audio", mediaId: 13 },
    { kind: "unknown", mediaId: 14 },
    null,
  ];

  it("智能模式下只保留图片引用，其余计数丢弃", () => {
    const result = collectReferenceIdsByPlaymode(refs, "auto");
    expect(result.referenceIds).toEqual([11]);
    expect(result.droppedCount).toBe(3);
    expect(result.kindCounts).toEqual({ image: 2, video: 0, audio: 0, unknown: 0 });
  });

  it("全能模式下放行图/视频/音频并去重保序，未知类型始终拦截", () => {
    const result = collectReferenceIdsByPlaymode(refs, "omniReference");
    expect(result.referenceIds).toEqual([11, 12, 13]);
    expect(result.droppedCount).toBe(1);
    expect(result.kindCounts).toEqual({ image: 2, video: 1, audio: 1, unknown: 0 });
  });
});
