import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { statSync } from "node:fs";

import { ToolError } from "./types.js";

/** Directories that are never worth scanning or searching by default. */
export const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "coverage",
  ".cache",
]);

export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return input;
}

/** Resolves a tool argument to an absolute path, relative to the session cwd. */
export function resolvePath(cwd: string, input: string): string {
  const expanded = expandHome(input);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** Path shown to the model and the user: relative to cwd when inside it. */
export function displayPath(cwd: string, absolute: string): string {
  const rel = relative(cwd, absolute);
  if (rel.length === 0) return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return absolute;
  return rel.split(sep).join("/");
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export interface Truncated {
  text: string;
  truncated: boolean;
  /** Number of source lines before truncation. */
  totalLines: number;
}

/**
 * Caps output so a runaway command or a huge file cannot blow up the context
 * window. The model is told exactly how much was withheld so it can ask for a
 * narrower slice.
 */
export function truncateLines(text: string, maxLines: number, maxChars = 120_000): Truncated {
  const lines = text.split("\n");
  const totalLines = lines.length;
  let kept = lines.slice(0, maxLines);

  let chars = 0;
  let cutByChars = false;
  for (let index = 0; index < kept.length; index++) {
    chars += kept[index]!.length + 1;
    if (chars > maxChars) {
      kept = kept.slice(0, index + 1);
      cutByChars = true;
      break;
    }
  }

  let truncated = kept.length < totalLines || cutByChars;
  let out = kept.join("\n");

  if (chars > maxChars) {
    out = out.slice(0, maxChars);
    truncated = true;
  }

  if (truncated) {
    const shown = out.split("\n").length;
    out += `\n… output truncated: showing ${shown} of ${totalLines} lines`;
  }

  return { text: out, truncated, totalLines };
}

/** Throws a ToolError when a numeric argument is out of range. */
export function requireNumber(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolError(`"${name}" must be a number`);
  }
  if (value < min || value > max) {
    throw new ToolError(`"${name}" must be between ${min} and ${max}`);
  }
  return Math.floor(value);
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new ToolError(`"${name}" must be a string`);
  return value;
}

export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name);
}

export function asRecord(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new ToolError("arguments must be a JSON object");
  }
  return args as Record<string, unknown>;
}

/** True when the buffer looks like binary content rather than text. */
export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

export function formatBytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
