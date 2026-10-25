import type { PermissionConfig } from "../../config/schema.js";
import type { ToolDefinition } from "../../provider/types.js";
import { ToolError, type PermissionRequest, type Tool, type ToolContext, type ToolResult } from "./types.js";

export interface ToolExecution {
  name: string;
  args: unknown;
  preview: string;
  result: ToolResult;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /** Parses the model's raw JSON arguments, tolerating empty/invalid payloads. */
  static parseArguments(raw: string): unknown {
    const trimmed = raw.trim();
    if (trimmed === "") return {};
    try {
      return JSON.parse(trimmed);
    } catch {
      // Models occasionally emit near-JSON. Fall back to the raw string so the
      // tool itself can report a useful error instead of exploding here.
      return { __raw: raw };
    }
  }

  /**
   * Runs a tool, consulting the permission config first.
   *
   * `ask` delegates to the TUI; `deny` short-circuits with an error result the
   * model can learn from; `allow` runs immediately.
   */
  async execute(
    toolName: string,
    args: unknown,
    ctx: ToolContext,
    permission?: PermissionConfig,
  ): Promise<ToolExecution> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      const known = this.names().join(", ") || "(none)";
      return {
        name: toolName,
        args,
        preview: toolName,
        result: {
          output: `Unknown tool "${toolName}". Available tools: ${known}`,
          isError: true,
          summary: "unknown tool",
        },
      };
    }

    const preview = safeSummarize(tool, args);
    const mode = permission ? permission[toolName as keyof PermissionConfig] ?? "ask" : "ask";

    if (mode === "deny") {
      return {
        name: toolName,
        args,
        preview,
        result: {
          output: `Permission denied by configuration: the "${toolName}" tool is disabled.`,
          isError: true,
          summary: "denied",
        },
      };
    }

    if (mode === "ask") {
      const request: PermissionRequest = { tool: toolName, args, preview };
      const allowed = await ctx.requestPermission(request);
      if (!allowed) {
        return {
          name: toolName,
          args,
          preview,
          result: {
            output: `The user denied permission to run "${toolName}". Do not retry it; ask the user how to proceed.`,
            isError: true,
            summary: "denied by user",
          },
        };
      }
    }

    try {
      const result = await tool.execute(args, ctx);
      return { name: toolName, args, preview, result };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        name: toolName,
        args,
        preview,
        result: {
          output:
            cause instanceof ToolError ? message : `${toolName} failed: ${message}`,
          isError: true,
          summary: "error",
        },
      };
    }
  }
}

function safeSummarize(tool: Tool, args: unknown): string {
  try {
    return tool.summarize(args);
  } catch {
    return tool.name;
  }
}
