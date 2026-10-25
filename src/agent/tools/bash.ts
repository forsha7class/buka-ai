import { spawn, type ChildProcess } from "node:child_process";

import { ToolError, type Tool, type ToolResult } from "./types.js";
import { asRecord, requireNumber, requireString, truncateLines } from "./shared.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Env vars a well-behaved CLI should not inherit into a subprocess prompt. */
const SECRET_ENV = /^(_|BUKA_|OPENAI|ANTHROPIC|AWS_|AZURE_|GCP_|GH_|GITHUB_|NPM_TOKEN|DOCKER_)/;

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command in the working directory. stdout and stderr are combined and the exit code is reported. " +
    "Prefer the dedicated file tools for reading, searching and editing; use this for builds, tests, git and scripts.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run." },
      timeout: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).` },
      description: { type: "string", description: "Short description of what the command does." },
    },
    required: ["command"],
    additionalProperties: false,
  },

  summarize(args) {
    const record = asRecord(args);
    const command = typeof record["command"] === "string" ? record["command"] : "?";
    return command.replace(/\s+/g, " ").trim();
  },

  async execute(args, ctx): Promise<ToolResult> {
    const record = asRecord(args);
    const command = requireString(record["command"], "command").trim();
    const timeoutMs = requireNumber(record["timeout"], "timeout", 100, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

    if (command.length === 0) throw new ToolError("command must not be empty");

    const result = await run(command, ctx.cwd, timeoutMs, ctx.signal);

    const sections: string[] = [];
    if (result.stdout.length > 0) sections.push(result.stdout.trimEnd());
    if (result.stderr.length > 0) sections.push(`[stderr]\n${result.stderr.trimEnd()}`);
    if (sections.length === 0) sections.push("(no output)");

    const combined = sections.join("\n");
    const body = truncateLines(combined, 2000, 90_000).text;

    const status = result.timedOut
      ? `timed out after ${timeoutMs}ms`
      : result.aborted
        ? "aborted"
        : `exit code ${result.code}`;

    return {
      output: `${body}\n\n[${status}]`,
      // A timeout is a real failure; an abort is a user decision, not an error.
      isError: result.timedOut || result.code !== 0,
      summary: status,
      metadata: { exitCode: result.code, timedOut: result.timedOut, aborted: result.aborted },
    };
  },
};

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

function run(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, {
        shell: true,
        cwd,
        env: sanitizedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        // A process group lets us kill the whole tree, not just the shell.
        detached: process.platform !== "win32",
      });
    } catch (cause) {
      reject(new ToolError(`Could not start command: ${(cause as Error).message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted });
    };

    const kill = (): void => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        // Process already gone; the exit handler will settle the promise.
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new ToolError(`Command failed to start: ${error.message}`));
    });

    child.on("close", (code) => {
      finish(code ?? (timedOut ? 124 : aborted ? 130 : 0));
    });
  });
}

/**
 * Strips credentials from the child environment. A shell command has no
 * business seeing the user's API keys just because `buka` holds them.
 */
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRET_ENV.test(key)) continue;
    env[key] = value;
  }
  return env;
}
