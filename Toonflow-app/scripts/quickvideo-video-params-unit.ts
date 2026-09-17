/**
 * QuickVideo / 单视频快创 —— 聊天模型参数确认卡单元测试（SIY-161 方案C）
 * 纯函数测试，无需启动服务/数据库/供应商：
 *   npx tsx scripts/quickvideo-video-params-unit.ts
 *
 * 覆盖：
 * 1. buildVideoParamsCard：字段与模型元数据精确匹配（无多余/缺失字段），来源标记正确；
 * 2. 引用联动：有图自动带图（默认图片模式 + 冻结引用）、无图禁首帧（disabled + hint）、
 *    有图时纯文生模式降权（deemphasized）、张数不足禁首尾帧；
 * 3. validateVideoParamsAgainstCatalog：合法参数放行 + 负例全拒绝（非法时长/比例/画质/分辨率/
 *    未声明开关/seed 越界/模式与引用不匹配/提示词必填与字数）；
 * 4. applyVideoParamsEdits：白名单字段合并、来源标记改 user、非法取值拒绝、置灰选项拒绝；
 * 5. resolveSkipAskPreference / matchesResetAskPreference：「不再询问」直通与恢复确认。
 */
import {
  buildVideoParamsCard,
  validateVideoParamsAgainstCatalog,
  applyVideoParamsEdits,
  resolveSkipAskPreference,
  matchesResetAskPreference,
  cardFieldsToParams,
  parseDeclaredModes,
} from "@/lib/quickVideo/videoParamsCard";
import type { QuickVideoVideoParamsCard, VideoParamsPreference } from "@/lib/quickVideo/contract";
import type { VendorModelEntry } from "@/lib/quickVideo/modelValidation";

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

// 与 runninghub.ts 元数据同构的测试条目（不依赖 DB / vendors 模块）
const klingO1: VendorModelEntry = {
  modelName: "kling-video-o1/image-to-video",
  type: "video",
  mode: ["singleImage"],
  audio: false,
  durationResolutionMap: [{ duration: [5, 10], resolution: ["default"] }],
  aspectRatioOptions: [
    { value: "1:1", label: "1:1" },
    { value: "9:16", label: "9:16" },
    { value: "16:9", label: "16:9" },
  ],
  qualityOptions: ["std", "pro"],
  promptLengthRange: [5, 2000],
};

const seedance: VendorModelEntry = {
  modelName: "seedance-2.0-fast",
  type: "video",
  mode: ["text", ["imageReference:9"], ["videoReference:3"], ["imageReference:9", "videoReference:3", "audioReference:3"]],
  audio: "optional",
  durationResolutionMap: [{ duration: [-1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "1080p", "2k", "4k"] }],
  aspectRatioOptions: [{ value: "adaptive", label: "自适应" }, { value: "16:9", label: "16:9" }, { value: "9:16", label: "9:16" }],
  resolutionNote: "480p/720p 原生；1080p/2k/4k 超分",
  durationAutoNote: "「自动」档：由模型决定（文档未说明规则）",
  promptRequired: true,
  promptLengthRange: [1, 20480],
  promptSlotReferences: true,
  controls: ["generateAudio", "returnLastFrame", "seed"],
};

const minimax: VendorModelEntry = {
  modelName: "rhart-video/minimax-h3-oss/fl2va",
  type: "video",
  mode: ["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional", "text"],
  audio: "always",
  durationContinuous: true,
  durationResolutionMap: [{ duration: [5, 15], resolution: ["768p"] }],
  promptLengthRange: [0, 20000],
  aspectRatioOptions: [{ value: "16:9", label: "16:9 (Widescreen)" }, { value: "9:16", label: "9:16 (Portrait)" }],
};

function baseOpts(extra: Partial<Parameters<typeof buildVideoParamsCard>[1]> = {}): Parameters<typeof buildVideoParamsCard>[1] {
  return {
    cardId: "vpc-test-0001",
    modelKey: "vendor1:kling-video-o1/image-to-video",
    modelName: "kling-video-o1/image-to-video",
    sessionId: 7,
    prompt: "一只猫跳上窗台",
    referenceMediaIds: [],
    projectRatio: "16:9",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 1. buildVideoParamsCard：字段与元数据精确匹配
// ---------------------------------------------------------------------------
console.log("== 1. buildVideoParamsCard 元数据投影 ==");
{
  const card = buildVideoParamsCard(klingO1, baseOpts());
  const keys = card.fields.map((f) => f.key);
  assert(keys.includes("mode"), "Kling O1：含输入模式");
  assert(keys.includes("duration") && keys.includes("aspectRatio") && keys.includes("quality"), "Kling O1：时长/比例/画质档入卡");
  assert(!keys.includes("resolution") && !keys.includes("seed") && !keys.includes("generateAudio"), "Kling O1：未声明的分辨率/开关不出卡");
  const duration = card.fields.find((f) => f.key === "duration")!;
  assert(JSON.stringify(duration.options?.map((o) => o.value)) === "[5,10]", "Kling O1：时长档位 [5,10]");
  const quality = card.fields.find((f) => f.key === "quality")!;
  assert(quality.value === "std" && quality.source === "system", "Kling O1：画质默认首档 std，来源 system");
  assert(card.status === "pending" && card.promptSource === "llm", "卡片初始 pending + prompt 来源 llm");

  const scard = buildVideoParamsCard(seedance, baseOpts({ modelKey: "vendor1:seedance-2.0-fast", modelName: "seedance-2.0-fast" }));
  const skeys = scard.fields.map((f) => f.key);
  assert(skeys.includes("resolution") && skeys.includes("generateAudio"), "seedance：分辨率与音频开关入卡");
  assert(skeys.includes("seed") && scard.fields.find((f) => f.key === "seed")!.advanced === true, "seedance：seed 进高级折叠区");
  assert(!skeys.includes("quality"), "seedance：无画质档");
  const sduration = scard.fields.find((f) => f.key === "duration")!;
  assert(sduration.options?.some((o) => o.value === -1 && o.hint?.includes("自动")), "seedance：-1 自动档带说明");
  const sresolution = scard.fields.find((f) => f.key === "resolution")!;
  assert(sresolution.note?.includes("超分"), "seedance：分辨率带 resolutionNote");

  const mcard = buildVideoParamsCard(minimax, baseOpts({ modelKey: "vendor1:minimax", modelName: "minimax" }));
  const mduration = mcard.fields.find((f) => f.key === "duration")!;
  assert(mduration.type === "slider" && mduration.min === 5 && mduration.max === 15, "minimax：连续时长滑条 5-15");
  const mkeys = mcard.fields.map((f) => f.key);
  assert(!mkeys.includes("quality") && !mkeys.includes("resolution"), "minimax：无画质/分辨率字段");
}

// ---------------------------------------------------------------------------
// 2. 引用联动（守门规则可视化）
// ---------------------------------------------------------------------------
console.log("== 2. 引用联动 ==");
{
  // 无图（模型声明文生模式）：首帧模式不可选，默认纯文生
  const noRef = buildVideoParamsCard(minimax, baseOpts({ modelKey: "vendor1:minimax", modelName: "minimax" }));
  const mode0 = noRef.fields.find((f) => f.key === "mode")!;
  const singleOpt0 = mode0.options!.find((o) => String(o.value).includes("singleImage"))!;
  assert(singleOpt0.disabled === true && (singleOpt0.hint ?? "").includes("附带图片"), "无图禁首帧：选项 disabled + hint");
  assert(String(mode0.value).includes("text"), "无图：默认纯文生", String(mode0.value));

  // 有图：默认带图（首帧模式 + 冻结引用）
  const withRef = buildVideoParamsCard(klingO1, baseOpts({ referenceMediaIds: [42] }));
  const mode1 = withRef.fields.find((f) => f.key === "mode")!;
  assert(mode1.value === JSON.stringify("singleImage"), "有图：默认首帧模式", String(mode1.value));
  assert(mode1.source === "llm" && mode1.note?.includes("1 张"), "有图：来源 llm + 说明已带图");
  const imgOpt = mode1.options!.find((o) => String(o.value).includes("singleImage"))!;
  assert(!imgOpt.disabled, "有图：首帧模式可选");

  // 有图 + 模型声明文生模式（minimax）：纯文生降权
  const withRef2 = buildVideoParamsCard(minimax, baseOpts({ modelKey: "vendor1:minimax", modelName: "minimax", referenceMediaIds: [42] }));
  const textOpt = withRef2.fields.find((f) => f.key === "mode")!.options!.find((o) => String(o.value).includes("text"))!;
  assert(textOpt.deemphasized === true && (textOpt.hint ?? "").includes("不使用"), "有图：纯文生降权 + 提示弃图");

  // 无图 + 图输入专属模型（Kling O1）：保留首帧模式默认值，走概念首帧链（字段说明披露）
  const noRefKling = buildVideoParamsCard(klingO1, baseOpts());
  const kmode = noRefKling.fields.find((f) => f.key === "mode")!;
  assert(kmode.value === JSON.stringify("singleImage") && (kmode.note ?? "").includes("概念首帧"), "图输入专属模型无图：概念首帧说明", String(kmode.value));

  // 张数不足：minimax 首尾帧需要 2 张，只带 1 张时禁用
  const oneRef = buildVideoParamsCard(minimax, baseOpts({ modelKey: "vendor1:minimax", modelName: "minimax", referenceMediaIds: [1] }));
  const mode2 = oneRef.fields.find((f) => f.key === "mode")!;
  const startEndOpt = mode2.options!.find((o) => String(o.value).includes("startEnd"))!;
  assert(startEndOpt.disabled === true && (startEndOpt.hint ?? "").includes("2 张"), "1 图禁首尾帧：disabled + 张数说明");

  // seedance 多模态：有图时默认多参考模式
  const seedRef = buildVideoParamsCard(seedance, baseOpts({ modelKey: "vendor1:seedance-2.0-fast", modelName: "seedance-2.0-fast", referenceMediaIds: [9, 10] }));
  const smode = seedRef.fields.find((f) => f.key === "mode")!;
  assert(String(smode.value).includes("imageReference"), "seedance 有图：默认参考图模式", String(smode.value));
  assert(seedRef.referenceMediaIds.length === 2, "冻结引用 2 张");
}

// ---------------------------------------------------------------------------
// 3. validateVideoParamsAgainstCatalog 硬校验
// ---------------------------------------------------------------------------
console.log("== 3. 参数硬校验（正例 + 负例）=");
{
  const okKling = { mode: JSON.stringify("singleImage"), duration: 5, aspectRatio: "16:9", quality: "std" as const };
  assert(validateVideoParamsAgainstCatalog(klingO1, okKling, 1, "一只猫跳上窗台很快") != null, "Kling O1 合法参数放行");
  assert(validateVideoParamsAgainstCatalog(klingO1, okKling, 0) != null, "Kling O1 无图首帧模式放行（概念首帧链）");

  const cases: [string, VendorModelEntry, any, number, string | undefined][] = [
    ["Kling：时长不在档位", klingO1, { ...okKling, duration: 7 }, 1, undefined],
    ["Kling：非法比例", klingO1, { ...okKling, aspectRatio: "4:3" }, 1, undefined],
    ["Kling：非法画质档", klingO1, { ...okKling, quality: "ultra" as any }, 1, undefined],
    ["Kling：未声明开关 generateAudio", klingO1, { ...okKling, generateAudio: true }, 1, undefined],
    ["minimax：首帧模式但无引用图", minimax, { mode: JSON.stringify("singleImage"), duration: 5 }, 0, undefined],
    ["Kling：未声明模式 text 被拒", klingO1, { mode: JSON.stringify("text"), duration: 5 }, 0, undefined],
    ["seedance：非法分辨率", seedance, { mode: JSON.stringify("text"), duration: 5, resolution: "8k" }, 0, "提示词"],
    ["seedance：seed 越界", seedance, { mode: JSON.stringify("text"), duration: 5, resolution: "720p", seed: 99999999999 }, 0, "提示词"],
    ["seedance：非法比例", seedance, { mode: JSON.stringify("text"), duration: 5, resolution: "720p", aspectRatio: "4:3" }, 0, "提示词"],
    ["minimax：连续时长越界", minimax, { mode: JSON.stringify("text"), duration: 20 }, 0, undefined],
  ];
  for (const [name, entry, params, refCount, prompt] of cases) {
    let threw = "";
    try {
      validateVideoParamsAgainstCatalog(entry, params, refCount, prompt);
    } catch (err: any) {
      threw = err?.message ?? String(err);
    }
    assert(threw.length > 0, `负例被拒：${name}`, threw ? "" : "未抛错");
  }

  // 提示词必填（seedance）
  let threwEmpty = "";
  try {
    validateVideoParamsAgainstCatalog(seedance, { mode: JSON.stringify("text"), duration: 5, resolution: "720p" }, 0, "");
  } catch (err: any) {
    threwEmpty = err?.message ?? "";
  }
  assert(threwEmpty.includes("必填"), "seedance：提示词必填拦截");
  // -1 自动档合法
  let autoOk = false;
  try {
    validateVideoParamsAgainstCatalog(seedance, { mode: JSON.stringify("text"), duration: -1, resolution: "720p" }, 0, "提示词");
    autoOk = true;
  } catch {}
  assert(autoOk, "seedance：-1 自动档放行");
  // 多余模式拒绝
  let bogusMode = "";
  try {
    validateVideoParamsAgainstCatalog(klingO1, { ...okKling, mode: JSON.stringify("startEndRequired") }, 2);
  } catch (err: any) {
    bogusMode = err?.message ?? "";
  }
  assert(bogusMode.includes("模式"), "Kling：未声明的首尾帧模式拒绝");
}

// ---------------------------------------------------------------------------
// 4. applyVideoParamsEdits
// ---------------------------------------------------------------------------
console.log("== 4. 用户修改合并 ==");
{
  const card = buildVideoParamsCard(klingO1, baseOpts({ referenceMediaIds: [42] }));
  const edited = applyVideoParamsEdits(card, { duration: 10, quality: "pro" });
  assert(edited.fields.find((f) => f.key === "duration")!.value === 10, "时长改为 10");
  assert(edited.fields.find((f) => f.key === "quality")!.source === "user", "画质来源标记 user");
  const mmCard = buildVideoParamsCard(minimax, baseOpts({ modelKey: "vendor1:minimax", modelName: "minimax", referenceMediaIds: [42] }));
  const mmEdited = applyVideoParamsEdits(mmCard, { mode: JSON.stringify("text") });
  assert(mmEdited.fields.find((f) => f.key === "mode")!.source === "user", "模式来源标记 user");
  const params = cardFieldsToParams(edited);
  assert(params.duration === 10 && params.quality === "pro", "cardFieldsToParams 提取确认参数");
  const mmParams = cardFieldsToParams(mmEdited);
  assert(mmParams.mode === JSON.stringify("text"), "cardFieldsToParams 提取模式");

  let rejected = "";
  try {
    applyVideoParamsEdits(card, { duration: 7 });
  } catch (err: any) {
    rejected = err?.message ?? "";
  }
  assert(rejected.includes("可选项"), "select 非法选项拒绝");
  let unknownFieldIgnored = true;
  const edited2 = applyVideoParamsEdits(card, { nonexistent: "x", duration: 5 });
  unknownFieldIgnored = edited2.fields.every((f) => f.key !== "nonexistent");
  assert(unknownFieldIgnored, "非卡片字段被忽略");

  // 置灰选项拒绝（无图时选首帧；klingO1 是图输入专属模型，其无图首帧由概念首帧链兜底，不置灰）
  const noRefCard = buildVideoParamsCard(minimax, baseOpts({ modelKey: "vendor1:minimax", modelName: "minimax" }));
  let disabledRejected = "";
  try {
    applyVideoParamsEdits(noRefCard, { mode: JSON.stringify("singleImage") });
  } catch (err: any) {
    disabledRejected = err?.message ?? "";
  }
  assert(disabledRejected.includes("不可选"), "置灰选项（无图首帧）提交被拒");

  // prompt 编辑来源
  const edited3 = applyVideoParamsEdits(card, {}, "用户改过的提示词");
  assert(edited3.prompt === "用户改过的提示词" && edited3.promptSource === "user", "prompt 修改来源 user");
}

// ---------------------------------------------------------------------------
// 5. 偏好直通与恢复确认
// ---------------------------------------------------------------------------
console.log("== 5. 偏好记忆 ==");
{
  const pref: VideoParamsPreference = {
    modelKey: "vendor1:kling-video-o1/image-to-video",
    params: { mode: JSON.stringify("text"), duration: 5, quality: "std", aspectRatio: "16:9" },
    skipAsk: true,
    updatedAt: Date.now(),
  };
  assert(resolveSkipAskPreference(pref, pref.modelKey, false)?.skipAsk === true, "同模型 + skipAsk：直通");
  assert(resolveSkipAskPreference(pref, "vendor1:other", false) === null, "模型不同：不直通（出卡）");
  assert(resolveSkipAskPreference(pref, pref.modelKey, true) === null, "forceAsk：恢复出卡");
  assert(resolveSkipAskPreference({ ...pref, skipAsk: false }, pref.modelKey, false) === null, "未开 skipAsk：仅预填不出卡");

  // 偏好预填进卡片（来源 preference）
  const prefilled = buildVideoParamsCard(klingO1, baseOpts({ preference: pref }));
  assert(prefilled.fields.find((f) => f.key === "quality")!.source === "preference", "偏好预填字段来源 preference");
  assert(prefilled.fields.find((f) => f.key === "duration")!.value === 5, "偏好时长预填");

  assert(matchesResetAskPreference("重新询问参数"), "短语匹配：重新询问参数");
  assert(matchesResetAskPreference("以后每次都问我参数"), "短语匹配：每次都问");
  assert(!matchesResetAskPreference("生成一段猫的视频"), "普通生成消息不误触发恢复");
}

// ---------------------------------------------------------------------------
// 6. parseDeclaredModes 边界
// ---------------------------------------------------------------------------
console.log("== 6. 模式声明解析 ==");
{
  const modes = parseDeclaredModes(seedance);
  assert(modes.length === 4 && modes.filter((m) => m.kind === "multiReference").length === 3, "seedance：4 种声明模式（1 简单 + 3 组合）");
  const simple = parseDeclaredModes(klingO1);
  assert(simple.length === 1 && simple[0].kind === "singleImage", "Kling O1：仅单图模式");
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
