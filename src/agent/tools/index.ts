import { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { listTool } from "./list.js";
import { bashTool } from "./bash.js";

/**
 * The default tool set.
 *
 * Names intentionally match the `permission` keys in the config schema
 * (`read`, `glob`, `grep`, `list`, `bash`, `write`, `edit`) so permission modes
 * line up without a translation table.
 */
export function defaultTools(): Tool[] {
  return [readTool, writeTool, editTool, globTool, grepTool, listTool, bashTool];
}

export function createDefaultTools(_cwd: string): ToolRegistry {
  return new ToolRegistry(defaultTools());
}

export { readTool, writeTool, editTool, globTool, grepTool, listTool, bashTool };
