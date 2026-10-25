import { execFile } from "node:child_process";

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
  truncateLines,
} from "./shared.js";

const MAX_MATCHES = 200;
const MAX_FILES = 5000;

/** ripgrep is ~20x faster when present, so prefer it and fall back to JS. */
export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Returns `path:line: text` matches. " +
    "Uses ripgrep when available. Combine with `glob` to narrow which files are searched.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression." },
      path: { type: "string", description: "File or directory to search. Defaults to the working directory." },
      glob: { type: "string", description: "Only search files matching this glob, e.g. `*.ts`." },
      ignoreCase: { type: "boolean", description: "Case-insensitive match." },
      maxMatches: { type: "number", description: `Maximum matches to return (default ${MAX_MATCHES}).` },
    },
    required: ["pattern"],
    additionalProperties: false,
  },

  summarize(args) {
    const record = asRecord(args);
    const pattern = typeof record["pattern"] === "string" ? record["pattern"] : "?";
    const glob = typeof record["glob"] === "string" ? ` --glob ${record["glob"]}` : "";
    const path = typeof record["path"] === "string" ? ` ${record["path"]}` : "";
    return `/${pattern}/${glob}${path}`;
  },

  async execute(args, ctx): Promise<ToolResult> {
    const record = asRecord(args);
    const pattern = requireString(record["pattern"], "pattern");
    const fileGlob = optionalString(record["glob"], "glob");
    const ignoreCase = record["ignoreCase"] === true;
    const maxMatches = requireNumber(record["maxMatches"], "maxMatches", 1, 5000, MAX_MATCHES);
    const target = resolvePath(ctx.cwd, optionalString(record["path"], "path") ?? ".");
    const shown = displayPath(ctx.cwd, target);

    // Validate the regex up front so a bad pattern produces a clear message
    // rather than a ripgrep stderr dump.
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignoreCase ? "gi" : "g");
    } catch (cause) {
      return {
        output: `Invalid regular expression: ${(cause as Error).message}`,
        isError: true,
        summary: "bad pattern",
      };
    }

    const fromRipgrep = await tryRipgrep({
      pattern,
      target,
      cwd: ctx.cwd,
      ignoreCase,
      maxMatches,
      ...(fileGlob !== undefined ? { glob: fileGlob } : {}),
    });

    const matches = fromRipgrep ?? (await searchWithJs({ target, regex, maxMatches, glob: fileGlob }));

    if (matches.length === 0) {
      return { output: `No matches for /${pattern}/ in ${shown}.`, summary: "no matches" };
    }

    const body = truncateLines(matches.slice(0, maxMatches).join("\n"), maxMatches + 10).text;
    const suffix =
      matches.length > maxMatches ? `\n… ${matches.length - maxMatches} more matches not shown` : "";

    return {
      output: `${formatCount(matches.length, "match", "matches")} for /${pattern}/:\n${body}${suffix}`,
      summary: formatCount(matches.length, "match", "matches"),
      metadata: { count: matches.length },
    };
  },
};

interface RipgrepOptions {
  pattern: string;
  target: string;
  cwd: string;
  ignoreCase: boolean;
  maxMatches: number;
  glob?: string;
}

async function tryRipgrep(options: RipgrepOptions): Promise<string[] | null> {
  const args = ["--line-number", "--no-heading", "--color", "never", "--max-count", String(options.maxMatches)];
  if (options.ignoreCase) args.push("--ignore-case");
  for (const dir of IGNORED_DIRS) args.push("--glob", `!**/${dir}/**`);
  if (options.glob) args.push("--glob", options.glob);
  args.push("--regexp", options.pattern, "--", options.target);

  return new Promise<string[] | null>((resolve) => {
    execFile("rg", args, { cwd: options.cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        // ENOENT means ripgrep is not installed — fall back. Exit code 1 is
        // simply "no matches", which is a valid, empty result.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(null);
        if (error.code === "1" || (error as { code?: number }).code === 1) return resolve([]);
        if (stdout && stdout.length > 0) return resolve(splitMatches(stdout));
        return resolve(null);
      }
      resolve(splitMatches(stdout));
    });
  });
}

function splitMatches(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

interface JsSearchOptions {
  target: string;
  regex: RegExp;
  maxMatches: number;
  glob?: string;
}

/**
 * Dependency-free fallback: walk the tree and test each file line by line.
 * Slower and intentionally simple, but it means `grep` works on a machine with
 * no ripgrep installed.
 */
async function searchWithJs(options: JsSearchOptions): Promise<string[]> {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { relative, join } = await import("node:path");

  const matches: string[] = [];
  const visited = { files: 0 };
  const globRegex = options.glob ? globToRegExp(options.glob) : undefined;

  const walk = (path: string): void => {
    if (matches.length >= options.maxMatches || visited.files >= MAX_FILES) return;

    let stats;
    try {
      stats = statSync(path);
    } catch {
      return;
    }

    if (stats.isDirectory()) {
      let entries;
      try {
        entries = readdirSync(path, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(join(path, entry.name));
      }
      return;
    }

    if (!stats.isFile() || stats.size > 4 * 1024 * 1024) return;
    if (globRegex && !globRegex.test(path.split("/").pop() ?? path)) return;

    visited.files += 1;
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      return;
    }
    if (content.includes("\u0000")) return;

    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      options.regex.lastIndex = 0;
      if (!options.regex.test(line)) continue;
      matches.push(`${relative(process.cwd(), path)}:${index + 1}: ${line.trim()}`);
      if (matches.length >= options.maxMatches) return;
    }
  };

  walk(options.target);
  return matches;
}

/** Minimal glob → RegExp for the fallback path (`*`, `**`, `?`, `{a,b}`). */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        out += ".*";
        index += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      const end = pattern.indexOf("}", index);
      if (end === -1) {
        out += "\\{";
      } else {
        const options = pattern.slice(index + 1, end).split(",");
        out += `(?:${options.map(escapeRegExp).join("|")})`;
        index = end;
      }
    } else if (".+^$()|[]\\".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
