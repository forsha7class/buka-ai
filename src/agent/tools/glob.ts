import { glob } from "node:fs/promises";
import { sep } from "node:path";

import type { Tool, ToolResult } from "./types.js";
import {
  IGNORED_DIRS,
  asRecord,
  displayPath,
  formatCount,
  optionalString,
  requireNumber,
  requireString,
  resolvePath,
} from "./shared.js";

const MAX_RESULTS = 500;

export const globTool: Tool = {
  name: "glob",
  description:
    "Find files by glob pattern (e.g. `**/*.ts`, `src/**/*.{ts,tsx}`). " +
    "Results are relative to the working directory and exclude build/vendor directories by default.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. `**/*.test.ts`." },
      path: { type: "string", description: "Directory to search in. Defaults to the working directory." },
      limit: { type: "number", description: `Maximum results (default ${MAX_RESULTS}).` },
    },
    required: ["pattern"],
    additionalProperties: false,
  },

  summarize(args) {
    const record = asRecord(args);
    const pattern = typeof record["pattern"] === "string" ? record["pattern"] : "?";
    const path = typeof record["path"] === "string" ? ` in ${record["path"]}` : "";
    return `${pattern}${path}`;
  },

  async execute(args, ctx): Promise<ToolResult> {
    const record = asRecord(args);
    const pattern = requireString(record["pattern"], "pattern");
    const base = resolvePath(ctx.cwd, optionalString(record["path"], "path") ?? ".");
    const limit = requireNumber(record["limit"], "limit", 1, 5000, MAX_RESULTS);

    const matches: Array<{ relative: string; absolute: string }> = [];

    try {
      for await (const entry of glob(pattern, { cwd: base })) {
        const relativePath = String(entry).split(sep).join("/");
        if (isIgnored(relativePath)) continue;
        matches.push({ relative: relativePath, absolute: resolvePath(base, relativePath) });
        if (matches.length > limit * 4) break; // hard stop on pathological patterns
      }
    } catch (cause) {
      return {
        output: `Glob failed for "${pattern}": ${(cause as Error).message}`,
        isError: true,
        summary: "glob failed",
      };
    }

    matches.sort((a, b) => a.relative.localeCompare(b.relative));
    const limited = matches.slice(0, limit);

    if (limited.length === 0) {
      return {
        output: `No files match ${pattern} in ${displayPath(ctx.cwd, base)}.`,
        summary: "no matches",
      };
    }

    const lines = limited.map((match) => displayPath(ctx.cwd, match.absolute));
    const suffix =
      matches.length > limit ? `\n… ${matches.length - limit} more matches not shown` : "";

    return {
      output: `${formatCount(limited.length, "file")} matching ${pattern}:\n${lines.join("\n")}${suffix}`,
      summary: formatCount(matches.length, "file"),
      metadata: { count: matches.length, truncated: matches.length > limit },
    };
  },
};

export function isIgnored(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => IGNORED_DIRS.has(segment));
}
