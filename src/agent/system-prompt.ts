import { platform, release } from "node:os";
import { basename } from "node:path";

import type { ToolRegistry } from "./tools/registry.js";

export interface SystemPromptOptions {
  cwd: string;
  tools?: ToolRegistry;
  /** The persona and rules text, resolved from SYSTEM_PROMPT.md. */
  prompt: string;
}

/**
 * Assembles what is actually sent as the system message.
 *
 * The prompt text itself comes from `SYSTEM_PROMPT.md` (see `./prompt.ts`); this
 * only appends the facts the author should not have to maintain by hand — where
 * we are running and which tools exist.
 */
export function buildSystemPrompt(options: SystemPromptOptions): string {
  const parts: string[] = [options.prompt.trim()];

  const environment = [
    `Working directory: ${options.cwd}`,
    `Project: ${basename(options.cwd)}`,
    `Platform: ${platform()} ${release()}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
  ];
  parts.push(`Environment:\n${environment.map((line) => `- ${line}`).join("\n")}`);

  const tools = options.tools?.names();
  if (tools && tools.length > 0) {
    parts.push(`Available tools: ${tools.join(", ")}`);
  }

  return parts.join("\n\n");
}
