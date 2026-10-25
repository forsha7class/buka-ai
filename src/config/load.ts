import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import { parseJsonc } from "../util/jsonc.js";
import {
  CONFIG_FILENAMES,
  configDir,
  expandHome,
  globalConfigPaths,
  projectConfigPaths,
} from "./paths.js";
import {
  ConfigSchema,
  type Config,
  type ModelConfig,
  type PermissionConfig,
  type ResolvedConfig,
  type ResolvedProviderConfig,
  type TuiConfig,
} from "./schema.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadConfigOptions {
  cwd?: string;
  /** Explicit config file, replacing the search path entirely. */
  configPath?: string;
  /** Skip the project-level files (used by `--global`). */
  ignoreProject?: boolean;
}

export interface LoadedConfig {
  config: ResolvedConfig;
  /** Files that contributed, in increasing precedence order. */
  sources: string[];
  /** Non-fatal problems (e.g. an unresolvable secret reference). */
  warnings: string[];
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const cwd = options.cwd ?? process.cwd();
  const sources: string[] = [];
  const warnings: string[] = [];

  const files: string[] = [];
  if (options.configPath) {
    const explicit = resolve(expandHome(options.configPath));
    if (!existsSync(explicit)) {
      throw new ConfigError(`Config file not found: ${explicit}`);
    }
    files.push(explicit);
  } else {
    files.push(...globalConfigPaths().filter(existsSync));
    if (!options.ignoreProject) files.push(...projectConfigPaths(cwd).filter(existsSync));
  }

  // Later files win; objects merge deeply, everything else replaces.
  let merged: Record<string, unknown> = {};
  for (const file of files) {
    const raw = parseFile(file);
    merged = deepMerge(merged, raw);
    sources.push(file);
  }

  if (files.length === 0) {
    merged = deepMerge(defaultConfig(), merged);
  }

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid configuration${sources.length ? ` (${sources.join(", ")})` : ""}:\n${formatIssues(parsed.error)}`,
    );
  }

  return { config: materialize(parsed.data, warnings), sources, warnings };
}

/** Writes a starter config to the global location and returns its path. */
export function writeStarterConfig(overwrite = false): string {
  const target = join(configDir(), CONFIG_FILENAMES[0]!);
  if (existsSync(target) && !overwrite) {
    throw new ConfigError(`Config already exists: ${target}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, STARTER_CONFIG, "utf8");
  return target;
}

function parseFile(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    throw new ConfigError(`Cannot read ${file}: ${(cause as Error).message}`);
  }
  try {
    const parsed = parseJsonc(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("top-level value must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (cause) {
    throw new ConfigError(`Cannot parse ${file}: ${(cause as Error).message}`);
  }
}

export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = deepMerge(current, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  • ${path}: ${issue.message}`;
    })
    .join("\n");
}

function materialize(config: Config, warnings: string[]): ResolvedConfig {
  const providers: Record<string, ResolvedProviderConfig> = {};
  for (const [id, provider] of Object.entries(config.providers)) {
    let apiKey: string | undefined;
    if (provider.apiKey) {
      try {
        apiKey = resolveSecret(provider.apiKey);
      } catch (cause) {
        // A missing key for one provider must not take down the whole app;
        // the request itself will fail with a clear 401 instead.
        warnings.push(`provider "${id}": ${(cause as Error).message}`);
      }
    }
    providers[id] = {
      id,
      name: provider.name ?? id,
      type: "openai-compatible",
      baseURL: provider.baseURL,
      apiKey,
      headers: provider.headers,
      discover: provider.discover ?? true,
      models: provider.models as Record<string, ModelConfig>,
    };
  }

  const systemPrompt = loadSystemPrompt(config);

  return {
    model: config.model ?? "",
    systemPrompt,
    providers,
    permission: config.permission as PermissionConfig,
    tui: config.tui as TuiConfig,
  };
}

function loadSystemPrompt(config: Config): string | undefined {
  if (config.systemPrompt && config.systemPrompt.trim().length > 0) {
    return config.systemPrompt.trim();
  }
  if (config.systemPromptFile) {
    const file = resolve(expandHome(config.systemPromptFile));
    try {
      return readFileSync(file, "utf8").trim();
    } catch (cause) {
      throw new ConfigError(`Cannot read systemPromptFile ${file}: ${(cause as Error).message}`);
    }
  }
  return undefined;
}

/**
 * Expands `{env:VAR}` and `{file:path}` secret references. Anything else is
 * treated as a literal so configs stay readable for local, keyless endpoints.
 */
export function resolveSecret(value: string): string {
  const trimmed = value.trim();

  const env = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmed);
  if (env) {
    const name = env[1]!;
    const found = process.env[name];
    if (found === undefined) {
      throw new ConfigError(`Environment variable ${name} is not set (referenced by apiKey)`);
    }
    return found;
  }

  const file = /^\{file:(.+)\}$/.exec(trimmed);
  if (file) {
    const path = resolve(expandHome(file[1]!.trim()));
    try {
      return readFileSync(path, "utf8").trim();
    } catch (cause) {
      throw new ConfigError(`Cannot read apiKey file ${path}: ${(cause as Error).message}`);
    }
  }

  return trimmed;
}

/**
 * Out-of-the-box config. Points at a local 9router gateway when one is
 * present, and falls back to any OpenAI-compatible env vars so `buka` runs
 * without a config file at all.
 */
function defaultConfig(): Record<string, unknown> {
  const providers: Record<string, unknown> = {};

  // Prefer a local key file when one exists so `buka` works with zero setup.
  const localKey = join(homedir(), ".config", "opencode", "9router.key");
  const routerKey = existsSync(localKey) ? `{file:${localKey}}` : "{env:BUKA_9ROUTER_KEY}";

  providers["9router"] = {
    name: "9Router",
    baseURL: process.env["BUKA_9ROUTER_URL"] ?? "http://127.0.0.1:20128/v1",
    apiKey: routerKey,
    discover: true,
    models: {},
  };

  if (process.env["OPENAI_BASE_URL"] || process.env["OPENAI_API_KEY"]) {
    providers["openai"] = {
      name: "OpenAI",
      baseURL: process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1",
      apiKey: "{env:OPENAI_API_KEY}",
      discover: true,
      models: {},
    };
  }

  return {
    model: process.env["BUKA_MODEL"],
    providers,
  };
}

const STARTER_CONFIG = `{
  // buka ai configuration
  // Docs: https://github.com/ — see README
  "$schema": "https://buka.ai/config.json",

  // Default model: "provider/modelKey"
  "model": "9router/davo",

  "providers": {
    "9router": {
      "name": "9Router",
      "type": "openai-compatible",
      "baseURL": "http://127.0.0.1:20128/v1",
      // Secrets support {env:VAR} and {file:path}
      "apiKey": "{env:BUKA_9ROUTER_KEY}",
      "discover": true,
      "models": {
        "davo": {
          "id": "Davo",
          "name": "Davo (9Router Combo)",
          "tools": true,
          "reasoning": true,
          "input": ["text", "image"],
          "context": 1000000,
          "output": 128000
        }
      }
    }
  },

  "permission": {
    "read": "allow",
    "glob": "allow",
    "grep": "allow",
    "list": "allow",
    "bash": "ask",
    "write": "ask",
    "edit": "ask"
  },

  "tui": {
    "theme": "dark",
    "showThinking": true,
    "showTokenUsage": true
  }
}
`;
