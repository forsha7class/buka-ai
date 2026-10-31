#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

import { ConfigError, writeStarterConfig } from "./config/load.js";
import { globalConfigPaths, projectConfigPaths } from "./config/paths.js";
import type { ProviderSetupResult } from "./config/setup.js";
import { resolvePrompt } from "./agent/prompt.js";
import { createDefaultTools } from "./agent/tools/index.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { runPrint } from "./run/print.js";
import { SessionStore, type Session } from "./session/store.js";
import { getBool, getString, parseArgs, type FlagSpec } from "./util/args.js";
import { color, style, symbol } from "./util/theme.js";

const FLAGS: FlagSpec[] = [
  { name: "help", alias: "h" },
  { name: "version", alias: "v" },
  { name: "print", alias: "p", value: true },
  { name: "model", alias: "m", value: true },
  { name: "continue", alias: "c" },
  { name: "session", alias: "s", value: true },
  { name: "config", value: true },
  { name: "cwd", value: true },
  { name: "yolo" },
  { name: "verbose" },
  { name: "no-tools" },
  { name: "max-turns", value: true },
  { name: "list-models" },
  { name: "show-prompt" },
  { name: "yes" },
];

function version(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function helpText(): string {
  return `${style.bold("buka ai")} ${style.dim(`v${version()}`)} — terminal-native AI coding agent

${style.bold("USAGE")}
  buka                         start the interactive TUI
  buka -p "<prompt>"           one-shot: print the answer and exit
  buka models                  list available models
  buka sessions                list saved sessions
  buka setup                   add or change a provider and API key
  buka init                    set up a provider (starter config with --yes)

${style.bold("OPTIONS")}
  -m, --model <provider/model>   override the configured model
  -p, --print <prompt>           run non-interactively
  -c, --continue                 resume the most recent session for this directory
  -s, --session <id>             resume a specific session
      --config <path>            use a specific config file
      --cwd <dir>                set the working directory
      --yolo                     auto-approve every tool call
      --no-tools                 disable tool use for this run
      --max-turns <n>            cap agent turns (default 32)
      --verbose                  stream reasoning + token usage to stderr
      --list-models              list available models
      --show-prompt              print the system prompt that would be sent
      --yes                      with init: write the starter config non-interactively
  -h, --help                     show this help
  -v, --version                  print the version

${style.bold("NOTES")}
  The system prompt lives in ~/.config/buka-ai/SYSTEM_PROMPT.md — edit it there,
  no rebuild needed. HTML comments in that file are not sent to the model.
  Run \`buka setup\` to add a provider or replace an API key.

  Interactive runs are always saved. A one-shot run is saved only when it
  resumes a session (--continue / --session), so scripts stay ephemeral.

${style.bold("EXAMPLES")}
  ${color.gray('buka -p "jelasin isi package.json" -m 9router/davo')}
  ${color.gray('buka -c -p "lanjut: tambahin test buat itu"')}
  ${color.gray('buka --yolo -p "refactor utils.ts dan jalanin test"')}
`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv, FLAGS);

  if (args.unknown.length > 0) {
    process.stderr.write(
      `${color.red(symbol.fail)} unknown option: ${args.unknown.join(" ")}\n${style.dim("run `buka --help`")}\n`,
    );
    return 2;
  }

  if (getBool(args, "help") || args.positionals[0] === "help") {
    process.stdout.write(helpText());
    return 0;
  }
  if (getBool(args, "version")) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  const command = args.positionals[0];
  const cwd = getString(args, "cwd") ?? process.cwd();
  const prompt = getString(args, "print");
  const configFlag = getString(args, "config");
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const readOnlyCommand =
    command === "models" || command === "sessions" || getBool(args, "list-models");

  if (command === "setup") {
    if (!interactive) {
      process.stderr.write(
        `${color.red(symbol.fail)} provider setup needs an interactive terminal\n`,
      );
      return 1;
    }
    const result = await runSetupFlow(configFlag);
    if (!result) return 1;
    printSetupResult(result);
    return 0;
  }

  if (command === "init") {
    // In a terminal, `init` means "help me set up a provider". Scripts keep the
    // old non-interactive starter-file behaviour with `--yes` (or `--yolo`).
    if (interactive && !getBool(args, "yes") && !getBool(args, "yolo")) {
      const result = await runSetupFlow(configFlag);
      if (!result) return 1;
      printSetupResult(result);
      const promptFile = resolvePrompt();
      for (const note of promptFile.notes) {
        process.stdout.write(`${color.dimGray("·")} ${style.dim(note)}\n`);
      }
      process.stdout.write(
        `${color.dimGray("·")} ${style.dim(`system prompt: ${promptFile.path}`)}\n`,
      );
      return 0;
    }
    try {
      const configPath = writeStarterConfig(getBool(args, "yolo"));
      // Also materialise the prompt file, so there is something to edit.
      const promptFile = resolvePrompt();
      process.stdout.write(`${color.green(symbol.ok)} wrote ${configPath}\n`);
      for (const note of promptFile.notes) {
        process.stdout.write(`${color.dimGray("·")} ${style.dim(note)}\n`);
      }
      process.stdout.write(
        `${color.dimGray("·")} ${style.dim(`system prompt: ${promptFile.path}`)}\n`,
      );
      return 0;
    } catch (cause) {
      process.stderr.write(`${color.red(symbol.fail)} ${(cause as Error).message}\n`);
      return 1;
    }
  }

  const configAlreadyExists = configExists(configFlag, cwd);
  const envProvider = Boolean(
    process.env["OPENAI_API_KEY"] ||
      process.env["OPENAI_BASE_URL"] ||
      process.env["ANTHROPIC_API_KEY"] ||
      process.env["GEMINI_API_KEY"] ||
      process.env["GOOGLE_API_KEY"] ||
      process.env["BUKA_9ROUTER_KEY"] ||
      process.env["BUKA_MODEL"],
  );

  // A genuinely fresh install gets the provider picker before the first TUI.
  // Environment-only setups keep working without an interactive detour.
  if (
    interactive &&
    command === undefined &&
    prompt === undefined &&
    !getBool(args, "show-prompt") &&
    !getBool(args, "list-models") &&
    getString(args, "model") === undefined &&
    !configAlreadyExists &&
    !envProvider
  ) {
    const result = await runSetupFlow(configFlag);
    if (!result) return 1;
    printSetupResult(result);
  }

  const buildRuntime = (): Promise<Runtime> =>
    createRuntime({
      ...(getString(args, "model") !== undefined ? { model: getString(args, "model")! } : {}),
      ...(configFlag !== undefined ? { configPath: configFlag } : {}),
      ...(getString(args, "cwd") !== undefined ? { cwd: getString(args, "cwd")! } : {}),
      seedPrompt: !readOnlyCommand,
    });

  let runtime: Runtime;
  try {
    runtime = await buildRuntime();
  } catch (cause) {
    const canRepair =
      interactive &&
      command === undefined &&
      prompt === undefined &&
      !getBool(args, "show-prompt") &&
      !getBool(args, "list-models") &&
      getString(args, "model") === undefined &&
      !(cause instanceof ConfigError);

    if (!canRepair) {
      const message =
        cause instanceof ConfigError ? cause.message : String((cause as Error).message);
      process.stderr.write(`${color.red(symbol.fail)} ${message}\n`);
      return 1;
    }

    process.stderr.write(
      `${color.yellow(symbol.warn)} ${style.dim((cause as Error).message)}\n`,
    );
    process.stderr.write(
      `${color.dimGray("·")} ${style.dim("opening provider setup so you can fix it")}\n`,
    );
    const result = await runSetupFlow(configFlag);
    if (!result) {
      process.stderr.write(`${color.red(symbol.fail)} ${(cause as Error).message}\n`);
      return 1;
    }
    printSetupResult(result);
    try {
      runtime = await buildRuntime();
    } catch (retryCause) {
      const message =
        retryCause instanceof ConfigError
          ? retryCause.message
          : String((retryCause as Error).message);
      process.stderr.write(`${color.red(symbol.fail)} ${message}\n`);
      return 1;
    }
  }

  for (const warning of runtime.warnings) {
    process.stderr.write(`${color.yellow(symbol.warn)} ${style.dim(warning)}\n`);
  }
  for (const note of runtime.notes) {
    process.stderr.write(`${color.dimGray("·")} ${style.dim(note)}\n`);
  }

  if (getBool(args, "show-prompt")) {
    process.stdout.write(`${runtime.systemPrompt}\n`);
    process.stderr.write(
      `${color.dimGray("·")} ${style.dim(`prompt from ${runtime.promptSource.path} (${runtime.promptSource.source})`)}\n`,
    );
    return 0;
  }

  if (command === "models" || getBool(args, "list-models")) {
    return listModels(runtime);
  }

  const store = new SessionStore();

  if (command === "sessions") {
    return listSessions(store, cwd);
  }

  if (command !== undefined) {
    process.stderr.write(
      `${color.red(symbol.fail)} unknown command "${command}"\n${style.dim("run `buka --help`")}\n`,
    );
    return 2;
  }

  // Resolve a session to resume, if one was requested.
  let resume: Session | undefined;
  const sessionFlag = getString(args, "session");
  const wantsContinue = getBool(args, "continue") || sessionFlag !== undefined;
  if (wantsContinue) {
    try {
      if (sessionFlag !== undefined) {
        resume = store.load(sessionFlag);
      } else {
        const latest = store.latest(cwd);
        if (!latest) {
          process.stderr.write(
            `${color.yellow(symbol.warn)} no saved session for ${cwd}; starting a new one\n`,
          );
        } else {
          resume = store.load(latest.id);
        }
      }
    } catch (cause) {
      process.stderr.write(`${color.red(symbol.fail)} ${(cause as Error).message}\n`);
      return 1;
    }
    if (resume) {
      process.stderr.write(
        `${color.dimGray("·")} ${style.dim(`resuming "${resume.title}" (${resume.id})`)}\n`,
      );
    }
  }
  const maxTurns = getString(args, "max-turns");
  const verbose = getBool(args, "verbose");
  const noTools = getBool(args, "no-tools");
  const yolo = getBool(args, "yolo");

  if (prompt !== undefined) {
    if (prompt.trim().length === 0) {
      process.stderr.write(`${color.red(symbol.fail)} empty prompt\n`);
      return 2;
    }
    const tools = createDefaultTools(cwd);

    // A resumed one-shot run is part of a session, so it gets persisted. A bare
    // `-p` stays ephemeral so scripts do not litter the session store — unless
    // the user explicitly asked to continue, in which case a fresh session is
    // created when none exists yet.
    const session =
      resume ??
      (wantsContinue
        ? store.create({
            cwd,
            modelRef: `${runtime.model.providerId}/${runtime.model.key}`,
            model: runtime.model.modelId,
          })
        : undefined);

    const result = await runPrint({
      prompt,
      runtime,
      tools,
      ...(session ? { session } : {}),
      ...(maxTurns !== undefined ? { maxTurns: Number(maxTurns) } : {}),
      ...(verbose ? { verbose: true } : {}),
      ...(noTools ? { noTools: true } : {}),
      ...(yolo ? { yolo: true } : {}),
      cwd,
    });
    return result.code;
  }

  // Interactive TUI.
  try {
    const { launchTui } = await import("./tui/app.js");
    return await launchTui({
      runtime,
      cwd,
      store,
      ...(resume ? { session: resume } : {}),
      ...(yolo ? { yolo: true } : {}),
      ...(verbose ? { verbose: true } : {}),
    });
  } catch (cause) {
    if ((cause as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
      process.stderr.write(
        `${color.yellow(symbol.warn)} the interactive TUI is not available in this build.\n` +
          `${style.dim('use `buka -p "..."` for now.')}\n`,
      );
      return 1;
    }
    throw cause;
  }
}

function configExists(configPath: string | undefined, cwd: string): boolean {
  if (configPath) return existsSync(configPath);
  return [...globalConfigPaths(), ...projectConfigPaths(cwd)].some(existsSync);
}

async function runSetupFlow(configPath: string | undefined): Promise<ProviderSetupResult | null> {
  try {
    const { runSetup } = await import("./setup/run.js");
    return await runSetup(configPath !== undefined ? { configPath } : {});
  } catch (cause) {
    process.stderr.write(`${color.red(symbol.fail)} ${(cause as Error).message}\n`);
    return null;
  }
}

function printSetupResult(result: ProviderSetupResult): void {
  process.stdout.write(`${color.green(symbol.ok)} saved ${result.configPath}\n`);
  process.stdout.write(
    `${color.dimGray("·")} ${style.dim(`default model: ${result.modelRef}`)}\n`,
  );
  if (result.secretPath) {
    process.stdout.write(
      `${color.dimGray("·")} ${style.dim(`api key: ${result.secretPath} (0600)`)}\n`,
    );
  }
}

function listSessions(store: SessionStore, cwd: string): number {
  const sessions = store.list();
  if (sessions.length === 0) {
    process.stdout.write(`${style.dim("no saved sessions yet")}\n`);
    return 0;
  }

  process.stdout.write(`${style.bold(`${sessions.length} session${sessions.length === 1 ? "" : "s"}`)}\n\n`);
  for (const session of sessions) {
    const here = session.cwd === cwd ? color.green(symbol.bullet) : " ";
    const updated = session.updatedAt.replace("T", " ").slice(0, 16);
    process.stdout.write(`${here} ${style.bold(session.id)}\n`);
    process.stdout.write(
      `   ${style.dim(updated)}  ${session.messages} msg  ${style.dim(session.modelRef)}\n`,
    );
    process.stdout.write(`   ${session.title}\n\n`);
  }
  process.stdout.write(
    `${style.dim("resume with")} ${color.cyan("buka -s <id>")} ${style.dim("or")} ${color.cyan("buka -c")}\n`,
  );
  return 0;
}

async function listModels(runtime: Runtime): Promise<number> {
  const models = await runtime.registry.listModels();
  if (models.length === 0) {
    process.stderr.write(`${color.yellow(symbol.warn)} no models found\n`);
    return 1;
  }

  const current = `${runtime.model.providerId}/${runtime.model.key}`;
  let lastProvider = "";
  for (const model of models) {
    if (model.providerId !== lastProvider) {
      lastProvider = model.providerId;
      process.stdout.write(`\n${style.bold(model.providerName)}\n`);
    }
    const marker = model.reference === current ? color.green(symbol.bullet) : " ";
    const flags: string[] = [];
    if (model.info.tools) flags.push("tools");
    if (model.info.reasoning) flags.push("reasoning");
    const suffix = flags.length > 0 ? style.dim(`  (${flags.join(", ")})`) : "";
    process.stdout.write(` ${marker} ${model.reference}${suffix}\n`);
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    process.stderr.write(
      `${color.red(`${symbol.fail} ${cause instanceof Error ? cause.message : String(cause)}`)}\n`,
    );
    process.exitCode = 1;
  });
