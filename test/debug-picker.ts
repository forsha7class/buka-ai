/**
 * Focused reproduction for overlay keybindings after a long local transcript.
 * No provider calls, so it runs in seconds.
 *
 * Usage: npx tsx test/debug-picker.ts
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

async function main(): Promise<void> {
  const runtime = await createRuntime({ cwd: process.cwd() });
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();

  const app = render(
    createElement(App, { runtime, cwd: process.cwd(), store: new SessionStore() }),
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

  await delay(400);

  const report = (label: string): void => {
    const text = stdout.text();
    process.stdout.write(
      `  [${label}] picker=${String(/select model/.test(text)).padEnd(5)} ` +
        `session=${String(/resume session|no saved sessions/.test(text)).padEnd(5)} ` +
        `loading=${String(/loading/.test(text)).padEnd(5)} bytes=${text.length}\n`,
    );
  };

  report("boot");

  // Build a transcript with local slash commands (no provider traffic).
  for (let index = 0; index < 4; index++) {
    stdin.write("/help");
    await delay(100);
    stdin.write("\r");
    await delay(150);
  }
  await delay(300);
  report("after 4x /help");

  stdin.write("\u001b[5~");
  await delay(300);
  stdin.write("\u001b[6~");
  await delay(300);
  report("after paging");

  stdin.write("\u000b");
  await delay(1500);
  report("after ctrl+k");

  process.stdout.write("\n--- transcript tail ---\n");
  process.stdout.write(`${stdout.text().slice(-1200)}\n`);
  process.stdout.write("--- end ---\n");

  app.unmount();
}

main().catch((cause: unknown) => {
  process.stderr.write(`${(cause as Error).stack}\n`);
  process.exitCode = 1;
});
