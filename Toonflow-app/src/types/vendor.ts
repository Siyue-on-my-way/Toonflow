export type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[];

export interface AspectRatioOption {
  value: string;
  label: string;
}

export type VideoAspectRatioOption = AspectRatioOption;

export interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
  /** 是否具备视觉理解能力（可接收图文多模态输入）；缺省视为不支持，快创聊天图文模式据此守门（SIY-144） */
  vision?: boolean;
}

export interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
  associationSkills?: string;
  aspectRatioOptions?: AspectRatioOption[];
  resolutionOptions?: ("1K" | "2K" | "4K")[];
  resolutionNote?: string;
  /** 需要的最少参考图数量（编辑类模型如 Nano Banana Pro 为 1）；不设置则不校验 */
  minReferenceImages?: number;
  /** 允许的最多参考图数量（Nano Banana Pro 为 10）；不设置则不限制 */
  maxReferenceImages?: number;
}

export interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  associationSkills?: string;
  audio: "always" | "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
  /** 时长是否为连续区间（durationResolutionMap[].duration 取 [min, max]），如 minimax fl2va 的 5-15 秒滑条；缺省视为离散档位 */
  durationContinuous?: boolean;
  aspectRatioOptions?: VideoAspectRatioOption[];
  qualityOptions?: ("std" | "pro")[];
  promptLengthRange?: [number, number];
  /** 提示词是否必填；缺省时仅纯文生视频模式必填（seedance 文档要求必填，kling O1/minimax 可选） */
  promptRequired?: boolean;
  /** 分辨率旁的警示说明（如"1080p 以上为超分输出"），随 modelDetail 下发渲染 */
  resolutionNote?: string;
  /**
   * 高级参数开关（元数据驱动渲染，前端按声明出现，禁止按模型名特判）：
   * - generateAudio：是否生成视频音频（seedance）
   * - returnLastFrame：是否返回视频尾帧（seedance）
   * - seed：随机种子（seedance，-1 表示随机）
   * - realPersonMode：真人素材资产化（seedance，待产品确认前不声明、UI 不出）
   */
  controls?: ("generateAudio" | "returnLastFrame" | "seed" | "realPersonMode")[];
  /** 提示词支持 @Image N / @Video N 槽位引用（seedance），前端据此渲染引用 chip 与一致性校验 */
  promptSlotReferences?: boolean;
  /** 离散时长 -1「自动」档的说明（SIY-161：官方文档未说明实际输出规则的按实标注，不脑补） */
  durationAutoNote?: string;
  /** 档位成本说明（std/pro、480p-4k 价格差异；价格数据未提供前留空，由产品补充后随元数据下发） */
  costNote?: string;
}

export interface TTSModel {
  name: string;
  modelName: string;
  type: "tts";
  voices: { title: string; voice: string }[];
}

export interface VendorConfig {
  id: string;
  version: string;
  name: string;
  author: string;
  description?: string;
  icon?: string;
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string }[];
  inputValues: Record<string, string>;
  models: (TextModel | ImageModel | VideoModel | TTSModel)[];
}

export type ReferenceList =
  | { type: "image"; sourceType: "base64"; base64: string; slot?: "start" | "end" }
  | { type: "audio"; sourceType: "base64"; base64: string; slot?: "start" | "end" }
  | { type: "video"; sourceType: "base64"; base64: string; slot?: "start" | "end" };

export interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

export interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: string;
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  /** Seedance and other multimodal models may expose these request controls. */
  generateAudio?: boolean;
  seed?: number;
  returnLastFrame?: boolean;
  /** 真人素材资产化（seedance）：仅类型占位，UI/DSL 是否放开待产品确认（SIY-159）。 */
  realPersonMode?: boolean;
  mode: VideoMode[];
  quality?: "std" | "pro";
}

export interface TTSConfig {
  text: string;
  voice: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
  referenceList?: Extract<ReferenceList, { type: "audio" }>[];
}

export interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}
