/**
 * 快创工作台可调节双栏布局（SIY-141）—— 纯布局层能力。
 *
 * 职责（不接触分镜数据流 / Socket / WebAV）：
 * - 左侧聊天栏宽度拖拽（Pointer Events，兼容鼠标 / 触控板 / 触摸屏）；
 * - 键盘无障碍（左右方向键步进，Home / End 跳转边界）；
 * - 按项目维度持久化宽度比例到 LocalStorage，进页与容器尺寸变化时按最新约束夹紧（clamp）；
 * - 窄屏判定：两栏最小宽度无法并存时降级为抽屉覆盖层模式。
 *
 * 宽度以"左栏像素宽"为唯一运行时状态，LocalStorage 只存比例——
 * 换显示器 / 缩放窗口后按比例还原再夹紧，避免绝对像素漂移。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, type ComputedRef, type Ref } from "vue";

export interface SplitLayoutConstraints {
  /** 左栏（聊天栏）最小宽度 px */
  minLeft: number;
  /** 左栏最大宽度占容器宽度的比例 */
  maxLeftRatio: number;
  /** 右栏（主体工作区）最小宽度 px */
  minRight: number;
  /** 行内不属于两栏的固定占位宽度 px（分隔线 + 图标导航 + flex 间距） */
  chromeWidth: number;
  /** 无记忆记录时的默认左栏占比 */
  defaultRatio: number;
  /** 键盘左右方向键的步进 px */
  keyboardStep: number;
}

/** 快创默认约束（SIY-141 规范）：左栏 300px~55%，右栏 ≥420px，默认 35% */
export const QUICK_VIDEO_SPLIT_CONSTRAINTS: SplitLayoutConstraints = {
  minLeft: 300,
  maxLeftRatio: 0.55,
  minRight: 420,
  // 分隔线 8px + quickNav 72px + workspaceLayout flex gap 8px × 3
  chromeWidth: 8 + 72 + 8 * 3,
  defaultRatio: 0.35,
  keyboardStep: 24,
};

export const QUICK_VIDEO_LAYOUT_STORAGE_PREFIX = "toonflow:quick-video:layout:";

/** LocalStorage 键按项目隔离；projectId 缺失时退回 default，避免多项目互相覆盖 */
export function quickVideoLayoutStorageKey(projectId: string | null | undefined): string {
  return `${QUICK_VIDEO_LAYOUT_STORAGE_PREFIX}${projectId || "default"}`;
}

export interface LeftBounds {
  min: number;
  max: number;
}

/**
 * 给定容器宽度时左栏允许的像素区间。
 * 容器连两栏最小宽度都放不下（含固定占位）时返回 null —— 调用方应切换抽屉模式。
 */
export function computeLeftBounds(containerWidth: number, c: SplitLayoutConstraints): LeftBounds | null {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return null;
  const available = containerWidth - c.chromeWidth;
  if (available < c.minLeft + c.minRight) return null;
  const max = Math.max(c.minLeft, Math.min(Math.floor(c.maxLeftRatio * containerWidth), available - c.minRight));
  return { min: c.minLeft, max };
}

/** 将任意期望宽度夹紧到区间内并取整，避免亚像素抖动 */
export function clampLeftWidth(width: number, bounds: LeftBounds): number {
  if (!Number.isFinite(width)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

/** 读取持久化的宽度比例；缺失或非法时返回 null（调用方用 defaultRatio） */
export function readStoredRatio(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const ratio = Number(raw);
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return null;
    return ratio;
  } catch {
    return null;
  }
}

/** 拖拽 / 键盘调节结束后按项目写入比例（保留 4 位小数） */
export function writeStoredRatio(key: string, ratio: number): void {
  try {
    localStorage.setItem(key, String(Math.round(ratio * 10000) / 10000));
  } catch {
    // 隐私模式 / 配额满等场景静默降级为"本次会话内记忆"
  }
}

const RATIO_EPSILON = 1e-4;

/**
 * 快创双栏布局 composable。
 *
 * @param container 挂在 workspaceLayout 根元素上的 ref（左栏贴其左缘，拖拽位移按它计算）
 * @param storageKey 响应式的 LocalStorage 键（随 projectId 变化）
 */
export function useQuickVideoSplitLayout(
  container: Ref<HTMLElement | null>,
  storageKey: ComputedRef<string> | Ref<string>,
  constraints: SplitLayoutConstraints = QUICK_VIDEO_SPLIT_CONSTRAINTS,
) {
  const containerWidth = ref(0);
  /** 当前左栏期望像素宽；null 表示尚未测量，交回 CSS 默认值（35%） */
  const leftWidth = ref<number | null>(null);
  const dragging = ref(false);
  const narrowDrawerOpen = ref(false);

  const leftBounds = computed<LeftBounds | null>(() => computeLeftBounds(containerWidth.value, constraints));
  /** 两栏最小宽度无法并存 → 窄屏单栏 + 聊天抽屉模式 */
  const isNarrow = computed(() => containerWidth.value > 0 && leftBounds.value === null);

  /** 实际生效的左栏像素宽；未测量或窄屏时为 null（窄屏宽度由抽屉样式接管） */
  const appliedWidth = computed<number | null>(() => {
    const bounds = leftBounds.value;
    if (!bounds || leftWidth.value === null) return null;
    return clampLeftWidth(leftWidth.value, bounds);
  });

  // ---- 持久化恢复 + 容器变化时的重新夹紧 ----
  let restoredKey: string | null = null;
  watch([storageKey, leftBounds], ([key, bounds]) => {
    if (!bounds) return; // 窄屏或不具备测量条件时不处理，恢复宽屏后再夹紧
    const switchingProject = restoredKey !== key;
    if (leftWidth.value === null || switchingProject) {
      const stored = readStoredRatio(key);
      const ratio = stored ?? constraints.defaultRatio;
      leftWidth.value = clampLeftWidth(ratio * containerWidth.value, bounds);
    } else {
      // 容器宽度变化（窗口缩放 / 折叠侧栏）：只夹紧展示值，不回写用户偏好的比例
      leftWidth.value = clampLeftWidth(leftWidth.value, bounds);
    }
    restoredKey = key;
  });

  function persistCurrent(): void {
    const bounds = leftBounds.value;
    if (!bounds || leftWidth.value === null || containerWidth.value <= 0) return;
    writeStoredRatio(storageKey.value, leftWidth.value / containerWidth.value);
  }

  // ---- Pointer Events 拖拽（setPointerCapture：移出分隔线仍持续跟手） ----
  let activePointerId: number | null = null;

  function setBodyUserSelect(value: string | null): void {
    if (value === null) document.body.style.removeProperty("user-select");
    else document.body.style.userSelect = value;
  }

  function onResizerPointerdown(event: PointerEvent): void {
    if (isNarrow.value || !event.isPrimary) return;
    const resizer = event.currentTarget as HTMLElement | null;
    if (!resizer) return;
    // 不 preventDefault：保留点击聚焦，鼠标点击后可直接用键盘微调；拖拽选字由 body user-select 兜底
    activePointerId = event.pointerId;
    resizer.setPointerCapture(event.pointerId);
    dragging.value = true;
    // 拖拽全程禁用文字选中，防止跨文本拖出选区丢帧
    setBodyUserSelect("none");
    const bounds = leftBounds.value;
    if (bounds && leftWidth.value === null) leftWidth.value = clampLeftWidth(constraints.defaultRatio * containerWidth.value, bounds);
  }

  function onResizerPointermove(event: PointerEvent): void {
    if (!dragging.value || event.pointerId !== activePointerId) return;
    const rect = container.value?.getBoundingClientRect();
    const bounds = leftBounds.value;
    if (!rect || !bounds) return;
    leftWidth.value = clampLeftWidth(event.clientX - rect.left, bounds);
  }

  function endDrag(event: PointerEvent): void {
    if (!dragging.value || event.pointerId !== activePointerId) return;
    const resizer = event.currentTarget as HTMLElement | null;
    if (resizer?.hasPointerCapture?.(event.pointerId)) resizer.releasePointerCapture(event.pointerId);
    dragging.value = false;
    activePointerId = null;
    setBodyUserSelect(null);
    persistCurrent();
  }

  // ---- 键盘无障碍：方向键步进，Home / End 直达边界 ----
  function onResizerKeydown(event: KeyboardEvent): void {
    const bounds = leftBounds.value;
    if (!bounds || isNarrow.value) return;
    if (leftWidth.value === null) leftWidth.value = clampLeftWidth(constraints.defaultRatio * containerWidth.value, bounds);
    const current = leftWidth.value;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
        next = current - constraints.keyboardStep;
        break;
      case "ArrowRight":
        next = current + constraints.keyboardStep;
        break;
      case "Home":
        next = bounds.min;
        break;
      case "End":
        next = bounds.max;
        break;
      default:
        return;
    }
    event.preventDefault();
    leftWidth.value = clampLeftWidth(next, bounds);
    persistCurrent();
  }

  function toggleDrawer(): void {
    narrowDrawerOpen.value = !narrowDrawerOpen.value;
  }

  function closeDrawer(): void {
    narrowDrawerOpen.value = false;
  }

  // 窄屏抽屉打开时支持 Esc 关闭；恢复宽屏时复位抽屉状态
  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && narrowDrawerOpen.value) closeDrawer();
  }
  watch(isNarrow, (narrow) => {
    if (narrow) {
      window.addEventListener("keydown", onWindowKeydown);
    } else {
      narrowDrawerOpen.value = false;
      window.removeEventListener("keydown", onWindowKeydown);
    }
  });

  // ---- ResizeObserver：容器尺寸变化即时重新夹紧（纯 CSS 宽度变化，不触发子组件重建） ----
  let observer: ResizeObserver | null = null;
  onMounted(() => {
    observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      containerWidth.value = entry.contentRect.width;
    });
    if (container.value) observer.observe(container.value);
  });

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
    // 拖拽中途卸载时兜底恢复文字选中
    setBodyUserSelect(null);
    window.removeEventListener("keydown", onWindowKeydown);
  });

  return {
    containerWidth,
    leftWidth,
    appliedWidth,
    leftBounds,
    dragging,
    isNarrow,
    narrowDrawerOpen,
    onResizerPointerdown,
    onResizerPointermove,
    onResizerPointerup: endDrag,
    onResizerPointercancel: endDrag,
    onResizerKeydown,
    toggleDrawer,
    closeDrawer,
    persistCurrent,
  };
}
