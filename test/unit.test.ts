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
import { reducer, initialState, messageReasoning, messageText, messageTools, type AppState } from "../src/tui/types.js";
import { markdownLines, messageToLines } from "../src/tui/blocks.js";
import { assistant, compaction, text, thinking, tool } from "./helpers.js";
import { getBool, getList, getString, parseArgs } from "../src/util/args.js";
import { parseJsonc } from "../src/util/jsonc.js";
import { extractFirstJsonObject } from "../src/util/http.js";
import { simpleDiff, diffStats } from "../src/agent/tools/diff.js";
import { extractChangedFiles } from "../src/tui/changes.js";
import {
  THEMES,
  currentTheme,
  palette,
  resolveTheme,
  setActiveTheme,
  themeById,
} from "../src/tui/theme.js";
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
    const message = state.messages[0]!;
    assert.equal(messageText(message), "hello");
    assert.equal(messageReasoning(message), "think");
    // A reasoning burst that arrives after text starts a new part rather than
    // being merged into the text.
    assert.deepEqual(
      message.parts.map((part) => part.kind),
      ["text", "thinking"],
    );
  });

  it("keeps parts in the order the model produced them", () => {
    let state = reducer(base(), { type: "assistant_start" });
    state = reducer(state, { type: "reasoning", text: "why" });
    state = reducer(state, { type: "delta", text: "let me look" });
    state = reducer(state, { type: "tool_start", id: "c1", name: "bash", preview: "ls" });
    state = reducer(state, { type: "tool_end", id: "c1", output: "ok", isError: false });
    state = reducer(state, { type: "reasoning", text: "now I know" });
    state = reducer(state, { type: "delta", text: "done" });

    const message = state.messages[0]!;
    assert.deepEqual(
      message.parts.map((part) => part.kind),
      ["thinking", "text", "tool", "thinking", "text"],
      "grouping by kind would reorder the work",
    );
    assert.equal(messageText(message), "let me look\n\ndone");
    assert.equal(messageReasoning(message), "why\nnow I know");
    assert.equal(messageTools(message).length, 1);
  });

  it("ignores empty deltas so parts do not multiply", () => {
    let state = reducer(base(), { type: "assistant_start" });
    state = reducer(state, { type: "delta", text: "" });
    state = reducer(state, { type: "delta", text: "" });
    assert.equal(state.messages[0]!.parts.length, 0);
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
    assert.equal(messageTools(state.messages[0]!)[0]!.status, "running");

    state = reducer(state, {
      type: "tool_end",
      id: "1",
      output: "ok",
      isError: false,
      summary: "1 line",
    });
    assert.equal(messageTools(state.messages[0]!)[0]!.status, "done");
    assert.equal(messageTools(state.messages[0]!)[0]!.summary, "1 line");

    state = reducer(state, { type: "tool_end", id: "1", output: "bad", isError: true });
    assert.equal(messageTools(state.messages[0]!)[0]!.status, "error");
  });

  it("toggles a tool only inside its own message", () => {
    let state = reducer(base(), { type: "assistant_start" });
    state = reducer(state, { type: "tool_start", id: "same", name: "bash", preview: "ls" });
    state = reducer(state, { type: "tool_end", id: "same", output: "one", isError: false });
    const firstId = state.messages[0]!.id;

    state = reducer(state, { type: "assistant_start" });
    state = reducer(state, { type: "tool_start", id: "same", name: "bash", preview: "ls" });
    state = reducer(state, { type: "tool_end", id: "same", output: "two", isError: false });

    state = reducer(state, { type: "toggle_tool", messageId: firstId, id: "same" });

    assert.equal(messageTools(state.messages[0]!)[0]!.expanded, true);
    assert.equal(
      messageTools(state.messages[1]!)[0]!.expanded,
      false,
      "a repeated tool id in another message must not be affected",
    );
  });

  it("appends a compaction marker as its own message", () => {
    let state = reducer(base(), { type: "user", text: "hi" });
    state = reducer(state, { type: "compacted", summary: "did some things" });
    assert.equal(state.messages.length, 2);
    assert.equal(state.messages[1]!.role, "compact");
    assert.equal(messageText(state.messages[1]!), "did some things");
  });

  it("resets the transcript but keeps the model", () => {
    let state = reducer(base(), { type: "user", text: "hi" });
    state = reducer(state, { type: "reset" });
    assert.equal(state.messages.length, 0);
    assert.equal(state.modelRef, "p/m");
  });

  it("queues messages typed while the agent is running", () => {
    let state = reducer(base(), { type: "queue_add", text: "first" });
    state = reducer(state, { type: "queue_add", text: "second" });
    assert.deepEqual(state.queued, ["first", "second"]);

    state = reducer(state, { type: "queue_shift" });
    assert.deepEqual(state.queued, ["second"]);

    state = reducer(state, { type: "queue_add", text: "third" });
    state = reducer(state, { type: "queue_remove", index: 0 });
    assert.deepEqual(state.queued, ["third"]);
  });

  it("drops the queue when the session is reset", () => {
    let state = reducer(base(), { type: "queue_add", text: "later" });
    state = reducer(state, { type: "reset" });
    assert.deepEqual(state.queued, []);
  });

  it("keeps a tool's measured duration on the block", () => {
    let state = reducer(base(), { type: "assistant_start" });
    state = reducer(state, { type: "tool_start", id: "t1", name: "bash", preview: "npm test" });
    state = reducer(state, {
      type: "tool_end",
      id: "t1",
      output: "ok",
      isError: false,
      summary: "exit code 0",
      durationMs: 1240,
    });
    assert.equal(messageTools(state.messages[0]!)[0]!.durationMs, 1240);
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
  const opts = { width: 60, showThinking: true };

  it("labels the roles and keeps every line within the width", () => {
    const lines = messageToLines(assistant([text("x".repeat(200))]), { width: 40, showThinking: true });
    const rendered = plain(lines);
    assert.ok(rendered[0]!.includes("buka"));
    for (const line of rendered) assert.ok(stringWidth(line) <= 40, `too wide: ${line}`);
  });

  it("renders parts in order, interleaving text and tools", () => {
    const rendered = plain(
      messageToLines(
        assistant([
          thinking("I should look at what files exist before deciding anything."),
          text("let me look"),
          tool({ id: "c1", name: "bash", preview: "ls", output: "a\nb" }),
          text("all done"),
        ]),
        opts,
      ),
    );

    const thinkingIndex = rendered.findIndex((line) => line.includes("thinking"));
    const firstText = rendered.findIndex((line) => line.includes("let me look"));
    const toolIndex = rendered.findIndex((line) => line.includes("bash"));
    const secondText = rendered.findIndex((line) => line.includes("all done"));

    assert.ok(thinkingIndex >= 0 && firstText >= 0 && toolIndex >= 0 && secondText >= 0);
    assert.ok(
      thinkingIndex < firstText && firstText < toolIndex && toolIndex < secondText,
      `expected chronological order, got ${JSON.stringify({ thinkingIndex, firstText, toolIndex, secondText })}`,
    );
  });

  it("hides thinking unless expanded", () => {
    const secret = "The route replies 200 even when the store returns undefined, so the fix belongs in the store.";
    const message = assistant([thinking(secret), text("answer")]);
    const collapsed = plain(messageToLines(message, opts));
    assert.ok(!collapsed.some((line) => line.includes("The route replies")));
    assert.ok(collapsed.some((line) => line.includes("thinking")));

    const expanded = plain(messageToLines({ ...message, thinkingExpanded: true }, opts));
    assert.ok(expanded.some((line) => line.includes("The route replies")));
  });

  it("elides throwaway thinking bursts but keeps substantial ones", () => {
    const short = assistant([thinking("checking the file"), text("answer")]);
    const shortRendered = plain(messageToLines(short, opts));
    assert.ok(
      !shortRendered.some((line) => line.includes("thinking")),
      "a 17-char burst is noise, not a transcript entry",
    );

    const long = assistant([
      thinking(
        "The route always replies 200, so I need to make the store throw and let the handler translate that into a 404.",
      ),
      text("answer"),
    ]);
    assert.ok(plain(messageToLines(long, opts)).some((line) => line.includes("thinking")));
  });

  it("hides tool output until expanded and hints at the keybinding", () => {
    const output = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    const collapsedMessage = assistant([tool({ id: "t", name: "bash", output, expanded: false })]);
    const collapsed = plain(messageToLines(collapsedMessage, opts));
    assert.ok(!collapsed.some((line) => line.includes("line 0")), "output stays collapsed");
    assert.ok(collapsed.some((line) => line.includes("ctrl+o")), "expansion is advertised");

    const expandedMessage = assistant([tool({ id: "t", name: "bash", output, expanded: true })]);
    const expanded = plain(messageToLines(expandedMessage, opts));
    assert.ok(expanded.some((line) => line.includes("line 0")));
    assert.ok(expanded.some((line) => line.includes("line 29")), "nothing is truncated when expanded");
  });

  it("shows a truncated preview for failed tools", () => {
    const output = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    const lines = plain(
      messageToLines(assistant([tool({ id: "t", name: "bash", output, status: "error" })]), opts),
    );
    assert.ok(lines.some((line) => line.includes("line 0")), "errors are never hidden");
    assert.ok(lines.some((line) => line.includes("more lines")), "but are truncated");
    assert.ok(!lines.some((line) => line.includes("line 29")));
  });

  it("draws a cursor when a streaming turn has no text yet", () => {
    const rendered = plain(messageToLines(assistant([], { streaming: true }), opts));
    assert.ok(rendered.some((line) => line.includes("▌")));
  });

  it("renders a compaction as a divider with the summary", () => {
    const summary = "Refactored auth and added tests.";
    const rendered = plain(messageToLines(compaction(summary), opts));
    assert.ok(rendered.some((line) => line.includes("context compacted")));
    assert.ok(rendered.some((line) => line.includes("Refactored auth")));
    assert.ok(
      rendered.some((line) => line.includes(`${summary.length} chars summarised`)),
      "the divider reports how much was folded away",
    );
  });

  it("strips markdown markers from the compaction preview", () => {
    const rendered = plain(
      messageToLines(compaction("## Findings\n- one\n* two\n### Detail"), opts),
    );
    assert.ok(!rendered.some((line) => line.includes("##")), "no raw heading markers");
    assert.ok(rendered.some((line) => line.includes("Findings")));
    assert.ok(rendered.some((line) => line.includes("• one")));
    assert.ok(rendered.some((line) => line.includes("• two")));
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

describe("diff", () => {
  it("returns nothing when the text is unchanged", () => {
    assert.equal(simpleDiff("same\n", "same\n", "a.ts"), "");
  });

  it("shows the changed lines with a unified header", () => {
    const diff = simpleDiff("one\ntwo\nthree\n", "one\nTWO\nthree\n", "a.ts");
    assert.match(diff, /^--- a\/a\.ts$/m);
    assert.match(diff, /^\+\+\+ b\/a\.ts$/m);
    assert.match(diff, /^@@/m);
    assert.match(diff, /^-two$/m);
    assert.match(diff, /^\+TWO$/m);
    assert.match(diff, /^ three$/m, "keeps context");
  });

  it("counts additions and removals without counting the file headers", () => {
    const stats = diffStats(simpleDiff("a\nb\n", "a\nc\nd\n", "a.ts"));
    assert.deepEqual(stats, { added: 2, removed: 1 });
  });

  it("treats a brand-new file as additions only", () => {
    const diff = simpleDiff("", "first\nsecond\n", "new.ts");
    assert.match(diff, /^\+first$/m);
    assert.match(diff, /^\+second$/m);
    assert.deepEqual(diffStats(diff), { added: 2, removed: 0 });
  });

  it("caps very large diffs", () => {
    const before = "same\n";
    const after = `same\n${Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n")}`;
    const diff = simpleDiff(before, after, "big.ts");
    assert.ok(diff.split("\n").length <= 161, "diff should be capped");
    assert.match(diff, /truncated/);
  });
});

describe("themes", () => {
  it("ships complete palettes", () => {
    for (const [id, theme] of Object.entries(THEMES)) {
      assert.equal(theme.id, id);
      for (const [key, value] of Object.entries(theme.colors)) {
        assert.match(value, /^#[0-9a-f]{6}$/i, `${id}.${key} should be a hex colour`);
      }
    }
  });

  it("resolves names, aliases and the light-background hint", () => {
    assert.equal(resolveTheme("opencode").id, "opencode");
    assert.equal(resolveTheme("dark").id, "buka");
    assert.equal(resolveTheme("nope").id, "buka");
    assert.equal(resolveTheme(undefined, { COLORFGBG: "0;15" }).id, "light");
    assert.equal(resolveTheme(undefined, { COLORFGBG: "15;0" }).id, "buka");
    assert.equal(resolveTheme(undefined, { BUKA_THEME: "hermes" }).id, "hermes");
    // An explicit choice beats the environment.
    assert.equal(resolveTheme("classic", { BUKA_THEME: "hermes" }).id, "classic");
  });

  it("exposes the active theme through the live palette and restores it", () => {
    const previous = currentTheme();
    try {
      const hermes = themeById("hermes")!;
      setActiveTheme(hermes);
      assert.equal(palette.accent, hermes.colors.accent);
      assert.equal(palette.panel, hermes.colors.panel);
    } finally {
      setActiveTheme(previous);
    }
    assert.equal(palette.accent, previous.colors.accent);
  });
});

describe("changed files", () => {
  it("deduplicates and keeps the most recent edits", () => {
    const message = (id: string, preview: string) =>
      assistant([tool({ id, name: "edit", preview })]);
    const state = reducer(initialState({ model: "m", modelRef: "p/m" }), {
      type: "seed",
      model: "m",
      modelRef: "p/m",
      messages: [
        message("a", "src/a.ts  (all occurrences)"),
        message("b", "src/b.ts  (12 lines)"),
        message("c", "src/a.ts  (all occurrences)"),
        message("d", "src/c.ts"),
        message("e", "src/d.ts"),
        message("f", "src/e.ts"),
        message("g", "src/f.ts"),
      ],
    });
    assert.deepEqual(extractChangedFiles(state), [
      "src/a.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
      "src/f.ts",
    ]);
  });
});
