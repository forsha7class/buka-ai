import { platform, release } from "node:os";
import { basename } from "node:path";

import type { ToolRegistry } from "./tools/registry.js";

export interface SystemPromptOptions {
  cwd: string;
  tools?: ToolRegistry;
  /** User-supplied override from config; replaces the built-in text. */
  custom?: string;
}

const BASE = `You are buka, a terminal-native coding agent. You help the user with
software engineering tasks directly in their working directory.

Working style:
- Be concise. The user is in a terminal; skip preamble and pleasantries.
- Investigate before acting: read the relevant files before editing them.
- Prefer making the change over describing the change.
- When you are unsure, say so plainly instead of guessing.
- After editing, verify with the project's own tooling when one exists.

Tool use:
- Call tools when they help. Do not narrate what you are about to do and then
  not do it.
- Batch independent tool calls into a single turn when possible.
- If a tool is denied by the user, do not retry it. Ask how to proceed instead.
- Never invent file contents or command output; read them.
- Prefer the dedicated file tools (read/write/edit/glob/grep) over shelling out.`;

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const parts: string[] = [];

  if (options.custom && options.custom.trim().length > 0) {
    parts.push(options.custom.trim());
  } else {
    parts.push(BASE);
  }

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
