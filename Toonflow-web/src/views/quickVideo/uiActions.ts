/**
 * 聊天驱动 UI 动作协议 —— 前端白名单执行器（SIY-153）
 *
 * 聊天窗是快创工作台的"万能遥控器"：QuickVideoAgent 在助手消息 ext.actions 附带结构化
 * 动作元数据，本模块负责按白名单派发执行。设计约束：
 * - **白名单安全**：只执行 switch_panel / open_export_confirm / focus_shot 三类动作；
 *   白名单外或畸形的动作元数据忽略并 console.warn，不报错、不中断聊天流。
 * - **导出确认门不可绕过**：open_export_confirm 仅在 ready_to_assemble / completed 阶段
 *   打开导出确认弹窗，编码、下载与 gate=export 回写仍走既有 startExport() 链路。
 * - **幂等回放**：同一消息 id 只执行一次；历史恢复（getHistory 回放）的消息只登记 id
 *   不执行——重进页面/切换会话后动作不重复触发。
 * 纯逻辑无 DOM 依赖，副作用（切面板/开弹窗/滚动定位/提示）通过依赖注入，便于单测。
 */
import type { QuickVideoPanel, QuickVideoStage, QuickVideoUiAction, QuickVideoUiActionType } from "@/types/quickVideo";
import { QUICK_VIDEO_PANELS, QUICK_VIDEO_UI_ACTION_TYPES, QUICK_VIDEO_UI_ACTIONS_MAX } from "@/types/quickVideo";

export interface NormalizedUiActions {
  accepted: QuickVideoUiAction[];
  rejected: string[];
}

/**
 * 规范化消息 ext.actions（与后端 contract.normalizeQuickVideoUiActions 同一判据）：
 * 非数组/非对象/白名单外类型/缺参数一律拒绝，未知字段剔除，去重并按上限截断。
 */
export function normalizeUiActions(raw: unknown): NormalizedUiActions {
  const rejected: string[] = [];
  if (!Array.isArray(raw)) {
    return { accepted: [], rejected: ["actions 必须是数组"] };
  }
  const accepted: QuickVideoUiAction[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const label = `actions[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      rejected.push(`${label} 不是对象`);
      return;
    }
    const record = item as Record<string, unknown>;
    const type = record.type;
    if (typeof type !== "string" || !(QUICK_VIDEO_UI_ACTION_TYPES as readonly string[]).includes(type)) {
      rejected.push(`${label}.type「${String(type)}」不在白名单（${QUICK_VIDEO_UI_ACTION_TYPES.join("/")}）`);
      return;
    }
    const action: QuickVideoUiAction = { type: type as QuickVideoUiActionType };
    if (action.type === "switch_panel") {
      const panel = record.panel;
      if (typeof panel !== "string" || !(QUICK_VIDEO_PANELS as readonly string[]).includes(panel)) {
        rejected.push(`${label}.panel「${String(panel)}」不是合法面板（${QUICK_VIDEO_PANELS.join("/")}）`);
        return;
      }
      action.panel = panel as QuickVideoPanel;
    } else if (action.type === "focus_shot") {
      const shotId = record.shotId;
      if (typeof shotId !== "string" || !shotId.trim() || shotId.length > 40) {
        rejected.push(`${label}.shotId 缺失或非法（需 1-40 字符的镜头 ID，如 shot-2）`);
        return;
      }
      action.shotId = shotId.trim();
    }
    const key = `${action.type}|${action.panel ?? ""}|${action.shotId ?? ""}`;
    if (seen.has(key)) return;
    if (accepted.length >= QUICK_VIDEO_UI_ACTIONS_MAX) {
      rejected.push(`${label} 超出单条消息动作上限（${QUICK_VIDEO_UI_ACTIONS_MAX}）`);
      return;
    }
    seen.add(key);
    accepted.push(action);
  });
  return { accepted, rejected };
}

/** open_export_confirm 的阶段守卫：仅待装配/已完成阶段放行，其余阶段安全忽略 */
export function canOpenExportConfirm(stage: QuickVideoStage | null | undefined): boolean {
  return stage === "ready_to_assemble" || stage === "completed";
}

export interface UiActionExecutorDeps {
  /** 当前工作台阶段（open_export_confirm 阶段守卫用） */
  getStage(): QuickVideoStage | null | undefined;
  /** 解析目标镜头；返回 null 表示当前分镜中不存在该镜头 */
  resolveShot(shotId: string): { id: string; index: number } | null;
  /** 切换右侧面板（含轻量提示） */
  switchPanel(panel: QuickVideoPanel): void;
  /** 打开导出确认弹窗（含轻量提示；编码与确认回写仍走既有导出链路） */
  openExportConfirm(): void;
  /** 分镜表滚动定位并高亮镜头行（含轻量提示） */
  focusShot(shotId: string): void;
}

export interface UiActionExecutor {
  /** 该消息的动作是否已执行/登记过（幂等判据） */
  hasExecuted(messageId: string): boolean;
  /** 历史回放：只登记消息 id 不执行（重进页面/切换会话后动作不重复触发） */
  markReplayed(messageId: string): void;
  /** 实时派发：同一消息 id 只执行一次；白名单外忽略并 console.warn；阶段守卫 */
  dispatch(messageId: string, rawActions: unknown): void;
}

export function createUiActionExecutor(deps: UiActionExecutorDeps): UiActionExecutor {
  const executedMessageIds = new Set<string>();

  return {
    hasExecuted(messageId) {
      return executedMessageIds.has(String(messageId));
    },

    markReplayed(messageId) {
      executedMessageIds.add(String(messageId));
    },

    dispatch(messageId, rawActions) {
      const id = String(messageId);
      // 先登记再执行：同一条消息（重复派发/重连重放）只会执行一次
      if (executedMessageIds.has(id)) return;
      executedMessageIds.add(id);

      const { accepted, rejected } = normalizeUiActions(rawActions);
      if (rejected.length) {
        console.warn("[quickVideo] 忽略白名单外/畸形的 UI 动作:", ...rejected);
      }
      for (const action of accepted) {
        if (action.type === "switch_panel" && action.panel) {
          deps.switchPanel(action.panel);
        } else if (action.type === "open_export_confirm") {
          const stage = deps.getStage();
          if (!canOpenExportConfirm(stage)) {
            console.warn(`[quickVideo] 忽略 open_export_confirm：当前阶段 ${stage ?? "未知"} 不允许打开导出确认弹窗`);
            continue;
          }
          deps.openExportConfirm();
        } else if (action.type === "focus_shot" && action.shotId) {
          if (!deps.resolveShot(action.shotId)) {
            console.warn(`[quickVideo] 忽略 focus_shot(${action.shotId})：当前分镜中不存在该镜头`);
            continue;
          }
          deps.focusShot(action.shotId);
        }
      }
    },
  };
}
