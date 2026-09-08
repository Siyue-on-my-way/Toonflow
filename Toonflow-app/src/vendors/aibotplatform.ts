import { VendorConfig, TextModel, ImageModel, VideoModel, TTSModel, ImageConfig, VideoConfig, TTSConfig } from "@/types/vendor";
import { createOpenAI } from "@ai-sdk/openai";
import { v4 as uuidv4 } from 'uuid';

/**
 * 从 AibotPlatform 的 message/delta.content（数组 / 字符串 / null）中提取纯文本。
 * 网关在“思考型模型 token 耗尽且无输出”或纯工具调用时会省略 content，必须容错。
 */
function extractTextContent(raw: any): string | null {
  if (raw == null) return null;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw[0]?.text?.text ?? null;
  return null;
}

/**
 * 将 OpenAI 原生 tool_choice 映射为 AibotPlatform 的 toolChoice（SOP 9.3）。
 * 网关不接受 OpenAI 的 "auto" 字符串，必须传 { toolChoiceMode: "auto" }，
 * 否则返回 101400 “请求 json 数据不符合预期”。
 */
function mapToolChoice(tc: any): { toolChoiceMode: string; functionName?: string } | undefined {
  if (tc == null) return undefined;
  if (typeof tc === "string") return { toolChoiceMode: tc }; // auto | none | required
  const name = tc?.function?.name ?? tc?.name;
  if (name) return { toolChoiceMode: "specific", functionName: name };
  if (tc?.type) return { toolChoiceMode: tc.type };
  return undefined;
}

/**
 * Toonflow AI供应商模板 - AibotPlatform
 * @version 1.0
 */
// ============================================================
// 供应商配置
// ============================================================
export const vendor: VendorConfig = {
  id: "aibotplatform",
  version: "1.0",
  author: "Toonflow",
  name: "AibotPlatform",
  description: "AibotPlatform 专属接口，自动处理流式与非流式请求的 URL 差异，并封装自定义请求体。",
  icon: "",
  inputs: [
    { key: "appID", label: "App ID", type: "text", required: true },
    { key: "businessSource", label: "Business Source", type: "text", required: true },
    { key: "token", label: "Token", type: "password", required: true },
    { key: "modelRoutes", label: "Model Routes (JSON)", type: "text", required: true, placeholder: '{"gpt-4o":"azure/gpt-4o@europe-west@app@source"}' },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "默认：https://bus-ie.aibotplatform.com/assistant/vendor-api/v2" },
  ],
  inputValues: {
    appID: "",
    businessSource: "",
    token: "",
    modelRoutes: "",
    baseUrl: "https://bus-ie.aibotplatform.com/assistant/vendor-api/v2",
  },
  models: [
    { name: "GPT-4o", modelName: "gpt-4o", type: "text", think: false },
    { name: "GPT-3.5-Turbo", modelName: "gpt-3.5-turbo", type: "text", think: false },
    { name: "GPT-5.6 Terra", modelName: "gpt-5.6-terra", type: "text", think: false },
  ],
};

/**
 * 递归剔除 JSON Schema 中的 $schema / $id 元数据关键字。
 * 网关的 gemini 等路由会对带 $schema 的工具参数直接返回 400 "Bad Request"
 * （gpt 系路由可容忍），而 ai-sdk / zod 的 toJSONSchema 默认会带上它，
 * 因此在进入网关前统一剔除。
 */
function stripSchemaMeta(value: any): any {
  if (Array.isArray(value)) return value.map(stripSchemaMeta);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "$schema" || k === "$id") continue;
      out[k] = stripSchemaMeta(v);
    }
    return out;
  }
  return value;
}

export function createVendorAPI(inputValues: Record<string, string>) {
  // ============================================================
  // 适配器函数
  // ============================================================
  const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
    if (!inputValues.token) throw new Error("缺少 Token");
    
    // 解析 modelRoutes
    let routesMap: Record<string, string> = {};
    try {
      if (inputValues.modelRoutes) {
        routesMap = JSON.parse(inputValues.modelRoutes);
      }
    } catch (e) {
      console.warn("解析 modelRoutes 失败，请检查 JSON 格式");
    }

    const customFetch = async (url: string, options: RequestInit) => {
      let isStream = false;
      // 工具名列表：网关流式非首片常把 function.name 置空，需用它回填，避免覆盖首片。
      let toolNames: string[] = [];
      if (options.body) {
        try {
          const body = JSON.parse(options.body as string);
          
          // 如果是流式请求，将 URL 替换为 sse 的地址
          if (body.stream && url.endsWith('/chat/completions')) {
            url = url.replace('/chat/completions', '/chat/sse/completions');
            isStream = true;
          }

          // 获取当前请求的模型名称
          const requestedModel = body.model;
          
          // 从 routesMap 中查找对应的路由字符串
          const routeString = routesMap[requestedModel] || "";
          
          // 解析 routeString (例如: azure/gpt-5.4@europe-west@hushclaw@hushclawcloud)
          // 格式通常为: vendor/model@cluster@appID@businessSource
          let routeID = requestedModel;
          let model_cluster_id = "";
          
          if (routeString) {
            const parts = routeString.split('@');
            if (parts.length >= 2) {
              routeID = parts[0]; // 例如 azure/gpt-5.4
              model_cluster_id = parts[1]; // 例如 europe-west
            }
          }

          // 收集工具名，供流式 tool_call 回填（网关非首片常把 function.name 置空）
          toolNames = (body.tools || []).map((t: any) => t?.function?.name).filter(Boolean);

          // 封装自定义请求体
          const customBody = {
            metadata: {
              clientRegion: "pk",
              clientID: "35788096000522512",
              clientLanguage: "zh_CN",
              requestID: uuidv4(),
              appID: inputValues.appID,
              businessSource: inputValues.businessSource,
            },
            payload: {
              standard: {
                messages: body.messages.map((msg: any) => {
                  // assistant 工具调用消息：透传 tool_calls，content 统一成网关要求的数组形态（无正文时为 null）
                  if (msg.role === "assistant" && msg.tool_calls) {
                    const text = extractTextContent(msg.content);
                    return {
                      role: "assistant",
                      content: text != null ? [{ type: "text", text: { text } }] : null,
                      tool_calls: msg.tool_calls,
                    };
                  }
                  // tool 结果消息：必须保留 tool_call_id 供网关匹配对应工具调用，content 转成数组形态
                  if (msg.role === "tool") {
                    const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
                    return {
                      role: "tool",
                      tool_call_id: msg.tool_call_id,
                      content: [{ type: "text", text: { text } }],
                    };
                  }
                  // 普通文本消息：字符串 content 包成网关要求的数组形态
                  if (typeof msg.content === 'string') {
                    return {
                      role: msg.role,
                      content: [{
                        type: "text",
                        text: {
                          text: msg.content
                        }
                      }]
                    };
                  }
                  return msg;
                }),
                temperature: 1, // 强制使用 1，gpt-5 等推理模型同样要求 temperature=1
                maxCompletionTokens: body.max_completion_tokens || body.max_tokens || 1024,
                stream: isStream,
                // 透传工具定义与 tool_choice（SOP 9.3）。网关用 payload.standard.tools + toolChoice.toolChoiceMode，
                // 而非 OpenAI 原生的 tools/tool_choice；tool_choice 缺省时不传，由网关默认 auto。
                // 工具参数里的 $schema/$id 元数据关键字部分路由（如 gemini）会拒绝，先剔除。
                ...(body.tools?.length ? { tools: stripSchemaMeta(body.tools) } : {}),
                ...(body.tool_choice != null ? { toolChoice: mapToolChoice(body.tool_choice) } : {}),
              },
              inhouse: {
                token: inputValues.token,
                model_cluster_id: model_cluster_id,
                routeID: routeString // 使用完整的 routeString 作为 routeID
              }
            }
          };

          options.body = JSON.stringify(customBody);

          // 确保 headers 中有 Content-Type
          if (!options.headers) {
            options.headers = {};
          }
          
          // 移除 ai-sdk 自动添加的 Authorization header，因为我们使用 payload.inhouse.token
          if (options.headers instanceof Headers) {
            options.headers.delete('Authorization');
            options.headers.set('Content-Type', 'application/json');
          } else if (Array.isArray(options.headers)) {
            options.headers = options.headers.filter(([key]) => key.toLowerCase() !== 'authorization');
            options.headers.push(['Content-Type', 'application/json']);
          } else {
            const headers = options.headers as Record<string, string>;
            delete headers['Authorization'];
            delete headers['authorization'];
            headers['Content-Type'] = 'application/json';
          }
          
        } catch (e) {
          // 忽略 JSON 解析错误
        }
      }
      
      const response = await fetch(url, options);
      
      // 拦截响应，处理 AibotPlatform 的自定义响应结构
      if (response.ok) {
        const contentType = response.headers.get('content-type');
        
        // 处理非流式响应
        if (!isStream && contentType && contentType.includes('application/json')) {
          const json = await response.json();
          // 如果响应包含 metadata.code 且不为 200，说明有业务错误
          if (json.metadata && json.metadata.code !== 200) {
            throw new Error(`AibotPlatform Error: ${json.metadata.debugMessage || json.metadata.message || 'Unknown error'}`);
          }
          // 如果响应包含 payload，则提取出来返回给 ai-sdk
          if (json.payload) {
            // AibotPlatform 返回的 payload 结构与 OpenAI 略有不同，需要转换
            const standardPayload = {
              id: json.payload.id,
              object: json.payload.object,
              created: parseInt(json.payload.created, 10),
              model: json.payload.model,
              choices: json.payload.choices.map((choice: any) => {
                // 思考型模型 token 耗尽且无输出时，网关会省略 choice.message，必须容错避免
                // “Cannot read properties of undefined (reading 'role')” 崩溃。
                const msg = choice.message || {};
                const message: any = {
                  role: msg.role ?? "assistant",
                  content: extractTextContent(msg.content),
                };
                // 透传工具调用（网关返回标准 OpenAI 形态：message.tool_calls[] + finish_reason:"tool_calls"）
                if (msg.tool_calls) message.tool_calls = msg.tool_calls;
                return {
                  index: choice.index,
                  message,
                  finish_reason: choice.finish_reason
                };
              }),
              usage: json.payload.usage
            };
            return new Response(JSON.stringify(standardPayload), {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers
            });
          } else {
             // 如果没有 payload，但 code 为 200，可能直接返回了结果
             return new Response(JSON.stringify(json), {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers
            });
          }
        }
        
        // 处理流式响应 (SSE)
        if (isStream && contentType && contentType.includes('text/event-stream')) {
          // 对于流式响应，我们需要拦截并解析每一块数据
          // AibotPlatform 的流式响应可能也包装在 payload.standard 中
          // 但由于 ai-sdk 期望标准的 OpenAI SSE 格式，我们需要转换
          
          // SSE 事件可能跨多个网络 chunk 到达：必须跨 chunk 缓冲、按完整行解析，
          // 否则半截 data 行 JSON.parse 失败后被透传，下游报 "Unterminated string in JSON"。
          const sseDecoder = new TextDecoder();
          const sseEncoder = new TextEncoder();
          let sseBuffer = "";
          const handleSseLine = (line: string, controller: any): boolean => {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const data = JSON.parse(line.slice(6));
                // 如果包含业务错误
                if (data.metadata && data.metadata.code !== 200) {
                  controller.error(new Error(`AibotPlatform Error: ${data.metadata.debugMessage || data.metadata.message || 'Unknown error'}`));
                  return false;
                }
                // 提取 standard payload
                if (data.payload) {
                  const standardPayload = {
                    id: data.payload.id,
                    object: data.payload.object,
                    created: parseInt(data.payload.created, 10),
                    model: data.payload.model,
                    choices: data.payload.choices.map((choice: any) => {
                      const delta = choice.delta || {};
                      const outDelta: any = {
                        role: delta.role || undefined,
                        content: extractTextContent(delta.content) ?? "",
                      };
                      // 透传流式工具调用增量（delta.tool_calls[]）。
                      // 网关非首片常把 name/id/type 置空，回填工具名并剔空值，避免覆盖首片。
                      if (delta.tool_calls) {
                        outDelta.tool_calls = delta.tool_calls.map((call: any, idx: number) => {
                          const fn = call.function || {};
                          const callIndex = Number.isInteger(call.index) ? call.index : idx;
                          const name = fn.name || toolNames[callIndex] || toolNames[idx];
                          const out: any = { index: callIndex, type: "function" };
                          if (call.id != null) out.id = String(call.id);
                          const f: any = { arguments: fn.arguments ?? "" };
                          if (name) f.name = name;
                          out.function = f;
                          return out;
                        });
                      }
                      return {
                        index: choice.index,
                        delta: outDelta,
                        finish_reason: choice.finish_reason || null
                      };
                    }),
                    usage: data.payload.usage
                  };
                  controller.enqueue(sseEncoder.encode(`data: ${JSON.stringify(standardPayload)}\n\n`));
                } else {
                  // 如果没有包装，直接透传
                  controller.enqueue(sseEncoder.encode(`${line}\n\n`));
                }
              } catch (e) {
                // 解析失败，可能是其他格式的数据，直接透传
                controller.enqueue(sseEncoder.encode(`${line}\n\n`));
              }
            } else if (line === 'data: [DONE]') {
              controller.enqueue(sseEncoder.encode('data: [DONE]\n\n'));
            }
            return true;
          };
          const transformStream = new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              sseBuffer += sseDecoder.decode(chunk, { stream: true });
              let nl: number;
              while ((nl = sseBuffer.indexOf("\n")) !== -1) {
                const line = sseBuffer.slice(0, nl).replace(/\r$/, "");
                sseBuffer = sseBuffer.slice(nl + 1);
                if (!handleSseLine(line, controller)) return;
              }
            },
            flush(controller) {
              sseBuffer += sseDecoder.decode();
              const line = sseBuffer.replace(/\r$/, "");
              if (line.length) handleSseLine(line, controller);
            }
          });
          
          return new Response(response.body?.pipeThrough(transformStream), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        }
        
        // 如果是流式请求但返回了 JSON（通常是错误）
        if (isStream && contentType && contentType.includes('application/json')) {
           const json = await response.json();
           if (json.metadata && json.metadata.code !== 200) {
             // 抛出错误，ai-sdk 会捕获
             return new Response(JSON.stringify({
               error: {
                 message: `AibotPlatform Error: ${json.metadata.debugMessage || json.metadata.message || 'Unknown error'}`
               }
             }), {
               status: 400,
               headers: { 'Content-Type': 'application/json' }
             });
           }
        }
      } else {
        // 处理非 200 响应
        const text = await response.text();
        console.error("API Error Response:", text);
        throw new Error(`API Error: ${response.status} - ${text}`);
      }
      
      return response;
    };

    return createOpenAI({ 
      baseURL: inputValues.baseUrl, 
      apiKey: "dummy-key", // ai-sdk requires an apiKey, but we use token in payload
      fetch: customFetch 
    }).chat(model.modelName);
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
    return { hasUpdate: false, latestVersion: "1.0", notice: "" };
  };
  const updateVendor = async (): Promise<string> => {
    return "";
  };

  // ============================================================
  // 导出
  // ============================================================
  return { textRequest, imageRequest, videoRequest, ttsRequest, checkForUpdates, updateVendor };
}
