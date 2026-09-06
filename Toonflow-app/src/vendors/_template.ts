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
 * Toonflow AI供应商接入骨架模板
 *
 * 这是一个骨架文件，不是可用渠道：本文件不会被注册进 src/vendors/index.ts。
 * 接入新渠道时复制本文件、改名为 src/vendors/<id>.ts，再按
 * docs/vendor-integration-guide.md 第 4 步把 <id> 注册进 vendors/index.ts
 * 并把协议目录写进 o_vendorConfig 表。
 *
 * @version 1.0
 */

// ============================================================
// 供应商配置（Layer1：协议目录的一部分，全账号共享只读）
// ============================================================

export const vendor: VendorConfig = {
  id: "TODO_vendor_id", // 纯英文小写，作为 vendors/index.ts 的 key 和 o_vendorConfig 主键，禁止特殊符号和空格
  version: "1.0",
  author: "Toonflow",
  name: "TODO 渠道显示名",
  description: "## TODO 渠道说明\n支持哪些模型、去哪里申请 key，用 Markdown 写清楚。",
  inputs: [
    // 账号在设置页需要填的字段。字段名含 key/secret/token（大小写不敏感）会被自动加密存储，不需要自己实现加解密。
    { key: "apiKey", label: "API Key", type: "password", required: true, placeholder: "请输入 API Key" },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "默认：https://api.example.com/v1" },
  ],
  inputValues: { apiKey: "", baseUrl: "https://api.example.com/v1" },
  models: [
    // 协议目录的初始值，只在全新建表（initData 首次执行）时生效。
    // 已经跑起来的环境要新增/修改模型，需要额外写一次性脚本更新 o_vendorConfig.models（见接入指南第 4 步）。
    { name: "TODO 模型显示名", modelName: "TODO-model-name", type: "image", mode: ["singleImage"] },
  ],
};

export function createVendorAPI(inputValues: Record<string, string>) {
  // ============================================================
  // 辅助工具（多个适配器函数共享的逻辑放这里，小驼峰命名）
  // ============================================================

  const getHeaders = () => {
    if (!inputValues.apiKey) throw new Error("缺少 API Key");
    return { "Content-Type": "application/json", Authorization: `Bearer ${inputValues.apiKey}` };
  };

  const getBaseUrl = () => (inputValues.baseUrl ?? "").replace(/\/$/, "");

  /**
   * 提交任务 → 轮询查询 → 拿结果 URL 的通用骨架。
   *
   * 只有当新渠道的接口形状和 RunningHub 一样简单（提交返回 taskId，查询按 taskId
   * 返回 status + 结果 URL）时才照抄这两个函数改字段名。如果鉴权需要动态签名/
   * 短期 token，或者响应结构是深层嵌套、状态取值不同，参照 src/vendors/klingai.ts
   * 的 submitAndPoll 自己写一版——pollTask 这个轮询循环引擎本身总是可以复用，
   * 只要 queryFn 返回符合 PollResult { completed, data?, error? } 的形状即可。
   */
  const submitTask = async (endpoint: string, data: any): Promise<string> => {
    const url = `${getBaseUrl()}/${endpoint}`;
    logger(`[TODO] 提交任务: ${url}`);
    const response = await axios.post(url, data, { headers: getHeaders() });
    if (response.data?.taskId) return response.data.taskId;
    throw new Error(`任务提交失败: ${response.data?.errorMessage || JSON.stringify(response.data)}`);
  };

  const queryTask = async (taskId: string): Promise<string> => {
    const result = await pollTask(
      async () => {
        const response = await axios.post(`${getBaseUrl()}/query`, { taskId }, { headers: getHeaders() });
        const data = response.data;
        if (data.status === "SUCCESS") {
          if (data.results?.[0]?.url) return { completed: true, data: data.results[0].url };
          return { completed: true, error: "任务成功，但未返回结果 URL" };
        }
        if (data.status === "FAILED") return { completed: true, error: data.errorMessage || "任务生成失败" };
        return { completed: false }; // RUNNING / QUEUED，继续轮询
      },
      5000,
      600000, // 每5秒轮询，10分钟超时
    );
    if (result.error) throw new Error(result.error);
    return await urlToBase64(result.data!);
  };

  // ============================================================
  // 适配器函数
  // ============================================================

  const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
    if (!inputValues.apiKey) throw new Error("缺少 API Key");
    const apiKey = inputValues.apiKey.replace(/^Bearer\s+/i, "");
    return createOpenAI({ baseURL: inputValues.baseUrl, apiKey }).chat(model.modelName);
  };

  const imageRequest = async (config: ImageConfig, model: ImageModel, inputValues: Record<string, string>): Promise<string> => {
    // 如果该渠道字段命名/枚举/endpoint 不规整、模型数量多，参照
    // src/vendors/runninghub-models.ts 新建一个 <id>-models.ts DSL 文件，
    // 这里只负责 findXxxModelSpec + submitTask/queryTask，不要把拼请求体的
    // 逻辑堆在这个函数里。字段结构里有嵌套/条件分支（DSL 覆盖不到）时才手写。
    throw new Error("TODO: 实现图片生成");
  };

  const videoRequest = async (config: VideoConfig, model: VideoModel, inputValues: Record<string, string>): Promise<string> => {
    throw new Error("TODO: 实现视频生成");
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

  // ============================================================
  // 导出
  // ============================================================

  return { textRequest, imageRequest, videoRequest, ttsRequest, checkForUpdates, updateVendor };
}
