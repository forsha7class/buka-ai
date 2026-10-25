import { readFileSync, statSync } from "node:fs";

import type { Tool, ToolResult } from "./types.js";
import {
  asRecord,
  displayPath,
  formatBytes,
  looksBinary,
  requireNumber,
  requireString,
  resolvePath,
  truncateLines,
} from "./shared.js";

/** Max lines returned for a single read unless the model asks for more. */
const DEFAULT_LIMIT = 2000;

export const readTool: Tool = {
  name: "read",
  description:
    "Read a text file from the filesystem. Returns the content with 1-based line numbers. " +
    "Use `offset` and `limit` to page through large files. Always read a file before editing it.",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Path to the file, relative to the working directory." },
      offset: { type: "number", description: "1-based line number to start from." },
      limit: { type: "number", description: "Maximum number of lines to return." },
    },
    required: ["filePath"],
    additionalProperties: false,
  },

  summarize(args) {
    const record = asRecord(args);
    const path = typeof record["filePath"] === "string" ? record["filePath"] : "?";
    const offset = typeof record["offset"] === "number" ? record["offset"] : undefined;
    const limit = typeof record["limit"] === "number" ? record["limit"] : undefined;
    const range = offset !== undefined || limit !== undefined ? `:${offset ?? 1}${limit ? `-${(offset ?? 1) + limit - 1}` : ""}` : "";
    return `${path}${range}`;
  },

  execute(args, ctx): Promise<ToolResult> {
    const record = asRecord(args);
    const filePath = resolvePath(ctx.cwd, requireString(record["filePath"], "filePath"));
    const offset = requireNumber(record["offset"], "offset", 1, 10_000_000, 1);
    const limit = requireNumber(record["limit"], "limit", 1, 50_000, DEFAULT_LIMIT);
    const shown = displayPath(ctx.cwd, filePath);

    let stats;
    try {
      stats = statSync(filePath);
    } catch {
      return Promise.resolve({
        output: `File not found: ${shown}`,
        isError: true,
        summary: "not found",
      });
    }

    if (stats.isDirectory()) {
      return Promise.resolve({
        output: `${shown} is a directory. Use the "list" tool to see its contents.`,
        isError: true,
        summary: "is a directory",
      });
    }

    let buffer: Buffer;
    try {
      buffer = readFileSync(filePath);
    } catch (cause) {
      return Promise.resolve({
        output: `Could not read ${shown}: ${(cause as Error).message}`,
        isError: true,
        summary: "read failed",
      });
    }

    if (looksBinary(buffer)) {
      return Promise.resolve({
        output: `${shown} appears to be a binary file (${formatBytes(stats.size)}).`,
        isError: true,
        summary: "binary file",
      });
    }

    const allLines = buffer.toString("utf8").split("\n");
    // A trailing newline produces a phantom empty last element.
    if (allLines.length > 1 && allLines[allLines.length - 1] === "") allLines.pop();

    const total = allLines.length;
    const start = Math.min(offset - 1, total);
    const slice = allLines.slice(start, start + limit);
    const numbered = slice.map((line, index) => `${String(start + index + 1).padStart(6)}│ ${line}`);

    if (slice.length === 0) {
      return Promise.resolve({
        output: `${shown} has ${total} lines; offset ${offset} is past the end.`,
        isError: true,
        summary: "offset past end",
      });
    }

    const body = truncateLines(numbered.join("\n"), limit).text;
    const header =
      start > 0 || start + slice.length < total
        ? `# ${shown} — lines ${start + 1}-${start + slice.length} of ${total}`
        : `# ${shown} — ${total} lines`;

    return Promise.resolve({
      output: `${header}\n${body}`,
      summary: `${slice.length} of ${total} lines`,
      metadata: { path: filePath, offset: start + 1, lines: slice.length, total },
    });
  },
};
