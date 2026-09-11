/**
 * 快创可调节双栏布局单元测试（SIY-141）：
 * 覆盖宽度夹紧边界、窄屏降级判定、按项目隔离的 LocalStorage 持久化。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  QUICK_VIDEO_LAYOUT_STORAGE_PREFIX,
  QUICK_VIDEO_SPLIT_CONSTRAINTS,
  clampLeftWidth,
  computeLeftBounds,
  quickVideoLayoutStorageKey,
  readStoredRatio,
  writeStoredRatio,
} from "../splitLayout";

const C = QUICK_VIDEO_SPLIT_CONSTRAINTS;

describe("quickVideoLayoutStorageKey", () => {
  it("按 projectId 隔离键名", () => {
    expect(quickVideoLayoutStorageKey("proj-a")).toBe(`${QUICK_VIDEO_LAYOUT_STORAGE_PREFIX}proj-a`);
    expect(quickVideoLayoutStorageKey("proj-b")).toBe(`${QUICK_VIDEO_LAYOUT_STORAGE_PREFIX}proj-b`);
  });

  it("projectId 缺失时退回 default，不产生 undefined 键名", () => {
    expect(quickVideoLayoutStorageKey(null)).toBe(`${QUICK_VIDEO_LAYOUT_STORAGE_PREFIX}default`);
    expect(quickVideoLayoutStorageKey(undefined)).toBe(`${QUICK_VIDEO_LAYOUT_STORAGE_PREFIX}default`);
  });
});

describe("computeLeftBounds", () => {
  it("标准容器：下限 300px，上限为 55% 容器宽与（可用宽-右栏最小值）的较小者", () => {
    // 1200px 容器，chrome 104 → 可用 1096；55% = 660；1096-420 = 676 → max 660
    expect(computeLeftBounds(1200, C)).toEqual({ min: 300, max: 660 });
    // 900px 容器：可用 796；55% = 495；796-420 = 376 → max 376（右栏最小值先约束）
    expect(computeLeftBounds(900, C)).toEqual({ min: 300, max: 376 });
  });

  it("容器容不下两栏最小宽度时返回 null（触发抽屉模式）", () => {
    // 104 + 300 + 420 = 824 为并存阈值；恰好 824px 时右栏最小值约束绑定，左栏被钉在 300px
    expect(computeLeftBounds(823, C)).toBeNull();
    expect(computeLeftBounds(824, C)).toEqual({ min: 300, max: 300 });
  });

  it("非法容器宽度返回 null", () => {
    expect(computeLeftBounds(0, C)).toBeNull();
    expect(computeLeftBounds(-100, C)).toBeNull();
    expect(computeLeftBounds(Number.NaN, C)).toBeNull();
  });
});

describe("clampLeftWidth", () => {
  const bounds = { min: 300, max: 660 };
  it("期望值在区间内时取整保留", () => {
    expect(clampLeftWidth(420.4, bounds)).toBe(420);
    expect(clampLeftWidth(659.6, bounds)).toBe(660);
  });
  it("越过边界时夹紧", () => {
    expect(clampLeftWidth(120, bounds)).toBe(300);
    expect(clampLeftWidth(9999, bounds)).toBe(660);
  });
  it("非数值输入落到下限", () => {
    expect(clampLeftWidth(Number.NaN, bounds)).toBe(300);
  });
});

describe("LocalStorage 持久化", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("写入后可读回同一比例，且按项目键隔离", () => {
    const keyA = quickVideoLayoutStorageKey("proj-a");
    const keyB = quickVideoLayoutStorageKey("proj-b");
    writeStoredRatio(keyA, 0.35);
    writeStoredRatio(keyB, 0.52);
    expect(readStoredRatio(keyA)).toBeCloseTo(0.35, 6);
    expect(readStoredRatio(keyB)).toBeCloseTo(0.52, 6);
  });

  it("比例会被规整到 4 位小数", () => {
    const key = quickVideoLayoutStorageKey("proj-c");
    writeStoredRatio(key, 1 / 3);
    expect(readStoredRatio(key)).toBe(0.3333);
  });

  it("无记录或非法记录返回 null", () => {
    expect(readStoredRatio(quickVideoLayoutStorageKey("missing"))).toBeNull();
    const bad = quickVideoLayoutStorageKey("bad");
    localStorage.setItem(bad, "not-a-number");
    expect(readStoredRatio(bad)).toBeNull();
    localStorage.setItem(bad, "1.5");
    expect(readStoredRatio(bad)).toBeNull();
    localStorage.setItem(bad, "0");
    expect(readStoredRatio(bad)).toBeNull();
  });
});
