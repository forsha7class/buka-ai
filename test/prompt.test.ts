/**
 * System prompt resolution tests.
 *
 * The prompt is the one thing every runner sends, and it is now a file on disk
 * in the user's config directory. These pin the resolution order, the comment
 * stripping, and the seeding behaviour that makes the file discoverable.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  PROMPT_FILENAME,
  builtinPromptPath,
  resolvePrompt,
  stripComments,
  userPromptPath,
} from "../src/agent/prompt.js";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import { createDefaultTools } from "../src/agent/tools/index.js";
import { loadConfig } from "../src/config/load.js";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "buka-prompt-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fresh isolated config directory per test. */
function freshDir(): string {
  const path = join(dir, `case-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(path, { recursive: true });
  return path;
}

describe("comment stripping", () => {
  it("removes HTML comment blocks", () => {
    assert.equal(stripComments("<!-- note -->hello"), "hello");
    assert.equal(stripComments("hello<!-- note -->"), "hello");
  });

  it("removes multi-line comments, including markdown that looks like one", () => {
    const source = `<!--
      a note
      spanning lines
    -->
You are a helpful agent.`;
    assert.equal(stripComments(source), "You are a helpful agent.");
  });

  it("strips several comments and trims", () => {
    assert.equal(stripComments("  <!--a-->  keep  <!--b-->  "), "keep");
  });

  it("returns empty string for a comments-only file", () => {
    assert.equal(stripComments("<!-- nothing else -->\n\n"), "");
  });

  it("leaves angle brackets that are not comments alone", () => {
    assert.equal(stripComments("use <T> generics"), "use <T> generics");
  });
});

describe("built-in prompt", () => {
  it("exists and has real text", () => {
    assert.equal(existsSync(builtinPromptPath()), true, builtinPromptPath());
    const text = stripComments(readFileSync(builtinPromptPath(), "utf8"));
    assert.ok(text.length > 200, "the built-in prompt should be substantial");
    assert.match(text, /You are buka/);
  });

  it("does not send its own guidance header to the model", () => {
    const text = stripComments(readFileSync(builtinPromptPath(), "utf8"));
    assert.ok(!text.includes("How this file works"));
    assert.ok(!text.includes("buka --show-prompt"));
  });
});

describe("resolution order", () => {
  it("seeds the user file from the built-in default when missing", () => {
    const home = freshDir();
    const resolved = resolvePrompt({ dir: home });

    assert.equal(resolved.source, "user");
    assert.equal(resolved.path, join(home, PROMPT_FILENAME));
    assert.equal(existsSync(resolved.path), true, "the file should have been created");
    assert.ok(resolved.notes.some((note) => note.includes("created")), resolved.notes.join("; "));
  });

  it("seeded file content matches the built-in default", () => {
    const home = freshDir();
    const resolved = resolvePrompt({ dir: home });
    assert.equal(readFileSync(resolved.path, "utf8"), readFileSync(builtinPromptPath(), "utf8"));
  });

  it("uses the user file when it has text", () => {
    const home = freshDir();
    writeFileSync(join(home, PROMPT_FILENAME), "You are a custom agent.\n", "utf8");
    const resolved = resolvePrompt({ dir: home });
    assert.equal(resolved.source, "user");
    assert.equal(resolved.text, "You are a custom agent.");
  });

  it("ignores comments when deciding whether the user file has text", () => {
    const home = freshDir();
    writeFileSync(
      join(home, PROMPT_FILENAME),
      "<!-- my notes -->\nYou only speak in riddles.\n",
      "utf8",
    );
    const resolved = resolvePrompt({ dir: home });
    assert.equal(resolved.text, "You only speak in riddles.");
  });

  it("falls back to the built-in default when the user file is comments only", () => {
    const home = freshDir();
    writeFileSync(join(home, PROMPT_FILENAME), "<!-- nothing here -->\n", "utf8");
    const resolved = resolvePrompt({ dir: home });
    assert.equal(resolved.source, "builtin");
    assert.match(resolved.text, /You are buka/);
    assert.ok(
      resolved.notes.some((note) => note.includes("no prompt text")),
      resolved.notes.join("; "),
    );
  });

  it("does not write anything when seeding is disabled", () => {
    const home = freshDir();
    const resolved = resolvePrompt({ dir: home, seed: false });
    assert.equal(existsSync(join(home, PROMPT_FILENAME)), false);
    assert.equal(resolved.source, "builtin");
    assert.deepEqual(resolved.notes, []);
  });

  it("never overwrites an existing user file", () => {
    const home = freshDir();
    const path = join(home, PROMPT_FILENAME);
    writeFileSync(path, "MINE\n", "utf8");
    resolvePrompt({ dir: home });
    assert.equal(readFileSync(path, "utf8"), "MINE\n");
  });
});

describe("assembly", () => {
  it("appends the environment and the tool list to the prompt text", () => {
    const cwd = "/tmp/example-project";
    const assembled = buildSystemPrompt({
      cwd,
      tools: createDefaultTools(cwd),
      prompt: "You are a custom agent.",
    });

    assert.ok(assembled.startsWith("You are a custom agent."));
    assert.match(assembled, /Environment:/);
    assert.match(assembled, /Working directory: \/tmp\/example-project/);
    assert.match(assembled, /Project: example-project/);
    assert.match(assembled, /Available tools: read, write, edit, glob, grep, list, bash/);
  });

  it("omits the tool line when there are no tools", () => {
    const assembled = buildSystemPrompt({ cwd: "/tmp/x", prompt: "Hi." });
    assert.ok(!assembled.includes("Available tools"));
  });
});

describe("config integration", () => {
  it("keeps the built-in provider when the config only sets other keys", () => {
    const home = freshDir();
    const configPath = join(home, "buka.jsonc");
    writeFileSync(configPath, '{ "permission": { "bash": "deny" } }', "utf8");

    const { config } = loadConfig({ configPath });
    assert.ok(
      Object.keys(config.providers).length > 0,
      "a partial config must not wipe out the provider fallback",
    );
    assert.equal(config.permission.bash, "deny");
  });

  it("lets a config define its own providers", () => {
    const home = freshDir();
    const configPath = join(home, "buka.jsonc");
    writeFileSync(
      configPath,
      '{ "providers": { "mine": { "baseURL": "https://example.test/v1" } } }',
      "utf8",
    );

    const { config } = loadConfig({ configPath });
    assert.deepEqual(Object.keys(config.providers), ["mine"]);
  });

  it("warns about the removed systemPrompt keys instead of ignoring them", () => {
    const home = freshDir();
    const configPath = join(home, "buka.jsonc");
    writeFileSync(
      configPath,
      '{ "systemPrompt": "old style", "providers": { "p": { "baseURL": "https://x.test/v1" } } }',
      "utf8",
    );

    const { warnings } = loadConfig({ configPath });
    assert.ok(
      warnings.some((warning) => warning.includes("systemPrompt") && warning.includes(PROMPT_FILENAME)),
      warnings.join("; "),
    );
  });

  it("warns about systemPromptFile too", () => {
    const home = freshDir();
    const configPath = join(home, "buka.jsonc");
    writeFileSync(
      configPath,
      '{ "systemPromptFile": "./AGENTS.md", "providers": { "p": { "baseURL": "https://x.test/v1" } } }',
      "utf8",
    );

    const { warnings } = loadConfig({ configPath });
    assert.ok(warnings.some((warning) => warning.includes("systemPromptFile")), warnings.join("; "));
  });

  it("does not warn for a config that never used those keys", () => {
    const home = freshDir();
    const configPath = join(home, "buka.jsonc");
    writeFileSync(configPath, '{ "model": "p/m" }', "utf8");
    const { warnings } = loadConfig({ configPath });
    assert.deepEqual(warnings, []);
  });
});

describe("user prompt path", () => {
  it("lives in the config directory", () => {
    process.env["XDG_CONFIG_HOME"] = "/tmp/xdg-probe";
    try {
      assert.equal(userPromptPath(), "/tmp/xdg-probe/buka-ai/SYSTEM_PROMPT.md");
    } finally {
      delete process.env["XDG_CONFIG_HOME"];
    }
  });
});
