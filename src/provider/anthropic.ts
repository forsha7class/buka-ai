/**
 * Anthropic Messages API adapter.
 *
 * Anthropic's wire format is deliberately not OpenAI-compatible: the system
 * prompt is a top-level field, tool calls are content blocks, and tool results
 * are user messages. This adapter translates both directions into the same
 * normalized events the rest of buka consumes.
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

const ANTHROPIC_VERSION = "2023-06-01";

interface PendingTool {
  id: string;
  name: string;
  args: string;
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  thinking?: string;
}

interface AnthropicModel {
  id: string;
  display_name?: string;
  context_window?: number;
  max_output_tokens?: number;
}

export class AnthropicProvider implements Provider {
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
      "anthropic-version": ANTHROPIC_VERSION,
      ...(this.config.headers ?? {}),
    };
    if (!this.config.apiKey) throw new ProviderError(`${this.name} requires an API key`);
    headers["x-api-key"] = this.config.apiKey;
    return headers;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    let after: string | undefined;

    // Anthropic paginates /models. Two pages are plenty for normal accounts,
    // but keep following the cursor with a hard ceiling so a broken endpoint
    // cannot loop forever.
    for (let page = 0; page < 20; page++) {
      const query = after ? `?limit=1000&after_id=${encodeURIComponent(after)}` : "?limit=1000";
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
        data?: AnthropicModel[];
        has_more?: boolean;
        last_id?: string;
      };
      for (const model of json.data ?? []) {
        if (!model || typeof model.id !== "string") continue;
        models.push({
          id: model.id,
          ...(typeof model.display_name === "string" ? { name: model.display_name } : {}),
          ...(typeof model.context_window === "number" ? { context: model.context_window } : {}),
          ...(typeof model.max_output_tokens === "number"
            ? { output: model.max_output_tokens }
            : {}),
          tools: true,
          input: ["text", "image"],
        });
      }

      if (!json.has_more || !json.last_id) break;
      after = json.last_id;
    }

    return models;
  }

  async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, undefined> {
    const system = systemPrompt(req.messages);
    const payload = {
      model: req.model,
      max_tokens: req.maxTokens ?? 8192,
      messages: toAnthropicMessages(req.messages),
      stream: true,
      ...(system ? { system } : {}),
      ...(req.tools && req.tools.length > 0
        ? { tools: req.tools.map(toAnthropicTool) }
        : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };

    let res: Response;
    try {
      res = await fetch(this.url("/messages"), {
        method: "POST",
        headers: this.headers("text/event-stream"),
        body: JSON.stringify(payload),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      });
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
    let model = req.model;
    let announced = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens: number | undefined;
    let stopReason: string | undefined;
    const pending = new Map<number, PendingTool>();

    for await (const event of parseSSE(res.body)) {
      const raw = safeJson(event.data);
      if (raw === undefined) continue;
      const type = typeof raw["type"] === "string" ? raw["type"] : event.event;

      if (type === "error") {
        const error = raw["error"];
        const message =
          typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
            ? (error as { message: string }).message
            : "Anthropic returned an error";
        throw new ProviderError(`${this.name}: ${message}`);
      }

      if (type === "message_start") {
        const message = raw["message"] as
          | { model?: string; usage?: Record<string, unknown> }
          | undefined;
        if (typeof message?.model === "string" && message.model.length > 0) {
          model = message.model;
        }
        const usage = message?.usage;
        if (usage) {
          inputTokens = number(usage["input_tokens"]) ?? inputTokens;
          cachedTokens = number(usage["cache_read_input_tokens"]) ?? cachedTokens;
        }
        if (!announced) {
          announced = true;
          yield { type: "start", model };
        }
        continue;
      }

      if (type === "content_block_start") {
        const index = number(raw["index"]) ?? 0;
        const block = (raw["content_block"] ?? {}) as Block;
        if (block.type === "tool_use" && typeof block.name === "string") {
          const id = typeof block.id === "string" ? block.id : `toolu_${index}`;
          const hasInput =
            block.input !== null &&
            typeof block.input === "object" &&
            Object.keys(block.input as Record<string, unknown>).length > 0;
          const args = hasInput ? JSON.stringify(block.input) : "";
          pending.set(index, { id, name: block.name, args });
          yield { type: "tool_call_start", index, id, name: block.name };
        }
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          text += block.text;
          yield { type: "text", delta: block.text };
        }
        if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
          reasoning += block.thinking;
          yield { type: "reasoning", delta: block.thinking };
        }
        continue;
      }

      if (type === "content_block_delta") {
        const index = number(raw["index"]) ?? 0;
        const delta = (raw["delta"] ?? {}) as Record<string, unknown>;
        if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
          text += delta["text"];
          yield { type: "text", delta: delta["text"] };
        } else if (delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string") {
          reasoning += delta["thinking"];
          yield { type: "reasoning", delta: delta["thinking"] };
        } else if (
          delta["type"] === "input_json_delta" &&
          typeof delta["partial_json"] === "string"
        ) {
          const tool = pending.get(index);
          if (tool) {
            tool.args += delta["partial_json"];
            yield { type: "tool_call_args", index, delta: delta["partial_json"] };
          }
        }
        continue;
      }

      if (type === "message_delta") {
        const delta = (raw["delta"] ?? {}) as Record<string, unknown>;
        if (typeof delta["stop_reason"] === "string") stopReason = delta["stop_reason"];
        const usage = (raw["usage"] ?? {}) as Record<string, unknown>;
        outputTokens = number(usage["output_tokens"]) ?? outputTokens;
        cachedTokens = number(usage["cache_read_input_tokens"]) ?? cachedTokens;
        continue;
      }

      if (type === "message_stop") break;
    }

    const toolCalls: ToolCall[] = [...pending.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, tool]) => tool.name.length > 0)
      .map(([, tool], index) => ({
        id: tool.id || `toolu_${index}`,
        type: "function" as const,
        function: { name: tool.name, arguments: tool.args || "{}" },
      }));

    const usage: Usage = {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
      ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    };

    yield {
      type: "finish",
      reason:
        toolCalls.length > 0
          ? "tool_calls"
          : stopReasonToFinish(stopReason),
      model,
      text,
      reasoning,
      toolCalls,
      usage,
    };
  }
}

function toAnthropicMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      const result = {
        type: "tool_result",
        tool_use_id: message.tool_call_id ?? "unknown",
        content: stringContent(message.content),
      };
      const last = out[out.length - 1];
      const blocks = last && Array.isArray(last["content"]) ? (last["content"] as unknown[]) : undefined;
      if (last && last["role"] === "user" && blocks && blocks.every(isToolResultBlock)) {
        blocks.push(result);
      } else {
        out.push({ role: "user", content: [result] });
      }
      continue;
    }

    if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      if (typeof message.content === "string" && message.content.length > 0) {
        content.push({ type: "text", text: message.content });
      }
      for (const call of message.tool_calls ?? []) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: parseArguments(call.function.arguments),
        });
      }
      if (content.length > 0) out.push({ role: "assistant", content });
      continue;
    }

    out.push({ role: "user", content: toAnthropicContent(message.content) });
  }
  return out;
}

function isToolResultBlock(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "tool_result"
  );
}

function toAnthropicContent(content: ChatMessage["content"]): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "text", text: "" }];
  return content.flatMap((part: ContentPart): Array<Record<string, unknown>> => {
    if (part.type === "text") return [{ type: "text", text: part.text }];
    if (part.url.startsWith("data:")) {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.url);
      if (match) {
        return [
          {
            type: "image",
            source: { type: "base64", media_type: match[1]!, data: match[2]! },
          },
        ];
      }
    }
    return [{ type: "image", source: { type: "url", url: part.url } }];
  });
}

function toAnthropicTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
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

function stopReasonToFinish(reason: string | undefined): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
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
