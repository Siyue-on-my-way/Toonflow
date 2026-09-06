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
  id: "grsai",
  version: "2.2",
  author: "Toonflow",
  name: "Grsai",
  description: "Grsai AI平台适配，支持文生图、图生图、文生视频、Gemini兼容文本模型 \n [前往中转平台](https://tf.grsai.ai/zh)",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true },
    {
      key: "baseUrl",
      label: "请求地址",
      type: "url",
      required: true,
      placeholder: "示例：https://grsai.dakka.com.cn",
    },
  ],
  inputValues: { apiKey: "", baseUrl: "https://grsai.dakka.com.cn" },
  models: [
    {
      name: "GPT Image 2",
      modelName: "gpt-image-2",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
    },
    {
      name: "Nano Banana Fast",
      modelName: "nano-banana-fast",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
    },
    {
      name: "Nano Banana 2",
      modelName: "nano-banana-2",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
    },
    {
      name: "Nano Banana Pro",
      modelName: "nano-banana-pro",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
    },
  ],
};

export function createVendorAPI(inputValues: Record<string, string>) {
  
  // ============================================================
  // 辅助工具
  // ============================================================
  
  const getHeaders = () => {
    const apiKey = inputValues.apiKey.replace(/^Bearer\s+/i, "");
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
  };
  
  // ============================================================
  // 适配器函数
  // ============================================================
  
  const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
    if (!inputValues.apiKey) throw new Error("缺少API Key");
    const apiKey = inputValues.apiKey.replace(/^Bearer\s+/i, "");
    return createGoogleGenerativeAI({
      baseURL: `${inputValues.baseUrl}/v1beta`,
      apiKey,
    }).chat(model.modelName);
  };
  
  const imageRequest = async (config: ImageConfig, model: ImageModel, inputValues: Record<string, string>): Promise<string> => {
    if (!inputValues.apiKey) throw new Error("缺少API Key");
    const baseUrl = inputValues.baseUrl;
    const headers = getHeaders();
  
    // 构造请求参数
    const requestBody: any = {
      model: model.modelName,
      prompt: config.prompt,
      aspectRatio: config.aspectRatio,
      webHook: "-1",
      shutProgress: true,
    };
  
    // 补充模型专属参数
    if (model.modelName.startsWith("nano-banana")) {
      requestBody.imageSize = config.size;
    } else {
      requestBody.size = config.aspectRatio;
      requestBody.variants = 1;
    }
  
    // 处理参考图
    if (config.referenceList && config.referenceList.length > 0) {
      requestBody.urls = config.referenceList.map((img) => img.base64);
    }
  
    // 选择接口路径
    const apiPath = model.modelName.startsWith("nano-banana") ? "/v1/draw/nano-banana" : "/v1/draw/completions";
  
    logger(`开始提交图片生成任务，模型：${model.modelName}`);
    logger(`${baseUrl}${apiPath}`)
    const submitResp = await fetch(`${baseUrl}${apiPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });
    if (!submitResp.ok) {
      const errorReason = await submitResp.text();
      throw new Error(`任务提交失败：${errorReason}`);
    }
    const submitData = await submitResp.json();
    if (submitData.code !== 0) throw new Error(`任务提交失败：${submitData.msg}`);
  
    const taskId = submitData.data.id;
    logger(`图片任务提交成功，任务ID：${taskId}`);
  
    // 轮询结果
    const pollResult = await pollTask(
      async () => {
        const resp = await fetch(`${baseUrl}/v1/draw/result`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: taskId }),
        });
        if (!resp.ok) {
          const errorReason = await resp.text();
          throw new Error(`查询任务失败：${errorReason}`);
        }
        const respData = await resp.json();
        if (respData.code !== 0) return { completed: true, error: respData.msg };
  
        const taskData = respData.data;
        if (taskData.status === "failed")
          return {
            completed: true,
            error: taskData.failure_reason || taskData.error,
          };
        if (taskData.status === "succeeded") {
          const imgUrl = taskData.results?.[0]?.url || taskData.url;
          return { completed: true, data: imgUrl };
        }
        logger(`图片任务生成中，进度：${taskData.progress}%`);
        return { completed: false };
      },
      3000,
      600000,
    );
  
    if (pollResult.error) throw new Error(pollResult.error);
    logger(`图片生成完成，开始转换Base64`);
    return await urlToBase64(pollResult.data!);
  };
  
  const videoRequest = async (config: VideoConfig, model: VideoModel, inputValues: Record<string, string>): Promise<string> => {
    if (!inputValues.apiKey) throw new Error("缺少API Key");
    const baseUrl = inputValues.baseUrl;
    const headers = getHeaders();
  
    // 构造请求参数
    const requestBody: any = {
      model: model.modelName,
      prompt: config.prompt,
      aspectRatio: config.aspectRatio,
      webHook: "-1",
      shutProgress: true,
    };
  
    // 处理参考资源
    if (config.referenceList && config.referenceList.length > 0) {
      const imageRefs = config.referenceList.filter((item) => item.type === "image") as Extract<ReferenceList, { type: "image" }>[];
      if (config.mode.includes("endFrameOptional") && imageRefs.length >= 1) {
        requestBody.firstFrameUrl = imageRefs[0].base64;
        if (imageRefs.length >= 2) requestBody.lastFrameUrl = imageRefs[1].base64;
      } else if (config.mode.some((m) => Array.isArray(m) && m.includes("imageReference:3"))) {
        requestBody.urls = imageRefs.map((img) => img.base64);
      }
    }
  
    logger(`开始提交视频生成任务，模型：${model.modelName}`);
    const submitResp = await fetch(`${baseUrl}/v1/video/veo`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });
    if (!submitResp.ok) {
      const errorReason = await submitResp.text();
      throw new Error(`任务提交失败： ${errorReason}`);
    }
    const submitData = await submitResp.json();
    if (submitData.code !== 0) throw new Error(`任务提交失败：${submitData.msg}`);
  
    const taskId = submitData.data.id;
    logger(`视频任务提交成功，任务ID：${taskId}`);
  
    // 轮询结果
    const pollResult = await pollTask(
      async () => {
        const resp = await fetch(`${baseUrl}/v1/draw/result`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: taskId }),
        });
        if (!resp.ok) {
          const errorReason = await resp.text();
          throw new Error(`查询视频任务失败 ${errorReason}`);
        }
        const respData = await resp.json();
        logger(respData);
        if (respData.code !== 0) return { completed: true, error: respData.msg };
  
        const taskData = respData.data;
        if (taskData.status === "failed")
          return {
            completed: true,
            error: taskData.failure_reason || taskData.error,
          };
        if (taskData.status === "succeeded") {
          return { completed: true, data: taskData.url };
        }
        logger(`视频任务生成中，进度：${taskData.progress}%`);
        return { completed: false };
      },
      5000,
      1800000,
    );
  
    if (pollResult.error) throw new Error(pollResult.error);
    logger(`视频生成完成，开始转换Base64`);
    return await urlToBase64(pollResult.data!);
  };
  
  const ttsRequest = async (config: TTSConfig, model: TTSModel, inputValues: Record<string, string>): Promise<string> => {
    return "";
  };
  
  const checkForUpdates = async (): Promise<{
    hasUpdate: boolean;
    latestVersion: string;
    notice: string;
  }> => {
    return {
      hasUpdate: false,
      latestVersion: "1.0",
      notice: "## 新版本更新公告",
    };
  };
  
  const updateVendor = async (): Promise<string> => {
    return "";
  };
  
  // ============================================================
  // 导出
  // ============================================================
  
  
  
  
  
  
  
  
  
  // 这行代码用于确保当前文件被识别为模块，避免全局变量冲突
  
  
  return { textRequest, imageRequest, videoRequest, ttsRequest, checkForUpdates, updateVendor };
}
