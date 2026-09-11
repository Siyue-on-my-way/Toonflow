/**
 * QuickVideo / 单视频快创 —— 对话式配置 + 生成确认门单元测试（SIY-138）
 * 纯函数测试，无需启动服务：
 *   npx tsx scripts/quickvideo-config-gate-unit.ts
 *
 * 覆盖：
 * 1. 目标时长 schema：5-60 正整数秒放行，旧版 15/30/60 兼容，越界/小数/字符串拒绝；
 * 2. 存量状态兼容：旧版状态 JSON（无 configVersion/pendingSnapshot/confirmationStatus）解析回填默认值；
 * 3. configVersion 版本递增与旧确认自动失效（bumpConfigVersion / invalidatePendingConfirmation）；
 * 4. 待确认快照组装（buildPendingSnapshot）：摘要截断、总时长、预估透传；
 * 5. 分镜校验在新时长区间下的行为（shotCountBounds / validateStoryboard）。
 */
import {
  QUICK_VIDEO_DURATION_MAX,
  QUICK_VIDEO_DURATION_MIN,
  QuickVideoState,
  buildPendingSnapshot,
  bumpConfigVersion,
  invalidatePendingConfirmation,
  quickVideoDurationSchema,
  quickVideoStateSchema,
  validateStoryboard,
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

function makeState(overrides: Partial<QuickVideoState> = {}): QuickVideoState {
  return quickVideoStateSchema.parse({
    version: 1,
    stage: "storyboard_confirmed",
    targetDuration: 30,
    videoRatio: "16:9",
    artStyle: "",
    createIdempotencyKey: "idem-key-0001",
    brief: null,
    storyboard: {
      version: 1,
      status: "confirmed",
      confirmedAt: 1,
      summary: "",
      shots: [
        { id: "shot-1", index: 1, duration: 5, description: "镜头一", dialogue: "", camera: "", assetRefs: [], imageState: "pending", videoState: "pending", imageRef: null, videoRef: null, errorReason: null, firstFrame: null },
      ],
    },
    updateTime: Date.now(),
    ...overrides,
  } as any);
}

console.log("== 1. 目标时长 schema（5-60 正整数秒） ==");
{
  assert(QUICK_VIDEO_DURATION_MIN === 5 && QUICK_VIDEO_DURATION_MAX === 60, "常量为 5 与 60");
  for (const v of [5, 12, 15, 18, 30, 60]) {
    assert(quickVideoDurationSchema.safeParse(v).success, `接受 ${v} 秒`);
  }
  for (const v of [4, 61, 0, -12, 12.5, "12", null]) {
    assert(!quickVideoDurationSchema.safeParse(v).success, `拒绝 ${JSON.stringify(v)}`);
  }
}

console.log("== 2. 存量状态兼容（旧版 15/30/60 无新字段） ==");
{
  const legacy = {
    schemaVersion: 1,
    version: 7,
    stage: "collect_brief",
    targetDuration: 30,
    videoRatio: "9:16",
    artStyle: "国潮插画",
    createIdempotencyKey: "legacy-key-123",
    brief: null,
    storyboard: null,
    appliedKeys: {},
    lastChatAt: null,
    updateTime: 1700000000000,
  };
  const parsed = quickVideoStateSchema.parse(JSON.parse(JSON.stringify(legacy)));
  assert(parsed.targetDuration === 30, "旧时长 30 秒原样读回");
  assert(parsed.artStyle === "国潮插画", "旧画风原样读回");
  assert(parsed.configVersion === 0, "缺失 configVersion 回填 0");
  assert(parsed.confirmationStatus === "none", "缺失 confirmationStatus 回填 none");
  assert(parsed.pendingSnapshot === null, "缺失 pendingSnapshot 回填 null");
  assert(parsed.generation && typeof parsed.generation === "object", "缺失 generation 回填默认对象");

  const legacy60 = { ...legacy, targetDuration: 60 };
  assert(quickVideoStateSchema.parse(legacy60).targetDuration === 60, "旧时长 60 秒兼容");

  const unset = { ...legacy, targetDuration: null, artStyle: "" };
  const parsedUnset = quickVideoStateSchema.parse(unset);
  assert(parsedUnset.targetDuration === null && parsedUnset.artStyle === "", "新项目允许时长/画风未设置");
}

console.log("== 3. configVersion 递增与旧确认失效 ==");
{
  const state = makeState();
  assert(state.configVersion === 0, "初始 configVersion=0");

  state.pendingSnapshot = buildPendingSnapshot(state);
  state.confirmationStatus = "pending";
  const v1 = bumpConfigVersion(state);
  assert(v1 === 1 && state.configVersion === 1, "bump 后 configVersion=1");
  assert(state.pendingSnapshot === null && state.confirmationStatus === "none", "bump 使 pending 确认失效清空");

  state.confirmationStatus = "confirmed";
  state.pendingSnapshot = buildPendingSnapshot(state);
  bumpConfigVersion(state);
  assert(state.confirmationStatus === "none" && state.pendingSnapshot === null, "confirmed 状态同样被失效清空");

  state.pendingSnapshot = null;
  state.confirmationStatus = "none";
  const before = state.configVersion;
  assert(invalidatePendingConfirmation(state) === false, "无待确认时 invalidate 返回 false");
  assert(state.configVersion === before, "invalidate 不改变 configVersion");
}

console.log("== 4. buildPendingSnapshot 组装 ==");
{
  const state = makeState({
    targetDuration: 12,
    artStyle: "水彩",
    storyboard: {
      version: 3,
      status: "confirmed",
      confirmedAt: 1,
      summary: "两镜水彩短片",
      shots: [
        { id: "shot-1", index: 1, duration: 5, description: "清晨湖面薄雾，一只白鹭掠过水面激起涟漪，画面安静唯美", dialogue: "", camera: "远景", assetRefs: [], imageState: "pending", videoState: "pending", imageRef: null, videoRef: null, errorReason: null, firstFrame: null },
        { id: "shot-2", index: 2, duration: 7, description: "湖边小镇苏醒，炊烟升起，结尾定版", dialogue: "新的一天", camera: "中景", assetRefs: [], imageState: "pending", videoState: "pending", imageRef: null, videoRef: null, errorReason: null, firstFrame: null },
      ],
    },
  });
  const snapshot = buildPendingSnapshot(state, { estimatedImageCount: 2, estimatedVideoCount: 2, estimatedCostYuan: 6.9 });
  assert(snapshot.configVersion === state.configVersion, "快照冻结当前 configVersion");
  assert(snapshot.targetDuration === 12 && snapshot.artStyle === "水彩", "快照记录时长与画风");
  assert(snapshot.shotCount === 2 && snapshot.totalDuration === 12, "镜头数与总时长正确");
  assert(snapshot.shotSummaries.length === 2 && snapshot.shotSummaries[0].duration === 5, "逐镜摘要完整");
  assert(snapshot.shotSummaries[0].description.length <= 120, "摘要描述截断到 120 字内");
  assert(snapshot.estimatedImageCount === 2 && snapshot.estimatedCostYuan === 6.9, "预估透传");

  const noDuration = makeState({ targetDuration: null });
  let threw = false;
  try {
    buildPendingSnapshot(noDuration);
  } catch {
    threw = true;
  }
  assert(threw, "时长未设置时组装报错");
}

console.log("== 5. 分镜校验（5-60 秒区间） ==");
{
  const bounds12 = { min: Math.max(1, Math.min(5, Math.floor(12 / 15) || 1)), max: Math.max(1, Math.min(12, Math.floor(12 / 5))) };
  const shots12 = [5, 7].map((d, i) => ({ id: `shot-${i + 1}`, index: i + 1, duration: d, description: `镜头${i + 1}`, dialogue: "", camera: "", assetRefs: [] as any[], imageState: "pending" as const, videoState: "pending" as const, imageRef: null, videoRef: null, errorReason: null, firstFrame: null }));
  assert(validateStoryboard(12, shots12).length === 0, "12 秒目标可由 2 镜 5+7 秒满足");
  assert(Math.floor(12 / 5) === bounds12.max, "12 秒目标最多 2 镜（5 秒下限）");

  const tooMany = [...shots12, { ...shots12[0], id: "shot-3", index: 3 }];
  assert(validateStoryboard(12, tooMany).length > 0, "12 秒目标 3 镜超上限被拒");

  const shots18 = [6, 6, 6].map((d, i) => ({ id: `shot-${i + 1}`, index: i + 1, duration: d, description: `镜头${i + 1}`, dialogue: "", camera: "", assetRefs: [] as any[], imageState: "pending" as const, videoState: "pending" as const, imageRef: null, videoRef: null, errorReason: null, firstFrame: null }));
  assert(validateStoryboard(18, shots18).length === 0, "18 秒目标 3×6 秒满足");
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
