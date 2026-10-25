/** Core wire types shared by providers, the agent loop and the TUI. */

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  /** Either an http(s) URL or a `data:` base64 URL. */
  url: string;
  detail?: "auto" | "low" | "high";
}

export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** Raw JSON string as produced by the model. Never assumed valid here. */
    arguments: string;
  };
}

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[] | null;
  /** Present on assistant messages that requested tools. */
  tool_calls?: ToolCall[];
  /** Present on `role: "tool"` messages, linking back to the request. */
  tool_call_id?: string;
  name?: string;
}

export type JSONSchema = Record<string, unknown>;

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Tokens served from the provider's prompt cache, when reported. */
  cachedTokens?: number;
  reasoningTokens?: number;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "error"
  | "unknown";

/** Normalized event stream emitted by every provider implementation. */
export type ProviderEvent =
  | { type: "start"; model: string }
  | { type: "text"; delta: string }
  /** Chain-of-thought tokens (`reasoning_content` / `reasoning`). */
  | { type: "reasoning"; delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_args"; index: number; delta: string }
  | {
      type: "finish";
      reason: FinishReason;
      /** The model actually used — may differ from the requested id (aliases, combos). */
      model: string;
      text: string;
      reasoning: string;
      toolCalls: ToolCall[];
      usage?: Usage;
    };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ModelInfo {
  id: string;
  name?: string;
  context?: number;
  output?: number;
  tools?: boolean;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
}

export interface Provider {
  readonly id: string;
  readonly name: string;
  listModels(): Promise<ModelInfo[]>;
  stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, undefined>;
}

export interface ProviderConfig {
  name?: string;
  type?: "openai-compatible";
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Fetch `/models` from the endpoint instead of hardcoding the list. */
  discover?: boolean;
  models?: Record<string, ModelConfig>;
}

export interface ModelConfig {
  /** Wire id sent to the provider. Defaults to the config key. */
  id?: string;
  name?: string;
  context?: number;
  output?: number;
  tools?: boolean;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
}
