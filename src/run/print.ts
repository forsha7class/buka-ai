import type { PermissionConfig } from "../config/schema.js";
import type { ChatMessage, ToolCall, Usage } from "../provider/types.js";
import type { ToolRegistry } from "../agent/tools/registry.js";
import type { Session, ToolResultRecord } from "../session/store.js";
import { createPermissionHandler } from "../agent/permission.js";
import { runAgent } from "../agent/loop.js";
import type { Runtime } from "../runtime.js";
import { color, style, symbol } from "../util/theme.js";

export interface PrintOptions {
  prompt: string;
  runtime: Runtime;
  /** Prior conversation to continue from (without the system message). */
  history?: ChatMessage[];
  /** When present, the run is appended to this session log. */
  session?: Session;
  tools?: ToolRegistry;
  model?: string;
  yolo?: boolean;
  verbose?: boolean;
  noTools?: boolean;
  maxTurns?: number;
  systemPrompt?: string;
  cwd?: string;
  signal?: AbortSignal;
}

export interface PrintResult {
  code: number;
  messages: ChatMessage[];
  usage?: Usage;
  assistantText: string;
}

/**
 * Non-interactive runner: streams the answer to stdout and diagnostics to
 * stderr, so `buka -p "..."` stays pipeable and scriptable.
 */
export async function runPrint(options: PrintOptions): Promise<PrintResult> {
  const cwd = options.cwd ?? process.cwd();
  const permission: PermissionConfig = options.runtime.config.permission;
  const session = options.session;

  const messages: ChatMessage[] = [
    {
      role: "system",
      // Assembled once in the runtime, so print mode, the TUI and
      // `--show-prompt` all send the identical system message.
      content: options.systemPrompt ?? options.runtime.systemPrompt,
    },
    ...(options.history ?? session?.toChatMessages() ?? []),
    { role: "user", content: options.prompt },
  ];

  session?.recordUser(options.prompt);

  let assistantText = "";
  let reasoningText = "";
  let usage: Usage | undefined;
  let code = 0;
  /** True once any assistant text has been written, so notes get a fresh line. */
  let wroteText = false;
  const toolCalls: ToolCall[] = [];
  const toolResults = new Map<string, ToolResultRecord>();
  let errorMessage: string | undefined;
  let finalMessages: ChatMessage[] = messages;
  let upstreamModel = options.model ?? options.runtime.model.modelId;

  const writeOut = (text: string): void => {
    process.stdout.write(text);
    wroteText = true;
  };

  const note = (text: string): void => {
    process.stderr.write(`${wroteText ? "\n" : ""}${text}\n`);
    wroteText = false;
  };

  const agent = runAgent({
    provider: options.runtime.model.provider,
    model: options.model ?? options.runtime.model.modelId,
    messages,
    ...(options.tools ? { tools: options.tools } : {}),
    permission,
    cwd,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.noTools ? { enableTools: false } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    requestPermission: createPermissionHandler({
      config: permission,
      ...(options.yolo ? { yolo: true } : {}),
      interactive: true,
    }),
  });

  for await (const event of agent) {
    switch (event.type) {
      case "model":
        upstreamModel = event.model;
        break;

      case "text":
        writeOut(event.delta);
        assistantText += event.delta;
        break;

      case "reasoning":
        reasoningText += event.delta;
        if (options.verbose) process.stderr.write(color.dimGray(event.delta));
        break;

      case "tool_start":
        toolCalls.push(event.call);
        toolResults.set(event.call.id, {
          id: event.call.id,
          name: event.call.function.name,
          preview: event.preview,
          output: "",
          isError: false,
        });
        note(
          `${color.magenta(symbol.tool)} ${style.bold(event.call.function.name)} ${color.gray(event.preview)}`,
        );
        break;

      case "tool_end": {
        const existing = toolResults.get(event.call.id);
        toolResults.set(event.call.id, {
          id: event.call.id,
          name: event.call.function.name,
          preview: existing?.preview ?? event.call.function.name,
          output: event.output,
          isError: event.isError,
          ...(event.summary !== undefined ? { summary: event.summary } : {}),
        });
        note(
          event.isError
            ? `${color.red(symbol.fail)} ${style.dim(truncate(event.output, 200))}`
            : `${color.green(symbol.ok)} ${style.dim(event.summary ?? truncate(event.output, 80))}`,
        );
        break;
      }

      case "usage":
        if (event.usage) usage = event.usage;
        break;

      case "error":
        errorMessage = event.error.message;
        note(color.red(`${symbol.fail} ${event.error.message}`));
        code = 1;
        break;

      case "done":
        finalMessages = event.messages;
        if (event.reason === "aborted") code = 130;
        if (event.reason === "max-turns") {
          note(color.yellow(`${symbol.warn} stopped after reaching the turn limit`));
          if (code === 0) code = 1;
        }
        break;

      default:
        break;
    }
  }

  session?.completeAssistant({
    text: assistantText,
    reasoning: reasoningText,
    model: upstreamModel,
    toolCalls,
    toolResults: [...toolResults.values()],
    ...(errorMessage !== undefined ? { error: errorMessage } : {}),
  });

  // Emit a trailing newline so the shell prompt doesn't collide with the answer.
  if (assistantText.length > 0 && !assistantText.endsWith("\n")) process.stdout.write("\n");

  if (usage && options.verbose) {
    process.stderr.write(
      `${style.dim(
        `tokens: ${usage.promptTokens} in / ${usage.completionTokens} out` +
          (usage.cachedTokens ? ` (${usage.cachedTokens} cached)` : "") +
          (usage.reasoningTokens ? ` (${usage.reasoningTokens} reasoning)` : ""),
      )}\n`,
    );
  }

  return { code, messages: finalMessages, usage, assistantText };
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}
