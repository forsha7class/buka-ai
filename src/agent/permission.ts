import { createInterface } from "node:readline/promises";

import type { PermissionConfig, PermissionMode } from "../config/schema.js";
import type { PermissionRequest } from "./tools/types.js";
import { color, style, symbol } from "../util/theme.js";

export interface PermissionHandlerOptions {
  config: PermissionConfig;
  /** Auto-approve everything (`--yolo`). */
  yolo?: boolean;
  /** Allow interactive prompts. When false, `ask` resolves to deny. */
  interactive?: boolean;
}

/**
 * Builds the permission callback used by the agent loop.
 *
 * `allow` / `deny` come straight from config. `ask` prompts on stdin when a
 * TTY is attached, and degrades to a deny otherwise — so a piped or
 * non-interactive run never hangs waiting for an answer it can't receive.
 */
export function createPermissionHandler(
  options: PermissionHandlerOptions,
): (request: PermissionRequest) => Promise<boolean> {
  return async (request) => {
    if (options.yolo) return true;

    const mode = (options.config[request.tool as keyof PermissionConfig] ??
      "ask") as PermissionMode;

    if (mode === "allow") return true;
    if (mode === "deny") return false;

    if (!options.interactive || !process.stdin.isTTY) {
      process.stderr.write(
        `${color.dimGray("·")} ${style.dim(`skipped ${request.tool} (needs permission; pass --yolo or set permission.${request.tool}="allow")`)}\n`,
      );
      return false;
    }

    return promptForPermission(request);
  };
}

async function promptForPermission(request: PermissionRequest): Promise<boolean> {
  process.stderr.write(
    [
      "",
      `${color.yellow(symbol.warn)} ${style.bold(request.tool)} ${style.dim("wants to run:")}`,
      `  ${color.cyan(request.preview)}`,
      `${style.dim("allow? [y]es / [n]o / [a]lways")} `,
    ].join("\n"),
  );

  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    const answer = await rl.question("");
    const normalized = answer.trim().toLowerCase();
    return (
      normalized === "y" || normalized === "yes" || normalized === "a" || normalized === "always"
    );
  } catch {
    return false;
  } finally {
    rl.close();
  }
}
