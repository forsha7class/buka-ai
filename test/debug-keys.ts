/**
 * Focused keybinding probe. Boots the real <App />, sends one key at a time and
 * reports whether the expected overlay appeared. Used to debug key delivery
 * without the noise of the full smoke test.
 *
 * Usage: npx tsx test/debug-keys.ts
 */
import { PassThrough, Writable } from "node:stream";
import { createElement } from "react";
import { render } from "ink";

import { createRuntime } from "../src/runtime.js";
import { SessionStore } from "../src/session/store.js";
import { App } from "../src/tui/app.js";

const ANSI = /\u001b\[[0-9;?]*[a-zA-Z]|\u001b\][^\u0007]*\u0007|\u001b[()][A-Z0-9]/g;

class FakeStdout extends Writable {
  columns = 100;
  rows = 30;
  isTTY = true;
  chunks: string[] = [];
  override _write(chunk: Buffer | string, _e: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join("").replace(ANSI, "");
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

async function probe(
  stdout: FakeStdout,
  label: string,
  sequence: string,
  expectation: RegExp,
  waitMs = 8000,
): Promise<void> {
  stdout.chunks.length = 0;
  process.stdout.write(`probe ${label}: sending ${JSON.stringify(sequence)}\n`);
  const stdin = (globalThis as unknown as { stdin: FakeStdin }).stdin;
  stdin.write(sequence);

  const deadline = Date.now() + waitMs;
  let seen = false;
  while (Date.now() < deadline) {
    if (expectation.test(stdout.text())) {
      seen = true;
      break;
    }
    await delay(80);
  }
  process.stdout.write(`  ${seen ? "OK  " : "MISS"} ${label}\n`);
  if (!seen) {
    const text = stdout.text();
    process.stdout.write(`  --- raw tail ---\n${text.slice(-900)}\n  --- end ---\n`);
  }
}

async function main(): Promise<void> {
  const runtime = await createRuntime({ cwd: process.cwd() });
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  (globalThis as unknown as { stdin: FakeStdin }).stdin = stdin;

  const app = render(
    createElement(App, {
      runtime,
      cwd: process.cwd(),
      store: new SessionStore(),
    }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
      maxFps: 60,
    },
  );

  await delay(500);

  await probe(stdout, "ctrl+k (bare)", "\u000b", /select model/);
  await probe(stdout, "escape closes", "\u001b", /./);
  await delay(300);

  await probe(stdout, "ctrl+p (bare)", "\u0010", /resume session|no saved sessions/);
  await probe(stdout, "escape closes", "\u001b", /./);
  await delay(300);

  // Now the sequence the smoke test uses: page up, page down, then ctrl+k.
  await probe(stdout, "pageup accepted", "\u001b[5~", /./);
  await delay(200);
  await probe(stdout, "pagedown accepted", "\u001b[6~", /./);
  await delay(200);
  await probe(stdout, "ctrl+k (after paging)", "\u000b", /select model/);

  app.unmount();
}

main().catch((cause: unknown) => {
  process.stderr.write(`${(cause as Error).stack}\n`);
  process.exitCode = 1;
});
