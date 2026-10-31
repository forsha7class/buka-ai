/**
 * Google Gemini adapter.
 *
 * Gemini uses `contents`/`parts`, top-level `systemInstruction`, and
 * `functionCall`/`functionResponse` blocks instead of OpenAI's message and
 * tool-call shapes. The normalized event stream is identical to every other
 * provider, so the agent loop and TUI need no Gemini-specific code.
 */
import { ProviderError, readErrorMessage } from "../util/http.js";
import { parseSSE } from "../util/sse.js";
import type {
  ChatMessage,
  ChatRequest,
  ContentPart,
  FinishReason,
  ModelInfo,
  Provider,
  ProviderConfig,
  ProviderEvent,
  ToolCall,
  ToolDefinition,
  Usage,
} from "./types.js";

interface GeminiModel {
  name?: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name?: string; args?: unknown };
}

export class GoogleProvider implements Provider {
  readonly id: string;
  readonly name: string;
  private readonly config: ProviderConfig;

  constructor(id: string, config: ProviderConfig) {
    this.id = id;
    this.name = config.name ?? id;
    this.config = config;
  }

  private url(path: string): string {
    return `${this.config.baseURL.replace(/\/+$/, "")}${path}`;
  }

  private headers(accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept,
      ...(this.config.headers ?? {}),
    };
    if (!this.config.apiKey) throw new ProviderError(`${this.name} requires an API key`);
    headers["x-goog-api-key"] = this.config.apiKey;
    return headers;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    let pageToken: string | undefined;

    for (let page = 0; page < 20; page++) {
      const query = pageToken
        ? `?pageSize=1000&pageToken=${encodeURIComponent(pageToken)}`
        : "?pageSize=1000";
      let res: Response;
      try {
        res = await fetch(this.url(`/models${query}`), {
          headers: this.headers("application/json"),
          ...(signal !== undefined ? { signal } : {}),
        });
      } catch (cause) {
        if ((cause as Error).name === "AbortError") throw cause;
        throw new ProviderError(
          `Cannot reach ${this.config.baseURL}: ${(cause as Error).message}`,
        );
      }
      if (!res.ok) {
        throw new ProviderError(
          `Failed to list models from ${this.name}: ${await readErrorMessage(res)}`,
          res.status,
        );
      }

      const json = (await res.json()) as {
        models?: GeminiModel[];
        nextPageToken?: string;
      };
      for (const model of json.models ?? []) {
        if (!model || typeof model.name !== "string") continue;
        const id = model.name.replace(/^models\//, "");
        const methods = model.supportedGenerationMethods ?? [];
        if (methods.length > 0 && !methods.includes("generateContent")) continue;
        models.push({
          id,
          ...(typeof model.displayName === "string" ? { name: model.displayName } : {}),
          ...(typeof model.inputTokenLimit === "number"
            ? { context: model.inputTokenLimit }
            : {}),
          ...(typeof model.outputTokenLimit === "number"
            ? { output: model.outputTokenLimit }
            : {}),
          tools: true,
          input: ["text", "image"],
        });
      }

      if (!json.nextPageToken) break;
      pageToken = json.nextPageToken;
    }

    return models;
  }

  async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, undefined> {
    const model = req.model.replace(/^models\//, "");
    const system = systemPrompt(req.messages);
    const payload = {
      contents: toGeminiContents(req.messages),
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(req.tools && req.tools.length > 0
        ? { tools: [{ functionDeclarations: req.tools.map(toGeminiTool) }] }
        : {}),
      generationConfig: {
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
      },
    };

    let res: Response;
    try {
      res = await fetch(
        this.url(`/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`),
        {
          method: "POST",
          headers: this.headers("text/event-stream"),
          body: JSON.stringify(payload),
          ...(req.signal !== undefined ? { signal: req.signal } : {}),
        },
      );
    } catch (cause) {
      if ((cause as Error).name === "AbortError") return;
      throw new ProviderError(
        `Cannot reach ${this.config.baseURL}: ${(cause as Error).message}`,
      );
    }

    if (!res.ok) {
      throw new ProviderError(
        `Chat request to ${this.name} failed: ${await readErrorMessage(res)}`,
        res.status,
      );
    }
    if (!res.body) throw new ProviderError(`${this.name} returned an empty response body`);

    let text = "";
    let reasoning = "";
    let responseModel = req.model;
    let announced = false;
    let finish: string | undefined;
    let usage: Usage | undefined;
    const toolCalls: ToolCall[] = [];

    for await (const event of parseSSE(res.body)) {
      const raw = safeJson(event.data);
      if (raw === undefined) continue;

      if (typeof raw["modelVersion"] === "string" && raw["modelVersion"].length > 0) {
        responseModel = raw["modelVersion"];
      }
      if (!announced) {
        announced = true;
        yield { type: "start", model: responseModel };
      }

      const feedback = raw["promptFeedback"] as { blockReason?: string } | undefined;
      if (typeof feedback?.blockReason === "string") {
        finish = feedback.blockReason;
      }

      const metadata = raw["usageMetadata"] as Record<string, unknown> | undefined;
      if (metadata) {
        const prompt = number(metadata["promptTokenCount"]) ?? 0;
        const completion = number(metadata["candidatesTokenCount"]) ?? 0;
        const total = number(metadata["totalTokenCount"]) ?? prompt + completion;
        usage = {
          promptTokens: prompt,
          completionTokens: completion,
          totalTokens: total,
          ...(number(metadata["cachedContentTokenCount"]) !== undefined
            ? { cachedTokens: number(metadata["cachedContentTokenCount"]) }
            : {}),
          ...(number(metadata["thoughtsTokenCount"]) !== undefined
            ? { reasoningTokens: number(metadata["thoughtsTokenCount"]) }
            : {}),
        };
      }

      const candidate = (raw["candidates"] as Array<Record<string, unknown>> | undefined)?.[0];
      if (!candidate) continue;
      if (typeof candidate["finishReason"] === "string") {
        finish = candidate["finishReason"];
      }

      const content = candidate["content"] as { parts?: GeminiPart[] } | undefined;
      for (const part of content?.parts ?? []) {
        if (typeof part.text === "string" && part.text.length > 0) {
          if (part.thought === true) {
            reasoning += part.text;
            yield { type: "reasoning", delta: part.text };
          } else {
            text += part.text;
            yield { type: "text", delta: part.text };
          }
        }
        if (part.functionCall && typeof part.functionCall.name === "string") {
          const index = toolCalls.length;
          const call: ToolCall = {
            id: `call_${index + 1}`,
            type: "function",
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            },
          };
          toolCalls.push(call);
          yield { type: "tool_call_start", index, id: call.id, name: call.function.name };
          yield {
            type: "tool_call_args",
            index,
            delta: call.function.arguments,
          };
        }
      }
    }

    yield {
      type: "finish",
      reason: toolCalls.length > 0 ? "tool_calls" : finishReason(finish),
      model: responseModel,
      text,
      reasoning,
      toolCalls,
      usage,
    };
  }
}

function toGeminiContents(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      toolNames.set(call.id, call.function.name);
    }
  }

  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      const part = {
        functionResponse: {
          name: toolNames.get(message.tool_call_id ?? "") ?? message.name ?? "tool",
          response: { result: stringContent(message.content) },
        },
      };
      const last = out[out.length - 1];
      const parts = last && Array.isArray(last["parts"]) ? (last["parts"] as unknown[]) : undefined;
      if (last && last["role"] === "user" && parts && parts.every(isFunctionResponsePart)) {
        parts.push(part);
      } else {
        out.push({ role: "user", parts: [part] });
      }
      continue;
    }

    if (message.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      if (typeof message.content === "string" && message.content.length > 0) {
        parts.push({ text: message.content });
      }
      for (const call of message.tool_calls ?? []) {
        parts.push({
          functionCall: {
            name: call.function.name,
            args: parseArguments(call.function.arguments),
          },
        });
      }
      if (parts.length > 0) out.push({ role: "model", parts });
      continue;
    }

    out.push({ role: "user", parts: toGeminiParts(message.content) });
  }
  return out;
}

function isFunctionResponsePart(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "functionResponse" in value
  );
}

function toGeminiParts(content: ChatMessage["content"]): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: "" }];
  return content.flatMap((part: ContentPart): Array<Record<string, unknown>> => {
    if (part.type === "text") return [{ text: part.text }];
    if (part.url.startsWith("data:")) {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.url);
      if (match) {
        return [{ inlineData: { mimeType: match[1]!, data: match[2]! } }];
      }
    }
    return [{ fileData: { mimeType: "image/jpeg", fileUri: part.url } }];
  });
}

function toGeminiTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  };
}

function systemPrompt(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => stringContent(message.content))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function stringContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function finishReason(raw: string | undefined): FinishReason {
  switch (raw) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    case undefined:
      return "unknown";
    default:
      return "unknown";
  }
}

function safeJson(data: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
