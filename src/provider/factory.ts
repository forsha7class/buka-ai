import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import type { Provider, ProviderConfig } from "./types.js";

/** Builds the adapter that speaks the provider's native wire protocol. */
export function createProvider(id: string, config: ProviderConfig): Provider {
  switch (config.type) {
    case "anthropic":
      return new AnthropicProvider(id, config);
    case "google":
      return new GoogleProvider(id, config);
    default:
      return new OpenAICompatProvider(id, config);
  }
}
