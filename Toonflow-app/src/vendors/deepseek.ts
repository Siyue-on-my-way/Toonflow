import FormData from "form-data";
import crypto from "node:crypto";
import { VendorConfig, TextModel, ImageModel, VideoModel, TTSModel, ImageConfig, VideoConfig, TTSConfig, PollResult, ReferenceList, VideoMode } from "@/types/vendor";
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
 * Toonflow AI供应商模板 - DeepSeek
 * @version 2.1
 */

// ============================================================
// 供应商配置
// ============================================================

export const vendor: VendorConfig = {
  id: "deepseek",
  version: "2.1",
  author: "Toonflow",
  name: "DeepSeek",
  description:
    "DeepSeek 官方接口适配，支持 V4 系列模型与思考模式（思维链输出）。\n\n[前往平台](https://platform.deepseek.com/)",
  icon: "",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "示例：https://api.deepseek.com" },
  ],
  inputValues: {
    apiKey: "",
    baseUrl: "https://api.deepseek.com/v1",
  },
  models: [
    { name: "DeepSeek V4 Pro", modelName: "deepseek-v4-pro", type: "text", think: true },
    { name: "DeepSeek V4 Flash", modelName: "deepseek-v4-flash", type: "text", think: true },
  ],
};

export function createVendorAPI(inputValues: Record<string, string>) {
  
  // ============================================================
  // 适配器函数
  // ============================================================
  
  const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
    if (!inputValues.apiKey) throw new Error("缺少API Key");
    const apiKey = inputValues.apiKey.replace(/^Bearer\s+/i, "");
  
    // DeepSeek 思考强度仅支持 high / max（low、medium 会被映射为 high，xhigh 会被映射为 max）
    // thinkLevel: 0/1/2 → high, 3 → max
    const effortMap: Record<0 | 1 | 2 | 3, "high" | "max"> = {
      0: "high",
      1: "high",
      2: "high",
      3: "max",
    };
  
    const enableThinking = model.think && think;
    const extraBody: Record<string, any> = {
      thinking: { type: enableThinking ? "enabled" : "disabled" },
    };
    if (enableThinking) {
      extraBody.reasoning_effort = effortMap[thinkLevel];
    }
  
    return createOpenAICompatible({
      baseURL: inputValues.baseUrl,
      apiKey,
      fetch: async (url: string, options?: RequestInit) => {
        const rawBody = JSON.parse((options?.body as string) ?? "{}");
        const modifiedBody = {
          ...rawBody,
          ...extraBody
        };
        return await fetch(url, {
          ...options,
          body: JSON.stringify(modifiedBody),
        });
      },
    }).chatModel(model.modelName);
  };
  
  const imageRequest = async (config: ImageConfig, model: ImageModel, inputValues: Record<string, string>): Promise<string> => {
    return "";
  };
  
  const videoRequest = async (config: VideoConfig, model: VideoModel, inputValues: Record<string, string>): Promise<string> => {
    return "";
  };
  
  const ttsRequest = async (config: TTSConfig, model: TTSModel, inputValues: Record<string, string>): Promise<string> => {
    return "";
  };
  
  const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
    return { hasUpdate: false, latestVersion: "2.0", notice: "" };
  };
  
  const updateVendor = async (): Promise<string> => {
    return "";
  };
  
  // ============================================================
  // 导出
  // ============================================================
  
  
  
  
  
  
  
  
  
  
  return { textRequest, imageRequest, videoRequest, ttsRequest, checkForUpdates, updateVendor };
}
