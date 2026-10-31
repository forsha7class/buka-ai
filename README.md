<div align="center">

<h1 align="center">
  <img src="./assets/logo.svg" alt="buka ai" width="520">
</h1>

**A terminal-native AI coding agent with a full-screen TUI, real tool use, and resumable sessions.**

<sub>Meet <strong>Buka</strong>, the little terminal ghost that keeps your code moving.</sub>

[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-245%20passing-3fb950)](#testing)
[![TUI checks](https://img.shields.io/badge/TUI%20checks-35%20passing-3fb950)](#testing)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)

</div>

```text
 buka ai · 0.3.0            │ Fix flaky users test · ~/buka-ai/main        ● ready  22.3k tok
 9router/default            │
 deepseek-v4.1-flash        │▸ you
                            │  Test-nya gagal. Cari penyebabnya, perbaiki, tunjukin diff-nya,
 context                    │  terus jalanin test lagi. Ringkas aja.
 ████████████░░░░  62%      │
 79k / 128k                 │◂ buka  deepseek-v4.1-flash
                            │  ✻ thinking  139 chars  (ctrl+t to show)
 changed (2)                │  ⚙ bash  npm test 2>&1 | tail -40       exit code 1  1.2s ✓
 M src/lib/store.js         │  │ not ok 1 - throws on missing user
 M src/routes/users.js      │  │ 1..2
                            │  ⚙ edit  src/lib/store.js             +3 −1  1 replacement 8ms ✓
                            │  │ @@ -1,5 +1,6 @@
                            │  │ -  return users.find((u) => u.id === id);
                            │  │ +  const user = users.find((u) => u.id === id);
                            │  │ +  if (!user) throw new Error(`user ${id} not found`);
                            │
 ctrl+p palette             │  Beres. 2/2 test lulus.
 ctrl+x sessions            │
 ctrl+k model               │╭──────────────────────────────────────────────────────────╮
 ctrl+b sidebar             ││❯ ask buka to do something, or /help                      │
 /help                      │╰──────────────────────────────────────────────────────────╯
                            │ ● ready            enter send · alt+enter newline · ctrl+p palette
```

<p align="center"><sub>A real session: the model ran the tests, read the code, fixed two files, and re-ran the suite to verify the fix.</sub></p>

---

## Overview

`buka` is a terminal-native coding agent that can actually *do* things in your
repository. It reads and edits files, runs commands, searches code, and keeps
working until the task is done. It runs in your terminal against any
OpenAI-compatible endpoint, or natively against Anthropic and Google Gemini.

There is no provider SDK, no daemon, and no database. One command, one config
file, and plain files on disk.

```bash
buka                          # interactive TUI
buka -p "explain src/auth.ts" # one-shot, pipeable
buka -c                       # resume the latest session in this directory
```

**Highlights**

- Full-screen TUI with exact scrolling, a split-pane sidebar, themes, a command
  palette, and conversation queueing.
- Seven tools with per-tool permissions: `read`, `write`, `edit`, `glob`, `grep`,
  `list`, and `bash`.
- Streaming text and reasoning, syntax-highlighted code, and inline diff previews.
- Append-only session logs that survive restarts, plus persistent context
  compaction.
- Multi-provider configuration with automatic model discovery.

---

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Usage](#usage)
  - [CLI](#cli)
  - [Keybindings](#keybindings)
  - [Slash commands](#slash-commands)
- [Configuration](#configuration)
  - [System prompt](#system-prompt)
- [Architecture](#architecture)
- [Design notes](#design-notes)
- [Testing](#testing)
- [Development](#development)
- [Contributing](#contributing)
- [Limitations](#limitations)
- [License](#license)

---

## Features

### Terminal-first interface

- Alternate-screen TUI with its own scrollback, block cursor, and keyboard-driven
  navigation.
- Split-pane layout on terminals 100 columns or wider: session details, model,
  context usage, changed files, and active key hints.
- Collapsible reasoning blocks and expandable tool output.
- Command palette (`Ctrl+P`), inline slash autocomplete, model picker, and
  session switcher.
- Configurable themes (`buka`, `opencode`, `hermes`, `light`, `classic`, or
  `auto`), switchable at runtime with `/theme`.
- Messages typed while the agent is working are queued for the next turn instead
  of being dropped.

### A real agent loop

- Tools are chained across turns until the task is complete, with a configurable
  turn ceiling.
- `edit` requires an exact, unique match; ambiguous edits fail with actionable
  guidance instead of corrupting a file.
- `edit` and `write` return unified diffs, rendered inline and preserved across
  session resumes.
- Tool output is truncated with an explicit notice, so the model knows what it
  is missing.

### Deliberate about context

- Messages are stored as an ordered list of parts (`thinking`, `text`, `tool`),
  preserving the order in which work actually happened.
- Session logs are append-only JSONL under `~/.local/share/buka-ai/sessions/`.
- `/compact` records a compaction boundary instead of rewriting history, so
  resumes continue from the summary while the full log stays on disk.

### Provider-agnostic

- Works with OpenAI, OpenRouter, Groq, Ollama, llama.cpp, vLLM, 9Router, or a
  local gateway in front of them.
- Native Anthropic and Google Gemini adapters, including tools, reasoning blocks
  and usage accounting.
- Models can be discovered from `/v1/models` or declared explicitly.
- Switch models mid-session without restarting.

---

## Requirements

- **Node.js >= 22**
- An OpenAI-compatible endpoint, or an Anthropic/Gemini API key
- Optional: [`ripgrep`](https://github.com/BurntSushi/ripgrep) for faster `grep`
  (a JavaScript fallback is built in)

---

## Installation

`buka` requires **Node.js 22 or newer**.

Install with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/forsha7class/buka-ai/main/install.sh | bash
```

The installer downloads the latest source to `~/.buka-ai`, builds it, and puts
`buka` on your `PATH` — normally `/usr/local/bin` when writable, otherwise
`~/.local/bin` or `~/bin`. Then:

```bash
buka --version
buka
```

From a clone, run the installer in the checkout:

```bash
git clone https://github.com/forsha7class/buka-ai.git
cd buka-ai
./install.sh
```

The shell installer targets macOS and Linux; on Windows use Git Bash or WSL.

To inspect the installer before running it:

```bash
curl -fsSL https://raw.githubusercontent.com/forsha7class/buka-ai/main/install.sh -o install.sh
less install.sh
bash install.sh
```

To uninstall:

```bash
curl -fsSL https://raw.githubusercontent.com/forsha7class/buka-ai/main/install.sh | bash -s -- --uninstall
rm -rf ~/.buka-ai
```

---

## Quick start

If no provider is configured yet, the first run opens a provider picker:

```bash
buka
```

Choose a provider, paste your API key, and pick a model. The key is written to
`~/.config/buka-ai/secrets/<provider>.key` with `0600` permissions; the config
only stores a `{file:...}` reference.

The list includes **9Router**, OpenAI, OpenRouter, Anthropic, Google Gemini,
DeepSeek, Groq, xAI, Mistral, Together AI, Fireworks, Ollama, LM Studio, and a
**Custom** entry for any OpenAI-compatible endpoint. Providers can be added or
changed later with:

```bash
buka setup
```

Environment-only setups still work:

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1
buka
```

For a starter file without the interactive picker (scripts/CI):

```bash
buka init --yes
$EDITOR ~/.config/buka-ai/buka.jsonc
```

Useful first commands inside the TUI:

```text
/help          show commands and keybindings
/provider      switch provider or add one
/models        list available models
/theme         switch the colour palette
```

---

## Usage

### CLI

| Command | Description |
|---|---|
| `buka` | Start the interactive TUI. |
| `buka -p "<prompt>"` | Run one prompt non-interactively; answer to stdout, diagnostics to stderr. |
| `buka -c` | Resume the most recent session for the current directory. |
| `buka -s <id>` | Resume a specific session. |
| `buka models` | List every available model. |
| `buka sessions` | List saved sessions. |
| `buka setup` | Add or change a provider and API key interactively (requires a TTY). |
| `buka init` | Set up a provider interactively; non-interactive shells and `--yes` write a starter config. |

`buka -p` runs are ephemeral by default: they print the answer without writing a
session. Add `-c` or `-s <id>` to append the run to a session instead.

| Flag | Description |
|---|---|
| `-m, --model <ref>` | Override the configured model (`provider/modelKey`, or a bare provider id to auto-select). |
| `-p, --print <prompt>` | Run non-interactively and print the answer. |
| `-c, --continue` | Resume the latest session for this directory. |
| `-s, --session <id>` | Resume a specific session. |
| `--config <path>` | Use only this config file, replacing the normal global/project search. |
| `--cwd <dir>` | Set the working directory. |
| `--yolo` | Auto-approve every tool call. |
| `--no-tools` | Disable tool use for this run. |
| `--max-turns <n>` | Cap agent turns (default: 32). |
| `--verbose` | Stream reasoning and token usage to stderr. |
| `--list-models` | List available models (same as `buka models`). |
| `--show-prompt` | Print the assembled system prompt and exit. |
| `--yes` | With `init`, write the starter config without the interactive picker. |
| `-h, --help` | Show help. |
| `-v, --version` | Print the version. |

**Examples**

```bash
# Ask a question about the current repository
buka -p "explain the request flow in src/"

# Resume the last session and continue the task
buka -c -p "now add tests for that"

# Run unattended with a specific model
buka --yolo -m 9router/default -p "refactor utils.ts and run the tests"

# Inspect exactly what the model is being told
buka --show-prompt
```

### Keybindings

| Key | Action |
|---|---|
| `Enter` | Send; queues the message while the agent is running (`busyInput: "queue"`, the default). |
| `Alt+Enter` / `Ctrl+J` | Insert a new line. |
| `Esc` | Stop the running turn, or close a panel. |
| `PgUp` / `PgDn` | Scroll the transcript. |
| `Ctrl+P` | Open the command palette. |
| `Ctrl+X` | Open the session switcher, or the queue when messages are waiting. |
| `Ctrl+K` | Open the model picker. |
| `Ctrl+B` | Toggle the sidebar. |
| `Ctrl+T` | Expand or collapse thinking. |
| `Ctrl+O` | Expand or collapse tool output. |
| `Up` / `Down` | Prompt history when the cursor is on the first or last row. |
| `Home` / `End` | Start or end of the current line. |
| `Ctrl+A` / `Ctrl+E` | Start or end of line. |
| `Ctrl+U` / `Ctrl+W` | Delete to line start / delete the previous word. |
| `Ctrl+D` | Delete the character under the cursor. |
| `Ctrl+G` | Jump to the newest output. |
| `Ctrl+L` | Clear the visible transcript. |
| `Ctrl+C` | Stop the running turn; when idle, clear the input, then the queue, then quit. |

### Slash commands

| Command | Description |
|---|---|
| `/help` | Show commands and keybindings. |
| `/model [ref]` | Switch model; without an argument, open the model picker. |
| `/models` | List every available model. |
| `/provider [id]` | Switch provider, or open the provider manager to add one. |
| `/sessions` | Browse and resume past sessions. |
| `/new` | Start a fresh session. |
| `/rename <title>` | Name the current session. |
| `/clear` | Clear the visible transcript; the session file is kept. |
| `/compact` | Summarise earlier turns to shrink the context window. |
| `/tools` | List the tools the agent can use. |
| `/theme [name]` | Switch the colour theme; without an argument, list them. |
| `/export [file]` | Write the conversation to a Markdown file. |
| `/exit` | Quit. |

Commands live in a single registry (`src/tui/commands.ts`) that also feeds the
in-app help, slash autocomplete, and command palette, so the documentation cannot
drift from what is actually runnable.

---

## Configuration

Configuration is loaded from:

- **Global:** `~/.config/buka-ai/buka.jsonc` (XDG-aware)
- **Project:** `./buka.jsonc`, merged over the global file

At either level, `buka.json` and `.bukarc.jsonc` are also recognized. With
`--config`, only that file is loaded; the global and project search is skipped.

```jsonc
{
  "model": "9router/default",

  "providers": {
    "9router": {
      "name": "9Router",
      "type": "openai-compatible",
      "baseURL": "http://127.0.0.1:20128/v1",
      // Secrets: {env:VAR} or {file:/path/to/key}
      "apiKey": "{env:BUKA_9ROUTER_KEY}",
      // Optional extra request headers; auth headers are still set by the adapter
      "headers": { "X-Title": "buka" },
      // Discover models from the endpoint's /v1/models
      "discover": true,
      "models": {
        "default": {
          "id": "deepseek-v4.1-flash", // wire id, when it differs from the key
          "name": "Default route",
          "tools": true,
          "reasoning": true,
          "context": 1000000,
          "output": 128000
        }
      }
    }
  },

  "permission": {
    "read": "allow", "glob": "allow", "grep": "allow", "list": "allow",
    "bash": "ask",   "write": "ask",  "edit": "ask"
  },

  "tui": {
    // auto | dark | light | buka | opencode | hermes | classic
    "theme": "auto",
    // auto hides the sidebar below 100 columns
    "sidebar": "auto",
    "animations": true,
    // queue: Enter while the agent is running adds a message for the next turn
    "busyInput": "queue",
    "showThinking": true,
    "showTokenUsage": true
  }
}
```

### Providers

Run `buka setup` (or just start `buka` for the first time) to pick a provider.
The picker has presets for 9Router, OpenAI, OpenRouter, Anthropic, Google Gemini,
DeepSeek, Groq, xAI, Mistral, Together AI, Fireworks, Ollama, LM Studio, and any
custom OpenAI-compatible endpoint. Anthropic and Gemini use native adapters;
everything else uses the OpenAI-compatible client.

A provider entry needs a `baseURL`; `type` is one of `openai-compatible`
(default), `anthropic`, or `google`. The API key may be a literal value,
`{env:VAR}`, or `{file:/path/to/key}`. Setup stores typed keys in
`~/.config/buka-ai/secrets/<provider>.key` (mode `0600`) and writes a
`{file:...}` reference into the config. Optional `headers` are merged into every
request; authentication headers are applied last by the adapter.

If no config exists and `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`
(or its alias `GOOGLE_API_KEY`), or `BUKA_9ROUTER_KEY` is set, `buka` uses the
matching built-in provider. When the built-in provider is used, `BUKA_MODEL`
selects the default model. A config that only sets some keys still keeps the
built-in provider unless it defines `providers` itself.

Use `/provider` inside the TUI to see configured providers, add a new one, or
switch to another provider's models without restarting.

Setup merges the new provider into the existing config and keeps a
`<config>.bak` copy before rewriting it. The rewrite normalizes formatting, so
comments in a hand-edited file may be dropped; the backup keeps the original.

**Model references split on the first slash only.** Model ids legitimately
contain slashes (`Hr/claude-sonnet-4.6`, `@cf/meta/llama-3.2-1b-instruct`), so
`9router/Hr/glm-5.3` means provider `9router`, model `Hr/glm-5.3`. Anything not
declared in `models` is used as the wire id verbatim, which lets discovery and
hand-written configs mix cleanly. A bare provider id (no slash) auto-selects a
suitable model for that provider.

### Permissions

Each tool can be set to:

| Mode | Behaviour |
|---|---|
| `allow` | Run immediately. |
| `ask` | Prompt for approval in the TUI. |
| `deny` | Refuse; the model is told the tool is unavailable. |

The built-in defaults are `allow` for the read-only tools (`read`, `glob`,
`grep`, `list`) and `ask` for `bash`, `write`, and `edit`; an unknown tool falls
back to `ask`, never to unattended execution. During an approval prompt, `y`
allows once, `n` denies, and `a` allows that tool for the rest of the session.

### TUI

| Key | Values | Default | Description |
|---|---|---|---|
| `theme` | `auto`, `dark`, `light`, `buka`, `opencode`, `hermes`, `classic` | `auto` | Colour palette. `auto` follows the terminal background. |
| `sidebar` | `auto`, `true`, `false` | `auto` | `auto` shows the sidebar only on wide terminals. |
| `animations` | boolean | `true` | Spinner and activity animations. |
| `busyInput` | `queue`, `block` | `queue` | What `Enter` does while the agent is running. |
| `showThinking` | boolean | `true` | Show collapsible reasoning blocks. |
| `showTokenUsage` | boolean | `true` | Show token usage in the status line. |

### System prompt

The system prompt is a file, not a build-time constant:

```bash
$EDITOR ~/.config/buka-ai/SYSTEM_PROMPT.md
# restart buka
```

- The file is created automatically on first use, seeded from the repository
  copy.
- HTML comments are stripped before sending, so the file can carry usage notes
  without them reaching the model.
- The `Environment` block and the `Available tools` list are appended
  automatically.
- A missing or empty file falls back to the built-in default and reports why.
- Because the editable copy lives in your config directory, a `git pull` cannot
  overwrite your changes.

Inspect the exact prompt that would be sent:

```bash
buka --show-prompt
```

---

## Architecture

```text
SYSTEM_PROMPT.md            the built-in prompt (also seeds ~/.config)
src/
├─ cli.tsx                  entry point, flag parsing, subcommands
├─ runtime.ts               config + registry + model + resolved prompt
├─ config/
│  ├─ schema.ts             zod schema (the config contract)
│  ├─ load.ts               JSONC loader, merging, secret resolution
│  ├─ providers.ts          provider presets for first-run setup
│  ├─ setup.ts              provider wizard persistence + discovery
│  └─ paths.ts              XDG paths
├─ setup/
│  ├─ app.tsx               first-run / in-TUI provider picker
│  └─ run.ts                standalone setup renderer
├─ provider/
│  ├─ types.ts              wire types + normalized event stream
│  ├─ factory.ts            chooses the native or compatible adapter
│  ├─ openai-compat.ts      /chat/completions client (SSE)
│  ├─ anthropic.ts          Anthropic Messages API adapter
│  ├─ google.ts             Gemini streamGenerateContent adapter
│  └─ registry.ts           "provider/model" resolution, discovery
├─ agent/
│  ├─ loop.ts               the agent loop: stream → tools → repeat
│  ├─ prompt.ts             resolves + seeds SYSTEM_PROMPT.md
│  ├─ system-prompt.ts      appends environment + tool list
│  ├─ permission.ts         ask / allow / deny policy
│  └─ tools/                read, write, edit, glob, grep, list, bash
│                           (diff, registry, shared helpers)
├─ session/store.ts         append-only JSONL log, context rebuild
├─ run/print.ts             non-interactive runner
├─ tui/
│  ├─ app.tsx               root component, keybindings, agent pump, queue
│  ├─ brand.ts              terminal-ghost mascot for the welcome banner
│  ├─ commands.ts           slash-command registry
│  ├─ chrome.tsx            sidebar, top bar, composer, status line, banner
│  ├─ dialogs.tsx           centered dialog and completion-panel builders
│  ├─ layout.ts             pure pane geometry, sidebar breakpoints
│  ├─ theme.ts              palettes, auto light/dark, live palette view
│  ├─ blocks.ts             message → styled display lines (incl. diffs)
│  ├─ highlight.ts          stateful syntax scanner (no dependency)
│  ├─ text.ts               cell-accurate measurement and wrapping
│  ├─ editor.ts             pure text-editing operations
│  ├─ session-view.ts       stored records → display parts
│  ├─ changes.ts            files touched by edit/write, for the sidebar
│  ├─ types.ts              state + reducer + ordered message parts
│  └─ components.tsx        line primitives
└─ util/                    SSE parser, JSONC, args, theme, git, http
```

A request flows through five layers, each with a single responsibility:

```text
cli.tsx ──► runtime.ts ──► agent/loop.ts ──► provider/factory.ts ──► network
                                                ├─ openai-compat.ts
                                                ├─ anthropic.ts
                                                └─ google.ts
                              │
                              ├─► tools/* ──► filesystem / shell
                              └─► events ──► tui/app.tsx  (or)  run/print.ts
                                                    │
                                              session/store.ts
```

The agent loop yields **normalized events** (`text`, `reasoning`, `tool_start`,
`usage`, `done`, and others), so the TUI and the non-interactive runner share all
protocol logic and neither needs to know what an SSE chunk looks like.

---

## Design notes

The decisions below were driven by concrete problems encountered while building
and using the agent.

**Streaming is always requested, even for one-shot answers.** Some gateways
corrupt non-streaming bodies — one appended a stray `data: [DONE]` to valid JSON.
The client asks for SSE unconditionally and only reads a whole JSON body when the
server explicitly returns `application/json`, tolerating trailing garbage.

**The returned model name is the source of truth.** Alias and "combo" endpoints
resolve to a different upstream model: requesting a combo alias can stream chunks
labelled `deepseek-v4.1-flash`. The header shows both names, and the session
records the upstream name because that is what actually ran.

**Edits are strict on purpose.** `edit` requires `oldString` to appear exactly
once. Zero matches is an error with guidance to re-read the file; multiple
matches is an error suggesting more context or `replaceAll: true`. Both failures
are cheaper than a silently corrupted file.

**Tool output is capped, and says so.** Every tool truncates with an explicit
`… output truncated: showing N of M lines`, so the model learns the shape of what
it is missing and can request a narrower slice.

**Subprocesses do not inherit credentials.** `bash` runs with an environment
scrubbed of `OPENAI_*`, `ANTHROPIC_*`, `AWS_*`, `BUKA_*`, `GH_*`, and similar
variables. A shell command has no business reading the key `buka` itself holds.

**The TUI owns its layout.** Each message is compiled into display lines that are
already wrapped and measured in terminal cells (CJK and emoji count as two). The
viewport slices that array, which makes scrolling exact and desynchronisation
impossible. Layout tests render the real screen at multiple widths and assert
that no row overflows.

**The prompt is a file, not a constant.** The first version embedded the system
prompt in TypeScript, so changing a word required a rebuild and the config could
disagree with the code. Now there is exactly one built-in prompt file and one
user copy seeded from it; the source tree contains no prompt string.

**Distinct turns are distinct paragraphs.** A multi-turn tool run used to
concatenate each turn's text verbatim, fusing sentences together. The loop now
inserts a paragraph break at turn boundaries.

**Sessions have a deterministic total order.** Sorting by `updatedAt` alone is
not enough: two sessions created in the same millisecond come back in filesystem
order. Ordering falls back to `createdAt` and then `id`, which makes `buka -c`
predictable.

**`/compact` shrinks the context, not the record.** The append-only log remains
the truth of what happened. Compaction records a boundary, and `toChatMessages()`
starts from the most recent boundary.

**Ordered parts, because grouping lies.** Storing a message as `{ text, tools[] }`
and rendering all text before all tools silently reordered real work. Messages
now hold an ordered `parts` array, and the session log preserves the same order.

**Queueing beats refusing.** Input received while a turn is running is queued and
painted above the composer, then drained when the turn finishes.

---

## Testing

```bash
npm test              # 245 unit and integration tests, no network required
npm run test:smoke    # 35 end-to-end TUI checks (requires a live provider)
npm run typecheck     # src + tests, strict, noUnusedLocals
```

The suite covers the pure and near-pure layers: text measurement and wrapping,
the input editor, the reducer (including the queue), theme resolution, unified
diffs, Markdown rendering, the syntax highlighter, prompt resolution, argument
parsing, JSONC, config merging, secret resolution, all seven tools against a real
temporary filesystem, the session store, provider protocol decoding, and layout
invariants.

The agent loop is tested directly with a scripted fake provider, so multi-turn
tool chaining, permission modes, the turn ceiling, aborts, malformed tool
arguments, and provider failures are deterministic and instant. Provider setup
tests cover config merging and secret permissions, and the native Anthropic and
Gemini adapters are exercised against local SSE fixtures.

Two suites exist specifically to prevent documentation drift: one reads the real
key handlers and command registry and requires them to be documented in both
`/help` and this README; the layout suite renders the real screen to prove that a
row can never overflow.

CI runs typechecking, the full suite, and a build on Node 22 and Node 24, then
boots the compiled CLI. A separate job exercises the installer and its
uninstaller. See the **Actions** tab for the latest run (workflow badges do not
render on private repositories).

The screenshot at the top of this README is generated by `test/capture.tsx`,
which runs a genuine session and re-renders the real components with the captured
state.

---

## Development

```bash
npm run dev            # run from source (tsx)
npm run typecheck      # src + test, strict
npm test               # unit + integration
npm run test:smoke     # end-to-end TUI (requires a live provider)
npm run build          # compile to dist/
```

Release notes live in [CHANGELOG.md](./CHANGELOG.md).

### Adding a tool

Create a file in `src/agent/tools/`, implement the `Tool` interface, and register
it in `tools/index.ts`. Name it after its `permission` key so the policy lines up
without a translation table. Add the same key to `PermissionSchema` in
`src/config/schema.ts` and the `permission` example above so it can be
configured.

```ts
export const myTool: Tool = {
  name: "myTool",
  description: "Shown to the model — be specific about when to use it.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  summarize: (args) => String((args as { path?: string }).path ?? "?"),
  async execute(args, ctx) {
    // ctx.cwd, ctx.signal, ctx.requestPermission
    return { output: "text handed back to the model", summary: "short label for the TUI" };
  },
};
```

---

## Contributing

1. Fork the repository and create a topic branch.
2. Keep changes focused; include tests for behaviour changes.
3. Run `npm run typecheck` and `npm test` before opening a pull request.
4. Describe the problem and the approach in the pull request.

Bug reports and feature requests are welcome via GitHub Issues. For security
issues, please report them privately rather than opening a public issue.

---

## Limitations

An honest list, not a roadmap:

- **Markdown is deliberately minimal** — fenced code (highlighted), headings,
  bullets, blockquotes, inline code/bold/italic. No tables, links, or nested
  lists.
- **No mouse capture.** Ink has no mouse API, so selection and clickable overlays
  are unavailable. The interface is keyboard-only.
- **The sidebar needs width.** `auto` hides it below 100 columns. It can be
  forced with `tui.sidebar: true`, but code will wrap more.
- **The highlighter supports a fixed language set** — JavaScript/TypeScript,
  JSON, Python, shell, YAML, and diff. Unknown languages render plain rather than
  being guessed at.
- **Tool output is not highlighted**, only fenced code in the answer. Tool output
  is shown verbatim.
- **`grep` prefers `rg`** and falls back to a JavaScript walker (slower; skips
  files over 4 MB and build/vendor directories).
- **API keys, not OAuth.** Providers are configured with a key; browser/OAuth
  login flows are not implemented.
- **Images and PDFs** are typed but not yet plumbed from the TUI into requests.

---

## License

MIT — see [LICENSE](./LICENSE).
