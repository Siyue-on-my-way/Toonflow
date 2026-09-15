/**
 * 聊天驱动 UI 动作协议 —— 前端白名单执行器单元测试（SIY-153）：
 * 覆盖合法动作执行、白名单外/畸形动作忽略、open_export_confirm 阶段守卫、
 * focus_shot 镜头校验与幂等（同一消息只执行一次、历史回放只登记不执行）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canOpenExportConfirm, createUiActionExecutor, normalizeUiActions } from "../uiActions";

function makeDeps(overrides: Partial<Parameters<typeof createUiActionExecutor>[0]> = {}) {
  const calls = { switchPanel: [] as string[], openExportConfirm: 0, focusShot: [] as string[] };
  const deps = {
    getStage: vi.fn(() => "ready_to_assemble" as const),
    resolveShot: vi.fn((shotId: string) => (shotId === "shot-2" ? { id: "shot-2", index: 2 } : null)),
    switchPanel: vi.fn((panel: string) => calls.switchPanel.push(panel)),
    openExportConfirm: vi.fn(() => calls.openExportConfirm++),
    focusShot: vi.fn((shotId: string) => calls.focusShot.push(shotId)),
    ...overrides,
  };
  return { calls, deps };
}

describe("normalizeUiActions", () => {
  it("放行三类白名单动作并剔除未知字段", () => {
    const { accepted, rejected } = normalizeUiActions([
      { type: "switch_panel", panel: "storyboard", evil: 1 },
      { type: "open_export_confirm", evil: 2 },
      { type: "focus_shot", shotId: "shot-2" },
    ]);
    expect(rejected).toEqual([]);
    expect(accepted).toEqual([
      { type: "switch_panel", panel: "storyboard" },
      { type: "open_export_confirm" },
      { type: "focus_shot", shotId: "shot-2" },
    ]);
  });

  it("忽略白名单外与畸形的动作元数据", () => {
    const { accepted } = normalizeUiActions([
      { type: "run_arbitrary_code" },
      { type: "switch_panel", panel: "galaxy" },
      { type: "focus_shot" },
      null,
      "switch_panel",
      42,
    ]);
    expect(accepted).toEqual([]);
  });

  it("同参数动作去重并按上限截断", () => {
    const duplicated = normalizeUiActions([
      { type: "switch_panel", panel: "storyboard" },
      { type: "switch_panel", panel: "storyboard" },
      { type: "focus_shot", shotId: " shot-3 " },
      { type: "focus_shot", shotId: "shot-3" },
    ]);
    expect(duplicated.accepted).toHaveLength(2);

    const overflow = normalizeUiActions(
      Array.from({ length: 5 }, (_, i) => ({ type: "focus_shot", shotId: `shot-${i + 1}` })),
    );
    expect(overflow.accepted).toHaveLength(3);
    expect(overflow.accepted.map((a) => (a as any).shotId)).toEqual(["shot-1", "shot-2", "shot-3"]);
  });

  it("非数组输入整体拒绝", () => {
    expect(normalizeUiActions(null).accepted).toEqual([]);
    expect(normalizeUiActions("actions").accepted).toEqual([]);
    expect(normalizeUiActions(undefined).rejected.length).toBeGreaterThan(0);
  });
});

describe("canOpenExportConfirm", () => {
  it("仅 ready_to_assemble / completed 阶段放行", () => {
    expect(canOpenExportConfirm("ready_to_assemble")).toBe(true);
    expect(canOpenExportConfirm("completed")).toBe(true);
    expect(canOpenExportConfirm("generating")).toBe(false);
    expect(canOpenExportConfirm("storyboard_draft")).toBe(false);
    expect(canOpenExportConfirm(null)).toBe(false);
    expect(canOpenExportConfirm(undefined)).toBe(false);
  });
});

describe("createUiActionExecutor", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("合法动作逐个派发到对应副作用", () => {
    const { deps, calls } = makeDeps();
    const executor = createUiActionExecutor(deps);
    executor.dispatch("m1", [
      { type: "switch_panel", panel: "storyboard" },
      { type: "open_export_confirm" },
      { type: "focus_shot", shotId: "shot-2" },
    ]);
    expect(calls.switchPanel).toEqual(["storyboard"]);
    expect(calls.openExportConfirm).toBe(1);
    expect(calls.focusShot).toEqual(["shot-2"]);
  });

  it("白名单外/畸形动作被忽略且不抛错", () => {
    const { deps, calls } = makeDeps();
    const executor = createUiActionExecutor(deps);
    expect(() => executor.dispatch("m1", [{ type: "hack" }, null, { type: "switch_panel", panel: "storyboard" }])).not.toThrow();
    expect(calls.switchPanel).toEqual(["storyboard"]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("open_export_confirm 的阶段守卫：非待装配/完成阶段安全忽略", () => {
    for (const stage of ["collect_brief", "generating", "storyboard_confirmed", null, undefined] as const) {
      const { deps, calls } = makeDeps({ getStage: vi.fn(() => stage as any) });
      const executor = createUiActionExecutor(deps);
      executor.dispatch(`m-${stage}`, [{ type: "open_export_confirm" }]);
      expect(calls.openExportConfirm).toBe(0);
      expect(console.warn).toHaveBeenCalled();
    }
    // ready_to_assemble / completed 正常打开
    for (const stage of ["ready_to_assemble", "completed"] as const) {
      const { deps, calls } = makeDeps({ getStage: vi.fn(() => stage) });
      const executor = createUiActionExecutor(deps);
      executor.dispatch(`m-${stage}`, [{ type: "open_export_confirm" }]);
      expect(calls.openExportConfirm).toBe(1);
    }
  });

  it("focus_shot 定位不存在的镜头时被忽略", () => {
    const { deps, calls } = makeDeps();
    const executor = createUiActionExecutor(deps);
    executor.dispatch("m1", [{ type: "focus_shot", shotId: "shot-99" }]);
    expect(calls.focusShot).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("同一消息 id 只执行一次（重复派发/重连重放幂等）", () => {
    const { deps, calls } = makeDeps();
    const executor = createUiActionExecutor(deps);
    executor.dispatch("m1", [{ type: "switch_panel", panel: "storyboard" }]);
    executor.dispatch("m1", [{ type: "switch_panel", panel: "storyboard" }]);
    executor.dispatch("m1", [{ type: "open_export_confirm" }]);
    expect(calls.switchPanel).toEqual(["storyboard"]);
    expect(calls.openExportConfirm).toBe(0);
    expect(executor.hasExecuted("m1")).toBe(true);
  });

  it("历史回放只登记消息 id，不执行任何动作", () => {
    const { deps, calls } = makeDeps();
    const executor = createUiActionExecutor(deps);
    executor.markReplayed("m-history");
    executor.dispatch("m-history", [
      { type: "switch_panel", panel: "storyboard" },
      { type: "open_export_confirm" },
      { type: "focus_shot", shotId: "shot-2" },
    ]);
    expect(calls.switchPanel).toEqual([]);
    expect(calls.openExportConfirm).toBe(0);
    expect(calls.focusShot).toEqual([]);
    // 不同消息仍正常执行
    executor.dispatch("m-live", [{ type: "switch_panel", panel: "preview" }]);
    expect(calls.switchPanel).toEqual(["preview"]);
  });

  it("消息 id 以字符串归一化（数字/字符串 id 等价）", () => {
    const { deps } = makeDeps();
    const executor = createUiActionExecutor(deps);
    executor.markReplayed(123 as unknown as string);
    expect(executor.hasExecuted("123")).toBe(true);
  });
});
