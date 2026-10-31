import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { parseJsonc } from "../util/jsonc.js";
import { createProvider } from "../provider/factory.js";
import type { ModelInfo, ProviderType } from "../provider/types.js";
import { CONFIG_FILENAMES, configDir, expandHome } from "./paths.js";
import { presetById, presetEnv } from "./providers.js";
import { resolveSecret } from "./load.js";

export interface ProviderSetupInput {
  providerId: string;
  name: string;
  type: ProviderType;
  baseURL: string;
  modelId: string;
  /** Plaintext key typed in setup. Written to a 0600 secret file. */
  apiKey?: string;
  /** Existing `{env:VAR}` / `{file:...}` reference. */
  apiKeyRef?: string;
  /** Metadata discovered from `/models`, when available. */
  model?: ModelInfo;
}

export interface ProviderSetupResult {
  configPath: string;
  modelRef: string;
  secretPath?: string;
}

export interface SaveProviderOptions {
  /** Write to this file instead of the global `buka.jsonc`. */
  configPath?: string;
}

export interface NineRouterDefaults {
  baseURL: string;
  apiKey?: string;
  source?: string;
}

const DEFAULT_9ROUTER_URL = "http://127.0.0.1:20128/v1";

/**
 * Finds a usable 9Router endpoint/key on this machine. Setup only uses this to
 * pre-fill the form: the user still confirms it, and can point at a different
 * 9Router or paste their own key.
 */
export function detect9RouterDefaults(): NineRouterDefaults {
  let baseURL = process.env["BUKA_9ROUTER_URL"]?.trim();
  let apiKey = process.env["BUKA_9ROUTER_KEY"]?.trim();
  let source = apiKey ? "$BUKA_9ROUTER_KEY" : undefined;

  if (!baseURL || !apiKey) {
    // A previous buka setup is the most specific source: re-running setup
    // should not silently replace a self-hosted URL with the preset default.
    for (const file of CONFIG_FILENAMES) {
      const path = join(configDir(), file);
      const raw = readConfigObject(path);
      const providers = raw && isObject(raw["providers"]) ? raw["providers"] : undefined;
      const router = providers && isObject(providers["9router"]) ? providers["9router"] : undefined;
      if (!router) continue;
      if (!baseURL && typeof router["baseURL"] === "string") baseURL = router["baseURL"];
      const stored = router["apiKey"];
      if (!apiKey && typeof stored === "string") {
        try {
          apiKey = resolveSecret(stored);
          source = `buka config (${path})`;
        } catch {
          // Keep looking at key files.
        }
      }
      break;
    }
  }

  const opencodeConfig = join(homedir(), ".config", "opencode", "opencode.json");
  if (existsSync(opencodeConfig)) {
    try {
      const raw = parseJsonc(readFileSync(opencodeConfig, "utf8")) as Record<string, unknown>;
      const providers = isObject(raw["providers"]) ? raw["providers"] : raw["provider"];
      const router = isObject(providers) && isObject(providers["9router"]) ? providers["9router"] : undefined;
      const settings = router && isObject(router["settings"]) ? router["settings"] : router;
      if (settings) {
        const configURL = settings["baseURL"];
        if (!baseURL && typeof configURL === "string" && configURL.trim().length > 0) {
          baseURL = configURL.trim();
        }
        const configKey = settings["apiKey"];
        if (!apiKey && typeof configKey === "string" && configKey.trim().length > 0) {
          try {
            apiKey = resolveSecret(configKey);
            source = `OpenCode config (${opencodeConfig})`;
          } catch {
            // A dangling reference is not fatal; setup can still ask for a key.
          }
        }
      }
    } catch {
      // Ignore malformed OpenCode configs; this is only a convenience.
    }
  }

  if (!apiKey) {
    for (const path of [
      join(homedir(), ".config", "opencode", "9router-api-key"),
      join(homedir(), ".config", "opencode", "9router.key"),
      "/opt/9router/api-key.txt",
    ]) {
      if (!existsSync(path)) continue;
      try {
        const value = readFileSync(path, "utf8").trim();
        if (value.length > 0) {
          apiKey = value;
          source = path;
          break;
        }
      } catch {
        // Try the next location.
      }
    }
  }

  return {
    baseURL: baseURL && baseURL.length > 0 ? baseURL : DEFAULT_9ROUTER_URL,
    ...(apiKey ? { apiKey } : {}),
    ...(source ? { source } : {}),
  };
}

/** Validates a user-entered endpoint, returning the normalized form. */
export function normalizeBaseURL(raw: string): { value?: string; error?: string } {
  const value = raw.trim().replace(/\/+$/, "");
  if (value.length === 0) return { error: "Endpoint is required" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: "Endpoint must be a complete URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "Endpoint must start with http:// or https://" };
  }
  return { value };
}

export function validateProviderId(id: string): string | undefined {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    return "Use lowercase letters, numbers, - or _ (starting with a letter or number)";
  }
  return undefined;
}

export function providerConfigPath(configPath?: string): string {
  return configPath ? resolve(expandHome(configPath)) : join(configDir(), CONFIG_FILENAMES[0]!);
}

export interface ExistingProviderDefaults {
  name?: string;
  baseURL?: string;
  apiKey?: string;
  keySource?: string;
}

/** Reuses the provider's current endpoint/key when setup is run again. */
export function existingProviderDefaults(
  id: string,
  configPath?: string,
): ExistingProviderDefaults {
  const raw = readConfigObject(providerConfigPath(configPath));
  const providers = raw && isObject(raw["providers"]) ? raw["providers"] : undefined;
  const provider = providers && isObject(providers[id]) ? providers[id] : undefined;
  if (!provider) return {};

  const out: ExistingProviderDefaults = {};
  if (typeof provider["name"] === "string") out.name = provider["name"];
  if (typeof provider["baseURL"] === "string") out.baseURL = provider["baseURL"];
  const stored = provider["apiKey"];
  if (typeof stored === "string" && stored.trim().length > 0) {
    try {
      out.apiKey = resolveSecret(stored);
      out.keySource = stored.startsWith("{") ? `${providerConfigPath(configPath)}` : "existing config";
    } catch {
      // Keep the endpoint; setup can ask for a fresh key.
    }
  }
  return out;
}

export function providerIdExists(id: string, configPath?: string): boolean {
  const raw = readConfigObject(providerConfigPath(configPath));
  const providers = raw && isObject(raw["providers"]) ? raw["providers"] : undefined;
  return Boolean(providers && Object.prototype.hasOwnProperty.call(providers, id));
}

export function uniqueProviderId(base: string, configPath?: string): string {
  const clean = base.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "custom";
  if (!providerIdExists(clean, configPath)) return clean;
  for (let index = 2; index < 1000; index++) {
    const candidate = `${clean}-${index}`;
    if (!providerIdExists(candidate, configPath)) return candidate;
  }
  return `${clean}-${Date.now()}`;
}

export interface DiscoverOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Talks to the provider's `/models` endpoint using the real adapter, so
 * validation exercises the same auth and wire format the chat request will.
 */
export async function discoverModels(
  input: Pick<ProviderSetupInput, "providerId" | "name" | "type" | "baseURL" | "apiKey" | "apiKeyRef">,
  options: DiscoverOptions = {},
): Promise<ModelInfo[]> {
  const preset = presetById(input.providerId);
  const env = preset ? presetEnv(preset) : undefined;
  let apiKey = input.apiKey?.trim();
  if (!apiKey && input.apiKeyRef) {
    try {
      apiKey = resolveSecret(input.apiKeyRef);
    } catch {
      apiKey = undefined;
    }
  }
  if (!apiKey && env) apiKey = env.value;

  const provider = createProvider(input.providerId, {
    name: input.name,
    type: input.type,
    baseURL: input.baseURL,
    ...(apiKey ? { apiKey } : {}),
    discover: true,
    models: {},
  });

  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

  try {
    return await provider.listModels(controller.signal);
  } catch (cause) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new Error(`Timed out after ${Math.round((options.timeoutMs ?? 10_000) / 1000)}s`);
    }
    throw cause;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Writes a provider entry and the selected model into the global config,
 * merging with whatever is already there. The API key is stored in a 0600
 * secret file rather than in the config itself.
 */
export function saveProviderSetup(
  input: ProviderSetupInput,
  options: SaveProviderOptions = {},
): ProviderSetupResult {
  const idError = validateProviderId(input.providerId);
  if (idError) throw new Error(`Invalid provider id "${input.providerId}": ${idError}`);

  const base = normalizeBaseURL(input.baseURL);
  if (base.error || !base.value) throw new Error(base.error ?? "Invalid endpoint");
  if (input.modelId.trim().length === 0) throw new Error("Model id is required");

  const configPath = providerConfigPath(options.configPath);
  const existing = readConfigObject(configPath);
  if (existing === undefined && existsSync(configPath)) {
    throw new Error(`Cannot parse existing config: ${configPath}`);
  }
  const config = existing ?? {};
  const rawProviders = config["providers"];
  const providers: Record<string, unknown> = isObject(rawProviders) ? { ...rawProviders } : {};
  const rawPrevious = providers[input.providerId];
  const previous: Record<string, unknown> = isObject(rawPrevious) ? rawPrevious : {};

  let apiKey = typeof previous["apiKey"] === "string" ? previous["apiKey"] : input.apiKeyRef;
  let secretPath: string | undefined;
  if (input.apiKey && input.apiKey.trim().length > 0) {
    secretPath = writeSecret(input.providerId, input.apiKey.trim());
    apiKey = `{file:${secretPath}}`;
  } else if (input.apiKeyRef) {
    apiKey = input.apiKeyRef;
  } else if (!apiKey) {
    const preset = presetById(input.providerId);
    const env = preset ? presetEnv(preset) : undefined;
    if (env) apiKey = `{env:${env.name}}`;
  }

  const models = isObject(previous["models"]) ? { ...previous["models"] } : {};
  models[input.modelId] = modelConfig(input.modelId, input.model);

  const provider: Record<string, unknown> = {
    ...previous,
    name: input.name,
    type: input.type,
    baseURL: base.value,
    discover: true,
    models,
  };
  if (apiKey) provider["apiKey"] = apiKey;
  else delete provider["apiKey"];

  providers[input.providerId] = provider;
  const next: Record<string, unknown> = {
    ...config,
    model: `${input.providerId}/${input.modelId}`,
    providers,
  };

  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  if (existsSync(configPath)) {
    try {
      writeFileSync(`${configPath}.bak`, readFileSync(configPath), { mode: 0o600 });
    } catch {
      // A backup is a convenience; failing to make one must not block setup.
    }
  }
  const temporary = `${configPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, configPath);
  chmodSync(configPath, 0o600);

  return {
    configPath,
    modelRef: `${input.providerId}/${input.modelId}`,
    ...(secretPath ? { secretPath } : {}),
  };
}

/** Removes a provider from the config. */
export function removeProvider(id: string, options: SaveProviderOptions = {}): string {
  const configPath = providerConfigPath(options.configPath);
  const existing = readConfigObject(configPath);
  if (existing === undefined && existsSync(configPath)) {
    throw new Error(`Cannot parse existing config: ${configPath}`);
  }
  const config = existing ?? {};
  const providers = isObject(config["providers"]) ? { ...config["providers"] } : {};
  delete providers[id];

  const current = typeof config["model"] === "string" ? config["model"] : "";
  const model = current.startsWith(`${id}/`) ? "" : current;

  const next = { ...config, providers, model };
  const temporary = `${configPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, configPath);
  chmodSync(configPath, 0o600);
  return configPath;
}

function writeSecret(id: string, value: string): string {
  const dir = join(configDir(), "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, `${id}.key`);
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function modelConfig(id: string, model?: ModelInfo): Record<string, unknown> {
  const out: Record<string, unknown> = { id };
  if (!model) return out;
  if (model.name) out["name"] = model.name;
  if (typeof model.context === "number") out["context"] = model.context;
  if (typeof model.output === "number") out["output"] = model.output;
  if (typeof model.tools === "boolean") out["tools"] = model.tools;
  if (typeof model.reasoning === "boolean") out["reasoning"] = model.reasoning;
  if (model.input) out["input"] = model.input;
  return out;
}

function readConfigObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = parseJsonc(readFileSync(path, "utf8")) as unknown;
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
