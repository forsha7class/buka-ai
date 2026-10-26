/**
 * End-to-end TUI smoke test.
 *
 * Drives the real <App /> against the real provider using a fake TTY: a
 * PassThrough for stdin and a capturing Writable for stdout. This is the same
 * approach Ink's own test suite uses, and it exercises what unit tests cannot
 * reach — keybindings, the agent pump, streaming repaints, the permission
 * prompt, scrolling, the pickers and session persistence.
 *
 * Assertions read the component's committed state via the `onState` hook rather
 * than scraping ANSI, so they stay stable across Ink repaint strategies.
 *
 * Usage: npx tsx test/tui-smoke.ts
 */
import { PassThrough, Writable } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink";

import { createRuntime } from "../src/runtime.js";
import { SessionStore } from "../src/session/store.js";
import { App } from "../src/tui/app.js";
import { messageText, messageTools, type AppState } from "../src/tui/types.js";

const ANSI = /\u001b\[[0-9;?]*[a-zA-Z]|\u001b\][^\u0007]*\u0007|\u001b[()][A-Z0-9]/g;
/** Directory the agent works in. Defaults to this repo, which has plenty of .ts files. */
const WORKDIR = process.env["SMOKE_CWD"] ?? process.cwd();

class FakeStdout extends Writable {
  columns = 100;
  rows = 30;
  isTTY = true;
  private chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  /** Everything ever painted, with ANSI stripped. */
  text(): string {
    return this.chunks.join("").replace(ANSI, "");
  }

  /** Drops buffered output so the next assertion sees only fresh frames. */
  clear(): void {
    this.chunks.length = 0;
  }

  /** Best-effort view of the newest frame. */
  screen(): string {
    const text = this.text();
    const index = text.lastIndexOf("buka ai");
    return index === -1 ? text : text.slice(index);
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

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(80);
  }
  process.stderr.write(`timed out after ${timeoutMs}ms waiting for: ${label}\n`);
  return false;
}

async function main(): Promise<number> {
  // Isolate the config directory: resolving the prompt seeds a file, and a test
  // must never write into the developer's real ~/.config.
  const configHome = mkdtempSync(join(tmpdir(), "buka-smoke-config-"));
  process.env["XDG_CONFIG_HOME"] = configHome;

  const storeDir = mkdtempSync(join(tmpdir(), "buka-smoke-sessions-"));
  const store = new SessionStore(storeDir);
  const runtime = await createRuntime({
    cwd: WORKDIR,
    ...(process.env["SMOKE_MODEL"] ? { model: process.env["SMOKE_MODEL"]! } : {}),
  });

  const stdout = new FakeStdout();
  const stdin = new FakeStdin();

  let latest: AppState | undefined;
  // yolo is intentionally OFF so the permission prompt is exercised.
  const app = render(
    createElement(App, {
      runtime,
      cwd: WORKDIR,
      store,
      onState: (state: AppState) => {
        latest = state;
      },
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

  const checks: Array<[string, boolean]> = [];
  const expect = (label: string, condition: boolean): void => {
    checks.push([label, condition]);
  };

  const lastMessage = () => latest?.messages.at(-1);
  const waitIdle = async (label: string): Promise<boolean> =>
    waitFor(() => latest?.status === "idle", 120_000, label);

  /** Types a command and submits it, waiting for any run to settle first. */
  const sendCommand = async (text: string): Promise<void> => {
    await waitIdle(`idle before sending ${text}`);
    stdin.write(text);
    await delay(120);
    stdin.write("\r");
    await delay(250);
  };

  try {
    await delay(400);
    expect("banner renders on the empty state", stdout.text().includes("terminal coding agent"));
    expect("model reference is shown in the header", stdout.text().includes(runtime.model.key));

    // --- typing --------------------------------------------------------------
    const prompt = "Use the bash tool to run `echo permission-check`. Then reply with just the output.";
    stdin.write(prompt);
    await delay(300);
    expect("typed characters are echoed", stdout.text().includes(prompt));
    stdin.write("\r");

    const started = await waitFor(
      () => latest?.status !== "idle" || (latest?.messages.length ?? 0) === 2,
      20_000,
      "run to start",
    );
    expect("submitting starts a run", started);

    // --- permission prompt ---------------------------------------------------
    const asked = await waitFor(
      () => latest?.pendingPermission != null,
      120_000,
      "permission prompt (the model must call a tool)",
    );
    expect("a mutating tool triggers the permission prompt", asked);
    expect("the prompt names the tool", (latest?.pendingPermission?.tool ?? "").length > 0);

    stdin.write("n"); // deny
    await delay(300);
    expect("answering dismisses the prompt", latest?.pendingPermission == null);
    const deniedTool = latest?.messages.some((message) =>
      messageTools(message).some((entry) => entry.status === "error"),
    );
    expect("the denial is recorded on the tool block", deniedTool === true);

    const finished = await waitFor(() => latest?.status === "idle", 120_000, "run to finish");
    expect("run returns to idle after the denial", finished);
    const last = lastMessage();
    expect("assistant still produced a reply", last ? messageText(last).length > 0 : false);

    // --- session persistence -------------------------------------------------
    await delay(300);
    const sessions = store.list();
    expect("the run created a saved session", sessions.length === 1);
    expect("the session has both turns", (sessions[0]?.messages ?? 0) >= 2);
    const sessionFile = join(storeDir, `${sessions[0]?.id ?? "missing"}.jsonl`);
    const raw = existsSync(sessionFile) ? readFileSync(sessionFile, "utf8") : "";
    expect("the transcript is on disk", raw.includes('"t":"meta"') && raw.includes('"t":"user"'));
    expect("the tool result is persisted", raw.includes('"toolResults"'));
    expect("the denial is persisted", raw.includes('"denied"') || raw.includes('"isError":true'));

    // --- scrolling -----------------------------------------------------------
    for (let index = 0; index < 4; index++) {
      await sendCommand("/help");
    }
    await delay(300);
    expect("slash commands render into the transcript", (latest?.messages.length ?? 0) > 6);

    stdin.write("\u001b[5~"); // page up
    await delay(300);
    expect("page up unpins the viewport", latest?.scroll.pinned === false);
    stdin.write("\u001b[6~"); // page down
    await delay(300);
    expect("page down re-pins the viewport", latest?.scroll.pinned === true);

    /**
     * Escape closing an overlay is asserted on a cleared buffer, and a harmless
     * keystroke afterwards forces a repaint — otherwise "no output" would look
     * like success even if the key had been ignored.
     */
    const expectOverlayClosed = async (label: string, pattern: RegExp): Promise<void> => {
      stdout.clear();
      stdin.write("\u001b"); // escape
      await delay(400);
      stdin.write("x"); // force a repaint (inserted only if the overlay is gone)
      await delay(400);
      const fresh = stdout.text();
      expect(`${label} escape closes the overlay`, !pattern.test(fresh));
      expect(`${label} repaints afterwards`, fresh.length > 0);
      stdin.write("\u0003"); // clears the stray "x" from the input
      await delay(200);
    };

    // --- model picker --------------------------------------------------------
    stdout.clear();
    stdin.write("\u000b"); // ctrl+k
    const pickerOpened = await waitFor(
      () => /select model/.test(stdout.text()),
      30_000,
      "model picker",
    );
    expect("ctrl+k opens the model picker", pickerOpened);
    await expectOverlayClosed("model picker", /select model/);

    // --- session picker ------------------------------------------------------
    stdout.clear();
    stdin.write("\u0010"); // ctrl+p
    const sessionPicker = await waitFor(
      () => /resume session/.test(stdout.text()),
      20_000,
      "session picker",
    );
    expect("ctrl+p opens the session picker", sessionPicker);
    await expectOverlayClosed("session picker", /resume session/);

    // --- chunked delivery regression -----------------------------------------
    const beforeChunk = latest?.messages.length ?? 0;
    stdin.write("/tools\r");
    const chunkHandled = await waitFor(
      () => (latest?.messages.length ?? 0) > beforeChunk + 1,
      10_000,
      "chunked Enter to submit",
    );
    expect("a chunk ending in Enter still submits", chunkHandled);

    // --- /compact -------------------------------------------------------------
    stdout.clear();
    stdin.write("/compact");
    await delay(120);
    stdin.write("\r");
    const compacted = await waitFor(
      () => /context compacted|Not enough conversation/.test(stdout.text()),
      120_000,
      "/compact to finish",
    );
    expect("/compact summarises the context", compacted);
    expect(
      "/compact reports how much was folded away",
      /\d+ chars summarised/.test(stdout.text()),
    );

    // The whole point of the persistent form: the boundary is on disk.
    await delay(300);
    const compactedFile = join(storeDir, `${sessions[0]?.id ?? "missing"}.jsonl`);
    const compactedRaw = existsSync(compactedFile) ? readFileSync(compactedFile, "utf8") : "";
    expect("the compaction boundary is persisted", compactedRaw.includes('"t":"compaction"'));
    expect(
      "the earlier turns are still in the log",
      compactedRaw.includes('"t":"user"') && compactedRaw.includes('"t":"assistant"'),
    );
    expect(
      "the part order is persisted for exact replay",
      compactedRaw.includes('"parts"'),
    );

    // --- quit ---------------------------------------------------------------
    stdin.write("\u0003");
    const exited = await Promise.race([
      app.waitUntilExit().then(() => true),
      delay(5_000).then(() => false),
    ]);
    expect("ctrl+c exits the app", exited);
  } finally {
    try {
      app.unmount();
    } catch {
      /* already unmounted */
    }
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
  }

  process.stdout.write(`\n${"─".repeat(100)}\nSCREEN (tail)\n${"─".repeat(100)}\n`);
  process.stdout.write(`${stdout.screen().slice(0, 2500)}\n${"─".repeat(100)}\n`);

  if (process.env["SMOKE_DUMP"]) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env["SMOKE_DUMP"], stdout.text(), "utf8");
    process.stdout.write(`full transcript written to ${process.env["SMOKE_DUMP"]}\n`);
  }

  let failed = 0;
  process.stdout.write("\nresults\n");
  for (const [label, passed] of checks) {
    process.stdout.write(`  ${passed ? "PASS" : "FAIL"}  ${label}\n`);
    if (!passed) failed += 1;
  }
  process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    process.stderr.write(`smoke test crashed: ${(cause as Error).stack ?? String(cause)}\n`);
    process.exitCode = 1;
  });
