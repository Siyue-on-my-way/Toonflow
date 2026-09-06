/**
 * Toonflow AI供应商模板 - RunningHub
 * @version 1.0
 */

// ================
// 类型定义
// ================

type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[];

interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}

interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
  associationSkills?: string;
}

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  associationSkills?: string;
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
}

interface TTSModel {
  name: string;
  modelName: string;
  type: "tts";
  voices: { title: string; voice: string }[];
}

interface VendorConfig {
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

type ReferenceList =
  | { type: "image"; sourceType: "base64"; base64: string }
  | { type: "audio"; sourceType: "base64"; base64: string }
  | { type: "video"; sourceType: "base64"; base64: string };

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}

interface TTSConfig {
  text: string;
  voice: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
  referenceList?: Extract<ReferenceList, { type: "audio" }>[];
}

interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}

// ================
// 全局声明
// ================

declare const axios: any;
declare const logger: (msg: string) => void;
declare const jsonwebtoken: any;
declare const zipImage: (base64: string, size: number) => Promise<string>;
declare const zipImageResolution: (base64: string, w: number, h: number) => Promise<string>;
declare const mergeImages: (base64Arr: string[], maxSize?: string) => Promise<string>;
declare const urlToBase64: (url: string) => Promise<string>;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
declare const createOpenAI: any;
declare const createDeepSeek: any;
declare const createZhipu: any;
declare const createQwen: any;
declare const createOpenAICompatible: any;
declare const createXai: any;
declare const createMinimax: any;
declare const createGoogleGenerativeAI: any;
declare const exports: {
  vendor: VendorConfig;
  textRequest: (m: TextModel, t: boolean, tl: 0 | 1 | 2 | 3) => any;
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>;
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>;
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>;
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>;
  updateVendor?: () => Promise<string>;
};

// ================
// 供应商配置
// ================

const vendor: VendorConfig = {
  id: "runninghub",
  version: "1.0",
  author: "Toonflow",
  name: "RunningHub",
  description: "## RunningHub AI 模型服务接入\n支持 RunningHub 的图生图、文生视频等模型。",
  inputs: [
    { key: "apiKey", label: "API Key", type: "password", required: true, placeholder: "请输入 RunningHub API Key" },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "默认：https://www.runninghub.ai/openapi/v2" },
  ],
  inputValues: { apiKey: "", baseUrl: "https://www.runninghub.ai/openapi/v2" },
  models: [
    {
      name: "图生图 (rhart-image-n-g31-flash)",
      modelName: "rhart-image-n-g31-flash",
      type: "image",
      mode: ["singleImage"],
    },
    {
      name: "文生视频 (kling-video-o3-pro)",
      modelName: "kling-video-o3-pro",
      type: "video",
      mode: ["text"],
      audio: "optional",
      durationResolutionMap: [
        { duration: [5, 10], resolution: ["720p", "1080p"] }
      ]
    },
    {
      name: "图生视频 (kling-v3.0-pro)",
      modelName: "kling-v3.0-pro",
      type: "video",
      mode: ["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional"],
      audio: "optional",
      durationResolutionMap: [
        { duration: [5, 10], resolution: ["720p", "1080p"] }
      ]
    }
  ],
};

// ================
// 辅助工具
// ================

const getHeaders = () => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少 RunningHub API Key");
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`
  };
};

const getBaseUrl = () => {
  return vendor.inputValues.baseUrl.replace(/\/$/, "");
};

const extractRawBase64 = (base64Str: string): string => {
  return base64Str.replace(/^data:image\/\w+;base64,/, "");
};

const submitTask = async (endpoint: string, data: any) => {
  const url = `${getBaseUrl()}/${endpoint}`;
  logger(`[RunningHub] 提交任务: ${url}`);
  const response = await axios.post(url, data, { headers: getHeaders() });
  
  if (response.data && response.data.taskId) {
    logger(`[RunningHub] 任务提交成功，taskId: ${response.data.taskId}`);
    return response.data.taskId;
  } else {
    throw new Error(`任务提交失败: ${response.data?.errorMessage || JSON.stringify(response.data)}`);
  }
};

const queryTask = async (taskId: string): Promise<string> => {
  const queryUrl = `${getBaseUrl()}/query`;
  
  const result = await pollTask(async () => {
    logger(`[RunningHub] 轮询任务状态: ${taskId}`);
    try {
      const response = await axios.post(queryUrl, { taskId }, { headers: getHeaders() });
      const data = response.data;
      
      if (data.status === "SUCCESS") {
        if (data.results && data.results.length > 0 && data.results[0].url) {
          return { completed: true, data: data.results[0].url };
        } else {
          return { completed: true, error: "任务成功，但未返回结果 URL" };
        }
      } else if (data.status === "FAILED") {
        return { completed: true, error: data.errorMessage || "任务生成失败" };
      }
      
      // RUNNING or QUEUED
      return { completed: false };
    } catch (error: any) {
      logger(`[RunningHub] 查询异常: ${error.message}`);
      return { completed: false }; // 继续轮询
    }
  }, 5000, 600000); // 每5秒轮询，10分钟超时

  if (result.error) throw new Error(result.error);
  return await urlToBase64(result.data!);
};

// ================
// 适配器函数
// ================

const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
  throw new Error("RunningHub 暂未实现文本生成");
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  let endpoint = "";
  let requestData: any = {
    prompt: config.prompt,
    aspectRatio: config.aspectRatio,
    resolution: config.size.toLowerCase()
  };

  if (model.modelName === "rhart-image-n-g31-flash") {
    endpoint = `${model.modelName}/image-to-image`;
    if (!config.referenceList || config.referenceList.length === 0) {
      throw new Error("图生图模式需要提供参考图片");
    }
    // RunningHub supports base64 data URI directly in imageUrls
    requestData.imageUrls = [config.referenceList[0].base64];
  } else {
    throw new Error(`不支持的图像模型: ${model.modelName}`);
  }

  const taskId = await submitTask(endpoint, requestData);
  return await queryTask(taskId);
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  let endpoint = "";
  let requestData: any = {
    prompt: config.prompt,
    aspectRatio: config.aspectRatio,
    duration: String(config.duration),
    sound: config.audio === true
  };

  const isText = config.mode.includes("text");
  const isSingleImage = config.mode.includes("singleImage");
  const isStartEndRequired = config.mode.includes("startEndRequired");
  const isEndFrameOptional = config.mode.includes("endFrameOptional");
  const isStartFrameOptional = config.mode.includes("startFrameOptional");

  const imageRefs = config.referenceList?.filter(r => r.type === "image").map(r => r.base64) || [];

  if (model.modelName === "kling-video-o3-pro") {
    endpoint = `${model.modelName}/text-to-video`;
    if (!isText) throw new Error("该模型仅支持文生视频模式");
    requestData.multiShot = false;
    requestData.shotType = "customize";
  } else if (model.modelName === "kling-v3.0-pro") {
    endpoint = `${model.modelName}/image-to-video`;
    
    if (isSingleImage && imageRefs.length > 0) {
      requestData.firstImageUrl = imageRefs[0];
    } else if (isStartEndRequired && imageRefs.length >= 2) {
      requestData.firstImageUrl = imageRefs[0];
      requestData.lastImageUrl = imageRefs[1];
    } else if (isEndFrameOptional && imageRefs.length > 0) {
      requestData.firstImageUrl = imageRefs[0];
      if (imageRefs.length >= 2) requestData.lastImageUrl = imageRefs[1];
    } else if (isStartFrameOptional && imageRefs.length > 0) {
      if (imageRefs.length >= 2) {
        requestData.firstImageUrl = imageRefs[0];
        requestData.lastImageUrl = imageRefs[1];
      } else {
        requestData.firstImageUrl = imageRefs[0];
      }
    } else {
      throw new Error("图生视频模式需要提供参考图片");
    }
    
    requestData.cfgScale = 0.5;
    requestData.multiShot = false;
    requestData.shotType = "customize";
  } else {
    throw new Error(`不支持的视频模型: ${model.modelName}`);
  }

  const taskId = await submitTask(endpoint, requestData);
  return await queryTask(taskId);
};

const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  return "";
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return { hasUpdate: false, latestVersion: "1.0", notice: "初始版本" };
};

const updateVendor = async (): Promise<string> => {
  return "";
};

// ================
// 导出
// ================

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;

export {};
