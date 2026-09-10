/**
 * QuickVideo / 单视频快创 —— 聊天生图/首帧绑定数据契约单元测试（SIY-132）
 * 纯函数测试，无需启动服务、无需数据库/AI 供应商：
 *   npx tsx scripts/quickvideo-media-unit.ts
 *
 * 覆盖范围：
 * - pickEnabledModel：模型目录 + 全局启用列表的纯函数校验逻辑（media.ts 里 validateImageModelKey
 *   调用的核心判定，独立到 modelValidation.ts 以避免引入 db.ts 的 MySQL 前置校验，
 *   使其可以在没有真实 o_vendorConfig 数据、没有数据库连接的情况下直接测试）。
 * - contract.ts 新增的 MediaRef / shotFirstFrameSchema / snapshotShotSchema.firstFrame /
 *   QUICK_VIDEO_CHAT_MODES 契约结构是否符合预期（草稿阶段可粘贴/替换/解除、确认后随快照冻结
 *   的前置数据形状）。
 * 落库、权限隔离、幂等、版本冲突等需要真实 MySQL 的路径，覆盖在 quickvideo-e2e.ts 的相关小节
 * （需先启动服务：npx tsx src/app.ts），本脚本不重复覆盖、也不连接数据库。
 */
import {
  mediaRefSchema,
  shotFirstFrameSchema,
  snapshotFirstFrameSchema,
  quickVideoShotSchema,
  snapshotShotSchema,
  QUICK_VIDEO_CHAT_MODES,
  QUICK_VIDEO_MEDIA_KINDS,
  QUICK_VIDEO_MEDIA_STATES,
  QUICK_VIDEO_MEDIA_SOURCES,
} from "@/lib/quickVideo/contract";
import { pickEnabledModel, type VendorModelEntry } from "@/lib/quickVideo/modelValidation";

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

console.log("== 1. pickEnabledModel：目录命中 + 类型匹配 + 未收紧启用范围时放行 ==");
{
  const models: VendorModelEntry[] = [
    { modelName: "gpt-image-1", type: "image" },
    { modelName: "sora-2", type: "video" },
  ];
  const hit = pickEnabledModel(models, [], "gpt-image-1", "image");
  assert(hit?.modelName === "gpt-image-1", "enabledNames 为空数组时放行目录中的任意 image 模型");
}

console.log("== 2. pickEnabledModel：目录里存在但类型不符（用 image 模型名查 video）不命中 ==");
{
  const models: VendorModelEntry[] = [{ modelName: "gpt-image-1", type: "image" }];
  const hit = pickEnabledModel(models, [], "gpt-image-1", "video");
  assert(hit === null, "modelName 存在但 type 不匹配时应返回 null");
}

console.log("== 3. pickEnabledModel：目录里不存在的模型名不命中 ==");
{
  const models: VendorModelEntry[] = [{ modelName: "gpt-image-1", type: "image" }];
  const hit = pickEnabledModel(models, [], "nonexistent-model", "image");
  assert(hit === null, "目录中不存在的 modelName 应返回 null");
}

console.log("== 4. pickEnabledModel：enabledNames 非空且不包含该模型时拒绝（即使目录里存在） ==");
{
  const models: VendorModelEntry[] = [
    { modelName: "gpt-image-1", type: "image" },
    { modelName: "gpt-image-2", type: "image" },
  ];
  const hit = pickEnabledModel(models, ["gpt-image-2"], "gpt-image-1", "image");
  assert(hit === null, "enabledNames 收紧范围后，未列入的模型即使在目录里也应拒绝");
  const hit2 = pickEnabledModel(models, ["gpt-image-2"], "gpt-image-2", "image");
  assert(hit2?.modelName === "gpt-image-2", "enabledNames 中列出的模型应放行");
}

console.log("== 5. MediaRef 契约：kind/state/source 枚举与字段完整性 ==");
{
  const ref = {
    mediaId: 1,
    projectId: 10,
    kind: "image",
    assetId: 2,
    imageId: 3,
    videoId: null,
    state: "done",
    model: "aibotplatform:gpt-image-1",
    promptSummary: "一只猫",
    source: "chat",
    errorReason: null,
    url: "http://localhost/oss/1/quickVideo/chat-abcd1234.jpg",
    createTime: Date.now(),
  };
  const parsed = mediaRefSchema.safeParse(ref);
  assert(parsed.success, "合法 MediaRef 应通过 schema 校验", parsed.success ? "" : JSON.stringify((parsed as any).error?.issues));
  assert(QUICK_VIDEO_MEDIA_KINDS.includes("image") && QUICK_VIDEO_MEDIA_KINDS.includes("video"), "媒体种类枚举包含 image/video");
  assert(QUICK_VIDEO_MEDIA_STATES.includes("generating") && QUICK_VIDEO_MEDIA_STATES.includes("done") && QUICK_VIDEO_MEDIA_STATES.includes("failed"), "媒体状态枚举包含 generating/done/failed");
  assert(QUICK_VIDEO_MEDIA_SOURCES.includes("chat") && QUICK_VIDEO_MEDIA_SOURCES.includes("asset_board"), "媒体来源枚举包含 chat/asset_board");

  const badKind = { ...ref, kind: "audio" };
  assert(!mediaRefSchema.safeParse(badKind).success, "非法 kind（audio）应被拒绝，不静默通过");
}

console.log("== 6. 镜头首帧引用 shotFirstFrameSchema / snapshotFirstFrameSchema ==");
{
  const firstFrame = { mediaId: 5, assetId: 6, imageId: 7, boundAt: Date.now() };
  assert(shotFirstFrameSchema.safeParse(firstFrame).success, "合法首帧引用（不含 filePath）应通过草稿态 schema");
  assert(!snapshotFirstFrameSchema.safeParse(firstFrame).success, "冻结快照首帧 schema 缺少 filePath 时应拒绝（禁止把无文件的首帧冻结进快照）");
  assert(snapshotFirstFrameSchema.safeParse({ ...firstFrame, filePath: "/1/quickVideo/x.jpg" }).success, "补齐 filePath 后应通过冻结快照 schema");
}

console.log("== 7. QuickVideoShot 契约：firstFrame 默认 null，且与 imageRef 分开建模 ==");
{
  const base = {
    id: "shot-1",
    index: 1,
    duration: 5,
    description: "开场镜头",
    imageState: "pending",
    videoState: "pending",
  };
  const parsed = quickVideoShotSchema.safeParse(base);
  assert(parsed.success, "未提供 firstFrame 字段时应用默认值 null 通过校验", parsed.success ? "" : JSON.stringify((parsed as any).error?.issues));
  if (parsed.success) {
    assert(parsed.data.firstFrame === null, "firstFrame 默认值为 null（未绑定状态）");
    assert("imageRef" in parsed.data && "firstFrame" in parsed.data, "imageRef（分镜输出图）与 firstFrame（首帧输入）是两个独立字段");
  }
}

console.log("== 8. snapshotShotSchema：冻结快照携带 firstFrame（含 filePath），供生成引擎直接读取 ==");
{
  const snapshotShot = {
    id: "shot-1",
    index: 1,
    duration: 5,
    description: "开场镜头",
    firstFrame: { mediaId: 1, assetId: 2, imageId: 3, boundAt: Date.now(), filePath: "/1/quickVideo/x.jpg" },
  };
  const parsed = snapshotShotSchema.safeParse(snapshotShot);
  assert(parsed.success, "带 filePath 的首帧快照应通过校验", parsed.success ? "" : JSON.stringify((parsed as any).error?.issues));

  const withoutFirstFrame = { id: "shot-2", index: 2, duration: 5, description: "无首帧镜头" };
  const parsed2 = snapshotShotSchema.safeParse(withoutFirstFrame);
  assert(parsed2.success && parsed2.data.firstFrame === null, "未绑定首帧的镜头快照 firstFrame 默认回退为 null（生成引擎据此回退用 imageRef）");
}

console.log("== 9. 聊天发送模式枚举：text/image 两种，不包含尚未实现的 video 聊天生成 ==");
{
  assert(QUICK_VIDEO_CHAT_MODES.length === 2, "当前 MVP 只开放 text/image 两种聊天模式");
  assert(QUICK_VIDEO_CHAT_MODES.includes("text") && QUICK_VIDEO_CHAT_MODES.includes("image"), "聊天模式包含 text 和 image");
  assert(!(QUICK_VIDEO_CHAT_MODES as readonly string[]).includes("video"), "聊天生成视频不在本轮 MVP 范围内，不应出现在枚举里");
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
