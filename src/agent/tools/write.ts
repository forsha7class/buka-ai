import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Tool, ToolResult } from "./types.js";
import { simpleDiff } from "./diff.js";
import { asRecord, displayPath, formatBytes, requireString, resolvePath } from "./shared.js";

export const writeTool: Tool = {
  name: "write",
  description:
    "Write a file, creating parent directories as needed. Overwrites the file completely. " +
    "For small changes to an existing file prefer the `edit` tool, which preserves the rest of the content.",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Path to write, relative to the working directory." },
      content: { type: "string", description: "Full file content." },
    },
    required: ["filePath", "content"],
    additionalProperties: false,
  },

  summarize(args) {
    const record = asRecord(args);
    const path = typeof record["filePath"] === "string" ? record["filePath"] : "?";
    const content = typeof record["content"] === "string" ? record["content"] : "";
    const lines = content.length === 0 ? 0 : content.split("\n").length;
    return `${path}  (${lines} lines)`;
  },

  execute(args, ctx): Promise<ToolResult> {
    const record = asRecord(args);
    const filePath = resolvePath(ctx.cwd, requireString(record["filePath"], "filePath"));
    const content = requireString(record["content"], "content");
    const shown = displayPath(ctx.cwd, filePath);

    const existed = existsSync(filePath);
    let before = "";
    if (existed) {
      try {
        before = readFileSync(filePath, "utf8");
      } catch {
        before = "";
      }
    }

    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf8");
    } catch (cause) {
      return Promise.resolve({
        output: `Could not write ${shown}: ${(cause as Error).message}`,
        isError: true,
        summary: "write failed",
      });
    }

    const bytes = Buffer.byteLength(content, "utf8");
    const lines = content.length === 0 ? 0 : content.split("\n").length;

    return Promise.resolve({
      output: `${existed ? "Overwrote" : "Created"} ${shown} (${lines} lines, ${formatBytes(bytes)}).`,
      summary: `${existed ? "updated" : "created"} ${lines} lines`,
      metadata: { path: filePath, created: !existed, diff: simpleDiff(before, content, shown) },
    });
  },
};
