import type { PermissionConfig } from "../config/schema.js";
import type {
  ChatMessage,
  FinishReason,
  Provider,
  ProviderEvent,
  ToolCall,
  Usage,
} from "../provider/types.js";
import type { PermissionRequest, ToolContext, ToolResult } from "./tools/types.js";
import { ToolRegistry } from "./tools/registry.js";

export type StopReason = "complete" | "max-turns" | "aborted" | "error";

type FinishEvent = Extract<ProviderEvent, { type: "finish" }>;

export type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "model"; model: string }
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool_start"; call: ToolCall; args: unknown; preview: string }
  | {
      type: "tool_end";
      call: ToolCall;
      output: string;
      isError: boolean;
      summary?: string;
      metadata?: Record<string, unknown>;
    }
  | { type: "usage"; usage: Usage | undefined; model: string }
  | { type: "turn_end"; reason: FinishReason }
  | { type: "done"; reason: StopReason; messages: ChatMessage[] }
  | { type: "error"; error: Error; messages: ChatMessage[] };

export interface AgentOptions {
  provider: Provider;
  model: string;
  /** Conversation prefix (system + history). Taken by value, never mutated. */
  messages: ChatMessage[];
  tools?: ToolRegistry;
  permission?: PermissionConfig;
  cwd: string;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /** Safety valve against tool-call ping-pong. */
  maxTurns?: number;
  /** Set false to disable tool use entirely for this run. */
  enableTools?: boolean;
  /** Decides whether a tool may run. Defaults to allowing everything. */
  requestPermission?: (request: PermissionRequest) => Promise<boolean>;
}

const DEFAULT_MAX_TURNS = 32;

/**
 * The agentic loop: stream a completion, execute any requested tools, feed the
 * results back, repeat until the model stops asking for tools (or we hit the
 * turn ceiling).
 *
 * Yields normalized events so both the print runner and the TUI can render the
 * same run without duplicating protocol logic.
 */
export async function* runAgent(options: AgentOptions): AsyncGenerator<AgentEvent, void, undefined> {
  const messages: ChatMessage[] = [...options.messages];
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const useTools = (options.enableTools ?? true) && options.tools !== undefined;
  const definitions = useTools ? options.tools!.definitions() : [];
  const signal = options.signal ?? new AbortController().signal;

  const requestPermission =
    options.requestPermission ?? (async (_request: PermissionRequest) => true);

  /** True once any turn has produced visible text. */
  let producedTextBefore = false;

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal.aborted) {
      yield { type: "done", reason: "aborted", messages };
      return;
    }

    yield { type: "turn_start", turn };

    let final: FinishEvent | undefined;
    let textInThisTurn = false;

    try {
      for await (const event of options.provider.stream({
        model: options.model,
        // Snapshot: the loop keeps pushing onto its own array, and a provider
        // that retains the request (logging, retries) must not observe later
        // mutations.
        messages: [...messages],
        ...(definitions.length > 0 ? { tools: definitions } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        signal,
      })) {
        switch (event.type) {
          case "start":
            yield { type: "model", model: event.model };
            break;
          case "reasoning":
            yield { type: "reasoning", delta: event.delta };
            break;
          case "text":
            if (!textInThisTurn) {
              textInThisTurn = true;
              // Each turn is a separate message from the model. Without a break,
              // a sentence ending one turn fuses onto the first word of the next
              // (observed in practice: "…/not found/.Beres.").
              if (producedTextBefore) yield { type: "text", delta: "\n\n" };
            }
            producedTextBefore = true;
            yield { type: "text", delta: event.delta };
            break;
          case "finish":
            final = event;
            break;
          default:
            break;
        }
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (signal.aborted || error.name === "AbortError") {
        yield { type: "done", reason: "aborted", messages };
        return;
      }
      yield { type: "error", error, messages };
      return;
    }

    if (!final) {
      yield {
        type: "error",
        error: new Error("Provider stream ended without a finish event"),
        messages,
      };
      return;
    }

    yield { type: "usage", usage: final.usage, model: final.model };
    yield { type: "turn_end", reason: final.reason };

    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: final.text.length > 0 ? final.text : null,
    };
    if (final.toolCalls.length > 0) assistantMessage.tool_calls = final.toolCalls;
    messages.push(assistantMessage);

    if (final.toolCalls.length === 0 || final.reason !== "tool_calls") {
      yield { type: "done", reason: "complete", messages };
      return;
    }

    for (const call of final.toolCalls) {
      const args = ToolRegistry.parseArguments(call.function.arguments);
      const tool = options.tools?.get(call.function.name);
      const preview = previewOf(tool, call, args);

      yield { type: "tool_start", call, args, preview };

      const context: ToolContext = {
        cwd: options.cwd,
        signal,
        requestPermission,
      };

      const execution: ToolResult = (
        await options.tools!.execute(call.function.name, args, context, options.permission)
      ).result;

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: execution.output,
      });

      yield {
        type: "tool_end",
        call,
        output: execution.output,
        isError: execution.isError ?? false,
        summary: execution.summary,
        metadata: execution.metadata,
      };
    }
  }

  yield { type: "done", reason: "max-turns", messages };
}

function previewOf(
  tool: ReturnType<ToolRegistry["get"]>,
  call: ToolCall,
  args: unknown,
): string {
  if (!tool) return call.function.name;
  try {
    return tool.summarize(args);
  } catch {
    return call.function.name;
  }
}
