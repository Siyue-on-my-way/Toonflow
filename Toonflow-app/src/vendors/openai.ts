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
 * Toonflow AI供应商模板
 * @version 2.0
 */
// ============================================================
// 供应商配置
// ============================================================
export const vendor: VendorConfig = {
  id: "openai",
  version: "2.0",
  author: "Toonflow",
  name: "OpenAI标准接口",
  description: "OpenAI标准格式接口，可修改请求地址并手动添加模型。",
  icon: "",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "以v1结束，示例：https://api.openai.com/v1" },
  ],
  inputValues: {
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
  },
  models: [
    { name: "GPT-4o", modelName: "gpt-4o", type: "text", think: false },
    { name: "GPT-4.1", modelName: "gpt-4.1", type: "text", think: false },
    { name: "GPT-5.1", modelName: "gpt-5.1", type: "text", think: false },
    { name: "GPT-5.2", modelName: "gpt-5.2", type: "text", think: false },
    { name: "GPT-5.4", modelName: "gpt-5.4", type: "text", think: false },
  ],
};

export function createVendorAPI(inputValues: Record<string, string>) {
  // ============================================================
  // 适配器函数
  // ============================================================
  const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
    if (!inputValues.apiKey) throw new Error("缺少API Key");
    const apiKey = inputValues.apiKey.replace(/^Bearer\s+/i, "");
    return createOpenAI({ baseURL: inputValues.baseUrl, apiKey }).chat(model.modelName);
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
