import type { JSONSchema } from "../../provider/types.js";

export interface ToolResult {
  /** Text handed back to the model. */
  output: string;
  isError?: boolean;
  /** Short human-readable label for the TUI, e.g. `12 lines`. */
  summary?: string;
  /** Structured extras for rendering only — never sent to the model. */
  metadata?: Record<string, unknown>;
}

export interface PermissionRequest {
  /** Tool name, e.g. `bash`. */
  tool: string;
  /** Parsed arguments. */
  args: unknown;
  /** One-line preview shown in the prompt, e.g. `ls -la /root`. */
  preview: string;
}

export interface ToolContext {
  /** Session working directory. Tools must not escape it without asking. */
  cwd: string;
  signal: AbortSignal;
  /**
   * Resolves whether a mutating action may proceed. The TUI implements this
   * as a `y/n/a` prompt; print mode auto-answers from config.
   */
  requestPermission(request: PermissionRequest): Promise<boolean>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** Short preview of a call, shown before execution. */
  summarize(args: unknown): string;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}
