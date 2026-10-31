import { createProvider } from "./factory.js";
import type { ModelConfig, ModelInfo, Provider, ProviderConfig } from "./types.js";

export class ModelNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelNotFoundError";
  }
}

/** A provider instance plus the config it was built from. */
export interface ProviderEntry {
  id: string;
  name: string;
  provider: Provider;
  config: ProviderConfig;
}

export interface ResolvedModel {
  providerId: string;
  provider: Provider;
  /** Key or id the user typed, after the provider prefix. */
  key: string;
  /** The id actually sent on the wire. */
  modelId: string;
  modelName: string;
  config: ModelConfig | undefined;
}

export class ProviderRegistry {
  private readonly entries = new Map<string, ProviderEntry>();
  /** Cached `/models` results, populated lazily by `discover`. */
  private readonly discovered = new Map<string, ModelInfo[]>();

  constructor(configs: Record<string, ProviderConfig>) {
    this.replaceAll(configs);
  }

  /** Replaces every provider, used after setup rewrites the config. */
  replaceAll(configs: Record<string, ProviderConfig>): void {
    this.entries.clear();
    this.discovered.clear();
    for (const [id, config] of Object.entries(configs)) {
      this.entries.set(id, {
        id,
        name: config.name ?? id,
        provider: createProvider(id, config),
        config,
      });
    }
  }

  list(): ProviderEntry[] {
    return [...this.entries.values()];
  }

  get(id: string): ProviderEntry | undefined {
    return this.entries.get(id);
  }

  providerIds(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Resolves a `provider/modelKey` reference.
   *
   * Only the *first* slash is treated as the separator, because model ids
   * legitimately contain slashes (`Hr/claude-sonnet-4.6`,
   * `@cf/meta/llama-3.2-1b-instruct`). Anything after the first slash is
   * looked up in the provider's `models` map, and falls back to being used
   * verbatim as the wire id.
   */
  resolve(reference: string): ResolvedModel {
    const slash = reference.indexOf("/");
    if (slash <= 0) {
      throw new ModelNotFoundError(
        `Model reference must look like "provider/model", got "${reference}"`,
      );
    }

    const providerId = reference.slice(0, slash);
    const key = reference.slice(slash + 1);
    const entry = this.entries.get(providerId);
    if (!entry) {
      throw new ModelNotFoundError(
        `Unknown provider "${providerId}". Known providers: ${this.providerIds().join(", ") || "(none)"}`,
      );
    }
    if (key.length === 0) {
      throw new ModelNotFoundError(`Missing model name in "${reference}"`);
    }

    const config = entry.config.models?.[key];
    return {
      providerId,
      provider: entry.provider,
      key,
      modelId: config?.id ?? key,
      modelName: config?.name ?? config?.id ?? key,
      config,
    };
  }

  /** Model list from a provider's `/models` endpoint, cached per provider. */
  async discover(providerId: string): Promise<ModelInfo[]> {
    const cached = this.discovered.get(providerId);
    if (cached) return cached;

    const entry = this.entries.get(providerId);
    if (!entry) throw new ModelNotFoundError(`Unknown provider "${providerId}"`);

    const models = await entry.provider.listModels();
    this.discovered.set(providerId, models);
    return models;
  }

  /**
   * Every selectable model reference, with configured models taking priority
   * over discovered ones. Discovery failures are swallowed — an offline
   * gateway should not stop the TUI from opening.
   */
  async listModels(options: { includeDiscovered?: boolean } = {}): Promise<
    Array<{ reference: string; providerId: string; providerName: string; info: ModelInfo }>
  > {
    const includeDiscovered = options.includeDiscovered ?? true;
    const out: Array<{
      reference: string;
      providerId: string;
      providerName: string;
      info: ModelInfo;
    }> = [];

    for (const entry of this.entries.values()) {
      const seen = new Set<string>();

      for (const [key, model] of Object.entries(entry.config.models ?? {})) {
        seen.add(key);
        out.push({
          reference: `${entry.id}/${key}`,
          providerId: entry.id,
          providerName: entry.name,
          info: {
            id: model.id ?? key,
            name: model.name ?? key,
            context: model.context,
            output: model.output,
            tools: model.tools,
            reasoning: model.reasoning,
            input: model.input,
          },
        });
      }

      if (!includeDiscovered || entry.config.discover === false) continue;

      let discovered: ModelInfo[] = [];
      try {
        discovered = await this.discover(entry.id);
      } catch {
        discovered = [];
      }
      for (const model of discovered) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        out.push({
          reference: `${entry.id}/${model.id}`,
          providerId: entry.id,
          providerName: entry.name,
          info: model,
        });
      }
    }

    return out;
  }

  /** All models across providers that advertise tool support. */
  async toolCapableModels(): Promise<Array<{ reference: string; info: ModelInfo }>> {
    const all = await this.listModels();
    return all.map(({ reference, info }) => ({ reference, info }));
  }
}
