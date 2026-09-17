/**
 * QuickVideo / 单视频快创 —— 引用图三级解析与意图判定单元测试（SIY-158 方案A）
 * 纯函数测试，无需启动服务/数据库/供应商：
 *   npx tsx scripts/quickvideo-reference-unit.ts
 *
 * 覆盖：
 * 1. classifyChatReferenceIntent：以图为条件指代 / 显式拒绝用图 / 意图不明 / 否定语义剥除；
 * 2. resolveChatReferences 三级解析顺序：LLM 显式参数（mediaIds > slots）> 消息占位符 > 本轮附件兜底；
 * 3. 反静默守门：本轮有引用图、前两级为空且意图不明时 needsConfirmation=true（禁止静默退化）；
 * 4. 意图分支：textOnly 保持纯文生、imageConditioned 自动兜底引用图；
 * 5. 边界：去重、上限截断（视频 2 / 图片 4）、非法 id 过滤、SIY-137 事故场景复现。
 */
import {
  classifyChatReferenceIntent,
  resolveChatReferences,
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

// ---------------------------------------------------------------------------
// 1. classifyChatReferenceIntent
// ---------------------------------------------------------------------------

console.log("== 1. classifyChatReferenceIntent：意图判定 ==");
{
  const imageCases: [string, string][] = [
    ["让这张图动起来", "这张图"],
    ["以这张图为首帧生成视频", "作为首帧"],
    ["图生视频，动起来", "图生视频"],
    ["用图1生成一段视频", "用图"],
    ["把图片里的人跳舞做成视频", "图片里"],
    ["参考图给我生成5秒视频", "参考图"],
    ["垫图生成一张海报", "垫图（图片模式）"],
    ["这个画面变成视频", "这个画面"],
    ["帮我用该图做一版图生图", "该图"],
    ["照片里的人物笑一笑", "照片里"],
  ];
  for (const [text, tag] of imageCases) {
    assert(classifyChatReferenceIntent(text) === "imageConditioned", `imageConditioned：${tag}`, `实际 ${classifyChatReferenceIntent(text)}`);
  }

  const textOnlyCases: [string, string][] = [
    ["纯文生视频，不用图", "纯文生视频"],
    ["不要用这张图，直接按描述生成", "不要用这张图"],
    ["不用图片，纯文生图", "不用图片"],
    ["忽略我上传的图片", "忽略图片"],
    ["不需要图", "不需要图"],
    ["别用我发的图", "别用我发的图"],
    ["生成一段海边日落的视频，纯文字生视频即可", "纯文字生视频"],
  ];
  for (const [text, tag] of textOnlyCases) {
    assert(classifyChatReferenceIntent(text) === "textOnly", `textOnly：${tag}`, `实际 ${classifyChatReferenceIntent(text)}`);
  }

  const uncertainCases: [string, string][] = [
    ["生成一段15秒的城市宣传视频", "无指代"],
    ["", "空文本"],
    ["生成一个视频", "无指代"],
  ];
  for (const [text, tag] of uncertainCases) {
    assert(classifyChatReferenceIntent(text) === "uncertain", `uncertain：${tag}`, `实际 ${classifyChatReferenceIntent(text)}`);
  }

  // 有意设计：本轮附带图片 + 「让她/让它动起来」→ 动起来在有引用图的消息里几乎总是指让图动，
 // 自动兜底并在结果中向用户披露（回退提示词已含"已自动使用你本轮附带的图片"）；
  // 真正拿不准的场景由守门显式询问，而不是静默代选。
  assert(classifyChatReferenceIntent("让她动起来") === "imageConditioned", "动起来：本轮带图时代词指代视为以图生成", `实际 ${classifyChatReferenceIntent("让她动起来")}`);

  // 否定语义剥除：「不是纯文生视频，用这张图」应判为以图为条件，而非被"纯文生视频"误命中
  assert(classifyChatReferenceIntent("不是纯文生视频，用这张图生成") === "imageConditioned", "否定剥除：不是纯文生视频+这张图 -> imageConditioned", `实际 ${classifyChatReferenceIntent("不是纯文生视频，用这张图生成")}`);
  // 无主语「画面里」不误伤：纯文生提示词高频出现，不应自动兜底用图
  assert(classifyChatReferenceIntent("画面里要有海浪和夕阳") === "uncertain", "无主语「画面里」不误判", `实际 ${classifyChatReferenceIntent("画面里要有海浪和夕阳")}`);
}

// ---------------------------------------------------------------------------
// 2. resolveChatReferences：三级解析顺序
// ---------------------------------------------------------------------------

console.log("== 2. resolveChatReferences：解析顺序 ==");
{
  // 第 1 级：LLM 显式 mediaIds 优先于一切
  const explicitIds = resolveChatReferences({
    explicitIds: [47],
    explicitSlots: [2],
    slotMap: { 1: 101, 2: 102 },
    messageSlots: [1],
    userText: "让这张图动起来",
    turnReferences: [47, 48],
    max: 2,
  });
  assert(explicitIds.ids.length === 1 && explicitIds.ids[0] === 47 && explicitIds.source === "explicit", "显式 mediaIds 优先于 slots 与消息占位符", JSON.stringify(explicitIds));

  // 第 1 级：显式 slots 映射
  const explicitSlots = resolveChatReferences({
    explicitSlots: [2],
    slotMap: { 1: 101, 2: 102 },
    messageSlots: [1],
    userText: "用图2生成",
    turnReferences: [47],
    max: 2,
  });
  assert(explicitSlots.ids.length === 1 && explicitSlots.ids[0] === 102 && explicitSlots.source === "explicit", "显式 slots 按映射解析为 mediaId", JSON.stringify(explicitSlots));

  // 第 2 级：消息占位符（LLM 未传参时确定性回退，不触发守门）
  const placeholder = resolveChatReferences({
    slotMap: { 1: 101 },
    messageSlots: [1],
    userText: "让##图1##动起来",
    turnReferences: [101],
    max: 2,
  });
  assert(placeholder.ids.length === 1 && placeholder.ids[0] === 101 && placeholder.source === "placeholder" && !placeholder.needsConfirmation, "消息占位符为第 2 级回退", JSON.stringify(placeholder));

  // 第 3 级：本轮附件兜底（意图明确）
  const fallback = resolveChatReferences({
    slotMap: {},
    messageSlots: [],
    userText: "让这张图动起来，作为首帧",
    turnReferences: [47],
    max: 2,
  });
  assert(fallback.ids.length === 1 && fallback.ids[0] === 47 && fallback.source === "turnAttachment" && !fallback.needsConfirmation, "意图明确时本轮附件确定性兜底（SIY-137 事故修复路径）", JSON.stringify(fallback));

  // 反静默守门：意图不明时显式确认，不静默退化
  const gate = resolveChatReferences({
    slotMap: {},
    messageSlots: [],
    userText: "生成一段都市办公室的视频",
    turnReferences: [47],
    max: 2,
  });
  assert(gate.ids.length === 0 && gate.needsConfirmation && gate.source === "none", "意图不明 -> needsConfirmation（反静默守门）", JSON.stringify(gate));

  // textOnly：明确不用图，保持纯文生、不守门
  const textOnly = resolveChatReferences({
    slotMap: {},
    messageSlots: [],
    userText: "纯文生视频，不用图",
    turnReferences: [47],
    max: 2,
  });
  assert(textOnly.ids.length === 0 && textOnly.source === "none" && !textOnly.needsConfirmation, "textOnly 保持纯文生且不守门", JSON.stringify(textOnly));

  // 无引用图 + 意图不明：不守门（纯文生视频合法路径）
  const noRefs = resolveChatReferences({
    slotMap: {},
    messageSlots: [],
    userText: "生成一段都市办公室的视频",
    turnReferences: [],
    max: 2,
  });
  assert(noRefs.ids.length === 0 && noRefs.source === "none" && !noRefs.needsConfirmation, "无引用图时守门不触发", JSON.stringify(noRefs));
}

// ---------------------------------------------------------------------------
// 3. 边界：去重、截断、非法 id、占位符越界
// ---------------------------------------------------------------------------

console.log("== 3. resolveChatReferences：边界 ==");
{
  const dedup = resolveChatReferences({ explicitIds: [47, 47, 48], slotMap: {}, userText: "用图", max: 2 });
  assert(JSON.stringify(dedup.ids) === "[47,48]", "显式 ids 去重", JSON.stringify(dedup.ids));

  const cappedVideo = resolveChatReferences({ slotMap: {}, messageSlots: [], userText: "用图", turnReferences: [47, 48, 49], max: 2 });
  assert(cappedVideo.ids.length === 2 && cappedVideo.source === "turnAttachment", "视频参考图上限 2 张截断", JSON.stringify(cappedVideo.ids));

  const cappedImage = resolveChatReferences({ slotMap: {}, messageSlots: [], userText: "垫图", turnReferences: [1, 2, 3, 4, 5], max: 4 });
  assert(cappedImage.ids.length === 4, "图片参考图上限 4 张截断", JSON.stringify(cappedImage.ids));

  const illegal = resolveChatReferences({ explicitIds: [-1, 0, 47.5, 47], slotMap: {}, userText: "用图", max: 2 });
  assert(JSON.stringify(illegal.ids) === "[47]", "非法 id（负数/0/小数）被过滤", JSON.stringify(illegal.ids));

  const overflowSlot = resolveChatReferences({
    slotMap: {},
    messageSlots: [3],
    userText: "用##图3##生成",
    turnReferences: [47],
    max: 2,
  });
  assert(overflowSlot.ids.length === 1 && overflowSlot.ids[0] === 47 && overflowSlot.source === "turnAttachment", "占位符越界无映射时落到附件兜底", JSON.stringify(overflowSlot));

  const missingText = resolveChatReferences({
    slotMap: {},
    messageSlots: [],
    userText: undefined,
    turnReferences: [47],
    max: 2,
  });
  assert(missingText.needsConfirmation, "userText 缺失视为意图不明（安全默认，绝不静默丢图）", JSON.stringify(missingText));
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
