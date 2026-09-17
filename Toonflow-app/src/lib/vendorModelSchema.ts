import { z } from "zod";

// 单条渠道协议目录记录（Layer1，o_vendorConfig.models 里的一项）的字段校验，
// 供 admin 协议目录管理接口与 member 账号自助接口共用。
export const vendorModelSchema = z.discriminatedUnion("type", [
  z.object({
    name: z.string(),
    modelName: z.string(),
    type: z.literal("text"),
    think: z.boolean(),
    // 视觉理解能力标记（快创聊天图文模式守门用，SIY-144）；缺省视为不支持
    vision: z.boolean().optional(),
  }),
  z.object({
    name: z.string(),
    modelName: z.string(),
    type: z.literal("image"),
    mode: z.array(z.enum(["text", "singleImage", "multiReference"])),
    aspectRatioOptions: z
      .array(
        z.object({
          value: z.string().min(1),
          label: z.string().min(1),
        }),
      )
      .optional(),
    resolutionOptions: z.array(z.enum(["1K", "2K", "4K"])).optional(),
    resolutionNote: z.string().optional(),
    minReferenceImages: z.number().int().optional(),
    maxReferenceImages: z.number().int().optional(),
  }),
  z.object({
    name: z.string(),
    modelName: z.string(),
    type: z.literal("video"),
    mode: z.array(
      z.union([
        z.enum(["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional", "text", "audioReference", "videoReference"]),
        z.array(z.string().regex(/^(videoReference|imageReference|audioReference):\d+$/)),
      ]),
    ),
    audio: z.union([z.literal("always"), z.literal("optional"), z.boolean()]),
    durationResolutionMap: z.array(
      z.object({
        duration: z.array(z.number()),
        resolution: z.array(z.string()),
      }),
    ),
    // SIY-159：时长连续区间标记（minimax fl2va 5-15 滑条）
    durationContinuous: z.boolean().optional(),
    // SIY-159：提示词必填标记（seedance 必填，kling O1/minimax 可选）
    promptRequired: z.boolean().optional(),
    // SIY-159：分辨率警示说明（seedance 超分档位等），随 modelDetail 渲染
    resolutionNote: z.string().optional(),
    // SIY-159：高级参数开关声明，前端按声明渲染折叠区，禁止按模型名特判
    controls: z.array(z.enum(["generateAudio", "returnLastFrame", "seed", "realPersonMode"])).optional(),
    // SIY-159：提示词支持 @Image N / @Video N 槽位引用（seedance）
    promptSlotReferences: z.boolean().optional(),
    aspectRatioOptions: z
      .array(
        z.object({
          value: z.string().min(1),
          label: z.string().min(1),
        }),
      )
      .optional(),
    qualityOptions: z.array(z.enum(["std", "pro"])).min(1).optional(),
    promptLengthRange: z.tuple([z.number().int().min(0), z.number().int().min(1)]).optional(),
  }),
]);
