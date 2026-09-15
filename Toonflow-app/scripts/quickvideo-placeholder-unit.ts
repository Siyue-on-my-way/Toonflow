/**
 * QuickVideo / 单视频快创 —— 聊天图片占位符与镜头双提示词单元测试（SIY-151）
 * 纯函数测试，无需启动服务：
 *   yarn tsx scripts/quickvideo-placeholder-unit.ts
 *
 * 覆盖：
 * 1. parseImagePlaceholderSlots：##图N## 解析、去重升序、容许空格、越界编号保留截断、无占位符返回空数组；
 * 2. resolveSlotReferences：占位符编号按位序映射附件托盘（##图1## = references[0]），
 *    超出托盘容量的编号丢弃、空引用返回空映射；
 * 3. 存量状态兼容：旧版状态 JSON（镜头无 imagePrompt/videoPrompt 字段）解析回填默认空串，
 *    新版状态（含双提示词）解析通过且字段保留；
 * 4. quickVideoShotSchema 默认值：imagePrompt/videoPrompt 缺省时安全回退，不阻塞旧数据写入。
 */
import {
  IMAGE_PLACEHOLDER_MAX,
  QuickVideoState,
  parseImagePlaceholderSlots,
  quickVideoStateSchema,
  resolveSlotReferences,
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
// 1. parseImagePlaceholderSlots
// ---------------------------------------------------------------------------

assert(JSON.stringify(parseImagePlaceholderSlots("镜头1：##图1## 一只猫")) === "[1]", "解析单个占位符 ##图1##");
assert(JSON.stringify(parseImagePlaceholderSlots("##图2## 然后 ##图1##")) === "[1,2]", "多占位符去重升序");
assert(JSON.stringify(parseImagePlaceholderSlots("##图2## 然后 ##图2##")) === "[2]", "重复占位符去重");
assert(JSON.stringify(parseImagePlaceholderSlots("## 图 3 ## 尊重空格")) === "[3]", "容许占位符内空格");
assert(JSON.stringify(parseImagePlaceholderSlots("##图5## ##图99## ##图100##")) === "[5,99]", "两位编号保留，三位编号忽略");
assert(parseImagePlaceholderSlots("没有占位符的消息").length === 0, "无占位符返回空数组");
assert(parseImagePlaceholderSlots("").length === 0, "空文本返回空数组");
assert(parseImagePlaceholderSlots(null)?.length === 0, "null 文本安全返回空数组");
assert(parseImagePlaceholderSlots("##图1## ##图2## ##图3## ##图4## ##图5##").length === IMAGE_PLACEHOLDER_MAX, "超出托盘容量时截断");

// ---------------------------------------------------------------------------
// 2. resolveSlotReferences
// ---------------------------------------------------------------------------

assert(resolveSlotReferences([101, 102], [1, 2])[1] === 101 && resolveSlotReferences([101, 102], [1, 2])[2] === 102, "编号按位序映射托盘：##图1## -> references[0]");
assert(!resolveSlotReferences([101], [2])[2], "编号超出托盘容量时丢弃");
assert(JSON.stringify(resolveSlotReferences([], [1])) === "{}", "无引用时返回空映射");
assert(JSON.stringify(resolveSlotReferences([101], [])) === "{}", "无占位符时返回空映射");
assert(resolveSlotReferences([101, 102, 103, 104, 105], [1, 4])[4] === 104, "映射不超过托盘上限的位序");
assert(!resolveSlotReferences([101], [3])[3], "跳号（##图3## 但托盘只有 1 张）无映射");

// ---------------------------------------------------------------------------
// 3. 存量状态兼容：旧版镜头（无 imagePrompt/videoPrompt）解析回填默认值
// ---------------------------------------------------------------------------

const legacyStateJson = {
  schemaVersion: 1,
  version: 7,
  stage: "storyboard_draft",
  targetDuration: 30,
  videoRatio: "16:9",
  artStyle: "水彩",
  configVersion: 2,
  createIdempotencyKey: "idem-key-0001",
  brief: { theme: "猫", narrative: "一只猫的一天", confirmed: true, confirmedAt: 1 },
  storyboard: {
    version: 3,
    status: "draft",
    confirmedAt: null,
    summary: "旧版分镜",
    shots: [
      {
        id: "shot-1",
        index: 1,
        duration: 10,
        description: "小猫追蝴蝶",
        dialogue: "",
        camera: "全景",
        assetRefs: [],
        continuity: "last_frame",
        imageState: "pending",
        videoState: "pending",
        imageRef: null,
        videoRef: null,
        errorReason: null,
        firstFrame: null,
      },
    ],
  },
  generation: {},
  appliedKeys: {},
  lastChatAt: null,
  updateTime: 1,
};

const legacyParsed: QuickVideoState = quickVideoStateSchema.parse(JSON.parse(JSON.stringify(legacyStateJson)));
const legacyShot = legacyParsed.storyboard!.shots[0];
assert(legacyShot.imagePrompt === "", "存量镜头 imagePrompt 回填空串");
assert(legacyShot.videoPrompt === "", "存量镜头 videoPrompt 回填空串");
assert(legacyShot.description === "小猫追蝴蝶", "存量镜头其余字段解析不变");

const newStateJson = JSON.parse(JSON.stringify(legacyStateJson));
newStateJson.storyboard.shots[0].imagePrompt = "特写：橘猫扑蝶，水彩画风";
newStateJson.storyboard.shots[0].videoPrompt = "镜头缓慢推进，猫跃起扑蝶";
const newParsed: QuickVideoState = quickVideoStateSchema.parse(newStateJson);
assert(newParsed.storyboard!.shots[0].imagePrompt === "特写：橘猫扑蝶，水彩画风", "新版 imagePrompt 解析保留");
assert(newParsed.storyboard!.shots[0].videoPrompt === "镜头缓慢推进，猫跃起扑蝶", "新版 videoPrompt 解析保留");

// ---------------------------------------------------------------------------

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
