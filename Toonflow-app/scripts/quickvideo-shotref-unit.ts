/**
 * QuickVideo / 单视频快创 —— 聊天按镜头操作纯逻辑单元测试（SIY-140）
 * 纯函数测试，无需启动服务、无需数据库/AI 供应商：
 *   npx tsx scripts/quickvideo-shotref-unit.ts
 *
 * 覆盖范围：
 * - parseShotRefTokens：##编号# 语法解析（多镜头、空白容忍、剥离与原文保留）
 * - resolveShotRefsFromState：编号归属、storyboardId 一致性、重复/越界/空分镜
 * - isShotOpStageAllowed：阶段放行（素材生成任意阶段；按镜头生成要求分镜存在）
 * - buildChatShotImagePrompt / buildChatShotVideoPrompt / buildAssetImagePrompt：
 *   非破坏性拼装（基础文本 + 用户补充指令，分镜结构化字段不参与改写）
 * 落库、任务互斥、幂等、socket 广播等需要真实 MySQL/服务的路径，不在此覆盖。
 */
import {
  buildAssetImagePrompt,
  buildChatShotImagePrompt,
  buildChatShotVideoPrompt,
  hasShotRefTokens,
  isShotOpStageAllowed,
  parseAssetType,
  parseShotRefTokens,
  resolveShotRefsFromState,
} from "@/lib/quickVideo/shotRef";
import { quickVideoStoryboardSchema } from "@/lib/quickVideo/contract";

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

function buildStoryboard() {
  return quickVideoStoryboardSchema.parse({
    version: 1,
    status: "draft",
    confirmedAt: null,
    summary: "测试分镜",
    shots: [
      { id: "shot-1", index: 1, duration: 5, description: "城市天际线日出", dialogue: "", camera: "远景", assetRefs: [], firstFrame: null },
      { id: "shot-2", index: 2, duration: 8, description: "女孩走进旧街道", dialogue: "你好", camera: "中景跟拍", assetRefs: [], firstFrame: null },
      { id: "shot-3", index: 3, duration: 6, description: "产品特写", dialogue: "", camera: "特写", assetRefs: [], firstFrame: null },
    ],
  });
}

console.log("== 1. parseShotRefTokens：单镜头 / 多镜头 / 空白容忍 ==");
{
  const a = parseShotRefTokens("##1# 把这个镜头生成视频");
  assert(a.displayNos.length === 1 && a.displayNos[0] === 1, "单镜头编号解析", JSON.stringify(a));
  assert(a.cleaned === "把这个镜头生成视频", "剥离引用标记后的指令文本", JSON.stringify(a));

  const b = parseShotRefTokens("##1# ##3# 首帧画面改成雨后");
  assert(b.displayNos.join(",") === "1,3", "多镜头编号按出现顺序解析", JSON.stringify(b));
  assert(b.cleaned === "首帧画面改成雨后", "多镜头剥离后保留指令", JSON.stringify(b));

  const c = parseShotRefTokens("## 2 #  夜景");
  assert(c.displayNos[0] === 2 && c.cleaned === "夜景", "编号两侧空白容忍", JSON.stringify(c));

  const d = parseShotRefTokens("##1# ##1# 去重");
  assert(d.displayNos.join(",") === "1", "重复编号只保留一次", JSON.stringify(d));

  const e = parseShotRefTokens("普通消息不带引用");
  assert(e.displayNos.length === 0 && e.cleaned === "普通消息不带引用", "无引用时原文原样返回");
  assert(!hasShotRefTokens("普通消息") && hasShotRefTokens("##2# 有引用"), "hasShotRefTokens 判定");
}

console.log("== 2. resolveShotRefsFromState：归属校验与错误提示 ==");
{
  const state = { storyboard: buildStoryboard() };

  const ok = resolveShotRefsFromState(state, [{ displayNo: 1, storyboardId: "shot-1" }]);
  assert(ok.resolved.length === 1 && ok.resolved[0].shotId === "shot-1" && ok.resolved[0].displayNo === 1, "合法引用解析出 storyboardId");

  const bad = resolveShotRefsFromState(state, [{ displayNo: 99 }]);
  assert(bad.resolved.length === 0 && bad.errors.length === 1 && bad.errors[0].includes("99"), "越界编号报错且不产生引用", JSON.stringify(bad));

  const mismatch = resolveShotRefsFromState(state, [{ displayNo: 2, storyboardId: "shot-1" }]);
  assert(mismatch.resolved.length === 0 && mismatch.errors[0].includes("过期"), "storyboardId 与当前分镜不一致报错", JSON.stringify(mismatch));

  const mixed = resolveShotRefsFromState(state, [{ displayNo: 1 }, { displayNo: 99 }, { displayNo: 3 }]);
  assert(mixed.resolved.length === 2 && mixed.errors.length === 1, "部分有效时保留有效引用并单独报错", JSON.stringify(mixed));

  const dup = resolveShotRefsFromState(state, [
    { displayNo: 1, storyboardId: "shot-1" },
    { displayNo: 1, storyboardId: "shot-1" },
  ]);
  assert(dup.resolved.length === 1, "重复引用去重");

  const none = resolveShotRefsFromState(null, [{ displayNo: 1 }]);
  assert(none.resolved.length === 0 && none.errors[0].includes("暂无分镜"), "无分镜时给出友好错误");
}

console.log("== 3. isShotOpStageAllowed：阶段放行 ==");
{
  assert(isShotOpStageAllowed("collect_brief", "generate_asset"), "素材生成在 collect_brief 阶段放行");
  assert(!isShotOpStageAllowed("collect_brief", "generate_shot_video"), "无分镜阶段不允许按镜头生视频");
  assert(!isShotOpStageAllowed("brief_confirmed", "generate_shot_image"), "无分镜阶段不允许按镜头生图");
  assert(isShotOpStageAllowed("storyboard_draft", "generate_shot_video"), "分镜草稿阶段放行按镜头生视频");
  assert(isShotOpStageAllowed("storyboard_confirmed", "generate_shot_image"), "分镜确认阶段放行按镜头生图");
  assert(isShotOpStageAllowed("generating", "generate_shot_video"), "生成阶段放行按镜头操作");
  assert(isShotOpStageAllowed("ready_to_assemble", "generate_shot_image"), "装配阶段放行按镜头补图");
  assert(!isShotOpStageAllowed("completed", "generate_shot_video"), "成片完成后不再允许按镜头生成");
}

console.log("== 4. 提示词拼装：非破坏性合并 ==");
{
  const shot = { description: "女孩走进旧街道", camera: "中景跟拍", dialogue: "你好", duration: 8, assetRefs: [{ type: "role" as const, name: "女孩", desc: "短发红裙" }] };
  const img = buildChatShotImagePrompt({ artStyle: "赛博朋克", videoRatio: "9:16", shot, instruction: "改成雨夜霓虹" });
  assert(img.includes("女孩走进旧街道"), "生图提示词包含分镜描述原文");
  assert(img.includes("改成雨夜霓虹"), "生图提示词包含用户补充指令");
  assert(img.includes("中景跟拍") && img.includes("短发红裙") && img.includes("9:16"), "生图提示词保留运镜/资产/比例");
  assert(img.indexOf("改成雨夜霓虹") > img.indexOf("女孩走进旧街道"), "补充指令作为叠加参数拼在基础文本之后");

  const imgNoInstr = buildChatShotImagePrompt({ artStyle: "", videoRatio: "16:9", shot, instruction: "" });
  assert(!imgNoInstr.includes("用户补充要求"), "无补充指令时不出现指令段");

  const vid = buildChatShotVideoPrompt(shot, "镜头缓慢推进");
  assert(vid.includes("8 秒") && vid.includes("女孩走进旧街道") && vid.includes("镜头缓慢推进"), "生视频提示词包含时长/描述/指令");
  assert(vid.includes("口型对齐台词：你好"), "有台词时对齐口型要求保留");

  const asset = buildAssetImagePrompt({ artStyle: "水墨", assetType: "scene", name: "旧街道", description: "青石板路", instruction: "黄昏光线" });
  assert(asset.includes("场景「旧街道」") && asset.includes("青石板路") && asset.includes("黄昏光线") && asset.includes("水墨"), "素材提示词包含类型/名称/描述/指令/画风");
}

console.log("== 5. parseAssetType：类型校验 ==");
{
  assert(parseAssetType("role") === "role" && parseAssetType("scene") === "scene" && parseAssetType("tool") === "tool", "三类合法类型放行");
  let threw = false;
  try {
    parseAssetType("chat_media");
  } catch {
    threw = true;
  }
  assert(threw, "非法类型抛错（chat_media 不允许由聊天指定）");
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
