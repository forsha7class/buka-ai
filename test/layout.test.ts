/**
 * Layout invariant tests.
 *
 * The TUI slices a fixed number of display rows to implement scrolling, so the
 * single hardest requirement is: **one Line must render as exactly one row**,
 * and the panes must add up to the terminal height exactly. These tests render
 * the real components with Ink's `renderToString` and assert both.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "ink";
import { createElement } from "react";

import { LineList } from "../src/tui/components.js";
import { Composer, TuiView, type TuiViewProps } from "../src/tui/chrome.js";
import { completionLines, dialogLines } from "../src/tui/dialogs.js";
import { computeLayout, sidebarWidth } from "../src/tui/layout.js";
import { markdownLines, messageToLines } from "../src/tui/blocks.js";
import { assistant, text, thinking, tool } from "./helpers.js";
import { createEditor, editorRows, insertText } from "../src/tui/editor.js";
import { initialState, type AppState, type Line } from "../src/tui/types.js";
import { stringWidth } from "../src/tui/text.js";

const ANSI = /\u001b\[[0-9;?]*[a-zA-Z]/g;
const plain = (value: string): string => value.replace(ANSI, "");

const WIDTHS = [40, 60, 80, 99, 100, 132, 160];
const ROWS = 30;

function state(overrides: Partial<AppState> = {}): AppState {
  return { ...initialState({ model: "M", modelRef: "p/m" }), ...overrides };
}

function viewProps(overrides: Partial<TuiViewProps> = {}): TuiViewProps {
  const columns = overrides.layout?.columns ?? 120;
  const rows = overrides.layout?.rows ?? ROWS;
  const layout = overrides.layout ?? computeLayout({ columns, rows, editorRows: 1 });
  const lines: Line[] =
    overrides.lines ??
    Array.from({ length: layout.transcript }, (_, index) => [
      { text: `line ${index} ${"x".repeat(200)}`, style: { color: "#ffffff" } },
    ]);
  return {
    state: state({ model: "deepseek-v4.1-flash", totals: { prompt: 12_400, completion: 800, cached: 100 } }),
    layout,
    lines,
    offset: Math.max(0, lines.length - layout.transcript),
    editor: createEditor(),
    sessionTitle: "Fix the flaky users test",
    cwd: "/root/buka-ai",
    version: "0.3.0",
    toolCount: 7,
    contextWindow: 128_000,
    changedFiles: ["src/tui/app.tsx", "src/tui/chrome.tsx"],
    dialog: null,
    completing: null,
    hint: "enter send · alt+enter newline · ctrl+p palette · /help",
    spinnerTick: 0,
    runStartedAt: null,
    now: Date.now(),
    showTokens: true,
    ...overrides,
  };
}

describe("layout arithmetic", () => {
  it("makes the panes add up to exactly the terminal height", () => {
    for (const width of WIDTHS) {
      for (const rows of [12, 24, 30, 50]) {
        const layout = computeLayout({ columns: width, rows, editorRows: 1 });
        assert.equal(
          layout.topBar + layout.transcript + layout.queue + layout.completion + layout.composer + layout.status,
          rows,
          `panes do not fill ${width}x${rows}`,
        );
      }
    }
  });

  it("shows the sidebar only on wide terminals by default", () => {
    assert.equal(sidebarWidth(99, "auto"), 0);
    assert.equal(sidebarWidth(100, "auto"), 28);
    assert.equal(sidebarWidth(160, "auto"), 32);
    assert.equal(sidebarWidth(60, true), 0);
    assert.equal(sidebarWidth(120, false), 0);
  });

  it("keeps a sane transcript when the composer grows", () => {
    const layout = computeLayout({ columns: 120, rows: 24, editorRows: 6 });
    assert.ok(layout.transcript >= 3, `transcript collapsed: ${layout.transcript}`);
  });
});

describe("full screen", () => {
  for (const width of WIDTHS) {
    it(`renders ${width}x${ROWS} with no row wider than the terminal`, () => {
      const layout = computeLayout({ columns: width, rows: ROWS, editorRows: 1 });
      const rendered = plain(
        renderToString(createElement(TuiView, viewProps({ layout })), { columns: width }),
      );
      const rows = rendered.split("\n");
      assert.equal(rows.length, ROWS, `expected ${ROWS} rows at ${width}, got ${rows.length}`);
      for (const row of rows) {
        assert.ok(stringWidth(row) <= width, `row overflowed at ${width}: ${stringWidth(row)} ${JSON.stringify(row)}`);
      }
    });
  }

  it("shows the sidebar on wide terminals and hides it on narrow ones", () => {
    const wide = plain(
      renderToString(
        createElement(TuiView, viewProps({ layout: computeLayout({ columns: 120, rows: ROWS, editorRows: 1 }) })),
        { columns: 120 },
      ),
    );
    assert.match(wide, /terminal coding agent/);

    const narrow = plain(
      renderToString(
        createElement(TuiView, viewProps({ layout: computeLayout({ columns: 80, rows: ROWS, editorRows: 1 }) })),
        { columns: 80 },
      ),
    );
    assert.doesNotMatch(narrow, /terminal coding agent/);
  });

  it("renders the banner on an empty transcript", () => {
    const layout = computeLayout({ columns: 100, rows: ROWS, editorRows: 1 });
    const rendered = plain(
      renderToString(createElement(TuiView, viewProps({ layout, lines: [] })), { columns: 100 }),
    );
    assert.match(rendered, /terminal coding agent/);
    assert.match(rendered, /p\/m/);
  });

  it("renders a dialog instead of the transcript when one is open", () => {
    const layout = computeLayout({ columns: 100, rows: ROWS, editorRows: 1 });
    const rendered = plain(
      renderToString(
        createElement(
          TuiView,
          viewProps({
            layout,
            dialog: {
              title: "select model",
              subtitle: "1",
              filter: "",
              items: [{ reference: "9router/davo", detail: "tools reasoning" }],
              index: 0,
              hint: "enter select · esc close",
              empty: "none",
            },
          }),
        ),
        { columns: 100 },
      ),
    );
    const rows = rendered.split("\n");
    assert.equal(rows.length, ROWS);
    assert.match(rendered, /select model/);
    for (const row of rows) assert.ok(stringWidth(row) <= 100, `dialog row overflowed: ${stringWidth(row)}`);
  });

  it("keeps the queue strip and permission box inside the width", () => {
    const layout = computeLayout({
      columns: 100,
      rows: ROWS,
      editorRows: 1,
      queuedRows: 1,
      permission: true,
    });
    const rendered = plain(
      renderToString(
        createElement(
          TuiView,
          viewProps({
            layout,
            state: state({ queued: ["run the tests too"], pendingPermission: { tool: "bash", preview: "npm test" } }),
          }),
        ),
        { columns: 100 },
      ),
    );
    assert.match(rendered, /queued/);
    assert.match(rendered, /permission required/);
    for (const row of rendered.split("\n")) {
      assert.ok(stringWidth(row) <= 100, `row overflowed: ${stringWidth(row)}`);
    }
  });
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

describe("composer", () => {
  it("fits long unbroken input and grows with the editor", () => {
    const width = 60;
    const editor = createEditor("y".repeat(500));
    const rendered = plain(renderToString(Composer({ editor, width, disabled: false }), { columns: width }));
    const rows = rendered.split("\n");
    // The composer scrolls internally past six rows.
    assert.equal(rows.length, Math.min(editorRows(editor.value, width - 4).length, 6) + 2);
    for (const row of rows) assert.ok(stringWidth(row) <= width, `row overflowed: ${stringWidth(row)}`);
  });

  it("shows the placeholder when empty", () => {
    const rendered = plain(
      renderToString(Composer({ editor: createEditor(), width: 60, disabled: false }), { columns: 60 }),
    );
    assert.match(rendered, /ask buka/);
  });

  it("keeps many visual rows on one row each", () => {
    const width = 40;
    let editor = createEditor();
    for (let index = 0; index < 4; index++) editor = insertText(editor, `line ${index}\n`);
    const rendered = plain(renderToString(Composer({ editor, width, disabled: false }), { columns: width }));
    assert.equal(rendered.split("\n").length, editorRows(editor.value, width - 4).length + 2);
  });
});

describe("dialogs", () => {
  it("renders exactly the requested height with no overflow", () => {
    const items = [
      { reference: "9router/@cf/meta/llama-3.2-1b-instruct", detail: "tools reasoning vision" },
      { reference: "9router/Hr/claude-sonnet-4.6", detail: "tools reasoning" },
    ];
    for (const width of [40, 60, 100]) {
      const lines = dialogLines(
        {
          title: "select model",
          subtitle: `${items.length}`,
          filter: "",
          items,
          index: 1,
          hint: "enter select · esc close",
          empty: "none",
        },
        width,
        18,
      );
      assert.equal(lines.length, 18, `wrong height at ${width}`);
      const rendered = plain(renderToString(LineList({ lines, offset: 0, height: 18 }), { columns: width }));
      for (const row of rendered.split("\n")) {
        assert.ok(stringWidth(row) <= width, `dialog overflowed at ${width}: ${stringWidth(row)}`);
      }
      assert.match(rendered, /▸/);
    }
  });

  it("lists completions with one border row each", () => {
    const lines = completionLines(
      [
        { reference: "/model", detail: "switch model" },
        { reference: "/models", detail: "list every model" },
      ],
      0,
      60,
    );
    assert.equal(lines.length, 4);
    const rendered = plain(renderToString(LineList({ lines, offset: 0, height: lines.length }), { columns: 60 }));
    assert.match(rendered, /commands/);
    assert.match(rendered, /\/model/);
  });
});

describe("message rendering fits the viewport", () => {
  it("keeps every rendered line inside the width, for all content kinds", () => {
    const message = assistant(
      [
        thinking("chain of thought that is hidden by default but must still fit when expanded"),
        text(
          [
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
            "",
            "```diff",
            "-removed line",
            "+added line",
            "```",
          ].join("\n"),
        ),
        tool({
          id: "t1",
          name: "bash",
          preview: "a very long command preview that should be truncated",
          status: "error",
          output: `short\n${"z".repeat(300)}`,
          expanded: true,
        }),
      ],
      { streaming: true, thinkingExpanded: true },
    );

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

  it("renders an edit diff preview without overflowing", () => {
    const message = assistant([
      tool({
        id: "d1",
        name: "edit",
        preview: "src/a.ts",
        status: "done",
        summary: "1 replacement",
        diff: [
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1,3 +1,3 @@",
          " one",
          "-two",
          "+TWO",
          " three",
        ].join("\n"),
      }),
    ]);
    for (const width of [40, 80]) {
      const lines = messageToLines(message, { width, showThinking: true });
      const rendered = plain(renderToString(LineList({ lines, offset: 0, height: lines.length }), { columns: width }));
      assert.match(rendered, /\+TWO/);
      assert.match(rendered, /\+1 −1/);
      for (const row of rendered.split("\n")) {
        assert.ok(stringWidth(row) <= width, `diff row overflowed at ${width}: ${stringWidth(row)}`);
      }
    }
  });

  it("gives the user turn a full-width block", () => {
    const lines = messageToLines(
      { id: "u1", role: "user", parts: [{ kind: "text", text: "hello there" }], streaming: false, thinkingExpanded: false },
      { width: 40, showThinking: true },
    );
    assert.ok(lines.every((lineItem) => stringWidth(lineItem.map((segment) => segment.text).join("")) <= 40));
  });
});
