/**
 * Produces a README screenshot from a genuine session.
 *
 * Drives a real <App /> run against a fixture project, then re-renders the
 * *same presentational components* with the *real final state* captured from
 * that run. Re-rendering instead of replaying raw ANSI keeps the output exact:
 * no terminal emulator has to guess how Ink wrapped and repainted lines.
 *
 * Usage: npx tsx test/capture.ts <cwd> <prompt> [cols] [rows]
 */
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Box, Text, render, renderToString } from "ink";
import { createElement, type ReactNode } from "react";

import { createRuntime } from "../src/runtime.js";
import { SessionStore } from "../src/session/store.js";
import { App } from "../src/tui/app.js";
import { messagesToLines } from "../src/tui/blocks.js";
import { Header, LineList, PromptInput, StatusBar } from "../src/tui/components.js";
import { createEditor, editorRows } from "../src/tui/editor.js";
import { initialState, palette, type AppState } from "../src/tui/types.js";

/** Absorbs output: this run exists only to produce state. */
class Sink extends Writable {
  columns: number;
  rows: number;
  isTTY = true;

  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

class FakeStdin extends PassThrough {
  isTTY = true;
  setRawMode(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const [cwd = process.cwd(), prompt = "hello", colsArg, rowsArg] = process.argv.slice(2);
  const columns = Number(colsArg ?? 100);
  const rows = Number(rowsArg ?? 30);

  const stdout = new Sink(columns, rows);
  const stdin = new FakeStdin();
  const runtime = await createRuntime({ cwd });
  // Throwaway session store so a capture never touches the developer's history.
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "buka-capture-")));

  let status = "idle";
  let started = false;
  let latest: AppState = initialState({ model: "", modelRef: "" });
  let sessionTitle: string | undefined;

  const app = render(
    createElement(App, {
      runtime,
      cwd,
      store,
      yolo: true,
      onState: (state) => {
        latest = state;
        status = state.status;
        if (state.status !== "idle") started = true;
      },
    }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
      maxFps: 30,
    },
  );

  await delay(400);
  const session = store.list()[0];
  sessionTitle = session?.title;
  stdin.write(prompt);
  await delay(400);
  stdin.write("\r");

  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline && !started) await delay(100);
  while (Date.now() < deadline && status !== "idle") await delay(150);

  app.unmount();

  // Re-render the final state through the real components, twice: once at the
  // top of the transcript (shows the prompt and the first tool calls) and once
  // pinned to the bottom (shows the result). One run, two README frames.
  const showThinking = runtime.config.tui.showThinking;
  const lines = messagesToLines(latest.messages, { width: columns, showThinking });
  const inputRows = Math.min(Math.max(1, editorRows("", columns - 2).length), 6);
  const messageHeight = Math.max(3, rows - 3 - inputRows);
  const maxScroll = Math.max(0, lines.length - messageHeight);

  const renderFrame = (offset: number): string =>
    renderToString(
      createElement(
        Box,
        { flexDirection: "column", width: columns, height: rows },
        createElement(Header, { state: latest, width: columns, session: sessionTitle }),
        createElement(
          Box,
          { flexDirection: "column", height: messageHeight, overflow: "hidden" },
          createElement(LineList, { lines, offset, height: messageHeight }),
        ),
        createElement(Text, { color: palette.border }, "─".repeat(Math.max(1, columns))),
        createElement(PromptInput, {
          editor: createEditor(),
          width: columns,
          placeholder: "ask buka to do something, or /help",
          disabled: false,
        }),
        createElement(StatusBar, {
          state: latest,
          width: columns,
          hint: "Enter send · Alt+Enter newline · Ctrl+P sessions · /help",
        }),
      ) as ReactNode,
      { columns },
    );

  process.stdout.write("<<<FRAME:start>>>\n");
  process.stdout.write(`${renderFrame(0)}\n`);
  process.stdout.write("<<<FRAME:end>>>\n");
  process.stdout.write(`${renderFrame(maxScroll)}\n`);
  process.stderr.write(
    `\n[rendered ${columns}x${rows}; status=${status}; ${latest.messages.length} messages; ` +
      `turn=${latest.turn}; tokens=${latest.totals.prompt + latest.totals.completion}; ` +
      `lines=${lines.length}]\n`,
  );
}

main().catch((cause: unknown) => {
  process.stderr.write(`${(cause as Error).stack}\n`);
  process.exitCode = 1;
});
