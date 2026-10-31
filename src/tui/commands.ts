/**
 * Slash commands, in one place.
 *
 * Previously the dispatcher lived in `app.tsx` and the help text lived next to
 * it, so the two drifted. A single registry now feeds the dispatcher, the
 * `/help` output, the slash autocomplete panel and the command palette.
 */
import { writeFileSync } from "node:fs";
import type { RefObject } from "react";

import type { Runtime } from "../runtime.js";
import type { Session } from "../session/store.js";
import type { ToolRegistry } from "../agent/tools/registry.js";
import { messageText, type Action, type AppState } from "./types.js";
import type { PickerItem } from "./dialogs.js";

export interface CommandContext {
  dispatch: (action: Action) => void;
  exit: () => void;
  openModelPicker: (providerId?: string) => Promise<void>;
  openProviderPicker: () => void;
  openSessionPicker: () => Promise<void>;
  startNewSession: () => void;
  compactContext: () => Promise<void>;
  switchModel: (reference: string) => void;
  ensureSession: () => Session;
  sessionRef: RefObject<Session | undefined>;
  state: AppState;
  tools: ToolRegistry;
  runtime: Runtime;
  themeName: string;
  setTheme: (name: string) => void;
  themeNames: string[];
}

export interface Command {
  name: string;
  args?: string;
  description: string;
  run: (context: CommandContext, args: string, raw: string) => void;
}

export const COMMANDS: Command[] = [
  {
    name: "help",
    description: "show this help",
    run: (context, _args, raw) => reply(context, raw, helpText()),
  },
  {
    name: "model",
    args: "[ref]",
    description: "switch model (no argument opens the picker)",
    run: (context, args) => {
      if (args.length === 0) void context.openModelPicker();
      else context.switchModel(args);
    },
  },
  {
    name: "models",
    description: "list every available model",
    run: (context, _args, raw) => listModels(context, raw),
  },
  {
    name: "provider",
    args: "[id]",
    description: "switch provider or add one",
    run: (context, args) => {
      if (args.length > 0) {
        const id = args.split(/\s+/)[0]!;
        if (!context.runtime.registry.get(id)) {
          reply(context, `/provider ${args}`, `unknown provider "${id}". Try /provider for the list.`);
          return;
        }
        void context.openModelPicker(id);
        return;
      }
      context.openProviderPicker();
    },
  },
  {
    name: "sessions",
    description: "browse and resume past sessions",
    run: (context) => void context.openSessionPicker(),
  },
  {
    name: "new",
    description: "start a fresh session",
    run: (context) => context.startNewSession(),
  },
  {
    name: "rename",
    args: "<title>",
    description: "name the current session",
    run: (context, args, raw) => {
      const session = context.ensureSession();
      if (args.length === 0) {
        reply(context, raw, `current session: ${session.title}\nid: ${session.id}`);
        return;
      }
      session.rename(args);
      reply(context, raw, `renamed session to "${args}"`);
    },
  },
  {
    name: "clear",
    description: "clear the visible transcript (session file is kept)",
    run: (context) => context.dispatch({ type: "reset" }),
  },
  {
    name: "compact",
    description: "summarise earlier turns to shrink the context window",
    run: (context) => void context.compactContext(),
  },
  {
    name: "tools",
    description: "list the tools the agent can use",
    run: (context, _args, raw) => {
      const names = context.tools.names();
      reply(
        context,
        raw,
        names.length === 0
          ? "no tools registered"
          : `tools (${names.length}):\n${names.map((name) => `  ${name}`).join("\n")}`,
      );
    },
  },
  {
    name: "theme",
    args: "[name]",
    description: "switch colour theme (no argument lists them)",
    run: (context, args, raw) => {
      const requested = args.trim().toLowerCase();
      if (requested.length === 0) {
        reply(
          context,
          raw,
          `themes (${context.themeNames.length}):\n` +
            `${context.themeNames.map((name) => `  ${name === context.themeName ? "▸" : " "} ${name}`).join("\n")}`,
        );
        return;
      }
      if (!context.themeNames.includes(requested)) {
        reply(context, raw, `unknown theme "${requested}". Try /theme for the list.`);
        return;
      }
      context.setTheme(requested);
      reply(context, raw, `theme set to ${requested}`);
    },
  },
  {
    name: "export",
    args: "[file]",
    description: "write the conversation to a markdown file",
    run: (context, args, raw) => exportConversation(context, args, raw),
  },
  {
    name: "exit",
    description: "quit",
    run: (context) => context.exit(),
  },
];

/** `quit` is an alias, not a separate entry, so help lists it once. */
const ALIASES: Record<string, string> = { quit: "exit" };

export function commandByName(name: string): Command | undefined {
  const resolved = ALIASES[name] ?? name;
  return COMMANDS.find((command) => command.name === resolved);
}

/** Returns true when the input was consumed as a command. */
export function runCommand(raw: string, context: CommandContext): boolean {
  if (!raw.startsWith("/")) return false;
  const [name = "", ...rest] = raw.slice(1).split(/\s+/);
  const args = rest.join(" ").trim();
  const command = commandByName(name);
  if (!command) {
    reply(context, raw, `unknown command "/${name}". Try /help.`);
    return true;
  }
  command.run(context, args, raw);
  return true;
}

export function commandItems(): PickerItem[] {
  return COMMANDS.map((command) => ({
    // The reference is what gets executed, so it must not include the
    // placeholder arguments (`/model`, never `/model [ref]`).
    reference: `/${command.name}`,
    detail: command.args ? `${command.args} · ${command.description}` : command.description,
  }));
}

/**
 * Items for the inline autocomplete panel. Only an unfinished command word
 * matches: once the user types a space, they are writing arguments and the
 * panel gets out of the way.
 */
export function matchingCommands(input: string): PickerItem[] {
  if (!input.startsWith("/")) return [];
  if (/\s/.test(input)) return [];
  const query = input.slice(1).toLowerCase();
  const items = commandItems();
  if (query.length === 0) return items;
  return items.filter((item) => item.reference.slice(1).split(" ")[0]!.startsWith(query));
}

export function helpText(): string {
  const commands = COMMANDS.map((command) => {
    const signature = `/${command.name}${command.args ? ` ${command.args}` : ""}`;
    return `  ${signature.padEnd(19)}${command.description}`;
  });

  return [
    "slash commands",
    ...commands,
    "",
    "keys",
    "  Enter              send (queues while the agent is running)",
    "  Alt+Enter / Ctrl+J new line",
    "  Esc                stop the current run / close a panel",
    "  PgUp / PgDn        scroll the transcript",
    "  Ctrl+P             command palette",
    "  Ctrl+X             sessions, or the queue when messages are waiting",
    "  Ctrl+K             model picker",
    "  Ctrl+B             toggle the sidebar",
    "  Ctrl+T             expand / collapse thinking",
    "  Ctrl+O             expand / collapse tool output",
    "  Up / Down          prompt history when the cursor is at the edge",
    "  Home / End         start / end of the current line",
    "  Ctrl+A / Ctrl+E    start / end of line",
    "  Ctrl+U / Ctrl+W    delete to line start / delete word",
    "  Ctrl+D             delete the character under the cursor",
    "  Ctrl+G             jump back to the newest output",
    "  Ctrl+L             clear the transcript",
    "  Ctrl+C             stop, then clear the input, then quit",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function reply(context: CommandContext, raw: string, text: string): void {
  context.dispatch({ type: "user", text: raw });
  context.dispatch({ type: "assistant_start" });
  context.dispatch({ type: "delta", text });
  context.dispatch({ type: "done", reason: "complete" });
}

function listModels(context: CommandContext, raw: string): void {
  context.dispatch({ type: "user", text: raw });
  context.dispatch({ type: "assistant_start" });
  context.runtime.registry
    .listModels()
    .then((models) => {
      const text = models
        .map(
          (model) =>
            `${model.reference}${model.info.tools ? "  (tools)" : ""}${model.info.reasoning ? " (reasoning)" : ""}`,
        )
        .join("\n");
      context.dispatch({ type: "delta", text: `models (${models.length}):\n${text}` });
      context.dispatch({ type: "done", reason: "complete" });
    })
    .catch((cause: unknown) => {
      context.dispatch({ type: "error", message: (cause as Error).message });
      context.dispatch({ type: "done", reason: "complete" });
    });
}

function exportConversation(context: CommandContext, args: string, raw: string): void {
  const target = args.length > 0 ? args : `buka-${Date.now()}.md`;
  const session = context.sessionRef.current;
  const header = session
    ? `# ${session.title}\n\n- session: \`${session.id}\`\n- updated: ${session.metaSnapshot.updatedAt}\n\n`
    : "";
  const body = context.state.messages
    .map((message) => `## ${message.role}\n\n${messageText(message)}\n`)
    .join("\n");
  try {
    writeFileSync(target, header + body, "utf8");
    reply(context, raw, `exported ${context.state.messages.length} messages to ${target}`);
  } catch (cause) {
    reply(context, raw, `export failed: ${(cause as Error).message}`);
  }
}
