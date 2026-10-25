/**
 * Unit tests for the pure layers: text measurement, the input editor, argument
 * parsing, JSONC, config merging, the tool registry and provider protocol
 * decoding. Run with `npm test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hardWrap, padToWidth, stringWidth, truncateToWidth, wrapText } from "../src/tui/text.js";
import {
  backspace,
  createEditor,
  deleteWordBefore,
  editorRows,
  insertText,
  killToLineStart,
  moveEnd,
  moveHome,
  moveVertical,
  visualRows,
} from "../src/tui/editor.js";
import { reducer, initialState, type AppState } from "../src/tui/types.js";
import { markdownLines, messageToLines } from "../src/tui/blocks.js";
import { getBool, getList, getString, parseArgs } from "../src/util/args.js";
import { parseJsonc } from "../src/util/jsonc.js";
import { extractFirstJsonObject } from "../src/util/http.js";
import { deepMerge, resolveSecret } from "../src/config/load.js";
import { ToolRegistry } from "../src/agent/tools/registry.js";
import type { Tool } from "../src/agent/tools/types.js";
import { toFinishReason } from "../src/provider/openai-compat.js";

const plain = (lines: ReturnType<typeof markdownLines>): string[] =>
  lines.map((segments) => segments.map((segment) => segment.text).join(""));

describe("text", () => {
  it("measures ascii, wide and zero-width characters", () => {
    assert.equal(stringWidth("abc"), 3);
    assert.equal(stringWidth("日本"), 4);
    assert.equal(stringWidth("👋"), 2);
    assert.equal(stringWidth("e\u0301"), 1, "combining accent adds no width");
    assert.equal(stringWidth(""), 0);
  });

  it("wraps prose at word boundaries", () => {
    assert.deepEqual(wrapText("the quick brown fox", 9), ["the quick", "brown fox"]);
  });

  it("hard-breaks words that cannot fit", () => {
    assert.deepEqual(wrapText("aaaaaaaaaa", 4), ["aaaa", "aaaa", "aa"]);
  });

  it("keeps explicit newlines and blank lines", () => {
    assert.deepEqual(wrapText("a\n\nb", 10), ["a", "", "b"]);
  });

  it("never emits a line wider than the budget", () => {
    const result = wrapText("supercalifragilistic expialidocious", 7);
    for (const line of result) assert.ok(stringWidth(line) <= 7, `too wide: ${line}`);
  });

  it("hard-wraps to exact widths", () => {
    assert.deepEqual(hardWrap("abcdef", 2), ["ab", "cd", "ef"]);
  });

  it("truncates with an ellipsis inside the width", () => {
    assert.equal(truncateToWidth("abcdefgh", 5), "abcd…");
    assert.equal(stringWidth(truncateToWidth("abcdefgh", 5)), 5);
    assert.equal(truncateToWidth("abc", 5), "abc");
  });

  it("pads to an exact width", () => {
    assert.equal(padToWidth("ab", 5), "ab   ");
    assert.equal(padToWidth("abcdef", 3), "abcdef");
  });
});

describe("editor", () => {
  it("inserts at the cursor", () => {
    const state = insertText({ value: "ac", cursor: 1 }, "b");
    assert.deepEqual(state, { value: "abc", cursor: 2 });
  });

  it("supports multiline insertion", () => {
    assert.deepEqual(insertText(createEditor("ab"), "\n"), { value: "ab\n", cursor: 3 });
  });

  it("does not backspace past the start", () => {
    assert.deepEqual(backspace(createEditor("ab")), { value: "a", cursor: 1 });
    assert.deepEqual(backspace(createEditor("")), { value: "", cursor: 0 });
  });

  it("deletes the word before the cursor including trailing space", () => {
    assert.deepEqual(deleteWordBefore(createEditor("foo bar")), { value: "foo ", cursor: 4 });
    assert.deepEqual(deleteWordBefore(createEditor("foo bar ")), { value: "foo ", cursor: 4 });
  });

  it("kills to the start of the line, not the whole buffer", () => {
    // Cursor sits after the "t" of "two"; only that character dies.
    const state = { value: "one\ntwo", cursor: 5 };
    assert.deepEqual(killToLineStart(state), { value: "one\nwo", cursor: 4 });
  });

  it("moves to line home and end", () => {
    assert.deepEqual(moveHome({ value: "one\ntwo", cursor: 6 }), { value: "one\ntwo", cursor: 4 });
    assert.deepEqual(moveEnd({ value: "one\ntwo", cursor: 4 }), { value: "one\ntwo", cursor: 7 });
  });

  it("splits visual rows on newlines and wrapping", () => {
    assert.deepEqual(visualRows("ab\ncd", 10), [
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
    assert.deepEqual(visualRows("abcd", 2), [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("moves vertically while preserving the column", () => {
    const state = { value: "abc\ndef", cursor: 6 }; // on row 1, column 2
    assert.deepEqual(moveVertical(state, 10, -1), { value: "abc\ndef", cursor: 2 });
  });

  it("clamps the column when the target row is shorter", () => {
    const state = { value: "abcdef\nx", cursor: 5 };
    // The second row holds one character, so the column clamps to its end.
    assert.deepEqual(moveVertical(state, 10, 1), { value: "abcdef\nx", cursor: 8 });
  });

  it("renders rows without hard newlines", () => {
    assert.deepEqual(editorRows("ab\ncd", 10), ["ab", "cd"]);
    assert.deepEqual(editorRows("", 10), [""]);
  });
});

describe("reducer", () => {
  const base = (): AppState => initialState({ model: "m", modelRef: "p/m" });

  it("appends user and assistant messages in order", () => {
    let state = reducer(base(), { type: "user", text: "hi" });
    state = reducer(state, { type: "assistant_start" });
    assert.deepEqual(
      state.messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.equal(state.messages[1]!.streaming, true);
  });

  it("accumulates streamed text and reasoning onto the last message", () => {
    let state = reducer(base(), { type: "assistant_start" });
    state = reducer(state, { type: "delta", text: "he" });
    state = reducer(state, { type: "delta", text: "llo" });
    state = reducer(state, { type: "reasoning", text: "think" });
    assert.equal(state.messages[0]!.text, "hello");
    assert.equal(state.messages[0]!.reasoning, "think");
  });

  it("clears streaming on done", () => {
    let state = reducer(base(), { type: "assistant_start" });
    state = reducer(state, { type: "done", reason: "complete" });
    assert.equal(state.messages[0]!.streaming, false);
    assert.equal(state.status, "idle");
    assert.equal(state.lastStop, "complete");
  });

  it("tracks per-turn and cumulative token totals", () => {
    let state = reducer(base(), {
      type: "usage",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 4 },
    });
    state = reducer(state, {
      type: "usage",
      usage: { promptTokens: 20, completionTokens: 7, totalTokens: 27 },
    });
    assert.equal(state.totals.prompt, 30);
    assert.equal(state.totals.completion, 12);
    assert.equal(state.totals.cached, 4, "missing cached counts contribute zero");
  });

  it("keeps the viewport pinned while output streams", () => {
    let state = reducer(base(), { type: "user", text: "hi" });
    assert.equal(state.scroll.pinned, true);
    state = reducer(state, { type: "delta", text: "x" });
    assert.equal(state.scroll.pinned, true);
  });

  it("unpins on scroll up and clamps to the available range", () => {
    let state = reducer(base(), { type: "user", text: "hi" });
    state = reducer(state, { type: "scroll", delta: -5, maxScroll: 100 });
    assert.deepEqual(state.scroll, { pinned: false, offset: 95 });

    state = reducer(state, { type: "scroll", delta: -1000, maxScroll: 100 });
    assert.deepEqual(state.scroll, { pinned: false, offset: 0 }, "clamped at the top");
  });

  it("re-pins when scrolling back to the bottom", () => {
    let state = reducer(base(), { type: "scroll", delta: -10, maxScroll: 100 });
    state = reducer(state, { type: "scroll", delta: 10, maxScroll: 100 });
    assert.deepEqual(state.scroll, { pinned: true, offset: 100 });
  });

  it("starts scrolled from the bottom when nothing can scroll", () => {
    let state = reducer(base(), { type: "user", text: "hi" });
    state = reducer(state, { type: "scroll", delta: -5, maxScroll: 0 });
    assert.deepEqual(state.scroll, { pinned: true, offset: 0 });
  });

  it("attaches errors to the streaming message and stops it", () => {
    let state = reducer(base(), { type: "assistant_start" });
    state = reducer(state, { type: "error", message: "boom" });
    assert.equal(state.messages[0]!.error, "boom");
    assert.equal(state.messages[0]!.streaming, false);
    assert.equal(state.error, "boom");
  });

  it("records tool lifecycle", () => {
    let state = reducer(base(), { type: "assistant_start" });
    state = reducer(state, { type: "tool_start", id: "1", name: "bash", preview: "ls" });
    assert.equal(state.messages[0]!.tools[0]!.status, "running");
    state = reducer(state, { type: "tool_end", id: "1", output: "ok", isError: false, summary: "1 line" });
    assert.equal(state.messages[0]!.tools[0]!.status, "done");
    assert.equal(state.messages[0]!.tools[0]!.summary, "1 line");
    state = reducer(state, { type: "tool_end", id: "1", output: "bad", isError: true });
    assert.equal(state.messages[0]!.tools[0]!.status, "error");
  });

  it("resets the transcript but keeps the model", () => {
    let state = reducer(base(), { type: "user", text: "hi" });
    state = reducer(state, { type: "reset" });
    assert.equal(state.messages.length, 0);
    assert.equal(state.modelRef, "p/m");
  });
});

describe("markdown rendering", () => {
  it("renders fenced code without word wrapping", () => {
    const lines = plain(markdownLines("text\n```ts\nconst a = 1\n```\nmore", 40));
    assert.ok(lines.some((line) => line.includes("ts")), "language label shown");
    assert.ok(lines.some((line) => line.includes("const a = 1")));
    assert.ok(lines.some((line) => line.includes("more")));
  });

  it("keeps an unterminated code fence in code mode (streaming)", () => {
    const lines = plain(markdownLines("```\npartial line", 40));
    assert.ok(lines.some((line) => line.includes("partial line")));
  });

  it("renders bullets and headings", () => {
    const lines = plain(markdownLines("# Title\n- item", 40));
    assert.ok(lines.some((line) => line.includes("Title")));
    assert.ok(lines.some((line) => line.includes("• item")));
  });

  it("adds a cursor while streaming", () => {
    const lines = plain(markdownLines("hi", 40, true));
    assert.ok(lines[lines.length - 1]!.includes("▌"));
  });

  it("strips inline code markers but colors them", () => {
    const segments = markdownLines("use `bun` now", 40).at(-1)!;
    assert.ok(segments.some((segment) => segment.text === "bun"));
    assert.ok(!segments.some((segment) => segment.text.includes("`")));
  });
});

describe("message rendering", () => {
  it("labels the roles and keeps every line within the width", () => {
    const lines = messageToLines(
      {
        id: "1",
        role: "assistant",
        text: "x".repeat(200),
        reasoning: "",
        streaming: false,
        thinkingExpanded: false,
        tools: [],
      },
      { width: 40, showThinking: true },
    );
    const rendered = plain(lines);
    assert.ok(rendered[0]!.includes("buka"));
    for (const line of rendered) assert.ok(stringWidth(line) <= 40, `too wide: ${line}`);
  });

  it("hides thinking unless expanded", () => {
    const message = {
      id: "1",
      role: "assistant" as const,
      text: "answer",
      reasoning: "secret chain of thought",
      streaming: false,
      thinkingExpanded: false,
      tools: [],
    };
    const collapsed = plain(messageToLines(message, { width: 60, showThinking: true }));
    assert.ok(!collapsed.some((line) => line.includes("secret chain")));
    assert.ok(collapsed.some((line) => line.includes("thinking")));

    const expanded = plain(
      messageToLines({ ...message, thinkingExpanded: true }, { width: 60, showThinking: true }),
    );
    assert.ok(expanded.some((line) => line.includes("secret chain")));
  });

  it("hides tool output until expanded and hints at the keybinding", () => {
    const output = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    const message = {
      id: "1",
      role: "assistant" as const,
      text: "",
      reasoning: "",
      streaming: false,
      thinkingExpanded: false,
      tools: [
        { id: "t", name: "bash", preview: "ls", status: "done" as const, output, expanded: false },
      ],
    };
    const collapsed = plain(messageToLines(message, { width: 60, showThinking: true }));
    assert.ok(!collapsed.some((line) => line.includes("line 0")), "output stays collapsed");
    assert.ok(collapsed.some((line) => line.includes("ctrl+o")), "expansion is advertised");

    message.tools[0]!.expanded = true;
    const expanded = plain(messageToLines(message, { width: 60, showThinking: true }));
    assert.ok(expanded.some((line) => line.includes("line 0")));
    assert.ok(expanded.some((line) => line.includes("line 29")), "nothing is truncated when expanded");
  });

  it("shows a truncated preview for failed tools", () => {
    const output = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    const lines = plain(
      messageToLines(
        {
          id: "1",
          role: "assistant",
          text: "",
          reasoning: "",
          streaming: false,
          thinkingExpanded: false,
          tools: [
            { id: "t", name: "bash", preview: "ls", status: "error", output, expanded: false },
          ],
        },
        { width: 60, showThinking: true },
      ),
    );
    assert.ok(lines.some((line) => line.includes("line 0")), "errors are never hidden");
    assert.ok(lines.some((line) => line.includes("more lines")), "but are truncated");
    assert.ok(!lines.some((line) => line.includes("line 29")));
  });
});

describe("args", () => {
  const specs = [
    { name: "model", alias: "m", value: true },
    { name: "print", alias: "p", value: true },
    { name: "yolo" },
    { name: "add", value: true, repeat: true },
  ];

  it("parses long flags with = and space", () => {
    const args = parseArgs(["--model=a/b", "--print", "hi"], specs);
    assert.equal(getString(args, "model"), "a/b");
    assert.equal(getString(args, "print"), "hi");
  });

  it("parses short flags with and without values", () => {
    const args = parseArgs(["-m", "a/b", "-phello", "--yolo"], specs);
    assert.equal(getString(args, "model"), "a/b");
    assert.equal(getString(args, "print"), "hello");
    assert.equal(getBool(args, "yolo"), true);
  });

  it("collects repeated values", () => {
    const args = parseArgs(["--add", "one", "--add", "two"], specs);
    assert.deepEqual(getList(args, "add"), ["one", "two"]);
  });

  it("reports unknown flags and stops parsing at --", () => {
    const args = parseArgs(["--nope", "--", "--model"], specs);
    assert.deepEqual(args.unknown, ["--nope"]);
    assert.deepEqual(args.positionals, ["--model"]);
  });
});

describe("jsonc", () => {
  it("strips comments and trailing commas", () => {
    const source = `{
      // line comment
      "a": 1, /* block */
      "b": [1, 2,],
    }`;
    assert.deepEqual(parseJsonc(source), { a: 1, b: [1, 2] });
  });

  it("leaves comment-like text inside strings alone", () => {
    const source = '{"url": "http://x//y", "text": "a /* b */ c,}"}';
    assert.deepEqual(parseJsonc(source), { url: "http://x//y", text: "a /* b */ c,}" });
  });
});

describe("config merging", () => {
  it("merges nested objects but replaces arrays and scalars", () => {
    const merged = deepMerge(
      { model: "a", providers: { p: { baseURL: "x", models: { m: { context: 1 } } } }, list: [1] },
      { providers: { p: { baseURL: "y" } }, list: [2, 3] },
    );
    assert.equal(merged["model"], "a", "untouched keys survive");
    assert.deepEqual(
      (merged["providers"] as Record<string, Record<string, unknown>>)["p"],
      { baseURL: "y", models: { m: { context: 1 } } },
      "sibling keys inside a nested object are preserved",
    );
    assert.deepEqual(merged["list"], [2, 3]);
  });

  it("ignores explicit undefined overrides", () => {
    assert.deepEqual(deepMerge({ a: 1 }, { a: undefined }), { a: 1 });
  });
});

describe("secret resolution", () => {
  it("reads env references", () => {
    process.env["BUKA_TEST_SECRET"] = "shh";
    assert.equal(resolveSecret("{env:BUKA_TEST_SECRET}"), "shh");
    delete process.env["BUKA_TEST_SECRET"];
    assert.throws(() => resolveSecret("{env:BUKA_TEST_SECRET}"), /not set/);
  });

  it("passes literal values through", () => {
    assert.equal(resolveSecret("sk-literal"), "sk-literal");
  });
});

describe("tool registry", () => {
  const echo: Tool = {
    name: "echo",
    description: "echo",
    parameters: { type: "object" },
    summarize: (args) => `echo ${JSON.stringify(args)}`,
    execute: async (args) => ({ output: `got ${JSON.stringify(args)}`, summary: "ok" }),
  };

  it("parses empty and malformed arguments", () => {
    assert.deepEqual(ToolRegistry.parseArguments(""), {});
    assert.deepEqual(ToolRegistry.parseArguments("  "), {});
    assert.deepEqual(ToolRegistry.parseArguments('{"a":1}'), { a: 1 });
    assert.deepEqual(ToolRegistry.parseArguments("{oops"), { __raw: "{oops" });
  });

  it("reports unknown tools instead of throwing", async () => {
    const registry = new ToolRegistry([echo]);
    const execution = await registry.execute("nope", {}, context());
    assert.equal(execution.result.isError, true);
    assert.match(execution.result.output, /Unknown tool "nope"/);
    assert.match(execution.result.output, /echo/, "lists what is available");
  });

  it("runs allowed tools", async () => {
    const registry = new ToolRegistry([echo]);
    const execution = await registry.execute("echo", { a: 1 }, context(), {
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      bash: "allow",
      write: "allow",
      edit: "allow",
    });
    assert.equal(execution.result.output, 'got {"a":1}');
  });

  it("refuses denied tools without executing them", async () => {
    let ran = false;
    const denied: Tool = {
      ...echo,
      name: "bash",
      execute: async () => {
        ran = true;
        return { output: "should not happen" };
      },
    };
    const registry = new ToolRegistry([denied]);
    const execution = await registry.execute("bash", {}, context(), {
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      bash: "deny",
      write: "allow",
      edit: "allow",
    });
    assert.equal(ran, false, "a denied tool must never run");
    assert.equal(execution.result.isError, true);
    assert.match(execution.result.output, /Permission denied/);
  });

  it("asks before running prompting tools", async () => {
    const registry = new ToolRegistry([echo]);
    let asked = 0;
    const ctx = context(async () => {
      asked += 1;
      return false;
    });
    const execution = await registry.execute("echo", {}, ctx, {
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      bash: "ask",
      write: "allow",
      edit: "allow",
    });
    assert.equal(asked, 1);
    assert.equal(execution.result.isError, true);
    assert.match(execution.result.output, /denied permission/);
  });

  it("converts thrown errors into tool results", async () => {
    const registry = new ToolRegistry([
      {
        ...echo,
        execute: async () => {
          throw new Error("kaboom");
        },
      },
    ]);
    const execution = await registry.execute("echo", {}, context());
    assert.equal(execution.result.isError, true);
    assert.match(execution.result.output, /kaboom/);
  });
});

describe("provider protocol", () => {
  it("maps finish reasons onto the normalized set", () => {
    assert.equal(toFinishReason("stop"), "stop");
    assert.equal(toFinishReason("end_turn"), "stop");
    assert.equal(toFinishReason("length"), "length");
    assert.equal(toFinishReason("max_tokens"), "length");
    assert.equal(toFinishReason("tool_calls"), "tool_calls");
    assert.equal(toFinishReason(null), "unknown");
    assert.equal(toFinishReason("wat"), "unknown");
  });

  it("extracts JSON that has SSE garbage glued to the end", () => {
    // Exactly what the 9router gateway returns for a non-streaming request.
    const body = '{"id":"x","choices":[]}data: [DONE]';
    assert.deepEqual(extractFirstJsonObject(body), { id: "x", choices: [] });
  });

  it("ignores braces inside strings when extracting JSON", () => {
    assert.deepEqual(extractFirstJsonObject('{"a":"}{"} trailing'), { a: "}{" });
  });

  it("returns undefined when there is no JSON", () => {
    assert.equal(extractFirstJsonObject("data: [DONE]"), undefined);
    assert.equal(extractFirstJsonObject(""), undefined);
  });
});

function context(requestPermission?: (request: unknown) => Promise<boolean>) {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    requestPermission: requestPermission ?? (async () => true),
  } as Parameters<ToolRegistry["execute"]>[2];
}
