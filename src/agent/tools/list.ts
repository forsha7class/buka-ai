import { readdirSync, statSync } from "node:fs";

import type { Tool, ToolResult } from "./types.js";
import {
  IGNORED_DIRS,
  asRecord,
  displayPath,
  formatBytes,
  formatCount,
  optionalString,
  resolvePath,
} from "./shared.js";

const MAX_ENTRIES = 400;

export const listTool: Tool = {
  name: "list",
  description:
    "List the entries in a directory. Directories are suffixed with `/` and files show their size. " +
    "Use it to orient yourself before reading files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list. Defaults to the working directory." },
      all: { type: "boolean", description: "Include ignored build/vendor directories and dotfiles." },
    },
    additionalProperties: false,
  },

  summarize(args) {
    const record = asRecord(args);
    return typeof record["path"] === "string" ? record["path"] : ".";
  },

  execute(args, ctx): Promise<ToolResult> {
    const record = asRecord(args);
    const target = resolvePath(ctx.cwd, optionalString(record["path"], "path") ?? ".");
    const includeAll = record["all"] === true;
    const shown = displayPath(ctx.cwd, target);

    let entries;
    try {
      entries = readdirSync(target, { withFileTypes: true });
    } catch (cause) {
      return Promise.resolve({
        output: `Could not list ${shown}: ${(cause as Error).message}`,
        isError: true,
        summary: "list failed",
      });
    }

    const visible = entries
      .filter((entry) => includeAll || !IGNORED_DIRS.has(entry.name))
      .filter((entry) => includeAll || !entry.name.startsWith("."))
      .sort((a, b) => {
        // Directories first, then alphabetical — the order people expect.
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    if (visible.length === 0) {
      return Promise.resolve({ output: `${shown} is empty.`, summary: "empty" });
    }

    const limited = visible.slice(0, MAX_ENTRIES);
    const lines = limited.map((entry) => {
      if (entry.isDirectory()) return `${entry.name}/`;
      if (entry.isSymbolicLink()) return `${entry.name} ->`;
      try {
        return `${entry.name}  ${formatBytes(statSync(`${target}/${entry.name}`).size)}`;
      } catch {
        return entry.name;
      }
    });

    const suffix =
      visible.length > limited.length ? `\n… ${visible.length - limited.length} more` : "";

    return Promise.resolve({
      output: `${shown}/ — ${formatCount(visible.length, "entry", "entries")}\n${lines.join("\n")}${suffix}`,
      summary: formatCount(visible.length, "entry", "entries"),
      metadata: { path: target, count: visible.length },
    });
  },
};
