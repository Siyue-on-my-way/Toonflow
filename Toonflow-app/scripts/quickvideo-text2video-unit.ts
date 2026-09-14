/**
 * QuickVideo / 单视频快创 —— 纯文本直接生视频与双轨自适应单元测试（SIY-149）
 * 纯函数测试，无需启动服务、无需数据库/AI 供应商：
 *   npx tsx scripts/quickvideo-text2video-unit.ts
 *
 * 覆盖范围：
 * 1. isVideoModelSupportingText 判定（原生 text2video 能力）：
 *    - 目录 mode 含 "text" 时放行；未包含或模式为空时判定为不支持原生文生视频。
 * 2. isVideoModelSupportingSingleImage 判定（单图/首帧生视频能力）：
 *    - 未声明 mode 或声明包含 "singleImage" 时放行；显式排他模式（如仅 startEndRequired / 仅 text）拦截。
 * 3. generate_video 工具 inputSchema 数据契约校验：
 *    - referenceMediaId 为可选字段（纯文本无需图片输入时成功通过校验）；
 *    - 纯文本一句话仅传 prompt 校验通过；
 *    - 传 prompt + duration 校验通过；
 *    - 传 prompt + referenceMediaId 校验通过（兼容存量图生视频模式）；
 *    - prompt 为空或非法时长被校验拦截。
 * 4. 双轨自适应决策管道逻辑（纯函数模拟）：
 *    - 用户提供参考图 -> 走明确指定的图生视频轨；
 *    - 用户未提供参考图 + 视频模型支持 text -> 走原生文生视频轨；
 *    - 用户未提供参考图 + 视频模型仅支持 singleImage -> 走链式概念首帧生图 + 图生视频轨；
 *    - 用户未提供参考图 + 视频模型两者均不支持 -> 抛出明确阻断原因。
 */
import { z } from "zod";
import {
  isVideoModelSupportingText,
  isVideoModelSupportingSingleImage,
  type VendorModelEntry,
} from "@/lib/quickVideo/modelValidation";
import { SHOT_DURATION_MIN, SHOT_DURATION_MAX } from "@/lib/quickVideo/contract";

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

console.log("== 1. isVideoModelSupportingText：文生视频原生能力识别 ==");
{
  const textModel: VendorModelEntry = {
    modelName: "kling-v1-text",
    type: "video",
    mode: ["text", "singleImage"],
  };
  assert(isVideoModelSupportingText(textModel), "mode 包含 text 时返回 true");

  const pureTextModel: VendorModelEntry = {
    modelName: "vidu-q2-text",
    type: "video",
    mode: ["text"],
  };
  assert(isVideoModelSupportingText(pureTextModel), "mode 仅含 text 时返回 true");

  const singleImageOnly: VendorModelEntry = {
    modelName: "kling-v1-image",
    type: "video",
    mode: ["singleImage"],
  };
  assert(!isVideoModelSupportingText(singleImageOnly), "mode 仅含 singleImage 时返回 false");

  const emptyModeModel: VendorModelEntry = {
    modelName: "unknown-video",
    type: "video",
    mode: [],
  };
  assert(!isVideoModelSupportingText(emptyModeModel), "mode 为空数组时返回 false");

  assert(!isVideoModelSupportingText(null), "传入 null 时安全返回 false");
  assert(!isVideoModelSupportingText(undefined), "传入 undefined 时安全返回 false");
}

console.log("== 2. isVideoModelSupportingSingleImage：首帧图生视频能力识别 ==");
{
  const singleImageModel: VendorModelEntry = {
    modelName: "kling-v1-image",
    type: "video",
    mode: ["singleImage"],
  };
  assert(isVideoModelSupportingSingleImage(singleImageModel), "mode 包含 singleImage 时返回 true");

  const multiModeModel: VendorModelEntry = {
    modelName: "kling-omni",
    type: "video",
    mode: ["text", "singleImage", "startEndRequired"],
  };
  assert(isVideoModelSupportingSingleImage(multiModeModel), "包含 singleImage 在内的多模式返回 true");

  const noModeModel: VendorModelEntry = {
    modelName: "legacy-model",
    type: "video",
  };
  assert(isVideoModelSupportingSingleImage(noModeModel), "未声明 mode 缺省宽松放行返回 true");

  const textOnlyModel: VendorModelEntry = {
    modelName: "vidu-q2-text",
    type: "video",
    mode: ["text"],
  };
  assert(!isVideoModelSupportingSingleImage(textOnlyModel), "显式声明仅 text 模式排他时返回 false");

  const startEndOnlyModel: VendorModelEntry = {
    modelName: "special-anim",
    type: "video",
    mode: ["startEndRequired"],
  };
  assert(!isVideoModelSupportingSingleImage(startEndOnlyModel), "仅支持首尾帧不支持单图首帧时返回 false");
}

console.log("== 3. generate_video 入参契约（纯文本无图放行） ==");
{
  const generateVideoInputSchema = z.object({
    prompt: z.string().min(1).max(2000),
    referenceMediaId: z.number().int().positive().optional(),
    duration: z.number().int().min(SHOT_DURATION_MIN).max(SHOT_DURATION_MAX).optional(),
  });

  const pureTextInput = {
    prompt: "阳光下盛开的向日葵微风拂过",
  };
  const parsed1 = generateVideoInputSchema.safeParse(pureTextInput);
  assert(parsed1.success, "纯文本一句话仅传 prompt 校验通过（referenceMediaId 可选）");

  const withDurationInput = {
    prompt: "未来赛博都市夜景飞车穿梭",
    duration: 8,
  };
  const parsed2 = generateVideoInputSchema.safeParse(withDurationInput);
  assert(parsed2.success, "纯文本 + 合法时长校验通过");

  const withRefInput = {
    prompt: "参考图中人物在雨中奔跑",
    referenceMediaId: 42,
    duration: 10,
  };
  const parsed3 = generateVideoInputSchema.safeParse(withRefInput);
  assert(parsed3.success, "带参考图引用 mediaId 校验通过（兼容图生视频模式）");

  const emptyPromptInput = {
    prompt: "",
  };
  const parsedEmpty = generateVideoInputSchema.safeParse(emptyPromptInput);
  assert(!parsedEmpty.success, "prompt 为空串时校验拦截");

  const invalidDurationInput = {
    prompt: "视频测试",
    duration: 2,
  };
  const parsedInvalidDur = generateVideoInputSchema.safeParse(invalidDurationInput);
  assert(!parsedInvalidDur.success, "时长低于 SHOT_DURATION_MIN 时拦截");
}

console.log("== 4. 双轨自适应调度管道决策测试 ==");
{
  type GenerationTrack = "explicit_image_to_video" | "native_text_to_video" | "chained_concept_first_frame" | "unsupported";

  function resolveVideoTrack(model: VendorModelEntry, referenceId?: number): GenerationTrack {
    if (referenceId) {
      return isVideoModelSupportingSingleImage(model) ? "explicit_image_to_video" : "unsupported";
    }
    if (isVideoModelSupportingText(model)) {
      return "native_text_to_video";
    }
    if (isVideoModelSupportingSingleImage(model)) {
      return "chained_concept_first_frame";
    }
    return "unsupported";
  }

  // 模型 A：支持 text 与 singleImage（如 Kling）
  const hybridModel: VendorModelEntry = {
    modelName: "kling-omni",
    type: "video",
    mode: ["text", "singleImage"],
  };

  // 模型 B：仅支持 singleImage（如特定生视频大模型）
  const imageOnlyModel: VendorModelEntry = {
    modelName: "image-to-video-only",
    type: "video",
    mode: ["singleImage"],
  };

  // 模型 C：仅支持 text
  const textOnlyModel: VendorModelEntry = {
    modelName: "text-only",
    type: "video",
    mode: ["text"],
  };

  // 模型 D：两者均不支持
  const unsupportedModel: VendorModelEntry = {
    modelName: "start-end-only",
    type: "video",
    mode: ["startEndRequired"],
  };

  // 场景 1：用户未传图，混合模型 -> 走原生文生视频
  assert(
    resolveVideoTrack(hybridModel, undefined) === "native_text_to_video",
    "未传图且模型支持 text 时，优先走原生文生视频轨道",
  );

  // 场景 2：用户未传图，仅图生视频模型 -> 走链式概念首帧
  assert(
    resolveVideoTrack(imageOnlyModel, undefined) === "chained_concept_first_frame",
    "未传图且模型仅支持 singleImage 时，自适应走链式概念首帧生成轨道",
  );

  // 场景 3：用户传了参考图，混合模型 -> 走显式图生视频
  assert(
    resolveVideoTrack(hybridModel, 99) === "explicit_image_to_video",
    "用户显式提供参考图时，走图生视频轨道",
  );

  // 场景 4：用户传了参考图，仅图生视频模型 -> 走显式图生视频
  assert(
    resolveVideoTrack(imageOnlyModel, 99) === "explicit_image_to_video",
    "用户显式提供参考图时，仅图生视频模型正常走图生视频",
  );

  // 场景 5：用户未传图，纯文本模型 -> 走原生文生视频
  assert(
    resolveVideoTrack(textOnlyModel, undefined) === "native_text_to_video",
    "未传图且模型为纯文本模型时，走原生文生视频轨道",
  );

  // 场景 6：用户传了图但模型为纯文本模型 -> 拦截（不支持单图首帧）
  assert(
    resolveVideoTrack(textOnlyModel, 99) === "unsupported",
    "传图但模型不支持首帧输入时，拦截为不支持",
  );

  // 场景 7：两者均不支持 -> 拦截
  assert(
    resolveVideoTrack(unsupportedModel, undefined) === "unsupported",
    "模型既不支持文生视频也不支持单图首帧时，拦截为不支持",
  );
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
