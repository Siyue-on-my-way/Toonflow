/**
 * QuickVideo / 单视频快创 —— 对话式参数配置与生成确认单元测试（SIY-148）
 * 纯函数测试，无需启动服务：
 *   yarn tsx scripts/quickvideo-config-gate-unit.ts
 *
 * 覆盖：
 * 1. 目标时长 schema：5-60 正整数秒与 null 放行，旧版 15/30/60 兼容，越界/小数/字符串拒绝；
 * 2. 存量状态兼容：旧版状态 JSON（无 configVersion）解析回填默认值 0，新自适应状态解析通过；
 * 3. configVersion 版本递增（bumpConfigVersion）；
 * 4. finalParamsCards 回显卡片组装（buildFinalParamsCard）：时长与画风未设置时安全回退自适应/自由画风文案；
 * 5. 分镜自适应校验：targetDuration 为 null 时自适应放行 2-12 镜、总长不超过 60 秒的分镜，不抛出异常；
 * 6. 自定义时长校验：12s、18s 等自定义时长在 shotCountBounds 与 validateStoryboard 下的行为。
 */
import {
  QUICK_VIDEO_DURATION_MAX,
  QUICK_VIDEO_DURATION_MIN,
  QuickVideoState,
  buildFinalParamsCard,
  bumpConfigVersion,
  quickVideoDurationSchema,
  quickVideoStateSchema,
  shotCountBounds,
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
    configVersion: 0,
    createIdempotencyKey: "idem-key-0001",
    brief: null,
    storyboard: {
      version: 1,
      status: "confirmed",
      confirmedAt: 1,
      summary: "测试分镜",
      shots: [
        { id: "shot-1", index: 1, duration: 5, description: "镜头一", dialogue: "", camera: "", assetRefs: [], imageState: "pending", videoState: "pending", imageRef: null, videoRef: null, errorReason: null, firstFrame: null },
        { id: "shot-2", index: 2, duration: 5, description: "镜头二", dialogue: "", camera: "", assetRefs: [], imageState: "pending", videoState: "pending", imageRef: null, videoRef: null, errorReason: null, firstFrame: null },
      ],
    },
    generation: {
      snapshot: null,
      materialsConfirmed: false,
      materialsConfirmedAt: null,
      finalParamsCards: [],
      runId: null,
      startedAt: null,
      finishedAt: null,
      materialImages: {},
      timeline: null,
      exportInfo: null,
    },
    appliedKeys: {},
    lastChatAt: null,
    updateTime: Date.now(),
    ...overrides,
  } as any);
}

console.log("== 1. 目标时长 schema（5-60 正整数秒或 null 放行） ==");
{
  assert(QUICK_VIDEO_DURATION_MIN === 5 && QUICK_VIDEO_DURATION_MAX === 60, "常量为 5 与 60");
  for (const v of [5, 12, 15, 18, 30, 60, null]) {
    assert(quickVideoDurationSchema.safeParse(v).success, `接受 ${JSON.stringify(v)}`);
  }
  for (const v of [4, 61, 0, -12, 12.5, "12", ""]) {
    assert(!quickVideoDurationSchema.safeParse(v).success, `拒绝 ${JSON.stringify(v)}`);
  }
}

console.log("== 2. 存量状态兼容与自适应状态解析 ==");
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
  assert(parsed.generation && typeof parsed.generation === "object", "缺失 generation 回填默认对象");

  const adaptive = { ...legacy, targetDuration: null, artStyle: "" };
  const parsedAdaptive = quickVideoStateSchema.parse(adaptive);
  assert(parsedAdaptive.targetDuration === null && parsedAdaptive.artStyle === "", "新极简项目允许时长为 null、画风为空串");

  const custom18 = { ...legacy, targetDuration: 18, artStyle: "水彩风" };
  const parsedCustom = quickVideoStateSchema.parse(custom18);
  assert(parsedCustom.targetDuration === 18 && parsedCustom.artStyle === "水彩风", "自定义时长 18s 与画风正常解析");
}

console.log("== 3. configVersion 递增 ==");
{
  const state = makeState();
  assert(state.configVersion === 0, "初始 configVersion=0");
  const v1 = bumpConfigVersion(state);
  assert(v1 === 1 && state.configVersion === 1, "bumpConfigVersion 后 configVersion=1");
  const v2 = bumpConfigVersion(state);
  assert(v2 === 2 && state.configVersion === 2, "第二次 bump 后 configVersion=2");
}

console.log("== 4. buildFinalParamsCard 兜底回显 ==");
{
  // 留空自适应与空画风
  const adaptiveState = makeState({
    targetDuration: null,
    artStyle: "",
  });
  const adaptiveCard = buildFinalParamsCard(adaptiveState);
  assert(adaptiveCard.targetDuration === null, "卡片记录 targetDuration 为 null");
  assert(adaptiveCard.durationText === "自适应", "卡片 durationText 安全回退为「自适应」");
  assert(adaptiveCard.artStyleText === "自由画风", "卡片 artStyleText 安全回退为「自由画风」");
  assert(adaptiveCard.shotCount === 2, "卡片 shotCount 记录正确");

  // 自定义时长与具体画风
  const customState = makeState({
    targetDuration: 18,
    artStyle: "赛博朋克",
  });
  const customCard = buildFinalParamsCard(customState);
  assert(customCard.targetDuration === 18, "卡片 targetDuration 为 18");
  assert(customCard.durationText === "18s", "卡片 durationText 为 18s");
  assert(customCard.artStyleText === "赛博朋克", "卡片 artStyleText 为 赛博朋克");
}

console.log("== 5. 自适应分镜校验（targetDuration 为 null） ==");
{
  const boundsAdaptive = shotCountBounds(null);
  assert(boundsAdaptive.min === 2 && boundsAdaptive.max === 12, "自适应模式镜头区间为 2-12");

  const shots2 = [
    { id: "shot-1", index: 1, duration: 6, description: "镜头一", dialogue: "", camera: "", assetRefs: [], imageState: "pending" as const, videoState: "pending" as const, imageRef: null, videoRef: null, errorReason: null, firstFrame: null },
    { id: "shot-2", index: 2, duration: 7, description: "镜头二", dialogue: "", camera: "", assetRefs: [], imageState: "pending" as const, videoState: "pending" as const, imageRef: null, videoRef: null, errorReason: null, firstFrame: null },
  ];
  assert(validateStoryboard(null, shots2).length === 0, "2 镜头共 13 秒在自适应模式放行");

  const shot1 = [shots2[0]];
  assert(validateStoryboard(null, shot1).length > 0, "单镜头低于 2 镜头下限被拒");

  const shots13 = Array.from({ length: 13 }, (_, i) => ({
    id: `shot-${i + 1}`,
    index: i + 1,
    duration: 5,
    description: `镜头${i + 1}`,
    dialogue: "",
    camera: "",
    assetRefs: [],
    imageState: "pending" as const,
    videoState: "pending" as const,
    imageRef: null,
    videoRef: null,
    errorReason: null,
    firstFrame: null,
  }));
  assert(validateStoryboard(null, shots13).length > 0, "13 镜头超过 12 镜头上限被拒");

  const shotsOver60 = Array.from({ length: 5 }, (_, i) => ({
    id: `shot-${i + 1}`,
    index: i + 1,
    duration: 15, // 5 * 15 = 75s
    description: `镜头${i + 1}`,
    dialogue: "",
    camera: "",
    assetRefs: [],
    imageState: "pending" as const,
    videoState: "pending" as const,
    imageRef: null,
    videoRef: null,
    errorReason: null,
    firstFrame: null,
  }));
  assert(validateStoryboard(null, shotsOver60).length > 0, "总长 75 秒超过自适应 60 秒上限被拒");
}

console.log("== 6. 自定义时长（12s / 18s）校验 ==");
{
  const bounds12 = shotCountBounds(12);
  assert(bounds12.min === 1 && bounds12.max === 2, "12 秒目标镜头区间为 1-2");
  const shots12 = [
    { id: "shot-1", index: 1, duration: 5, description: "镜头1", dialogue: "", camera: "", assetRefs: [], imageState: "pending" as const, videoState: "pending" as const, imageRef: null, videoRef: null, errorReason: null, firstFrame: null },
    { id: "shot-2", index: 2, duration: 7, description: "镜头2", dialogue: "", camera: "", assetRefs: [], imageState: "pending" as const, videoState: "pending" as const, imageRef: null, videoRef: null, errorReason: null, firstFrame: null },
  ];
  assert(validateStoryboard(12, shots12).length === 0, "12 秒目标 5+7s 合法");

  const bounds18 = shotCountBounds(18);
  assert(bounds18.min === 1 && bounds18.max === 3, "18 秒目标镜头区间为 1-3");
  const shots18 = [
    { id: "shot-1", index: 1, duration: 6, description: "镜头1", dialogue: "", camera: "", assetRefs: [], imageState: "pending" as const, videoState: "pending" as const, imageRef: null, videoRef: null, errorReason: null, firstFrame: null },
    { id: "shot-2", index: 2, duration: 6, description: "镜头2", dialogue: "", camera: "", assetRefs: [], imageState: "pending" as const, videoState: "pending" as const, imageRef: null, videoRef: null, errorReason: null, firstFrame: null },
    { id: "shot-3", index: 3, duration: 6, description: "镜头3", dialogue: "", camera: "", assetRefs: [], imageState: "pending" as const, videoState: "pending" as const, imageRef: null, videoRef: null, errorReason: null, firstFrame: null },
  ];
  assert(validateStoryboard(18, shots18).length === 0, "18 秒目标 3×6s 合法");
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
