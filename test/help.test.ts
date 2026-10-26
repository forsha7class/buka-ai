/**
 * Documentation drift guard.
 *
 * The keybind tables in the in-app `/help` and in the README are hand-written,
 * so they silently fall behind the actual handlers. They did: `Ctrl+D`,
 * `Ctrl+G`, `Home` and `End` were implemented and undocumented until this test
 * was added.
 *
 * Rather than trying to parse prose, this reads the real handler code, extracts
 * every `key.ctrl && input === "x"` binding, and requires each one to appear in
 * both places a user might look.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { HELP_TEXT } from "../src/tui/app.js";

const root = fileURLToPath(new URL("..", import.meta.url));

const APP_SOURCE = readFileSync(`${root}src/tui/app.tsx`, "utf8");
const README = readFileSync(`${root}README.md`, "utf8");

/** Every control+letter binding the key handler actually implements. */
function implementedCtrlKeys(): string[] {
  const keys = new Set<string>();
  for (const match of APP_SOURCE.matchAll(/key\.ctrl && input === "([a-z])"/g)) {
    keys.add(match[1]!.toUpperCase());
  }
  return [...keys].sort();
}

describe("keybinding documentation", () => {
  const keys = implementedCtrlKeys();

  it("finds the implemented bindings", () => {
    assert.ok(keys.length >= 10, `expected a real set of bindings, got ${keys.join(",")}`);
    for (const expected of ["K", "P", "T", "O", "L", "C"]) {
      assert.ok(keys.includes(expected), `Ctrl+${expected} should be bound in app.tsx`);
    }
  });

  it("documents every implemented binding in the in-app /help", () => {
    const missing = keys.filter((key) => !HELP_TEXT.includes(`Ctrl+${key}`));
    assert.deepEqual(
      missing,
      [],
      `implemented but missing from HELP_TEXT: ${missing.map((key) => `Ctrl+${key}`).join(", ")}`,
    );
  });

  it("documents every implemented binding in the README keybind table", () => {
    const table = README.slice(
      README.indexOf("### Keybindings"),
      README.indexOf("### Slash commands"),
    );
    assert.ok(table.length > 0, "the README should have a keybindings section");
    const missing = keys.filter((key) => !table.includes(`Ctrl+${key}`));
    assert.deepEqual(
      missing,
      [],
      `implemented but missing from the README table: ${missing.map((key) => `Ctrl+${key}`).join(", ")}`,
    );
  });

  it("lists every key that the handler binds for scrolling and navigation", () => {
    for (const name of ["PgUp", "PgDn", "Enter", "Esc"]) {
      assert.ok(HELP_TEXT.includes(name), `/help should mention ${name}`);
      assert.ok(README.includes(name), `README should mention ${name}`);
    }
    // Home/End are bound too.
    assert.ok(HELP_TEXT.includes("Home / End"));
    assert.ok(README.includes("Home") && README.includes("End"));
  });
});

describe("slash command documentation", () => {
  it("documents every slash command the dispatcher handles", () => {
    const dispatchStart = APP_SOURCE.indexOf("function handleSlashCommand");
    const dispatchEnd = APP_SOURCE.indexOf("function relativeTime");
    const body = APP_SOURCE.slice(dispatchStart, dispatchEnd);

    const handled = new Set<string>();
    for (const match of body.matchAll(/case "([a-z]+)":/g)) {
      handled.add(match[1]!);
    }
    // Aliases that intentionally share one entry, and the fallback branch.
    const aliases: Record<string, string> = { quit: "exit" };
    const documented = new Set(
      [...HELP_TEXT.matchAll(/^\s+\/([a-z]+)/gm)].map((match) => match[1]!),
    );

    const missing = [...handled]
      .map((command) => aliases[command] ?? command)
      .filter((command) => !documented.has(command));

    assert.deepEqual(missing, [], `handled but undocumented: ${missing.join(", ")}`);
  });

  it("does not document a command that is not handled", () => {
    const dispatchStart = APP_SOURCE.indexOf("function handleSlashCommand");
    const dispatchEnd = APP_SOURCE.indexOf("function relativeTime");
    const body = APP_SOURCE.slice(dispatchStart, dispatchEnd);

    const documented = [...HELP_TEXT.matchAll(/^\s+\/([a-z]+)/gm)].map((match) => match[1]!);
    const missing = documented.filter((command) => !body.includes(`case "${command}":`));
    assert.deepEqual(missing, [], `documented but not handled: ${missing.join(", ")}`);
  });
});
