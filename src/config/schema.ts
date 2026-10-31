import { z } from "zod";

import type { ProviderType } from "../provider/types.js";

const PermissionMode = z.enum(["ask", "allow", "deny"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

const ModelSchema = z.object({
  /** Wire id sent upstream. Defaults to the config key. */
  id: z.string().optional(),
  name: z.string().optional(),
  context: z.number().int().positive().optional(),
  output: z.number().int().positive().optional(),
  tools: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.enum(["text", "image"])).optional(),
});

export type ModelConfig = z.infer<typeof ModelSchema>;

const ProviderSchema = z.object({
  name: z.string().optional(),
  type: z.enum(["openai-compatible", "anthropic", "google"]).default("openai-compatible"),
  baseURL: z.string().min(1),
  /**
   * Literal value, or a reference: `{env:VAR}` / `{file:/path/to/key}`.
   * Resolved at load time.
   */
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** Pull the model list from the endpoint's `/models`. */
  discover: z.boolean().default(true),
  models: z.record(z.string(), ModelSchema).default({}),
});

export type ProviderConfig = z.infer<typeof ProviderSchema>;

const PermissionSchema = z.object({
  read: PermissionMode.default("allow"),
  glob: PermissionMode.default("allow"),
  grep: PermissionMode.default("allow"),
  list: PermissionMode.default("allow"),
  bash: PermissionMode.default("ask"),
  write: PermissionMode.default("ask"),
  edit: PermissionMode.default("ask"),
});

export type PermissionConfig = z.infer<typeof PermissionSchema>;

const TuiSchema = z.object({
  /** `auto` follows the terminal background; a named theme always wins. */
  theme: z
    .enum(["auto", "dark", "light", "buka", "opencode", "hermes", "classic"])
    .default("auto"),
  /** `auto` shows the sidebar only on wide terminals. */
  sidebar: z.union([z.literal("auto"), z.boolean()]).default("auto"),
  animations: z.boolean().default(true),
  /** `queue` keeps typing and running while the agent is busy. */
  busyInput: z.enum(["queue", "block"]).default("queue"),
  showThinking: z.boolean().default(true),
  showTokenUsage: z.boolean().default(true),
});

export type TuiConfig = z.infer<typeof TuiSchema>;

export const ConfigSchema = z.object({
  $schema: z.string().optional(),
  /** Default model reference: `provider/modelKey` or `provider/<raw-model-id>`. */
  model: z.string().optional(),
  providers: z.record(z.string(), ProviderSchema).default({}),
  // `prefault` (not `default`) so the nested field defaults still apply when
  // the key is absent from the config file.
  permission: PermissionSchema.prefault({}),
  tui: TuiSchema.prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Config with all defaults applied and providers materialized into plain
 * objects (zod's inference is exact but awkward to consume directly).
 */
export interface ResolvedConfig {
  model: string;
  providers: Record<string, ResolvedProviderConfig>;
  permission: PermissionConfig;
  tui: TuiConfig;
}

export interface ResolvedProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseURL: string;
  apiKey: string | undefined;
  headers: Record<string, string> | undefined;
  discover: boolean;
  models: Record<string, ModelConfig>;
}
