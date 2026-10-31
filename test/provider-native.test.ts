/**
 * Native Anthropic/Gemini protocol tests. Each adapter talks to a tiny local
 * HTTP server that emits the same SSE shapes as the real APIs, so the tests
 * stay offline and exercise parsing, usage and tool calls end to end.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "node:test";

import { createProvider } from "../src/provider/factory.js";
import type { ChatRequest, ProviderEvent } from "../src/provider/types.js";

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseURL: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function collect(
  provider: ReturnType<typeof createProvider>,
  request: ChatRequest,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(request)) events.push(event);
  return events;
}

const request: ChatRequest = {
  model: "test-model",
  messages: [
    { role: "system", content: "You are useful." },
    { role: "user", content: "hello" },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "bash",
        description: "run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
      },
    },
  ],
  maxTokens: 100,
};

describe("Anthropic adapter", () => {
  it("discovers models from the native /models endpoint", async () => {
    await withServer(
      (req, res) => {
        assert.equal(req.method, "GET");
        assert.equal(req.url, "/v1/models?limit=1000");
        assert.equal(req.headers["x-api-key"], "sk-ant-test");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              {
                id: "claude-test",
                display_name: "Claude Test",
                context_window: 200000,
                max_output_tokens: 8192,
              },
            ],
          }),
        );
      },
      async (baseURL) => {
        const provider = createProvider("anthropic", {
          name: "Anthropic",
          type: "anthropic",
          baseURL: `${baseURL}/v1`,
          apiKey: "sk-ant-test",
        });
        const models = await provider.listModels();
        assert.deepEqual(models, [
          {
            id: "claude-test",
            name: "Claude Test",
            context: 200000,
            output: 8192,
            tools: true,
            input: ["text", "image"],
          },
        ]);
      },
    );
  });

  it("parses text, usage and tool calls from Messages SSE", async () => {
    await withServer(
      (req, res) => {
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/v1/messages");
        assert.equal(req.headers["x-api-key"], "sk-ant-test");
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":10,"cache_read_input_tokens":4}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"bash","input":{}}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"ls\\"}"}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(""),
        );
        res.end();
      },
      async (baseURL) => {
        const provider = createProvider("anthropic", {
          name: "Anthropic",
          type: "anthropic",
          baseURL: `${baseURL}/v1`,
          apiKey: "sk-ant-test",
        });
        const events = await collect(provider, request);
        const finish = events.find((event) => event.type === "finish");
        assert.ok(finish && finish.type === "finish");
        assert.equal(finish.model, "claude-test");
        assert.equal(finish.text, "Hi ");
        assert.equal(finish.reason, "tool_calls");
        assert.equal(finish.usage?.promptTokens, 10);
        assert.equal(finish.usage?.completionTokens, 2);
        assert.equal(finish.usage?.cachedTokens, 4);
        assert.deepEqual(finish.toolCalls, [
          {
            id: "toolu_1",
            type: "function",
            function: { name: "bash", arguments: '{"cmd":"ls"}' },
          },
        ]);
      },
    );
  });
});

describe("Gemini adapter", () => {
  it("discovers models from the native /models endpoint", async () => {
    await withServer(
      (req, res) => {
        assert.equal(req.method, "GET");
        assert.equal(req.url, "/v1beta/models?pageSize=1000");
        assert.equal(req.headers["x-goog-api-key"], "gemini-test-key");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            models: [
              {
                name: "models/gemini-test",
                displayName: "Gemini Test",
                inputTokenLimit: 1000000,
                outputTokenLimit: 8192,
                supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
              },
            ],
          }),
        );
      },
      async (baseURL) => {
        const provider = createProvider("google", {
          name: "Gemini",
          type: "google",
          baseURL: `${baseURL}/v1beta`,
          apiKey: "gemini-test-key",
        });
        const models = await provider.listModels();
        assert.deepEqual(models, [
          {
            id: "gemini-test",
            name: "Gemini Test",
            context: 1000000,
            output: 8192,
            tools: true,
            input: ["text", "image"],
          },
        ]);
      },
    );
  });

  it("parses text, usage and function calls from streamGenerateContent", async () => {
    await withServer(
      (req, res) => {
        assert.equal(req.method, "POST");
        assert.match(req.url ?? "", /^\/v1beta\/models\/gemini-test:streamGenerateContent\?alt=sse$/);
        assert.equal(req.headers["x-goog-api-key"], "gemini-test-key");
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          [
            'data: {"modelVersion":"gemini-test","candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n\n',
            'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"bash","args":{"cmd":"ls"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}\n\n',
          ].join(""),
        );
        res.end();
      },
      async (baseURL) => {
        const provider = createProvider("google", {
          name: "Gemini",
          type: "google",
          baseURL: `${baseURL}/v1beta`,
          apiKey: "gemini-test-key",
        });
        const events = await collect(provider, { ...request, model: "gemini-test" });
        const finish = events.find((event) => event.type === "finish");
        assert.ok(finish && finish.type === "finish");
        assert.equal(finish.model, "gemini-test");
        assert.equal(finish.text, "Hi");
        assert.equal(finish.reason, "tool_calls");
        assert.equal(finish.usage?.promptTokens, 3);
        assert.equal(finish.usage?.completionTokens, 2);
        assert.deepEqual(finish.toolCalls, [
          {
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: '{"cmd":"ls"}' },
          },
        ]);
      },
    );
  });
});
