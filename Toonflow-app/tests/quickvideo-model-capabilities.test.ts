/**
 * QuickVideo 模型能力选择单元测试。
 * 运行：npx tsx tests/quickvideo-model-capabilities.test.ts
 */
import {
  getQuickVideoImageInputRequirements,
  selectQuickVideoImageModel,
  selectQuickVideoVideoModel,
  supportsQuickVideoImageInput,
} from "@/lib/quickVideo/modelCapabilities";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, extra = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✘ ${name}${extra ? ` (${extra})` : ""}`);
  }
}

const referenceOnly = { modelName: "runninghub:rhart-image-n-g31-flash", type: "image", mode: ["singleImage", "multiReference"] };
const textAndReference = { modelName: "runninghub:rhart-image-g-2", type: "image", mode: ["text", "singleImage", "multiReference"] };
const textOnlyVideo = { modelName: "runninghub:kling-video-o3-pro", type: "video", mode: ["text"] };
const imageVideo = { modelName: "runninghub:kling-v3.0-pro", type: "video", mode: ["singleImage"] };

console.log("== 1. 无资产引用时跳过图生图首项 ==");
{
  const requirements = getQuickVideoImageInputRequirements([
    { assetRefs: [] },
    { assetRefs: [] },
  ]);
  const selected = selectQuickVideoImageModel([referenceOnly, textAndReference], requirements);
  assert(requirements.needsText && !requirements.needsReference, "无引用镜头需要文生图能力");
  assert(selected?.modelName === textAndReference.modelName, "空 assetRefs 不选仅支持参考图的首项", selected?.modelName);
}

console.log("== 2. 混合引用场景要求模型同时支持文生图和参考图 ==");
{
  const requirements = getQuickVideoImageInputRequirements([{ assetRefs: [] }, { assetRefs: [{}] }]);
  assert(requirements.needsText && requirements.needsReference, "混合镜头同时记录两类能力");
  assert(!supportsQuickVideoImageInput(referenceOnly, requirements), "仅参考图模型不能覆盖无引用镜头");
  assert(supportsQuickVideoImageInput(textAndReference, requirements), "同时支持 text/参考图的模型可覆盖混合镜头");
}

console.log("== 3. 有资产引用时仍可使用图生图模型 ==");
{
  const requirements = getQuickVideoImageInputRequirements([{ assetRefs: [{}, {}] }]);
  const selected = selectQuickVideoImageModel([referenceOnly, textAndReference], requirements);
  assert(!requirements.needsText && requirements.needsReference, "纯引用镜头不强制文生图能力");
  assert(selected?.modelName === referenceOnly.modelName, "纯引用镜头保留图生图模型可用", selected?.modelName);
}

console.log("== 4. 视频兜底跳过仅文生视频模型 ==");
{
  const selected = selectQuickVideoVideoModel([textOnlyVideo, imageVideo]);
  assert(selected?.modelName === imageVideo.modelName, "快创视频选择支持 singleImage 的模型", selected?.modelName);
}

console.log("== 5. 缺失资产需要素材图时仍要求文生图能力 ==");
{
  const requirements = getQuickVideoImageInputRequirements([{ assetRefs: [{ name: "花" }] }], {
    needsTextForMaterialGeneration: true,
  });
  assert(requirements.needsText && requirements.needsReference, "需补生成素材时同时要求文生图和参考图能力");
  assert(!supportsQuickVideoImageInput(referenceOnly, requirements), "仅参考图模型不能生成缺失素材图");
  assert(supportsQuickVideoImageInput(textAndReference, requirements), "文生图/参考图兼容模型可覆盖该链路");
}

console.log("== 6. 单图模型不覆盖多资产镜头 ==");
{
  const singleOnly = { modelName: "single-only", type: "image", mode: ["singleImage"] };
  const requirements = getQuickVideoImageInputRequirements([{ assetRefs: [{}, {}] }]);
  assert(!supportsQuickVideoImageInput(singleOnly, requirements), "单图模型不会被用于多参考镜头");
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
