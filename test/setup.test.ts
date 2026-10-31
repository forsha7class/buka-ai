/**
 * Provider setup is the first-run path, so its config writer has to be boring:
 * merge what exists, keep secrets out of the config, and produce a file the
 * normal loader can immediately use.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { loadConfig } from "../src/config/load.js";
import { PROVIDER_PRESETS, presetById } from "../src/config/providers.js";
import {
  discoverModels,
  normalizeBaseURL,
  providerIdExists,
  removeProvider,
  saveProviderSetup,
  uniqueProviderId,
  validateProviderId,
} from "../src/config/setup.js";

const OLD_XDG = process.env["XDG_CONFIG_HOME"];

describe("provider catalog", () => {
  it("has unique ids and includes 9Router plus the native adapters", () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(presetById("9router")?.name, "9Router");
    assert.equal(presetById("anthropic")?.type, "anthropic");
    assert.equal(presetById("google")?.type, "google");
    assert.equal(presetById("custom")?.custom, true);
  });
});

describe("setup validation", () => {
  it("normalizes endpoints and rejects non-http URLs", () => {
    assert.deepEqual(normalizeBaseURL(" https://example.test/v1/// "), {
      value: "https://example.test/v1",
    });
    assert.match(normalizeBaseURL("ssh://example.test")?.error ?? "", /http/);
    assert.match(normalizeBaseURL("not a url")?.error ?? "", /URL/);
  });

  it("validates provider ids", () => {
    assert.equal(validateProviderId("my-provider_2"), undefined);
    assert.match(validateProviderId("My Provider") ?? "", /lowercase/);
    assert.match(validateProviderId("-bad") ?? "", /lowercase/);
  });
});

describe("saveProviderSetup", () => {
  let home: string;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "buka-setup-"));
    process.env["XDG_CONFIG_HOME"] = join(home, "config");
  });

  after(() => {
    if (OLD_XDG === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = OLD_XDG;
  });

  it("writes a provider, a 0600 secret and a loadable config", () => {
    const configPath = join(home, "buka.jsonc");
    const result = saveProviderSetup(
      {
        providerId: "9router",
        name: "9Router",
        type: "openai-compatible",
        baseURL: "http://127.0.0.1:20128/v1/",
        apiKey: "sk-local-test",
        modelId: "Davo",
        model: {
          id: "Davo",
          name: "Davo (combo)",
          tools: true,
          reasoning: true,
          context: 1000000,
        },
      },
      { configPath },
    );

    assert.equal(result.modelRef, "9router/Davo");
    assert.ok(result.secretPath && existsSync(result.secretPath));
    assert.equal(statSync(result.secretPath!).mode & 0o777, 0o600);
    assert.equal(readFileSync(result.secretPath!, "utf8").trim(), "sk-local-test");
    assert.equal(statSync(configPath).mode & 0o777, 0o600);

    const { config } = loadConfig({ configPath });
    assert.equal(config.model, "9router/Davo");
    assert.equal(config.providers["9router"]?.type, "openai-compatible");
    assert.equal(config.providers["9router"]?.baseURL, "http://127.0.0.1:20128/v1");
    assert.equal(config.providers["9router"]?.apiKey, "sk-local-test");
    assert.equal(config.providers["9router"]?.models["Davo"]?.name, "Davo (combo)");
  });

  it("keeps native provider types in the loaded config", () => {
    const configPath = join(home, "native.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        model: "google/gemini-test",
        providers: {
          google: {
            type: "google",
            baseURL: "https://generativelanguage.googleapis.com/v1beta",
            apiKey: "test-key",
          },
        },
      }),
      "utf8",
    );
    const { config } = loadConfig({ configPath });
    assert.equal(config.providers["google"]?.type, "google");
  });

  it("merges with existing providers and settings", () => {
    const configPath = join(home, "merged.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        permission: { bash: "deny" },
        tui: { theme: "light" },
        providers: {
          other: { baseURL: "https://other.test/v1" },
        },
      }),
      "utf8",
    );
    chmodSync(configPath, 0o600);

    saveProviderSetup(
      {
        providerId: "openai",
        name: "OpenAI",
        type: "openai-compatible",
        baseURL: "https://api.openai.com/v1",
        apiKeyRef: "{env:OPENAI_API_KEY}",
        modelId: "gpt-test",
      },
      { configPath },
    );

    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.equal((raw["permission"] as Record<string, unknown>)["bash"], "deny");
    assert.equal((raw["tui"] as Record<string, unknown>)["theme"], "light");
    assert.ok((raw["providers"] as Record<string, unknown>)["other"]);
    assert.equal(raw["model"], "openai/gpt-test");
    assert.equal(providerIdExists("openai", configPath), true);
    assert.equal(uniqueProviderId("openai", configPath), "openai-2");
  });

  it("removes a provider without leaving a dangling model reference", () => {
    const configPath = join(home, "remove.jsonc");
    saveProviderSetup(
      {
        providerId: "local",
        name: "Local",
        type: "openai-compatible",
        baseURL: "http://127.0.0.1:1234/v1",
        modelId: "local-model",
      },
      { configPath },
    );
    removeProvider("local", { configPath });
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(raw["providers"], {});
    assert.equal(raw["model"], "");
  });
});

describe("discoverModels", () => {
  it("uses the provider adapter and sends the key", async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "Davo", name: "Davo", capabilities: { tools: true, reasoning: true } },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const models = await discoverModels({
        providerId: "9router",
        name: "9Router",
        type: "openai-compatible",
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: "sk-test",
      });
      assert.deepEqual(models.map((model) => model.id), ["Davo"]);
      assert.match(requests[0] ?? "", /Bearer sk-test/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
