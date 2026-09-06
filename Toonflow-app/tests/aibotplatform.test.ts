import assert from "node:assert/strict";
import { generateText, jsonSchema, stepCountIs, streamText } from "ai";
import { createVendorAPI, vendor } from "../src/vendors/aibotplatform";

const modelDefinition = {
  name: "GPT-5.6 Terra",
  modelName: "gpt-5.6-terra",
  type: "text" as const,
  think: false,
};

const inputValues = {
  token: "test-token",
  appID: "test-app",
  businessSource: "ScriptAgent@ToolCall",
  modelRoutes: JSON.stringify({
    "gpt-5.6-terra": "azure/gpt-5.6-terra@europe-west@test-app@ScriptAgent@ToolCall",
  }),
  baseUrl: "https://example.invalid/assistant/vendor-api/v2",
};

const toolInputSchema = jsonSchema<{ location: string }>({
  type: "object",
  properties: {
    location: {
      type: "string",
      description: "城市名称",
    },
  },
  required: ["location"],
});

const passiveWeatherTool = {
  description: "获取指定城市的天气",
  inputSchema: toolInputSchema,
};

const executableWeatherTool = {
  description: "获取指定城市的天气",
  inputSchema: toolInputSchema,
  execute: async ({ location }: { location: string }) => ({
    location,
    temperature: 20,
  }),
};

type RequestRecord = {
  url: string;
  body: any;
};

function createModel() {
  return createVendorAPI(inputValues).textRequest(modelDefinition, false, 0);
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function textPayload(text: string) {
  return {
    payload: {
      id: "text-response",
      object: "chat.completion",
      created: 1,
      model: modelDefinition.modelName,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [{ type: "text", text: { text } }],
          },
          finish_reason: "stop",
        },
      ],
      usage: {},
    },
  };
}

function toolPayload() {
  return {
    payload: {
      id: "tool-response",
      object: "chat.completion",
      created: 1,
      model: modelDefinition.modelName,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [],
            tool_calls: [
              {
                id: "call_weather_1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: JSON.stringify({ location: "北京" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {},
    },
  };
}

function toolStreamPayload(argumentsPart: string, includeStart: boolean, finishReason: string | null) {
  return {
    payload: {
      id: "stream-response",
      object: "chat.completion.chunk",
      created: 1,
      model: modelDefinition.modelName,
      choices: [
        {
          index: 0,
          delta: {
            ...(includeStart ? { role: "assistant" } : {}),
            tool_calls: [
              {
                index: 0,
                ...(includeStart
                  ? {
                      id: "call_weather_1",
                      type: "function",
                      function: { name: "get_weather", arguments: argumentsPart },
                    }
                  : { function: { arguments: argumentsPart } }),
              },
            ],
          },
          finish_reason: finishReason,
        },
      ],
    },
  };
}

function liveLikeToolStreamPayload(argumentsPart: string, finishReason: string) {
  return {
    payload: {
      id: "live-like-stream-response",
      object: "chat.completion.chunk",
      created: 1,
      model: modelDefinition.modelName,
      choices: [
        {
          index: 0,
          delta: {
            role: "",
            tool_calls: [
              {
                index: 0,
                type: "function",
                id: "",
                function: { arguments: argumentsPart },
              },
            ],
          },
          finish_reason: finishReason,
        },
      ],
    },
  };
}

function sseResponse(events: unknown[]) {
  const encoder = new TextEncoder();
  const source = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  const bytes = encoder.encode(source);
  const splitAt = Math.max(1, Math.floor(bytes.length / 2));

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, splitAt));
        controller.enqueue(bytes.slice(splitAt));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function installFetch(responder: (record: RequestRecord, callNumber: number) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  const requests: RequestRecord[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const record = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    requests.push(record);
    return responder(record, requests.length);
  }) as typeof fetch;

  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

async function testRequestCarriesTools() {
  const mock = installFetch(() => jsonResponse(textPayload("ok")));

  try {
    await generateText({
      model: createModel(),
      messages: [{ role: "user", content: "请调用天气工具" }],
      tools: { get_weather: passiveWeatherTool },
    });
  } finally {
    mock.restore();
  }

  const standard = mock.requests[0].body.payload.standard;
  assert.equal(standard.tools[0].function.name, "get_weather");
  assert.deepEqual(standard.toolChoice, { toolChoiceMode: "auto" });
}

async function testNonStreamingToolCallIsReturned() {
  const mock = installFetch(() => jsonResponse(toolPayload()));

  try {
    const result = await generateText({
      model: createModel(),
      messages: [{ role: "user", content: "北京天气怎么样？" }],
      tools: { get_weather: passiveWeatherTool },
      stopWhen: stepCountIs(1),
    });

    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].toolName, "get_weather");
    assert.deepEqual(result.toolCalls[0].input, { location: "北京" });
  } finally {
    mock.restore();
  }
}

async function testToolMessagesSurviveTheNextRound() {
  const mock = installFetch((_record, callNumber) =>
    jsonResponse(callNumber === 1 ? toolPayload() : textPayload("工具结果已处理")),
  );

  try {
    const result = await generateText({
      model: createModel(),
      messages: [{ role: "user", content: "北京天气怎么样？" }],
      tools: { get_weather: executableWeatherTool },
      stopWhen: stepCountIs(2),
    });

    assert.equal(result.text, "工具结果已处理");
  } finally {
    mock.restore();
  }

  assert.equal(mock.requests.length, 2);
  const messages = mock.requests[1].body.payload.standard.messages;
  const assistantMessage = messages.find((message: any) => message.role === "assistant");
  const toolMessage = messages.find((message: any) => message.role === "tool");
  assert.equal(assistantMessage.tool_calls[0].id, "call_weather_1");
  assert.equal(toolMessage.tool_call_id, "call_weather_1");
}

async function testStreamingToolCallSurvivesSplitSseChunks() {
  const mock = installFetch(() =>
    sseResponse([
      toolStreamPayload('{"location":"北', true, null),
      toolStreamPayload('京"}', false, "tool_calls"),
    ]),
  );

  try {
    const result = streamText({
      model: createModel(),
      messages: [{ role: "user", content: "请流式调用天气工具" }],
      tools: { get_weather: passiveWeatherTool },
      stopWhen: stepCountIs(1),
    });

    for await (const _chunk of result.fullStream) {
      // Drain the stream so the provider response is fully parsed.
    }

    const toolCalls = await result.toolCalls;
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].toolName, "get_weather");
    assert.deepEqual(toolCalls[0].input, { location: "北京" });
  } finally {
    mock.restore();
  }
}

async function testStreamingToolCallIgnoresEmptyPlatformFields() {
  const mock = installFetch(() =>
    sseResponse([
      liveLikeToolStreamPayload('{"location":"上', ""),
      liveLikeToolStreamPayload('海"}', "tool_calls"),
    ]),
  );

  try {
    const result = streamText({
      model: createModel(),
      messages: [{ role: "user", content: "请流式调用天气工具" }],
      tools: { get_weather: passiveWeatherTool },
      stopWhen: stepCountIs(1),
    });

    for await (const _chunk of result.fullStream) {
      // Drain the stream so the provider response is fully parsed.
    }

    const toolCalls = await result.toolCalls;
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].toolName, "get_weather");
    assert.deepEqual(toolCalls[0].input, { location: "上海" });
  } finally {
    mock.restore();
  }
}

async function testTerraIsInTheVendorDirectory() {
  assert.ok(vendor.models.some((model) => model.modelName === "gpt-5.6-terra"));
}

const tests: Array<[string, () => Promise<void>]> = [
  ["request carries tools and toolChoice", testRequestCarriesTools],
  ["non-streaming tool call is returned", testNonStreamingToolCallIsReturned],
  ["tool messages survive the next round", testToolMessagesSurviveTheNextRound],
  ["streaming tool call survives split SSE chunks", testStreamingToolCallSurvivesSplitSseChunks],
  ["streaming tool call ignores empty platform fields", testStreamingToolCallIgnoresEmptyPlatformFields],
  ["gpt-5.6-terra is in the vendor directory", testTerraIsInTheVendorDirectory],
];

async function main() {
  let failed = false;
  for (const [name, test] of tests) {
    try {
      await test();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed = true;
      console.error(`FAIL ${name}`);
      console.error(error);
    }
  }

  if (failed) {
    process.exitCode = 1;
  }
}

void main();
