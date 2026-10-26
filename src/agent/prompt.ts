import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { configDir } from "../config/paths.js";

/**
 * The one place the system prompt lives.
 *
 * The user's copy is `~/.config/buka-ai/SYSTEM_PROMPT.md`; the repository copy is
 * the built-in fallback that seeds it. There is deliberately no hardcoded prompt
 * string in the source tree: two sources of truth for "what the agent is told"
 * is exactly the kind of thing that silently drifts.
 *
 * HTML comment blocks are stripped, so the file can carry usage notes without
 * them being sent to the model.
 */

export const PROMPT_FILENAME = "SYSTEM_PROMPT.md";

/**
 * Resolved relative to this module, which works from both `src/agent/prompt.ts`
 * (development) and `dist/agent/prompt.js` (built) — both are two levels below
 * the repository root.
 */
const BUILTIN_PATH = fileURLToPath(new URL("../../SYSTEM_PROMPT.md", import.meta.url));

export interface ResolvedPrompt {
  /** Ready to send: comments stripped, trimmed. */
  text: string;
  /** Which copy the text came from. */
  source: "user" | "builtin";
  /** Absolute path of the file the text came from. */
  path: string;
  /** Human-readable notes about what happened while resolving. */
  notes: string[];
}

export interface ResolvePromptOptions {
  /** Create the user's copy from the built-in default when missing. */
  seed?: boolean;
  /** Override the config directory (tests). */
  dir?: string;
}

const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** Removes HTML comment blocks, which are notes for the reader, not the model. */
export function stripComments(text: string): string {
  return text.replace(HTML_COMMENT, "").trim();
}

export function builtinPromptPath(): string {
  return BUILTIN_PATH;
}

export function userPromptPath(dir: string = configDir()): string {
  return join(dir, PROMPT_FILENAME);
}

/**
 * Resolves the prompt to send.
 *
 * Falls back to the built-in copy when the user's file is missing (seeding it
 * first) or holds nothing but comments. A missing built-in means the package is
 * incomplete, which is worth failing loudly over rather than silently inventing
 * a prompt.
 */
export function resolvePrompt(options: ResolvePromptOptions = {}): ResolvedPrompt {
  const seed = options.seed ?? true;
  const target = userPromptPath(options.dir);
  const notes: string[] = [];

  if (seed && !existsSync(target)) {
    try {
      const builtin = readBuiltin();
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, builtin, "utf8");
      notes.push(`created ${target}`);
    } catch (cause) {
      notes.push(`could not create ${target}: ${(cause as Error).message}`);
    }
  }

  if (existsSync(target)) {
    let raw: string;
    try {
      raw = readFileSync(target, "utf8");
    } catch (cause) {
      notes.push(`could not read ${target}: ${(cause as Error).message}`);
      raw = "";
    }

    const text = stripComments(raw);
    if (text.length > 0) {
      return { text, source: "user", path: target, notes };
    }
    notes.push(`${target} has no prompt text outside its comments; using the built-in default`);
  }

  return { text: stripComments(readBuiltin()), source: "builtin", path: BUILTIN_PATH, notes };
}

function readBuiltin(): string {
  try {
    return readFileSync(BUILTIN_PATH, "utf8");
  } catch {
    throw new Error(
      `Built-in system prompt not found at ${BUILTIN_PATH}. The installation looks incomplete — reinstall buka-ai.`,
    );
  }
}
