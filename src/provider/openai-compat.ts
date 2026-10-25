import { ProviderError, decodeJsonEvents, extractFirstJsonObject, readErrorMessage } from "../util/http.js";
import type {
  ChatMessage,
  ChatRequest,
  FinishReason,
  ModelInfo,
  Provider,
  ProviderConfig,
  ProviderEvent,
  ToolCall,
  Usage,
} from "./types.js";

interface RawToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface RawDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: RawToolCallDelta[];
}

interface RawChunk {
  id?: string;
  model?: string;
  error?: { message?: string } | string;
  usage?: Record<string, unknown>;
  choices?: Array<{
    index?: number;
    delta?: RawDelta;
    message?: RawDelta;
    finish_reason?: string | null;
  }>;
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
  announced: boolean;
}

/**
 * OpenAI-compatible `/chat/completions` client.
 *
 * Covers the whole `openai-compatible` family: OpenAI, OpenRouter, Groq,
 * llama.cpp, Ollama, vLLM, and the 9router gateway in front of all of them.
 *
 * Notes on real-world gateways, learned the hard way:
 *  - `stream` is always requested, because some gateways corrupt the
 *    non-streaming body (e.g. appending `data: [DONE]`).
 *  - `chunk.model` is the source of truth for the model name: alias/combo
 *    endpoints resolve to a different upstream model than what was asked.
 *  - Chain-of-thought arrives as `reasoning_content` (deepseek-style) or
 *    `reasoning`; both are surfaced as `reasoning` events.
 */
export class OpenAICompatProvider implements Provider {
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
    if (this.config.apiKey) headers["authorization"] = `Bearer ${this.config.apiKey}`;
    return headers;
  }

  async listModels(): Promise<ModelInfo[]> {
    let res: Response;
    try {
      res = await fetch(this.url("/models"), { headers: this.headers("application/json") });
    } catch (cause) {
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

    const json = (await res.json()) as unknown;
    const rows: unknown[] = Array.isArray(json)
      ? json
      : Array.isArray((json as { data?: unknown[] }).data)
        ? (json as { data: unknown[] }).data
        : [];

    return rows.flatMap((row): ModelInfo[] => {
      if (!row || typeof row !== "object") return [];
      const model = row as Record<string, unknown>;
      if (typeof model["id"] !== "string") return [];
      const caps = (model["capabilities"] ?? {}) as Record<string, unknown>;
      const info: ModelInfo = { id: model["id"] };
      if (typeof model["name"] === "string") info.name = model["name"];
      if (typeof caps["tools"] === "boolean") info.tools = caps["tools"];
      if (typeof caps["reasoning"] === "boolean") info.reasoning = caps["reasoning"];
      if (typeof caps["context"] === "number") info.context = caps["context"];
      if (caps["vision"] === true) info.input = ["text", "image"];
      return [info];
    });
  }

  async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, undefined> {
    const payload: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(serializeMessage),
      stream: true,
    };
    if (req.tools && req.tools.length > 0) {
      payload["tools"] = req.tools;
      payload["tool_choice"] = "auto";
    }
    if (req.temperature !== undefined) payload["temperature"] = req.temperature;
    if (req.maxTokens !== undefined) payload["max_tokens"] = req.maxTokens;

    let res: Response;
    try {
      res = await fetch(this.url("/chat/completions"), {
        method: "POST",
        headers: this.headers("text/event-stream"),
        body: JSON.stringify(payload),
        signal: req.signal,
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

    // Some gateways answer with a plain JSON body (plus a stray `data: [DONE]`)
    // despite `stream: true`, or ignore streaming entirely. Trust an explicit
    // JSON content type and fall back to SSE-prefixed parsing otherwise, so a
    // missing content type never costs us the stream.
    const contentType = res.headers.get("content-type") ?? "";
    const chunks: AsyncGenerator<unknown, void, undefined> = contentType.includes(
      "application/json",
    )
      ? readWholeJson(res)
      : decodeJsonEvents(res.body);

    let text = "";
    let reasoning = "";
    let model = req.model;
    let usage: Usage | undefined;
    let announced = false;
    let rawFinish: FinishReason = "unknown";
    const pending: PendingToolCall[] = [];

    for await (const raw of chunks) {
      const chunk = raw as RawChunk;

      if (chunk.error) {
        const message =
          typeof chunk.error === "string" ? chunk.error : (chunk.error.message ?? "unknown");
        throw new ProviderError(`${this.name}: ${message}`);
      }
      if (typeof chunk.model === "string" && chunk.model) model = chunk.model;
      if (chunk.usage) usage = normalizeUsage(chunk.usage);

      if (!announced) {
        announced = true;
        yield { type: "start", model };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) rawFinish = toFinishReason(choice.finish_reason);

      const delta = choice.delta ?? choice.message;
      if (!delta) continue;

      const think = delta.reasoning_content ?? delta.reasoning;
      if (typeof think === "string" && think.length > 0) {
        reasoning += think;
        yield { type: "reasoning", delta: think };
      }

      if (typeof delta.content === "string" && delta.content.length > 0) {
        text += delta.content;
        yield { type: "text", delta: delta.content };
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const fragment of delta.tool_calls) {
          const index = typeof fragment.index === "number" ? fragment.index : pending.length;
          while (pending.length <= index) {
            pending.push({ id: "", name: "", args: "", announced: false });
          }
          const slot = pending[index]!;

          if (fragment.id) slot.id = fragment.id;
          if (fragment.function?.name) slot.name += fragment.function.name;

          if (!slot.announced && slot.name.length > 0) {
            slot.announced = true;
            yield { type: "tool_call_start", index, id: slot.id, name: slot.name };
          }

          const args = fragment.function?.arguments;
          if (typeof args === "string" && args.length > 0) {
            slot.args += args;
            yield { type: "tool_call_args", index, delta: args };
          }
        }
      }
    }

    const toolCalls: ToolCall[] = pending
      .filter((slot) => slot.name.length > 0)
      .map((slot, index) => ({
        id: slot.id || `call_${index}`,
        type: "function" as const,
        function: { name: slot.name, arguments: slot.args || "{}" },
      }));

    yield {
      type: "finish",
      reason:
        toolCalls.length > 0
          ? "tool_calls"
          : rawFinish === "unknown"
            ? "stop"
            : rawFinish,
      model,
      text,
      reasoning,
      toolCalls,
      usage,
    };
  }
}

/**
 * Reads a non-streaming JSON response, tolerating the trailing `data: [DONE]`
 * that some gateways append to perfectly ordinary JSON bodies.
 */
async function* readWholeJson(res: Response): AsyncGenerator<unknown, void, undefined> {
  const text = await res.text();
  const payload = extractFirstJsonObject(text);
  if (payload !== undefined) yield payload;
}

function serializeMessage(message: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: message.role };

  if (typeof message.content === "string") {
    out["content"] = message.content;
  } else if (Array.isArray(message.content)) {
    out["content"] = message.content.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : {
            type: "image_url",
            image_url: { url: part.url, ...(part.detail ? { detail: part.detail } : {}) },
          },
    );
  }
  // `content: null` is intentionally omitted: assistant turns that only carry
  // tool_calls are rejected by some gateways when content is explicitly null.

  if (message.tool_calls) out["tool_calls"] = message.tool_calls;
  if (message.tool_call_id) out["tool_call_id"] = message.tool_call_id;
  if (message.name) out["name"] = message.name;
  return out;
}

function normalizeUsage(raw: Record<string, unknown>): Usage {
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  const prompt = num(raw["prompt_tokens"]) ?? 0;
  const completion = num(raw["completion_tokens"]) ?? 0;
  const details = (raw["prompt_tokens_details"] ?? {}) as Record<string, unknown>;
  const completionDetails = (raw["completion_tokens_details"] ?? {}) as Record<string, unknown>;

  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: num(raw["total_tokens"]) ?? prompt + completion,
    cachedTokens: num(details["cached_tokens"]) ?? num(raw["cache_read_input_tokens"]),
    reasoningTokens: num(completionDetails["reasoning_tokens"]),
  };
}

/** Maps provider finish reasons onto our normalized set. */
export function toFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case "stop":
    case "end_turn":
      return "stop";
    case "length":
    case "max_tokens":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    case null:
    case undefined:
      return "unknown";
    default:
      return "unknown";
  }
}
