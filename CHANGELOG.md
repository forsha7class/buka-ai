# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **First-run provider setup.** A fresh `buka` opens a provider picker with
  presets for 9Router, OpenAI, OpenRouter, Anthropic, Google Gemini, DeepSeek,
  Groq, xAI, Mistral, Together AI, Fireworks, Ollama and LM Studio, plus a
  custom OpenAI-compatible endpoint. `buka setup` opens the same wizard later.
- **An in-TUI provider manager.** `/provider` lists configured providers, lets
  you add one with an API key, and switches to its models without restarting.
- **Native Anthropic and Gemini adapters.** They speak each provider's native
  streaming protocol, tools, reasoning blocks and usage accounting rather than
  pretending they are OpenAI-compatible.
- **Secure key storage.** Keys typed in setup go to
  `~/.config/buka-ai/secrets/<provider>.key` with mode `0600`; the config stores
  only a `{file:...}` reference.
- **One-command install.** `install.sh` installs from a clone or a `curl` pipe,
  builds the project, and puts `buka` on `PATH`; `npm install` now builds
  automatically through a `prepare` script. The README documents the one-line
  install and uninstall paths.
- **A split-pane shell.** On terminals 100 columns or wider a sidebar shows the
  session, model and wire name, a context-usage bar, the files the agent has
  changed, and the active key hints. Narrow terminals keep the single-column
  transcript. A top bar carries the working directory and git branch; the prompt
  is a bordered composer and the status line sits underneath it.
- **Themes that are actually applied.** `tui.theme` was accepted and ignored; it
  now selects a palette: `buka` (default), `opencode`, `hermes`, `light`,
  `classic`, or `auto` to follow the terminal background. Switch at runtime with
  `/theme`.
- **A command registry** (`src/tui/commands.ts`) shared by the dispatcher, the
  in-app `/help`, the slash autocomplete and the command palette, so the four can
  no longer disagree.
- **Slash autocomplete and a command palette.** Typing `/` opens a floating list
  with descriptions (`Tab` completes, `Enter` runs); `Ctrl+P` opens the full
  palette. Both filter as you type.
- **A message queue.** `Enter` while the agent is running queues the message
  instead of dropping it; the queue is shown above the composer and drains after
  the current turn. Configurable with `tui.busyInput` (`queue` or `block`).
- **Diff previews.** `edit` and `write` attach a unified diff to their result
  metadata; the transcript shows the changed lines with `+added` / `−removed`
  counts, and a resumed session replays the same preview.
- **An activity line and welcome banner.** A spinner, the current action and
  elapsed time sit under the composer; the empty transcript shows a card with the
  model, cwd, tool count and key hints.
- **An animated Buka mascot.** The welcome banner blinks, floats and pulses its
  accent colour, with a compact variant for 24-row terminals. It respects
  `tui.animations` and `BUKA_NO_ANIMATION`.
- **New config:** `tui.sidebar` (`auto` | boolean) and `tui.animations`.
- **New keybinding:** `Ctrl+B` toggles the sidebar.
- A drift guard for the keybinding and slash-command documentation. It reads the
  real handlers out of `app.tsx` and the registry out of `commands.ts`, and
  requires every binding and every command to appear in both the in-app `/help`
  and the README table.

### Changed

- `buka init` opens the provider picker in an interactive terminal; `buka init
  --yes` keeps the old non-interactive starter-file behaviour for scripts.
- **Keybindings now follow the OpenCode/Hermes convention.** `Ctrl+P` is the
  command palette (it used to open the session picker), `Ctrl+X` opens the
  session picker — or the queue when messages are waiting — and `Ctrl+K` still
  opens the model picker.
- The default theme is charcoal with an amber accent; the previous lavender
  palette is available as `theme: "classic"`.
- `tui.theme: "dark"` / `"light"` from older configs still work and map onto the
  new themes.

### Fixed

- A fresh install no longer exits with `Could not choose a model automatically`
  when no provider is configured; setup runs before the first TUI.
- 9Router key detection now also checks `~/.config/opencode/9router-api-key` and
  `/opt/9router/api-key.txt`, not only the older `9router.key` path.
- `tui.theme` was silently ignored by the TUI; colour is now resolved from the
  config and re-applied on every render.
- `Ctrl+D`, `Ctrl+G`, `Home` and `End` were implemented but absent from both
  `/help` and the README. `Ctrl+J` was missing from `/help`.
- The `/compact` description still claimed it replaced "the in-memory context";
  since 0.2.0 it records a boundary in the session log and survives a restart.

## [0.3.0] - 2026-10-26

### Added

- **The system prompt is now a file you edit.** `~/.config/buka-ai/SYSTEM_PROMPT.md`
  is created automatically on first use and read on every run — change the
  wording and restart, no rebuild. HTML comments in the file are stripped before
  sending, so it can carry usage notes without them reaching the model.
- **`buka --show-prompt`** prints the exact assembled prompt (file text,
  environment, tool list) and reports which file it came from.
- The `Environment` block and `Available tools` list are appended automatically,
  so the prompt file only needs to contain the persona and rules.

### Changed

- **Breaking:** the `systemPrompt` and `systemPromptFile` config options are
  removed — the prompt has exactly one home now. A config that still sets them
  gets a warning pointing at the new file instead of being silently ignored.
- `buka init` now also creates the prompt file, and prefers a local key file over
  `{env:BUKA_9ROUTER_KEY}` when one exists — the previous starter config produced
  an immediate 401 on a machine without that variable set.
- A config that sets only some keys (say, `permission`) no longer wipes out the
  built-in provider. The default provider is merged whenever the config does not
  define `providers` itself.
- The assembled prompt is resolved once at startup and shared by the TUI, print
  mode and `--show-prompt`, instead of each building its own.

### Fixed

- Editing the prompt used to require a source change and a rebuild; the config
  override and the embedded default could disagree about what was being sent.

## [0.2.0] - 2026-10-25

### Added

- **Syntax highlighting** for fenced code blocks, via a hand-written stateful
  scanner (no dependency). Supports JavaScript/TypeScript, JSON, Python, shell,
  YAML and diff; block comments, template literals and triple-quoted strings
  carry across lines, and `$vars` are highlighted inside shell double quotes.
  Unknown languages render plain rather than being guessed at.
- **Ordered message parts.** A message is now a list of `thinking | text | tool`
  parts in the order the model produced them, so a multi-turn run reads as it
  actually happened instead of showing all the text and then all the tools.
  Tool parts are stored in the session log too, so a resumed transcript replays
  identically.
- **Persistent `/compact`.** Compaction records a boundary in the session log and
  `toChatMessages()` continues from it, so resuming picks up the summary instead
  of reloading every turn. The log itself is never rewritten.
- A `compaction` record type and a `compactions` count in `buka sessions`.
- `CHANGELOG.md`, `LICENSE`, `buka.example.jsonc` and a CI workflow.

### Changed

- Thinking bursts shorter than 40 characters are no longer rendered as their own
  block — a fragment before nearly every tool call buried the transcript. The
  full text remains in the session log.
- `Ctrl+O` toggles a tool in the message it belongs to, instead of every message
  that happens to share a tool-call id.
- Typechecking now covers `test/` as well as `src/`, with `noUnusedLocals` and
  `noUnusedParameters` enabled.

### Fixed

- Text produced by different provider turns was concatenated verbatim, fusing a
  sentence from one turn onto the first word of the next (`…/not found/.Beres.`).
  Turns are now separated by a paragraph break.
- `deleteWordBefore` skipped only trailing whitespace, not the word before it.
- A `bash` timeout was not reported as an error, so the model could not tell a
  killed command from a successful one.
- The TUI never created a session for an ordinary prompt, so interactive runs
  were not being saved.
- Two sessions created in the same millisecond came back in filesystem order,
  which decided what `buka -c` resumed. Ordering now has a deterministic total
  order (`updatedAt`, then `createdAt`, then `id`).
- The agent loop passed its internal message array to the provider by reference;
  providers that retain the request could observe later mutations.
- The header wrapped onto two lines when the session title was long, corrupting
  the viewport height calculation and therefore scrolling.
- A long session title could truncate the status indicator in the header.
- The model picker's rows overflowed the panel with long model ids.

## [0.1.0] - 2026-10-25

### Added

- Initial release: full-screen Ink TUI with a line-based renderer, streaming
  (including `reasoning_content`), seven tools (`read`, `write`, `edit`, `glob`,
  `grep`, `list`, `bash`), per-tool `ask`/`allow`/`deny` permissions, append-only
  JSONL sessions, multi-provider config with `/v1/models` discovery, a model
  picker and a non-interactive print mode.
- Zero provider SDK: a hand-written SSE parser tolerant of the malformed
  responses real gateways produce.
- 144 unit/integration tests and 28 end-to-end TUI checks.

[Unreleased]: https://github.com/forsha7class/buka-ai/commits/main
[0.3.0]: https://github.com/forsha7class/buka-ai/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/forsha7class/buka-ai/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/forsha7class/buka-ai/releases/tag/v0.1.0
