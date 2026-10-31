import { loadConfig, type LoadConfigOptions } from "./config/load.js";
import type { ResolvedConfig, ResolvedProviderConfig } from "./config/schema.js";
import { resolvePrompt, type ResolvedPrompt } from "./agent/prompt.js";
import { buildSystemPrompt } from "./agent/system-prompt.js";
import { createDefaultTools } from "./agent/tools/index.js";
import { ModelNotFoundError, ProviderRegistry, type ResolvedModel } from "./provider/registry.js";
import type { ProviderConfig } from "./provider/types.js";

export interface RuntimeOptions {
  /** `--model provider/model`, overriding the config default. */
  model?: string;
  configPath?: string;
  cwd?: string;
  ignoreProject?: boolean;
  /**
   * Create `~/.config/buka-ai/SYSTEM_PROMPT.md` from the built-in default when
   * it is missing. Off for read-only subcommands like `models` / `sessions`.
   */
  seedPrompt?: boolean;
}

export interface Runtime {
  config: ResolvedConfig;
  registry: ProviderRegistry;
  model: ResolvedModel;
  /** Explicit config path, when the user passed `--config`. */
  configPath?: string;
  /** Assembled system prompt — the single prompt every runner uses. */
  systemPrompt: string;
  /** Where that prompt came from, for `--show-prompt` and diagnostics. */
  promptSource: ResolvedPrompt;
  /** Config files that contributed, in increasing precedence order. */
  sources: string[];
  warnings: string[];
  /** Notes about automatic decisions (e.g. a model chosen by discovery). */
  notes: string[];
  /** Re-read config and rebuild providers after setup changes it. */
  reload(): void;
}

/**
 * Wires config + provider registry + the selected model together. Everything
 * that needs "what model are we talking to" goes through here so the TUI, the
 * print runner and future subcommands all behave identically.
 *
 * When no model is configured, the first reachable provider is queried and its
 * first tool-capable model is selected — so a fresh install pointing at a local
 * gateway works with no configuration at all.
 */
export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const loadOptions: LoadConfigOptions = {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.ignoreProject !== undefined ? { ignoreProject: options.ignoreProject } : {}),
  };
  const loaded = loadConfig(loadOptions);
  const config = loaded.config;
  const providerConfigs = toProviderConfigs(config.providers);
  const registry = new ProviderRegistry(providerConfigs);
  const notes: string[] = [];

  const prompt = resolvePrompt({ seed: options.seedPrompt ?? true });
  notes.push(...prompt.notes);

  // Assembled once here so every runner sends the identical system message.
  const sessionCwd = options.cwd ?? process.cwd();
  const tools = createDefaultTools(sessionCwd);

  const requested = options.model ?? config.model;
  let reference = requested ?? "";

  // A bare provider id (or no model at all) means "pick one for me".
  if (reference === "" || !reference.includes("/")) {
    const providerId = reference === "" ? undefined : reference;
    reference = await autoSelectModel(registry, config.providers, providerId);
    notes.push(`auto-selected model ${reference}`);
  }

  const runtime: Runtime = {
    config,
    registry,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    model: registry.resolve(reference),
    systemPrompt: buildSystemPrompt({ cwd: sessionCwd, tools, prompt: prompt.text }),
    promptSource: prompt,
    sources: loaded.sources,
    warnings: loaded.warnings,
    notes,
    reload: () => {
      const next = loadConfig(loadOptions);
      runtime.config = next.config;
      runtime.sources = next.sources;
      runtime.warnings = next.warnings;
      runtime.registry.replaceAll(toProviderConfigs(next.config.providers));
    },
  };

  return runtime;
}

function toProviderConfigs(
  providers: Record<string, ResolvedProviderConfig>,
): Record<string, ProviderConfig> {
  const configs: Record<string, ProviderConfig> = {};
  for (const [id, provider] of Object.entries(providers)) {
    configs[id] = toProviderConfig(provider);
  }
  return configs;
}

async function autoSelectModel(
  registry: ProviderRegistry,
  providers: Record<string, ResolvedProviderConfig>,
  providerId?: string,
): Promise<string> {
  if (registry.providerIds().length === 0) {
    throw new Error(
      "No providers configured. Run `buka setup` to add one, or add a `providers` entry to your config.",
    );
  }

  const candidateIds = providerId !== undefined ? [providerId] : registry.providerIds();
  const failures: string[] = [];

  for (const id of candidateIds) {
    if (!registry.get(id)) {
      throw new ModelNotFoundError(
        `Unknown provider "${id}". Known providers: ${registry.providerIds().join(", ")}`,
      );
    }

    const configured = Object.keys(providers[id]?.models ?? {});
    if (configured.length > 0) return `${id}/${configured[0]}`;

    try {
      const models = await registry.discover(id);
      if (models.length === 0) {
        failures.push(`${id}: endpoint returned no models`);
        continue;
      }
      const preferred =
        models.find((model) => model.tools === true) ?? models.find((model) => model.tools !== false) ?? models[0]!;
      return `${id}/${preferred.id}`;
    } catch (cause) {
      failures.push(`${id}: ${(cause as Error).message}`);
    }
  }

  throw new Error(
    `Could not choose a model automatically.\n${failures.map((line) => `  • ${line}`).join("\n")}\n` +
      `Run \`buka setup\`, pass --model provider/model, or set "model" in your config.`,
  );
}

function toProviderConfig(provider: ResolvedProviderConfig): ProviderConfig {
  return {
    name: provider.name,
    type: provider.type,
    baseURL: provider.baseURL,
    ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
    ...(provider.headers !== undefined ? { headers: provider.headers } : {}),
    discover: provider.discover,
    models: provider.models,
  };
}
