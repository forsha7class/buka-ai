import { readFileSync, writeFileSync } from "node:fs";

import { ToolError, type Tool, type ToolResult } from "./types.js";
import { asRecord, displayPath, requireString, resolvePath } from "./shared.js";

/**
 * Exact-string replacement.
 *
 * Deliberately strict: the old string must appear exactly once unless
 * `replaceAll` is set. That is what keeps a model from silently mangling a file
 * when its mental model of the content is slightly off — a zero-match or
 * many-match failure is far cheaper than a corrupted edit.
 */
export const editTool: Tool = {
  name: "edit",
  description:
    "Replace an exact string in a file. `oldString` must match the file byte-for-byte, " +
    "including indentation, and must be unique unless `replaceAll` is true. " +
    "Read the file first and copy the text you want to replace verbatim.",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "File to modify." },
      oldString: { type: "string", description: "Exact existing text to replace." },
      newString: { type: "string", description: "Replacement text. Use \"\" to delete." },
      replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness." },
    },
    required: ["filePath", "oldString", "newString"],
    additionalProperties: false,
  },

  summarize(args) {
    const record = asRecord(args);
    const path = typeof record["filePath"] === "string" ? record["filePath"] : "?";
    const replaceAll = record["replaceAll"] === true;
    return `${path}${replaceAll ? "  (all occurrences)" : ""}`;
  },

  execute(args, ctx): Promise<ToolResult> {
    const record = asRecord(args);
    const filePath = resolvePath(ctx.cwd, requireString(record["filePath"], "filePath"));
    const oldString = requireString(record["oldString"], "oldString");
    const newString = requireString(record["newString"], "newString");
    const replaceAll = record["replaceAll"] === true;
    const shown = displayPath(ctx.cwd, filePath);

    if (oldString === newString) {
      throw new ToolError("oldString and newString are identical; nothing to do");
    }
    if (oldString.length === 0) {
      throw new ToolError("oldString must not be empty");
    }

    let original: string;
    try {
      original = readFileSync(filePath, "utf8");
    } catch (cause) {
      return Promise.resolve({
        output: `Could not read ${shown}: ${(cause as Error).message}`,
        isError: true,
        summary: "read failed",
      });
    }

    const occurrences = countOccurrences(original, oldString);

    if (occurrences === 0) {
      return Promise.resolve({
        output:
          `No match for oldString in ${shown}.\n` +
          `The text must match exactly, including whitespace and indentation. ` +
          `Read the file again and copy the target text verbatim.`,
        isError: true,
        summary: "no match",
      });
    }

    if (occurrences > 1 && !replaceAll) {
      return Promise.resolve({
        output:
          `oldString appears ${occurrences} times in ${shown}; a single replacement would be ambiguous.\n` +
          `Include more surrounding context to make it unique, or pass replaceAll: true.`,
        isError: true,
        summary: `${occurrences} matches`,
      });
    }

    const updated = replaceAll
      ? original.split(oldString).join(newString)
      : original.replace(oldString, newString);

    try {
      writeFileSync(filePath, updated, "utf8");
    } catch (cause) {
      return Promise.resolve({
        output: `Could not write ${shown}: ${(cause as Error).message}`,
        isError: true,
        summary: "write failed",
      });
    }

    const replaced = replaceAll ? occurrences : 1;
    const delta = countLines(newString) - countLines(oldString);

    return Promise.resolve({
      output:
        `Edited ${shown}: ${replaced} replacement${replaced === 1 ? "" : "s"}` +
        (delta !== 0 ? ` (${delta > 0 ? "+" : ""}${delta} lines)` : "") +
        ".",
      summary: `${replaced} replacement${replaced === 1 ? "" : "s"}`,
      metadata: { path: filePath, replacements: replaced },
    });
  },
};

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}
