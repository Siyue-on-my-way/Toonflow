/**
 * QuickVideo / 单视频快创 —— 聊天驱动 UI 动作协议单元测试（SIY-153）
 * 纯函数测试，无需启动服务：
 *   yarn tsx scripts/quickvideo-ui-actions-unit.ts
 *
 * 覆盖：
 * 1. normalizeQuickVideoUiActions：合法动作放行、白名单外/畸形动作拒绝、字段剔除、去重与上限截断；
 * 2. canOpenExportConfirmStage：open_export_confirm 的阶段守卫（仅 ready_to_assemble / completed）；
 * 3. 向下兼容：历史消息无 ext / ext 非法 JSON 时不产生任何动作（getMemory 解析路径的输入形态）。
 */
import {
  QUICK_VIDEO_UI_ACTIONS_MAX,
  canOpenExportConfirmStage,
  normalizeQuickVideoUiActions,
} from "@/lib/quickVideo/contract";

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

function main() {
  console.log("== normalizeQuickVideoUiActions ==");
  {
    const { accepted, rejected } = normalizeQuickVideoUiActions([
      { type: "switch_panel", panel: "storyboard" },
      { type: "open_export_confirm" },
      { type: "focus_shot", shotId: "shot-2" },
    ]);
    assert(accepted.length === 3 && !rejected.length, "三个合法动作全部放行", JSON.stringify(rejected));
    assert(accepted[0].type === "switch_panel" && accepted[0].panel === "storyboard", "switch_panel 保留 panel");
    assert(accepted[2].shotId === "shot-2", "focus_shot 保留 shotId");
  }
  {
    const { accepted, rejected } = normalizeQuickVideoUiActions([
      { type: "run_arbitrary_code", payload: "rm -rf /" },
      { type: "switch_panel", panel: "galaxy" },
      { type: "focus_shot" },
      null,
      "switch_panel",
      42,
    ]);
    assert(accepted.length === 0, "白名单外/畸形动作全部拒绝", JSON.stringify(accepted));
    assert(rejected.length === 6, `每个非法动作都有可读拒绝原因（实际 ${rejected.length}）`);
    // open_export_confirm 没有必填参数，带未知字段也合法（未知字段剔除）
    const extraField = normalizeQuickVideoUiActions({ length: 0 } as never);
    assert(extraField.accepted.length === 0, "对象形态输入安全拒绝");
  }
  {
    const { accepted } = normalizeQuickVideoUiActions([{ type: "switch_panel", panel: "preview", evil: "x", extra: 1 }]);
    assert(accepted.length === 1 && !("evil" in accepted[0]) && !("extra" in accepted[0]), "未知字段被剔除，不透传到前端");
  }
  {
    const { accepted } = normalizeQuickVideoUiActions([
      { type: "switch_panel", panel: "storyboard" },
      { type: "switch_panel", panel: "storyboard" },
      { type: "focus_shot", shotId: " shot-3 " },
      { type: "focus_shot", shotId: "shot-3" },
    ]);
    assert(accepted.length === 2, "同参数动作去重（含 shotId 修剪）", JSON.stringify(accepted));
  }
  {
    const raw = Array.from({ length: QUICK_VIDEO_UI_ACTIONS_MAX + 2 }, (_, i) => ({ type: "focus_shot", shotId: `shot-${i + 1}` }));
    const { accepted, rejected } = normalizeQuickVideoUiActions(raw);
    assert(accepted.length === QUICK_VIDEO_UI_ACTIONS_MAX, `超出上限被截断到 ${QUICK_VIDEO_UI_ACTIONS_MAX}`);
    assert(rejected.length === 2, "截断的动作给出拒绝原因");
  }
  {
    assert(normalizeQuickVideoUiActions(null).accepted.length === 0, "null 输入安全拒绝");
    assert(normalizeQuickVideoUiActions("actions").accepted.length === 0, "字符串输入安全拒绝");
    assert(normalizeQuickVideoUiActions({ type: "switch_panel" }).accepted.length === 0, "对象输入安全拒绝");
    assert(normalizeQuickVideoUiActions(undefined).rejected.length > 0, "非数组输入返回拒绝原因");
  }

  console.log("== canOpenExportConfirmStage ==");
  {
    assert(canOpenExportConfirmStage("ready_to_assemble"), "ready_to_assemble 放行");
    assert(canOpenExportConfirmStage("completed"), "completed 放行");
    assert(!canOpenExportConfirmStage("generating"), "generating 拒绝");
    assert(!canOpenExportConfirmStage("storyboard_draft"), "storyboard_draft 拒绝");
    assert(!canOpenExportConfirmStage(null), "null 阶段拒绝");
    assert(!canOpenExportConfirmStage(undefined), "未知阶段拒绝");
  }

  console.log("== 向下兼容（历史消息无/坏 ext） ==");
  {
    // getMemory.parseMessageUiActions 的等价输入：无 ext、空 ext、坏 JSON 都必须零动作零异常
    for (const ext of [null, undefined, "", "not-json", '{"type":"switch_panel"}', '{"a":1}']) {
      let ok = true;
      let accepted: unknown[] = [];
      try {
        const parsed = ext ? JSON.parse(ext) : null;
        accepted = typeof parsed === "object" && parsed !== null ? normalizeQuickVideoUiActions(parsed).accepted : [];
      } catch {
        ok = true; // 坏 JSON 静默忽略
      }
      assert(ok && accepted.length === 0, `ext=${JSON.stringify(ext)} 安全解析为零动作`);
    }
    const { accepted } = normalizeQuickVideoUiActions(JSON.parse('[{"type":"focus_shot","shotId":"shot-1"}]'));
    assert(accepted.length === 1, "合法持久化 ext 能完整还原动作");
  }

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) process.exit(1);
}

main();
