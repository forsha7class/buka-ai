<div align="center">

# buka ai

**A terminal-native AI coding agent — full-screen TUI, real tool use, resumable sessions.**

[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-233%20passing-3fb950)](#testing)
[![TUI checks](https://img.shields.io/badge/TUI%20checks-35%20passing-3fb950)](#testing)
[![Provider SDK](https://img.shields.io/badge/provider%20SDK-none-8b5cf6)](#design-notes)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)

</div>

```
 buka ai · 0.3.0            │ Fix flaky users test · ~/buka-ai/main        ● ready  22.3k tok
 9router/davo               │
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

<sub>↑ a real session, not a mockup. The model ran the tests, read the code, fixed two files and re-ran the suite to prove it.</sub>

---

## What it is

`buka` is a chat CLI that can actually *do* things in your repository: read and
edit files, run commands, search code, and keep working until the task is done.
It runs in the terminal you already have, against any OpenAI-compatible
endpoint.

No provider SDK, no daemon, no database. One command, one config file.

```bash
buka                          # interactive TUI
buka -p "explain src/auth.ts" # one-shot, pipeable
buka -c                       # resume the last session in this directory
```

---

## Features

**A TUI that behaves like an application, not a log**

Alternate screen, its own scrollback, a block cursor, collapsible thinking and
expandable tool output. The transcript is rendered as a list of pre-wrapped
lines that the viewport slices, so scrolling is exact and the layout never
drifts — `test/layout.test.ts` asserts that no row can ever wrap or overflow.

**A split pane, not a wall of text**

On terminals 100 columns or wider, a sidebar shows the session, the model and
its wire name, a context-usage bar, the files the agent has changed, and the
keys that do something right now. Narrow terminals drop it and keep the same
single-column transcript. A top bar carries the working directory and git
branch; the composer is a real box, and the status line sits underneath it.

**Hermes-style flow**

Typing `/` opens a floating command palette with descriptions; `Tab` completes,
`Enter` runs. `Ctrl+P` opens the full command palette. Typing while the agent is
working queues the message instead of dropping it, and the queue drains after
the current turn. A spinner and elapsed time show what is running, and a welcome
card replaces the empty transcript.

**Themes that are actually applied**

`tui.theme` was a config key with no effect before; now it selects a real
palette: `buka` (charcoal and amber, the default), `opencode`, `hermes`, `light`
and `classic` (the old lavender). `auto` follows the terminal background via
`COLORFGBG`, and `/theme` switches at runtime.

**Diffs for edits, not just "done"**

`edit` and `write` return a unified diff in tool metadata. The transcript shows
the changed lines with `+added` / `−removed` counts, and a resumed session still
shows the same preview because the diff is stored with the tool result.

**A message is an ordered list of parts**

Not "some text plus a list of tools". One request can span many provider turns:
the model thinks, writes a sentence, calls a tool, thinks again, writes more.
Parts are kept in the order they happened and rendered that way, so the
transcript reads the way the work actually went.

**Streaming that shows its work**

Tokens appear as they arrive. Chain-of-thought (`reasoning_content`) is captured
separately and shown as a collapsed block you can open with `Ctrl+T`, instead of
being dumped into the answer.

**Syntax highlighting, without a megabyte of grammars**

Fenced code is highlighted by a hand-written, stateful scanner: correct string
and comment handling, block comments and template literals that carry across
lines, `$vars` highlighted inside shell quotes, diff hunks coloured by line.
Unknown languages are left plain rather than guessed at.

**Seven tools, a real agent loop**

`read` `write` `edit` `glob` `grep` `list` `bash` — chained across turns, with a
turn ceiling as a safety valve. The loop is provider-agnostic and directly unit
tested against a scripted provider.

**Permissions you can actually reason about**

Per-tool `ask` / `allow` / `deny`. A tool that isn't in the config defaults to
`ask`, never to "run unattended". Approval is `y` / `n` / `a` (always, for that
tool). A denial is reported back to the model as a refusal to retry, not as a
silent failure.

**Sessions that survive the process**

Append-only JSONL under `~/.local/share/buka-ai/sessions/`. Resume from a
different process and the conversation continues — tool calls, results and part
order included, in the exact shape the provider expects.

**Compaction that persists**

`/compact` asks the model to summarise the conversation and records the boundary
in the log. Resuming continues from the summary instead of reloading every turn.
The log itself is never rewritten — it stays the record of what actually
happened.

**Multi-provider, discovered**

Declare providers in JSONC; `buka` pulls the model list from `/v1/models` so you
don't maintain it by hand. Switch models mid-session with `Ctrl+K`. With no
config at all it finds a local gateway and picks a tool-capable model.

---

## Quickstart

```bash
git clone <this-repo> buka-ai && cd buka-ai
npm install
npm run build
npm link          # gives you the `buka` command

buka              # go
```

Requires **Node >= 22**. Point it at any OpenAI-compatible endpoint:

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1
buka
```

For a richer setup (multiple providers, permissions, a custom system prompt):

```bash
buka init         # writes ~/.config/buka-ai/buka.jsonc
```

---

## Usage

| Command | What it does |
|---|---|
| `buka` | start the interactive TUI |
| `buka -p "<prompt>"` | one-shot: answer to stdout, diagnostics to stderr |
| `buka -c` | resume the most recent session for this directory |
| `buka -s <id>` | resume a specific session |
| `buka models` | list every available model |
| `buka sessions` | list saved sessions |
| `buka init` | write a starter config |

| Flag | Meaning |
|---|---|
| `-m, --model <ref>` | override the model (`provider/modelKey`) |
| `-p, --print <prompt>` | run non-interactively |
| `-c, --continue` | resume the latest session for this directory |
| `-s, --session <id>` | resume a specific session |
| `--config <path>` | use a specific config file |
| `--cwd <dir>` | set the working directory |
| `--yolo` | auto-approve every tool call |
| `--no-tools` | disable tool use for this run |
| `--max-turns <n>` | cap agent turns (default 32) |
| `--verbose` | stream reasoning + token usage to stderr |
| `--show-prompt` | print the system prompt that would be sent, then exit |

### Keybindings

| Key | Action |
|---|---|
| `Enter` | send |
| `Alt+Enter` / `Ctrl+J` | new line |
| `Esc` | stop the running turn |
| `PgUp` / `PgDn` | scroll the transcript |
| `Ctrl+P` | command palette |
| `Ctrl+X` | session switcher, or the queue when messages are waiting |
| `Ctrl+K` | model picker |
| `Ctrl+B` | toggle the sidebar |
| `Ctrl+T` | expand / collapse thinking |
| `Ctrl+O` | expand / collapse tool output |
| `↑` / `↓` | prompt history (when the cursor is on the first/last row) |
| `Home` / `End` | start / end of the current line |
| `Ctrl+A` / `Ctrl+E` | start / end of line |
| `Ctrl+U` / `Ctrl+W` | delete to line start / delete word |
| `Ctrl+D` | delete the character under the cursor |
| `Ctrl+G` | jump back to the newest output |
| `Ctrl+L` | clear the visible transcript |
| `Ctrl+C` | stop → clear input → quit |

### Slash commands

`/help` `/model [ref]` `/models` `/sessions` `/new` `/rename <title>`
`/compact` `/clear` `/tools` `/theme [name]` `/export [file]` `/exit`

Commands live in one registry (`src/tui/commands.ts`) that also feeds the slash
autocomplete and the `Ctrl+P` palette, so help text cannot drift from what is
actually runnable.

`/compact` asks the model to summarise the conversation and records the boundary
in the session log, so resuming continues from the summary instead of reloading
every turn. The log itself keeps the full history — only what is sent to the
provider shrinks.

---

## Configuration

Global: `~/.config/buka-ai/buka.jsonc` · Project: `./buka.jsonc` (merged over global)

```jsonc
{
  "model": "9router/davo",

  "providers": {
    "9router": {
      "name": "9Router",
      "type": "openai-compatible",
      "baseURL": "http://127.0.0.1:20128/v1",
      // {env:VAR} or {file:/path/to/key}
      "apiKey": "{env:BUKA_9ROUTER_KEY}",
      "discover": true,              // pull the model list from /v1/models
      "models": {
        "davo": {
          "id": "Davo",              // wire id, when it differs from the key
          "name": "Davo (combo)",
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

The system prompt is deliberately **not** in this file — see
[Changing the system prompt](#changing-the-system-prompt).

Any OpenAI-compatible endpoint works: OpenAI, OpenRouter, Groq, Ollama,
llama.cpp, vLLM, or a local gateway in front of all of them.

> **Model references split on the *first* slash only** — model ids legitimately
> contain slashes (`Hr/claude-sonnet-4.6`,
> `@cf/meta/llama-3.2-1b-instruct`). So `9router/Hr/glm-5.3` means provider
> `9router`, model `Hr/glm-5.3`. Anything not listed in `models` is used as the
> wire id verbatim, which is why discovery and hand-written configs mix cleanly.

A config that only sets some keys still gets the built-in provider — writing
`{"permission": {"bash": "deny"}}` does not leave you without providers.

### Changing the system prompt

One file, no rebuild:

```bash
$EDITOR ~/.config/buka-ai/SYSTEM_PROMPT.md
# then restart buka
```

- It is **created automatically** the first time `buka` needs a prompt, seeded
  from the repository copy, so there is always a real file to open.
- **HTML comments are stripped** before sending, so the file can carry usage
  notes without them reaching the model.
- The `Environment` block and the `Available tools` list are appended for you.
- Missing or empty (comments only)? It falls back to the built-in default and
  tells you why.
- Sitting in your config directory rather than the repository means a
  `git pull` can never clobber your edits.

```bash
buka --show-prompt    # exactly what would be sent, plus which file it came from
```

`--show-prompt` is the honest answer to "what is this thing actually being told?"
There is no hardcoded prompt string anywhere in the source tree — the repository
copy at `SYSTEM_PROMPT.md` is the only built-in, and it is just a file.

---

## Architecture

```
SYSTEM_PROMPT.md            the one built-in prompt (also seeds ~/.config)
src/
├─ cli.tsx                  entry point, flag parsing, subcommands
├─ runtime.ts               config + registry + model + resolved prompt
├─ config/
│  ├─ schema.ts             zod schema (the config contract)
│  ├─ load.ts               JSONC loader, merging, secret resolution
│  └─ paths.ts              XDG paths
├─ provider/
│  ├─ types.ts              wire types + normalized event stream
│  ├─ openai-compat.ts      /chat/completions client (SSE)
│  └─ registry.ts           "provider/model" resolution, discovery
├─ agent/
│  ├─ loop.ts               the agent loop: stream → tools → repeat
│  ├─ prompt.ts             resolves + seeds SYSTEM_PROMPT.md
│  ├─ system-prompt.ts      appends environment + tool list
│  ├─ permission.ts         ask / allow / deny policy
│  └─ tools/                read, write, edit, glob, grep, list, bash
├─ session/store.ts         append-only JSONL log, context rebuild
├─ run/print.ts             non-interactive runner
├─ tui/
│  ├─ app.tsx               root component, keybindings, agent pump, queue
│  ├─ commands.ts           slash-command registry (help + autocomplete + palette)
│  ├─ chrome.tsx            sidebar, top bar, composer, status line, banner
│  ├─ dialogs.tsx           centered dialog and completion-panel line builders
│  ├─ layout.ts             pure pane geometry, sidebar breakpoints
│  ├─ theme.ts              palettes, auto light/dark, live `palette` view
│  ├─ blocks.ts             message → styled display lines (incl. diffs)
│  ├─ highlight.ts          stateful syntax scanner (no dependency)
│  ├─ text.ts               cell-accurate measurement and wrapping
│  ├─ editor.ts             pure text-editing operations
│  ├─ session-view.ts       stored records → display parts
│  ├─ changes.ts            files touched by edit/write, for the sidebar
│  ├─ types.ts              state + reducer + ordered message parts
│  └─ components.tsx        line primitives (`Segments`, `LineList`, `row`)
└─ util/                    SSE parser, JSONC, args, theme, git, http
```

A request flows through five layers with one job each:

```
cli.tsx ──► runtime.ts ──► agent/loop.ts ──► provider/openai-compat.ts ──► network
                              │
                              ├─► tools/* ──► filesystem / shell
                              └─► events ──► tui/app.tsx  (or)  run/print.ts
                                                    │
                                              session/store.ts
```

The agent loop yields **normalized events** (`text`, `reasoning`, `tool_start`,
`usage`, `done`, …), which is why the TUI and the non-interactive runner share
all protocol logic and neither knows what an SSE chunk looks like.

---

## Design notes

The interesting decisions, and the real-world problems that forced them.

**Streaming is always requested, even for "one-shot" answers.**
Some gateways corrupt the non-streaming body — the one in front of this project
appends a stray `data: [DONE]` to a perfectly valid JSON object, so a naive
`JSON.parse` throws. The client asks for SSE unconditionally, and only falls back
to reading a whole JSON body when the server explicitly says
`content-type: application/json`. It then extracts the first complete JSON
object, tolerant of trailing garbage. Regression tested with the exact bytes
that gateway returns.

**The model name that comes back is not the one you asked for.**
Alias and "combo" endpoints resolve to a different upstream model: requesting
`Davo` streams chunks labelled `deepseek-v4.1-flash`. `chunk.model` is treated as
the source of truth, the header shows both, and the session records the upstream
name — because that is what actually ran.

**Edits are strict on purpose.**
`edit` requires `oldString` to appear exactly once. Zero matches is an error with
guidance to re-read the file; multiple matches is an error suggesting more
context or `replaceAll: true`. Both failures are far cheaper than a silently
corrupted file, and they give the model something actionable to correct.

**Tool output is capped, and says so.**
Every tool truncates with an explicit `… output truncated: showing N of M lines`,
so the model learns the shape of what it is missing and can ask for a narrower
slice instead of hallucinating the rest.

**Subprocesses do not inherit your credentials.**
`bash` runs with an environment scrubbed of `OPENAI_*`, `ANTHROPIC_*`, `AWS_*`,
`BUKA_*`, `GH_*` and friends. A shell command has no business reading the key
`buka` itself is holding — and it is asserted in `test/tools.test.ts`.

**The TUI owns its own layout.**
Rather than depending on how a React renderer decides to wrap text, each message
is compiled into an array of display lines that are already wrapped and measured
in terminal cells (CJK and emoji counted as two). The viewport slices that array.
This is what makes scrolling exact, the header guaranteed one line, and the
chrome impossible to desynchronise — all of it locked down by layout tests
across five terminal widths.

**The prompt is a file, not a constant.**
The first version embedded the system prompt in TypeScript, which meant changing
a word required editing source and rebuilding — and the config could override it,
so there were two places claiming to be the truth. Now there is exactly one
built-in (`SYSTEM_PROMPT.md`, a plain file) and one user copy in the config
directory that seeds from it. The source tree contains no prompt string at all.
The old `systemPrompt` / `systemPromptFile` config keys are gone; a config still
carrying them gets a warning naming the new file rather than being silently
ignored.

**Distinct turns are distinct paragraphs.**
A multi-turn tool run used to concatenate each turn's text verbatim, so a
sentence ending one turn fused onto the first word of the next
(literally: ``…`/not found/`.Beres.``). The loop now inserts a paragraph break at
turn boundaries, and a fake-provider test pins the behaviour.

**Sessions have a total order.**
Ordering by `updatedAt` alone is not enough: two sessions created in the same
millisecond come back in filesystem order, and `latest()` decides what `buka -c`
resumes. The sort falls back to `createdAt` and then `id`.

**`/compact` shrinks the context, not the record.**
The session log is the append-only truth of what happened. Rewriting it to
summarise would be a lie, so compaction records a boundary instead:
`toChatMessages()` starts from the most recent boundary, so resuming continues
from the summary. The full history stays on disk, and the message count still
reflects the real turns.

**Ordered parts, because grouping lies.**
The first version stored a message as `{ text, tools[] }` and rendered all the
text followed by all the tools. A real run reads "thinking → sentence → tool →
more thinking → answer", so that layout silently reordered the work. Messages now
hold an ordered `parts` array, and the session log stores the same order so a
resumed transcript replays identically.

**A highlighter worth its weight.**
`highlight.js`/`shiki` mean megabytes of grammars and startup cost for a CLI that
mostly prints fragments of JavaScript and shell. The scanner here is a few hundred
lines with no dependency: it carries state across lines (block comments, template
literals, triple-quoted strings), highlights `$vars` inside shell double quotes,
and colours diff hunks by line. It refuses to guess — an unknown language renders
plain rather than mangled. The one invariant that really matters is asserted
directly: highlighting never adds, drops or reorders a single character.

**The shell is geometry, not vibes.**
Ink has no overlay, no z-index and no mouse. So the layout is arithmetic: a pure
`computeLayout` decides the sidebar width, the transcript height, the composer
rows and the dialog box, and the panes must add up to the terminal height
exactly. `test/layout.test.ts` renders the real screen at seven widths and
asserts every row fits. A dialog is not painted on top of the transcript — it
*is* the transcript for as long as it is open, which is the only thing Ink can
actually do reliably.

**The theme is a live view, not a copy.**
Components read `palette` during render, and `palette` is a set of getters over
the active theme. Nothing captures a colour at import time — a module-level
`TOKEN_STYLE` object was the first thing that broke when `/theme` was added, so
it became a function. Switching a theme re-renders and every pane follows.

**Queueing beats refusing.**
The old behaviour silently dropped `Enter` while a turn was running. Now the
message is queued and painted above the composer, and the turn runner drains it
when it finishes. The queue is mirrored in React state for rendering and in a
ref for the runner, because the runner must not read state through a stale
closure.

**A diff belongs to the tool, not the renderer.**
`edit` and `write` know exactly what they changed, so they attach a unified diff
to `metadata` alongside the human summary. The TUI renders it, the session log
keeps it, and a resumed transcript shows the same preview. Reconstructing a diff
from `before`/`after` snapshots at render time would have been guesswork.

---

## Testing

```bash
npm test              # 233 unit + integration tests, no network required
npm run test:smoke    # 35 end-to-end TUI checks (needs a live provider)
npm run typecheck     # src + tests, strict, noUnusedLocals
```

The full suite, a build, and a real agent run through the compiled binary were
all verified on **Node 22.23.4 and Node 24.22.1** — the `>= 22` requirement is
tested, not assumed.

CI runs the typecheck, the whole suite and a build on both Node 22 and 24, then
boots the compiled CLI. See the **Actions** tab for the latest run — workflow
badges do not render on private repositories.

**233 tests** cover the pure and near-pure layers: text measurement and wrapping,
the input editor, the reducer (including the queue), theme resolution, unified
diffs, markdown rendering, the syntax highlighter, prompt resolution and comment
stripping, argument parsing, JSONC, config merging, secret resolution, all seven
tools against a real temp filesystem, the session store, provider protocol
decoding, and **layout invariants** — the full screen at forty to a hundred and
sixty columns, asserting no rendered row can ever exceed the terminal width and
that the panes fill the height exactly.

Two of those suites exist to stop documentation from drifting away from the code:
one reads the real key handlers out of `app.tsx` and the command registry out of
`commands.ts`, and requires them to be documented in both `/help` and the README;
the layout suite renders the real screen to prove a row can never overflow.

**The agent loop is tested directly.** `test/loop.test.ts` drives `runAgent`
with a scripted fake provider, so multi-turn tool chaining, permission modes,
the turn ceiling, aborts, malformed tool arguments and provider failures are all
deterministic and instant — no model, no network.

**The highlighter is tested by its invariants**, not by golden output: a corpus
in every supported language must round-trip character-for-character, malformed
input must never throw, block comments and template literals must carry across
lines, and a `//` inside a string must not become a comment.

**35 end-to-end TUI checks** run the real `<App />` on a fake TTY (a
`PassThrough` for stdin, a capturing `Writable` for stdout) and assert against
the component's committed state rather than scraping ANSI output. They cover the
permission prompt and denial path, session persistence to disk, scrolling, the
command palette, both pickers opening *and closing*, slash autocomplete,
`/compact` including its persistence to the log, and quitting.

There are also two debug probes kept around because they earn their place:
`npx tsx test/debug-keys.ts` (does this keybinding reach the app?) and
`npx tsx test/debug-picker.ts` (does this overlay open and close?). Both found
real bugs.

`test/capture.tsx` generates the screenshot at the top of this README by running
a genuine session and re-rendering the real components with the captured state —
so the image is exact, not a hand-drawn mockup.

---

## Development

```bash
npm run dev            # run from source (tsx)
npm run typecheck      # src + test, strict
npm test               # unit + integration
npm run test:smoke     # end-to-end TUI (needs a live provider)
npm run build          # compile to dist/
```

### Adding a tool

Drop a file in `src/agent/tools/`, implement the `Tool` interface, and register
it in `tools/index.ts`. Name it after its `permission` key so the policy lines up
without a translation table.

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

## Known limitations

Honest list, not a wishlist:

- **Markdown is deliberately minimal** — fenced code (highlighted), headings,
  bullets, blockquotes, inline code/bold/italic. No tables, links or nested lists.
- **No mouse capture.** Ink has no mouse API, so the drag-to-select and clickable
  overlay affordances from other TUIs are not available. Keyboard only.
- **The sidebar needs width.** `auto` hides it below 100 columns; force it with
  `tui.sidebar: true` and the composer will still be usable, but code wraps more.
- **The highlighter covers a fixed language set** — JS/TS, JSON, Python, shell,
  YAML and diff. Other languages render plain rather than being guessed at.
- **Transient tool output is not highlighted** — only fenced code in the answer
  is. Tool output is shown verbatim so you see exactly what the command printed.
- **`grep` uses `rg` when available**, and falls back to a JS walker otherwise
  (slower; skips files over 4 MB and build/vendor directories).
- **One transport: `openai-compatible`.** No native Anthropic Messages API, no
  OAuth flows.
- **Images/PDFs are typed but not plumbed** from the TUI into requests.

---

## License

MIT — see [LICENSE](./LICENSE).
