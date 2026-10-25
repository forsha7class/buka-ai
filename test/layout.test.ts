/**
 * Layout invariant tests.
 *
 * The TUI slices a fixed number of display rows to implement scrolling, so the
 * single hardest requirement is: **one Line must render as exactly one row**.
 * These tests render the real components with Ink's `renderToString` and assert
 * that no row ever wraps past the terminal width or spills onto a second line.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "ink";

import { Header, LineList, ModelPicker, PromptInput, StatusBar } from "../src/tui/components.js";
import { markdownLines, messageToLines } from "../src/tui/blocks.js";
import { editorRows, createEditor, insertText } from "../src/tui/editor.js";
import { initialState, type AppState, type Line } from "../src/tui/types.js";
import { stringWidth } from "../src/tui/text.js";

const ANSI = /\u001b\[[0-9;?]*[a-zA-Z]/g;
const plain = (text: string): string => text.replace(ANSI, "");

function state(overrides: Partial<AppState> = {}): AppState {
  return { ...initialState({ model: "M", modelRef: "p/m" }), ...overrides };
}

const WIDTHS = [40, 60, 80, 100, 132];

describe("header", () => {
  for (const width of WIDTHS) {
    it(`stays on one line at ${width} columns`, () => {
      const rendered = plain(
        renderToString(
          Header({
            state: state({ model: "deepseek-v4.1-flash" }),
            width,
            session: "Use the bash tool to run `echo permission-check`. Then reply with the output.",
          }),
          { columns: width },
        ),
      );
      assert.equal(rendered.split("\n").length, 1, "header must not wrap");
      assert.ok(stringWidth(rendered) <= width, `header too wide: ${stringWidth(rendered)} > ${width}`);
    });
  }

  it("never truncates the status indicator", () => {
    for (const width of WIDTHS) {
      const rendered = plain(
        renderToString(
          Header({
            state: state({ model: "deepseek-v4.1-flash", status: "thinking" }),
            width,
            session: "a very long session title that should be the first thing to give way",
          }),
          { columns: width },
        ),
      );
      assert.ok(
        rendered.includes("● thinking"),
        `status truncated at ${width}: ${JSON.stringify(rendered)}`,
      );
    }
  });

  it("shows the model reference and token totals", () => {
    const rendered = plain(
      renderToString(
        Header({
          state: state({
            model: "deepseek-v4.1-flash",
            totals: { prompt: 4000, completion: 500, cached: 3100 },
          }),
          width: 100,
        }),
        { columns: 100 },
      ),
    );
    assert.match(rendered, /p\/m/);
    assert.match(rendered, /deepseek-v4\.1-flash/);
    assert.match(rendered, /4\.5k tok/);
    assert.match(rendered, /3\.1k cached/);
  });
});

describe("status bar", () => {
  for (const width of [30, 60, 100]) {
    it(`stays on one line at ${width} columns`, () => {
      const rendered = plain(
        renderToString(
          StatusBar({
            state: state({ turn: 12, lastStop: "max-turns" }),
            width,
            hint: "Enter send · Alt+Enter newline · Ctrl+P sessions · /help",
          }),
          { columns: width },
        ),
      );
      assert.equal(rendered.split("\n").length, 1);
      assert.ok(stringWidth(rendered) <= width);
    });
  }
});

describe("line list", () => {
  it("renders exactly the requested number of rows", () => {
    const lines: Line[] = Array.from({ length: 40 }, (_, index) => [
      { text: `line ${index} ${"x".repeat(120)}`, style: { color: "#ffffff" } },
    ]);
    for (const width of WIDTHS) {
      const rendered = plain(renderToString(LineList({ lines, offset: 10, height: 12 }), { columns: width }));
      const renderedRows = rendered.split("\n");
      assert.equal(renderedRows.length, 12, `expected 12 rows at width ${width}`);
      for (const row of renderedRows) {
        assert.ok(stringWidth(row) <= width, `row overflowed at ${width}: ${stringWidth(row)}`);
      }
    }
  });
});

describe("prompt input", () => {
  it("renders one row per visual row of the editor", () => {
    const width = 40;
    let editor = createEditor();
    for (let index = 0; index < 5; index++) editor = insertText(editor, `line ${index}\n`);

    const expected = editorRows(editor.value, width - 2).length;
    const rendered = plain(
      renderToString(PromptInput({ editor, width, placeholder: "hi", disabled: false }), {
        columns: width,
      }),
    );
    assert.equal(rendered.split("\n").length, expected);
  });

  it("fits very long unbroken input inside the width", () => {
    const width = 40;
    const editor = createEditor("y".repeat(500));
    const rendered = plain(
      renderToString(PromptInput({ editor, width, placeholder: "hi", disabled: false }), {
        columns: width,
      }),
    );
    for (const row of rendered.split("\n")) {
      assert.ok(stringWidth(row) <= width, `row overflowed: ${stringWidth(row)}`);
    }
  });

  it("shows the placeholder when empty", () => {
    const rendered = plain(
      renderToString(
        PromptInput({ editor: createEditor(), width: 60, placeholder: "ask buka", disabled: false }),
        { columns: 60 },
      ),
    );
    assert.match(rendered, /ask buka/);
  });
});

describe("model picker", () => {
  it("does not wrap rows even with long references and details", () => {
    const items = [
      { reference: "9router/@cf/meta/llama-3.2-1b-instruct", detail: "tools reasoning vision" },
      { reference: "9router/Hr/claude-sonnet-4.6", detail: "tools reasoning" },
    ];
    for (const width of WIDTHS) {
      const rendered = plain(renderToString(ModelPicker({ items, index: 1, width }), { columns: width }));
      // Two border rows, one title row, then one row per item.
      assert.equal(rendered.split("\n").length, items.length + 3, `unexpected row count at ${width}`);
      for (const row of rendered.split("\n")) {
        assert.ok(stringWidth(row) <= width, `row overflowed at ${width}: ${JSON.stringify(row)}`);
      }
    }
  });

  it("marks the selected item", () => {
    const rendered = plain(
      renderToString(
        ModelPicker({
          items: [
            { reference: "a", detail: "" },
            { reference: "b", detail: "" },
          ],
          index: 1,
          width: 60,
        }),
        { columns: 60 },
      ),
    );
    assert.match(rendered, /▸ *b/);
  });
});

describe("message rendering fits the viewport", () => {
  it("keeps every rendered line inside the width, for all content kinds", () => {
    const message = {
      id: "1",
      role: "assistant" as const,
      text: [
        "# Heading that is quite long and should wrap cleanly",
        "",
        "Prose with `inline code` and **bold** and *italic* text that goes on and on and on.",
        "",
        "- a bullet item that is long enough to need wrapping at narrow widths",
        "  - nested deeper",
        "",
        "> a blockquote that also needs to wrap",
        "",
        "```ts",
        "const veryLongIdentifier = someFunction(argumentOne, argumentTwo, argumentThree);",
        "```",
      ].join("\n"),
      reasoning: "chain of thought that is hidden by default but must still fit when expanded",
      streaming: true,
      thinkingExpanded: true,
      tools: [
        {
          id: "t1",
          name: "bash",
          preview: "a very long command preview that should be truncated",
          status: "error" as const,
          output: `short\n${"z".repeat(300)}`,
          expanded: true,
        },
      ],
    };

    for (const width of [40, 60, 100]) {
      const lines = messageToLines(message, { width, showThinking: true });
      const rendered = plain(renderToString(LineList({ lines, offset: 0, height: lines.length }), { columns: width }));
      for (const row of rendered.split("\n")) {
        assert.ok(
          stringWidth(row) <= width,
          `row overflowed at ${width} (${stringWidth(row)}): ${JSON.stringify(row)}`,
        );
      }
    }
  });

  it("produces one display line per Line object", () => {
    const lines = markdownLines("para one\n\npara two\n\n```\ncode\n```", 40);
    const rendered = plain(renderToString(LineList({ lines, offset: 0, height: lines.length }), { columns: 40 }));
    assert.equal(rendered.split("\n").length, lines.length);
  });
});
