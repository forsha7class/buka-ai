import type { ProviderType } from "../provider/types.js";

/**
 * The provider list shown by first-run setup and `/provider`.
 *
 * Everything here is either a native adapter (`anthropic`, `google`) or an
 * OpenAI-compatible endpoint. The custom entry is a sentinel, not a real
 * provider id.
 */
export interface ProviderPreset {
  id: string;
  name: string;
  type: ProviderType;
  /** Prefilled endpoint. Empty for the custom sentinel. */
  baseURL: string;
  /** Conventional environment variable for this provider's key. */
  apiKeyEnv?: string;
  /** Additional env names checked when pre-filling a key. */
  apiKeyEnvAliases?: string[];
  /** Local gateways may not require a key. */
  keyOptional?: boolean;
  custom?: boolean;
  description: string;
}

export const CUSTOM_PROVIDER_ID = "custom";

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "9router",
    name: "9Router",
    type: "openai-compatible",
    baseURL: "http://127.0.0.1:20128/v1",
    apiKeyEnv: "BUKA_9ROUTER_KEY",
    keyOptional: true,
    description: "local or self-hosted gateway",
  },
  {
    id: "openai",
    name: "OpenAI",
    type: "openai-compatible",
    baseURL: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    description: "api.openai.com",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    type: "openai-compatible",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    description: "one key for many models",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    type: "anthropic",
    baseURL: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    description: "Claude models, native API",
  },
  {
    id: "google",
    name: "Google Gemini",
    type: "google",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnv: "GEMINI_API_KEY",
    apiKeyEnvAliases: ["GOOGLE_API_KEY"],
    description: "Gemini models, native API",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    type: "openai-compatible",
    baseURL: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    description: "api.deepseek.com",
  },
  {
    id: "groq",
    name: "Groq",
    type: "openai-compatible",
    baseURL: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    description: "fast inference",
  },
  {
    id: "xai",
    name: "xAI",
    type: "openai-compatible",
    baseURL: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    description: "Grok models",
  },
  {
    id: "mistral",
    name: "Mistral",
    type: "openai-compatible",
    baseURL: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    description: "api.mistral.ai",
  },
  {
    id: "together",
    name: "Together AI",
    type: "openai-compatible",
    baseURL: "https://api.together.xyz/v1",
    apiKeyEnv: "TOGETHER_API_KEY",
    description: "open models",
  },
  {
    id: "fireworks",
    name: "Fireworks",
    type: "openai-compatible",
    baseURL: "https://api.fireworks.ai/inference/v1",
    apiKeyEnv: "FIREWORKS_API_KEY",
    description: "open models",
  },
  {
    id: "ollama",
    name: "Ollama",
    type: "openai-compatible",
    baseURL: "http://127.0.0.1:11434/v1",
    keyOptional: true,
    description: "local models",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    type: "openai-compatible",
    baseURL: "http://127.0.0.1:1234/v1",
    keyOptional: true,
    description: "local models",
  },
  {
    id: CUSTOM_PROVIDER_ID,
    name: "Custom",
    type: "openai-compatible",
    baseURL: "",
    keyOptional: true,
    custom: true,
    description: "any OpenAI-compatible endpoint",
  },
];

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function isCustomPreset(preset: ProviderPreset): boolean {
  return preset.custom === true;
}

/** The first environment variable that has a value for this preset. */
export function presetEnv(preset: ProviderPreset): { name: string; value: string } | undefined {
  for (const name of [preset.apiKeyEnv, ...(preset.apiKeyEnvAliases ?? [])]) {
    if (!name) continue;
    const value = process.env[name];
    if (value !== undefined && value.trim().length > 0) {
      return { name, value: value.trim() };
    }
  }
  return undefined;
}
