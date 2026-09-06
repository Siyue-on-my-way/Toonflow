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
  aspectRatioOptions?: VideoAspectRatioOption[];
  qualityOptions?: ("std" | "pro")[];
  promptLengthRange?: [number, number];
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
