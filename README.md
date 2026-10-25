<div align="center">

# buka ai

**A terminal-native AI coding agent — full-screen TUI, real tool use, resumable sessions.**

[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-184%20passing-3fb950)](#testing)
[![TUI checks](https://img.shields.io/badge/TUI%20checks-31%20passing-3fb950)](#testing)
[![Provider SDK](https://img.shields.io/badge/provider%20SDK-none-8b5cf6)](#design-notes)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)

</div>

```
 buka ai  9router/Davo · deepseek-v4.1-flash  22.3k tok (17.7k cached)                      ● ready
▸ you
  Test-nya gagal. Cari penyebabnya, perbaiki, tunjukin diff-nya, terus jalanin test lagi. Ringkas
  aja.

◂ buka  deepseek-v4.1-flash
  ✻ thinking  139 chars  (ctrl+t to show)
  ⚙ bash  ls -la && git status --short && git log --oneline -5 ✓  exit code 0  (ctrl+o)
  ⚙ glob  **/* ✓  10 files  (ctrl+o)
  ⚙ read  package.json ✓  5 of 5 lines  (ctrl+o)
  ⚙ read  src/lib/store.js ✓  8 of 8 lines  (ctrl+o)
  ⚙ read  src/routes/users.js ✓  8 of 8 lines  (ctrl+o)
  ⚙ read  src/server.js ✓  9 of 9 lines  (ctrl+o)
  ⚙ read  test/users.test.js ✓  11 of 11 lines  (ctrl+o)
  ⚙ read  README.md ✓  3 of 3 lines  (ctrl+o)
  ⚙ bash  npm test 2>&1 | tail -40 ✓  exit code 0  (ctrl+o)
  ✻ thinking  705 chars  (ctrl+t to show)
  ⚙ bash  grep -rn "findUser" src test ✓  exit code 0  (ctrl+o)
  ✻ thinking  2390 chars  (ctrl+t to show)
  Penyebabnya: findUser mengembalikan undefined untuk id yang tidak ada, sedangkan test
  menuntut error /not found/. Route /users/:id juga ikut salah — untuk user hilang ia balas
  200 dengan body kosong (JSON.stringify(undefined)).
  ⚙ edit  src/lib/store.js ✓  1 replacement  (ctrl+o)
  ⚙ edit  src/routes/users.js ✓  1 replacement  (ctrl+o)
  ⚙ bash  git diff && echo "=== TEST ===" && npm test 2>&1 | tail -15 ✓  exit code 0  (ctrl+o)


  Beres. 2/2 test lulus.

  Penyebab: findUser balikin undefined untuk id tak dikenal, bukan melempar error — jadi
  assert.throws gagal.
────────────────────────────────────────────────────────────────────────────────────────────────────
> ask buka to do something, or /help
Enter send · Alt+Enter newline · Ctrl+P sessions · /help                                     turn 7
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

### Keybindings

| Key | Action |
|---|---|
| `Enter` | send |
| `Alt+Enter` / `Ctrl+J` | new line |
| `Esc` | stop the running turn |
| `PgUp` / `PgDn` | scroll the transcript |
| `Ctrl+K` | model picker |
| `Ctrl+P` | session picker |
| `Ctrl+T` | expand / collapse thinking |
| `Ctrl+O` | expand / collapse tool output |
| `↑` / `↓` | prompt history (when the cursor is on the first/last row) |
| `Ctrl+A` / `Ctrl+E` | start / end of line |
| `Ctrl+U` / `Ctrl+W` | delete to line start / delete word |
| `Ctrl+L` | clear the visible transcript |
| `Ctrl+C` | stop → clear input → quit |

### Slash commands

`/help` `/model [ref]` `/models` `/sessions` `/new` `/rename <title>`
`/compact` `/clear` `/tools` `/export [file]` `/exit`

`/compact` asks the model to summarise the conversation and then replaces the
in-memory context with that summary — useful once a session gets long. The
session file keeps the full history; only what is sent to the provider shrinks.

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

  "tui": { "theme": "dark", "showThinking": true, "showTokenUsage": true },

  // optional
  "systemPromptFile": "./AGENTS.md"
}
```

Any OpenAI-compatible endpoint works: OpenAI, OpenRouter, Groq, Ollama,
llama.cpp, vLLM, or a local gateway in front of all of them.

> **Model references split on the *first* slash only** — model ids legitimately
> contain slashes (`Hr/claude-sonnet-4.6`,
> `@cf/meta/llama-3.2-1b-instruct`). So `9router/Hr/glm-5.3` means provider
> `9router`, model `Hr/glm-5.3`. Anything not listed in `models` is used as the
> wire id verbatim, which is why discovery and hand-written configs mix cleanly.

---

## Architecture

```
src/
├─ cli.tsx                  entry point, flag parsing, subcommands
├─ runtime.ts               config + provider registry + selected model
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
│  ├─ system-prompt.ts      persona + environment
│  ├─ permission.ts         ask / allow / deny policy
│  └─ tools/                read, write, edit, glob, grep, list, bash
├─ session/store.ts         append-only JSONL log, context rebuild
├─ run/print.ts             non-interactive runner
├─ tui/
│  ├─ app.tsx               root component, keybindings, agent pump
│  ├─ blocks.ts             message → styled display lines
│  ├─ highlight.ts          stateful syntax scanner (no dependency)
│  ├─ text.ts               cell-accurate measurement and wrapping
│  ├─ editor.ts             pure text-editing operations
│  ├─ session-view.ts       stored records → display parts
│  ├─ types.ts              state + reducer + ordered message parts
│  └─ components.tsx        header, input, status bar, pickers
└─ util/                    SSE parser, JSONC, args, theme, http
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

---

## Testing

```bash
npm test              # 184 unit + integration tests, no network required
npm run test:smoke    # 31 end-to-end TUI checks (needs a live provider)
npm run typecheck     # src + tests, strict, noUnusedLocals
```

The full suite, a build, and a real agent run through the compiled binary were
all verified on **Node 22.23.4 and Node 24.22.1** — the `>= 22` requirement is
tested, not assumed.

**184 tests** cover the pure and near-pure layers: text measurement and wrapping,
the input editor, the reducer, markdown rendering, the syntax highlighter,
argument parsing, JSONC, config merging, secret resolution, all seven tools
against a real temp filesystem, the session store, provider protocol decoding,
and **layout invariants** (asserting no rendered row can ever exceed the terminal
width).

**The agent loop is tested directly.** `test/loop.test.ts` drives `runAgent`
with a scripted fake provider, so multi-turn tool chaining, permission modes,
the turn ceiling, aborts, malformed tool arguments and provider failures are all
deterministic and instant — no model, no network.

**The highlighter is tested by its invariants**, not by golden output: a corpus
in every supported language must round-trip character-for-character, malformed
input must never throw, block comments and template literals must carry across
lines, and a `//` inside a string must not become a comment.

**31 end-to-end TUI checks** run the real `<App />` on a fake TTY (a
`PassThrough` for stdin, a capturing `Writable` for stdout) and assert against
the component's committed state rather than scraping ANSI output. They cover the
permission prompt and denial path, session persistence to disk, scrolling,
both pickers opening *and closing*, `/compact` including its persistence to the
log, and quitting.

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
