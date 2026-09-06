import FormData from "form-data";
import crypto from "node:crypto";
import { VendorConfig, TextModel, ImageModel, VideoModel, TTSModel, ImageConfig, VideoConfig, TTSConfig, PollResult, ReferenceList, VideoMode } from "@/types/vendor";
import { buildRunningHubRequestBody, findRunningHubModelSpec, KLING_O1_VENDOR_MODEL, NANO_BANANA_PRO_VENDOR_MODEL } from "@/vendors/runninghub-models";
import { createOpenAI } from "@ai-sdk/openai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createZhipu } from "zhipu-ai-provider";
import { createQwen } from "qwen-ai-provider-v5";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createMinimax } from "vercel-minimax-ai-provider";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import axios from "axios";
import jsonwebtoken from "jsonwebtoken";
import { zipImage, zipImageResolution, mergeImages, urlToBase64, pollTask, logger } from "@/utils/vm";

/**
 * Toonflow AI供应商模板 - RunningHub
 * @version 1.0
 */

// ================
// 供应商配置
// ================

export const vendor: VendorConfig = {
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
      name: "Nano Banana 2 图生图 (rhart-image-n-g31-flash)",
      modelName: "rhart-image-n-g31-flash",
      type: "image",
      mode: ["singleImage", "multiReference"],
    },
    {
      name: "GPT Image (文生图/图生图)",
      modelName: "rhart-image-g-2",
      type: "image",
      // 参考图走 image-to-image 独立 endpoint（docs/runninghub-api/gpt-image-2.0-conomy.md）
      mode: ["text", "singleImage", "multiReference"],
      aspectRatioOptions: [
        "1:1", "3:2", "2:3", "5:4", "4:5", "16:9", "9:16", "21:9",
        "3:4", "4:3", "9:21", "1:2", "2:1", "1:3", "3:1",
      ].map((ratio) => ({ value: ratio, label: ratio })),
      resolutionOptions: ["1K", "2K", "4K"],
      resolutionNote: "低价渠道版：因接口稳定性限制，暂不保证精准输出 2K/4K，多数情况下仍会输出 1K。",
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
    },
    {
      name: "文生图 (midjourney-v6)",
      modelName: "midjourney-v6",
      type: "image",
      mode: ["text"],
    },
    NANO_BANANA_PRO_VENDOR_MODEL,
    {
      name: "图生视频 (rhart-video-minimax-h3-oss-fl2va)",
      modelName: "rhart-video/minimax-h3-oss/fl2va",
      type: "video",
      // RunningHub 的标准模型 API 同时支持文生、单图、首尾帧以及两个可选首/尾帧模式。
      // 这些是模型的物理能力，不能在设置页被普通用户预先裁剪。
      mode: ["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional", "text"],
      audio: "always",
      durationResolutionMap: [{ duration: [5, 15], resolution: ["768p"] }],
      aspectRatioOptions: [
        { value: "1:1", label: "1:1 (Square)" },
        { value: "2:3", label: "2:3 (Portrait Photo)" },
        { value: "3:2", label: "3:2 (Photo)" },
        { value: "3:4", label: "3:4 (Portrait Standard)" },
        { value: "4:3", label: "4:3 (Standard)" },
        { value: "9:16", label: "9:16 (Portrait Widescreen)" },
        { value: "16:9", label: "16:9 (Widescreen)" },
        { value: "21:9", label: "21:9 (Ultrawide)" },
      ],
    },
    {
      name: "图生视频 (rhart-video-v3.1-fast)",
      modelName: "rhart-video-v3.1-fast",
      type: "video",
      mode: [["imageReference:3"]],
      audio: false,
      durationResolutionMap: [{ duration: [8, 8], resolution: ["720p", "1080p", "4k"] }],
    },
    {
      name: "多模态视频 (Seedance 2.0 Fast)",
      modelName: "seedance-2.0-fast",
      type: "video",
      mode: ["text", ["imageReference:9"], ["videoReference:3"], ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [-1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "1080p", "2k", "4k"] }],
    },
    {
      name: "多模态视频 (Seedance 2.0 Mini)",
      modelName: "seedance-2.0-mini",
      type: "video",
      mode: ["text", ["imageReference:9"], ["videoReference:3"], ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [-1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "1080p", "2k", "4k"] }],
    },
    KLING_O1_VENDOR_MODEL,
  ],
};

export async function queryRunningHubTask(
  inputValues: Record<string, string>,
  taskId: string,
): Promise<{ status: "SUCCESS" | "FAILED" | "RUNNING"; url?: string; error?: string }> {
  const apiKey = (inputValues.apiKey || "").replace(/^Bearer\s+/i, "");
  if (!apiKey) throw new Error("缺少 RunningHub API Key");
  const baseUrl = (inputValues.baseUrl || "https://www.runninghub.ai/openapi/v2").replace(/\/$/, "");
  const response = await axios.post(`${baseUrl}/query`, { taskId }, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
  });
  const data = response.data;
  if (data?.status === "SUCCESS") {
    const url = data.results?.find((result: any) => result?.url)?.url;
    return url ? { status: "SUCCESS", url } : { status: "FAILED", error: "任务成功，但未返回结果 URL" };
  }
  if (data?.status === "FAILED") {
    return { status: "FAILED", error: `[${data.errorCode ?? "-"}] ${data.errorMessage || "任务生成失败"}` };
  }
  return { status: "RUNNING" };
}

export function createVendorAPI(inputValues: Record<string, string>, hooks: { onProviderTaskId?: (providerTaskId: string) => Promise<void> } = {}) {
  
  // ================
  // 辅助工具
  // ================
  
  const getHeaders = () => {
    if (!inputValues.apiKey) throw new Error("缺少 RunningHub API Key");
    const apiKey = inputValues.apiKey.replace(/^Bearer\s+/i, "");
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    };
  };
  
  const getBaseUrl = () => {
    return inputValues.baseUrl.replace(/\/$/, "");
  };

  const uploadImage = async (imageDataUrl: string): Promise<string> => {
    const match = imageDataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/);
    if (!match) throw new Error("RunningHub 图片引用必须是 JPG、PNG 或 WEBP 的 base64 数据");
    const [, contentType, base64] = match;
    const form = new FormData();
    form.append("file", Buffer.from(base64, "base64"), {
      filename: `reference.${contentType.split("/")[1].replace("jpeg", "jpg")}`,
      contentType,
    });
    logger(`[RunningHub] 上传参考图片: ${form.getBuffer().length} bytes`);
    const response = await axios.post(`${getBaseUrl()}/media/upload/binary`, form, {
      headers: { Authorization: getHeaders().Authorization, ...form.getHeaders() },
    });
    const downloadUrl = response.data?.data?.download_url;
    if (response.data?.code !== 0 || !downloadUrl) {
      throw new Error(`参考图片上传失败: ${response.data?.message || JSON.stringify(response.data)}`);
    }
    return downloadUrl;
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
      await hooks.onProviderTaskId?.(response.data.taskId);
      return response.data.taskId;
    } else {
      const errorCode = response.data?.errorCode ?? "-";
      const errorMessage = response.data?.errorMessage || JSON.stringify(response.data);
      throw new Error(`任务提交失败 [${errorCode}]: ${errorMessage}`);
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
          return {
            completed: true,
            error: `[${data.errorCode ?? "-"}] ${data.errorMessage || "任务生成失败"}`,
          };
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
  
  const imageRequest = async (config: ImageConfig, model: ImageModel, inputValues: Record<string, string>): Promise<string> => {
    const spec = findRunningHubModelSpec(model.modelName, "image");
    if (!spec) throw new Error(`不支持的图像模型: ${model.modelName}`);

    const imageRefs = (config.referenceList ?? []).map(r => r.base64).filter(Boolean);
    const requestData = buildRunningHubRequestBody(spec, config, imageRefs);

    // 带参考图时切换到图生图 endpoint（如 GPT Image 的 image-to-image）
    const endpoint = imageRefs.length > 0 && spec.imageEndpoint ? spec.imageEndpoint : spec.endpoint;
    const taskId = await submitTask(endpoint, requestData);
    return await queryTask(taskId);
  };

  const videoRequest = async (config: VideoConfig, model: VideoModel, inputValues: Record<string, string>): Promise<string> => {
    const spec = findRunningHubModelSpec(model.modelName, "video");
    if (!spec) throw new Error(`不支持的视频模型: ${model.modelName}`);

    const imageReferences = (config.referenceList ?? []).filter((r) => r.type === "image");
    const videoReferences = (config.referenceList ?? []).filter((r) => r.type === "video");
    const audioReferences = (config.referenceList ?? []).filter((r) => r.type === "audio");
    const hasFrameSlots = imageReferences.some((r) => r.slot);
    const imageRefs = hasFrameSlots
      ? [imageReferences.find((r) => r.slot === "start")?.base64, imageReferences.find((r) => r.slot === "end")?.base64]
      : imageReferences.map((r) => r.base64);
    const uploadReference = async (ref: string, type: "image" | "video" | "audio") => {
      if (type === "image" && spec.imageInput?.uploadImages) return await uploadImage(ref);
      return ref;
    };
    const requestRefs = await Promise.all(imageRefs.map(async (ref) => ref ? await uploadReference(ref, "image") : ref));
    if (spec.multimodalReferences) {
      const limits = spec.multimodalReferences;
      const [videoUrls, audioUrls] = await Promise.all([
        Promise.all(videoReferences.map((r) => uploadReference(r.base64, "video"))),
        Promise.all(audioReferences.map((r) => uploadReference(r.base64, "audio"))),
      ]);
      const imageUrls = requestRefs.filter((ref): ref is string => Boolean(ref));
      const totalReferences = imageUrls.length + videoUrls.length + audioUrls.length;
      if (imageUrls.length > limits.maxImages) throw new Error(`${spec.modelName} 图片参考最多 ${limits.maxImages} 张`);
      if (videoUrls.length > limits.maxVideos) throw new Error(`${spec.modelName} 视频参考最多 ${limits.maxVideos} 个`);
      if (audioUrls.length > limits.maxAudios) throw new Error(`${spec.modelName} 音频参考最多 ${limits.maxAudios} 个`);
      if (limits.requireVisual && audioUrls.length > 0 && imageUrls.length + videoUrls.length === 0) {
        throw new Error(`${spec.modelName} 音频参考至少需要同时提供一张图片或一段视频`);
      }
      if (totalReferences > 0) {
        (config as VideoConfig & Record<string, any>).imageUrls = imageUrls;
        (config as VideoConfig & Record<string, any>).videoUrls = videoUrls;
        (config as VideoConfig & Record<string, any>).audioUrls = audioUrls;
      }
      const requestData = buildRunningHubRequestBody(spec, config, []);
      const taskId = await submitTask(spec.endpoint, requestData);
      return await queryTask(taskId);
    }
    const requestData = buildRunningHubRequestBody(spec, config, requestRefs);

    const taskId = await submitTask(spec.endpoint, requestData);
    return await queryTask(taskId);
  };
  
  const ttsRequest = async (config: TTSConfig, model: TTSModel, inputValues: Record<string, string>): Promise<string> => {
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
  
  
  
  
  
  
  
  
  
  
  
  return { textRequest, imageRequest, videoRequest, ttsRequest, checkForUpdates, updateVendor };
}
