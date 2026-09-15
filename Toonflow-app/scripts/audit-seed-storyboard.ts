/**
 * SIY-137 审核 E2E 辅助脚本：为指定快创项目预置「已确认简报 + 草稿分镜」。
 * 复用 mutateQuickVideoState 与 propose_storyboard 工具完全相同的 mutator 逻辑
 * （本运行时 LLM 上游不可达，无法驱动 Agent 真实提交分镜，此处以同口径内核等价替代）。
 * 用法：npx tsx scripts/audit-seed-storyboard.ts <projectId>
 */

import u from "@/utils";
import { mutateQuickVideoState } from "@/lib/quickVideo/state";
import { loadQuickVideoState } from "@/lib/quickVideo/state";
import { validateStoryboard, type QuickVideoShot } from "@/lib/quickVideo/contract";
import { normalizeShotDuration } from "@/lib/quickVideo/shots";
import { bumpUserMessageCountAndMaybeClaimTitle } from "@/lib/quickVideo/session";
import { generateSessionTitle } from "@/lib/quickVideo/title";

void u;
void bumpUserMessageCountAndMaybeClaimTitle;
void generateSessionTitle;

const projectId = Number(process.argv[2] ?? 0);
if (!projectId) throw new Error("usage: tsx scripts/audit-seed-storyboard.ts <projectId>");

const SHOT_SEEDS = [
  {
    duration: 5,
    description: "治愈雨后窗台，橘猫凑近观察玻璃上的水珠",
    dialogue: "喵？",
    camera: "特写",
    imagePrompt: "雨后窗台特写，橘猫侧脸贴着玻璃，水珠折射微光，治愈系插画",
    videoPrompt: "雨滴缓慢滑落，猫耳轻颤，镜头缓推",
    continuity: "independent" as const,
  },
  {
    duration: 5,
    description: "治愈窗台小花散发暖金色微光",
    dialogue: "",
    camera: "中景",
    imagePrompt: "窗台小花发光特写，暖金微光与冷蓝雨景对比，治愈插画",
    videoPrompt: "花瓣微光呼吸式闪烁，镜头缓慢环绕",
    continuity: "last_frame" as const,
  },
  {
    duration: 5,
    description: "治愈橘猫伸爪又缩回轻嗅小花",
    dialogue: "呼噜…",
    camera: "近景",
    imagePrompt: "橘猫伸爪触碰发光小花，暖光洒在猫毛上，治愈系插画",
    videoPrompt: "爪子伸出又收回，低头轻嗅，镜头轻微下沉",
    continuity: "last_frame" as const,
  },
];

async function main() {
  const current = await loadQuickVideoState(projectId);
  if (!current) throw new Error(`project ${projectId} 无 quickVideoAgent 状态`);
  console.log(`seed 前：stage=${current.stage} version=${current.version} brief=${current.brief ? "set" : "null"}`);

// 第一步：collect_brief -> brief_confirmed（保存简报并确认，等价 updateBrief + confirmStage 内核）
await mutateQuickVideoState(projectId, { idempotencyKey: `audit:seed:brief:${projectId}` }, (s) => {
  if (!s.brief) {
    s.brief = {
      theme: "雨后窗台的发光小花",
      hook: "橘猫第一次见到会发光的花",
      narrative: "橘猫好奇伸爪又缩回，最终轻轻嗅花，治愈收尾",
      cta: "治愈每一刻",
    };
  }
  if (s.stage === "collect_brief") s.stage = "brief_confirmed";
});

// 第二步：brief_confirmed -> storyboard_draft（等价 propose_storyboard 工具内核）
const { state } = await mutateQuickVideoState(projectId, { idempotencyKey: `audit:seed:sb:${projectId}` }, (s) => {
  const shots: QuickVideoShot[] = SHOT_SEEDS.map((shot, i) => ({
    id: `shot-${i + 1}`,
    index: i + 1,
    duration: normalizeShotDuration(shot.duration),
    description: shot.description,
    dialogue: shot.dialogue ?? "",
    camera: shot.camera ?? "",
    imagePrompt: shot.imagePrompt ?? "",
    videoPrompt: shot.videoPrompt ?? "",
    assetRefs: [],
    continuity: shot.continuity ?? "last_frame",
    imageState: "pending",
    videoState: "pending",
    imageRef: null,
    videoRef: null,
    errorReason: null,
    firstFrame: null,
  }));
  const errors = validateStoryboard(s.targetDuration, shots);
  if (errors.length) throw new Error(`STORYBOARD_INVALID: ${errors.join("；")}`);
  if (s.stage === "brief_confirmed") s.stage = "storyboard_draft";
  s.storyboard = {
    version: (s.storyboard?.version ?? 0) + 1,
    status: "draft",
    confirmedAt: null,
    summary: "审核预置：三镜治愈系分镜（含双提示词与连续性策略）",
    shots,
  };
});

console.log(`seed 后：stage=${state.stage} version=${state.version} shots=${state.storyboard?.shots.length} storyboardV=${state.storyboard?.version}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
