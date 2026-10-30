/**
 * The visual shell: sidebar, top bar, composer, activity/status line, banner
 * and the permission box.
 *
 * Everything is rendered as fixed rows so the transcript viewport can slice
 * display lines without the chrome ever reflowing. The structure follows
 * OpenCode (split pane, boxed composer, status field); the banner, activity
 * lane and queue strip follow Hermes.
 */
import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { LineList, row, Segments } from "./components.js";
import { completionLines, dialogLines, type DialogSpec, type PickerItem } from "./dialogs.js";
import { editorRows, visualRows, type EditorState } from "./editor.js";
import type { Layout } from "./layout.js";
import { palette } from "./theme.js";
import type { AppState, Line, RunStatus, Segment } from "./types.js";
import { stringWidth, truncateToWidth } from "./text.js";

export interface CompletionView {
  items: PickerItem[];
  index: number;
}

export interface TuiViewProps {
  state: AppState;
  layout: Layout;
  /** Pre-wrapped transcript lines. */
  lines: Line[];
  offset: number;
  editor: EditorState;
  sessionTitle?: string | undefined;
  cwd: string;
  branch?: string | undefined;
  version: string;
  toolCount: number;
  contextWindow?: number | undefined;
  changedFiles: string[];
  dialog: DialogSpec | null;
  completing: CompletionView | null;
  hint: string;
  spinnerTick: number;
  runStartedAt: number | null;
  now: number;
  showTokens: boolean;
}

export function TuiView(props: TuiViewProps): ReactElement {
  const { layout, dialog } = props;

  const transcript = dialog
    ? dialogLines(dialog, layout.main, layout.transcript)
    : props.lines.length === 0
      ? bannerLines(props, layout.main, layout.transcript)
      : props.lines;

  return (
    <Box flexDirection="row" width={layout.columns} height={layout.rows}>
      {layout.sidebar > 0 ? (
        <LineList
          lines={sidebarLines(props, layout.sidebar, layout.rows)}
          offset={0}
          height={layout.rows}
        />
      ) : null}
      <Box flexDirection="column" width={layout.main} height={layout.rows}>
        <Segments segments={topBar(props, layout.main, layout.columns >= 110)} />
        <Box flexDirection="column" height={layout.transcript} overflow="hidden">
          {dialog ? (
            <LineList lines={transcript} offset={0} height={layout.transcript} />
          ) : props.lines.length === 0 ? (
            <LineList lines={transcript} offset={0} height={layout.transcript} />
          ) : (
            <LineList lines={transcript} offset={props.offset} height={layout.transcript} />
          )}
        </Box>
        {layout.queue > 0 ? <Segments segments={queuedLine(props, layout.main)} /> : null}
        {layout.completion > 0 && props.completing
          ? completionLines(props.completing.items, props.completing.index, layout.main).map(
              (segments, index) => <Segments key={index} segments={segments} />,
            )
          : null}
        {props.state.pendingPermission ? (
          <PermissionBox state={props.state} width={layout.main} />
        ) : (
          <Composer editor={props.editor} width={layout.main} disabled={false} />
        )}
        <Segments segments={statusLine(props, layout.main)} />
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<RunStatus, { text: string; color: string }> = {
  idle: { text: "ready", color: palette.ok },
  thinking: { text: "thinking", color: palette.accent },
  responding: { text: "responding", color: palette.user },
  tool: { text: "running tool", color: palette.tool },
  permission: { text: "waiting for you", color: palette.warn },
};

export function topBar(props: TuiViewProps, width: number, wide: boolean): Line {
  const bg = { backgroundColor: palette.panel };
  const status = STATUS_LABEL[props.state.status];
  const totals = props.state.totals;
  const tokens = totals.prompt + totals.completion;

  const left: Segment[] = [
    { text: ` ${props.sessionTitle ?? "new session"}`, style: { color: palette.text, bold: true, ...bg } },
    { text: `  ${displayCwd(props.cwd)}`, style: { color: palette.muted, ...bg } },
  ];
  if (props.branch) left.push({ text: `  ${props.branch}`, style: { color: palette.accent, ...bg } });

  const right: Segment[] = [];
  if (wide && props.showTokens && tokens > 0) {
    right.push({ text: `${formatTokens(tokens)} tok  `, style: { color: palette.faint, ...bg } });
  }
  right.push({ text: `● ${status.text} `, style: { color: status.color, bold: true, ...bg } });

  const rightWidth = right.reduce((sum, segment) => sum + stringWidth(segment.text), 0);
  const leftBudget = Math.max(4, width - rightWidth - 1);
  const fittedLeft = row(leftBudget, bg, left);
  const used = fittedLeft.reduce((sum, segment) => sum + stringWidth(segment.text), 0);
  const gap = Math.max(0, width - used - rightWidth);
  return [...fittedLeft, { text: " ".repeat(gap), style: bg }, ...right];
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function sidebarLines(props: TuiViewProps, width: number, rows: number): Line[] {
  const contentWidth = Math.max(4, width - 1);
  const bg = { backgroundColor: palette.panel };
  const lines: Line[] = [];

  const push = (parts: Segment[]): void => {
    lines.push(withDivider(row(contentWidth, bg, parts), width));
  };
  const blank = (): void => push([]);
  const label = (text: string): void => push([{ text, style: { color: palette.faint, ...bg } }]);

  blank();
  push([
    { text: "buka ai", style: { color: palette.accent, bold: true, ...bg } },
    { text: ` · ${props.version}`, style: { color: palette.faint, ...bg } },
  ]);
  push([{ text: "terminal coding agent", style: { color: palette.muted, ...bg } }]);
  blank();
  label("session");
  push([{ text: truncateToWidth(props.sessionTitle ?? "new session", contentWidth - 2), style: { color: palette.text, ...bg } }]);
  blank();
  label("model");
  push([{ text: truncateToWidth(props.state.modelRef, contentWidth - 2), style: { color: palette.text, ...bg } }]);
  if (props.state.model && props.state.model !== props.state.modelRef) {
    push([{ text: truncateToWidth(props.state.model, contentWidth - 2), style: { color: palette.muted, ...bg } }]);
  }
  blank();
  contextSection(props, contentWidth, bg, label, push);
  blank();

  const keys: string[] = ["ctrl+p palette", "ctrl+x sessions", "ctrl+k model", "ctrl+b sidebar", "/help"];
  const changedRows = changedSection(props, contentWidth, bg, label, push);
  if (changedRows > 0) blank();

  // Anchor the key hints to the bottom of the pane.
  while (lines.length < rows - keys.length) blank();
  for (const key of keys) {
    if (lines.length >= rows) break;
    push([{ text: key, style: { color: palette.faint, ...bg } }]);
  }
  while (lines.length < rows) blank();

  return lines.slice(0, rows);
}

function contextSection(
  props: TuiViewProps,
  contentWidth: number,
  bg: Segment["style"],
  label: (text: string) => void,
  push: (parts: Segment[]) => void,
): void {
  const used = props.state.usage?.promptTokens ?? 0;
  const window = props.contextWindow ?? 0;
  label("context");
  if (window > 0 && used > 0) {
    const fraction = Math.min(1, used / window);
    const barWidth = Math.max(4, contentWidth - 8);
    const filled = Math.round(fraction * barWidth);
    const colour = fraction >= 0.9 ? palette.error : fraction >= 0.7 ? palette.warn : palette.ok;
    push([
      { text: "█".repeat(filled), style: { color: colour, ...bg } },
      { text: "░".repeat(Math.max(0, barWidth - filled)), style: { color: palette.borderStrong, ...bg } },
      { text: ` ${Math.round(fraction * 100)}%`, style: { color: palette.muted, ...bg } },
    ]);
    push([
      {
        text: `${formatTokens(used)} / ${formatTokens(window)}`,
        style: { color: palette.faint, ...bg },
      },
    ]);
  } else {
    push([
      {
        text: used > 0 ? `${formatTokens(used)} tok context` : "no usage yet",
        style: { color: palette.faint, ...bg },
      },
    ]);
  }
}

function changedSection(
  props: TuiViewProps,
  contentWidth: number,
  bg: Segment["style"],
  label: (text: string) => void,
  push: (parts: Segment[]) => void,
): number {
  if (props.changedFiles.length === 0) return 0;
  label(`changed (${props.changedFiles.length})`);
  let count = 0;
  for (const file of props.changedFiles.slice(-4)) {
    push([
      { text: "M ", style: { color: palette.warn, ...bg } },
      { text: truncateToWidth(file, contentWidth - 4), style: { color: palette.muted, ...bg } },
    ]);
    count += 1;
  }
  return count + 1;
}

function withDivider(line: Line, width: number): Line {
  const used = line.reduce((sum, segment) => sum + stringWidth(segment.text), 0);
  const gap = Math.max(0, width - 1 - used);
  const out: Line = [...line];
  if (gap > 0) out.push({ text: " ".repeat(gap), style: { backgroundColor: palette.panel } });
  out.push({ text: "│", style: { color: palette.border, backgroundColor: palette.panel } });
  return out;
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export function Composer({
  editor,
  width,
  placeholder = "ask buka to do something, or /help",
  disabled,
  maxRows = 6,
}: {
  editor: EditorState;
  width: number;
  placeholder?: string;
  disabled: boolean;
  /** The composer scrolls internally past this many rows. */
  maxRows?: number;
}): ReactElement {
  const inner = Math.max(1, width - 2);
  const textWidth = Math.max(1, inner - 2);
  const rows = editorRows(editor.value, textWidth);
  const visual = visualRows(editor.value, textWidth);

  const cursorRow = Math.max(
    0,
    visual.findIndex((range) => editor.cursor >= range.start && editor.cursor <= range.end),
  );
  const visibleRows = Math.max(1, Math.min(maxRows, rows.length));
  const start = Math.max(0, Math.min(cursorRow - visibleRows + 1, rows.length - visibleRows));
  const shown = rows.slice(start, start + visibleRows);

  const border = disabled ? { color: palette.border } : { color: palette.accentSoft };

  if (editor.value.length === 0 && placeholder.length > 0) {
    return (
      <Box borderStyle="round" {...border} width={width}>
        <Text color={palette.accent} bold>
          {"❯ "}
        </Text>
        <Text color={palette.faint}>{truncateToWidth(placeholder, textWidth - 1)}</Text>
        {!disabled ? <Text inverse> </Text> : null}
      </Box>
    );
  }

  return (
    <Box borderStyle="round" {...border} width={width} flexDirection="column">
      {shown.map((text, offset) => {
        const index = start + offset;
        const prefix = index === 0 ? "❯ " : "  ";
        if (index !== cursorRow) {
          return (
            <Box key={index}>
              <Text color={palette.accent} bold wrap="truncate">
                {prefix}
              </Text>
              <Text color={palette.text} wrap="truncate">
                {text}
              </Text>
            </Box>
          );
        }

        const column = editor.cursor - (visual[index]?.start ?? 0);
        const before = text.slice(0, column);
        const at = text.slice(column, column + 1);
        const after = text.slice(column + 1);
        return (
          <Box key={index}>
            <Text color={palette.accent} bold wrap="truncate">
              {prefix}
            </Text>
            <Text color={palette.text} wrap="truncate">
              {before}
            </Text>
            <Text inverse color={palette.text} wrap="truncate">
              {at.length > 0 ? at : " "}
            </Text>
            <Text color={palette.text} wrap="truncate">
              {after}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

export function PermissionBox({ state, width }: { state: AppState; width: number }): ReactElement {
  const request = state.pendingPermission!;
  const inner = Math.max(4, width - 2);
  return (
    <Box borderStyle="round" borderColor={palette.warn} width={width} flexDirection="column">
      <Text wrap="truncate">
        <Text color={palette.warn} bold>
          {"⚠ permission required  "}
        </Text>
        <Text color={palette.tool} bold>
          {request.tool}
        </Text>
      </Text>
      <Text color={palette.muted} wrap="truncate">
        {truncateToWidth(`  ${request.preview}`, inner)}
      </Text>
      <Box>
        <Text color={palette.ok} bold>
          {"  y"}
        </Text>
        <Text color={palette.muted}>{" allow "}</Text>
        <Text color={palette.error} bold>
          {"n"}
        </Text>
        <Text color={palette.muted}>{" deny "}</Text>
        <Text color={palette.accent} bold>
          {"a"}
        </Text>
        <Text color={palette.muted}>{" always allow this tool"}</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Queue + status line
// ---------------------------------------------------------------------------

export function queuedLine(props: TuiViewProps, width: number): Line {
  const bg = { backgroundColor: palette.panelAlt };
  const first = props.state.queued[0] ?? "";
  return row(width, bg, [
    { text: " ⏳ queued ", style: { color: palette.warn, bold: true, ...bg } },
    { text: `(${props.state.queued.length}) `, style: { color: palette.faint, ...bg } },
    { text: truncateToWidth(first, Math.max(4, Math.floor(width / 3))), style: { color: palette.text, ...bg } },
    { text: "  · ctrl+x manages", style: { color: palette.faint, ...bg } },
  ]);
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function statusLine(props: TuiViewProps, width: number): Line {
  const bg = { backgroundColor: palette.panel };
  const { state } = props;
  const busy = state.status !== "idle";

  let left: Segment[];
  if (state.pendingPermission) {
    left = [{ text: "⚠ waiting for your answer", style: { color: palette.warn, bold: true, ...bg } }];
  } else if (busy) {
    const frame = SPINNER[props.spinnerTick % SPINNER.length]!;
    const elapsed = props.runStartedAt ? Math.max(0, Math.floor((props.now - props.runStartedAt) / 1000)) : 0;
    left = [
      { text: ` ${frame} `, style: { color: palette.accent, ...bg } },
      { text: activityText(state), style: { color: palette.muted, ...bg } },
      { text: ` · ${elapsed}s`, style: { color: palette.faint, ...bg } },
    ];
  } else {
    left = [{ text: " ● ready", style: { color: palette.ok, ...bg } }];
    if (state.lastStop === "max-turns") {
      left.push({ text: " · turn limit reached", style: { color: palette.warn, ...bg } });
    }
  }

  // Truncate the hint rather than letting Ink clip a row that is logically
  // wider than the pane.
  const right = truncateToWidth(` ${props.hint}`, Math.max(0, width - 5));
  const leftBudget = Math.max(4, width - stringWidth(right) - 1);
  const fitted = row(leftBudget, bg, left);
  const used = fitted.reduce((sum, segment) => sum + stringWidth(segment.text), 0);
  const gap = Math.max(0, width - used - stringWidth(right));
  return [...fitted, { text: " ".repeat(gap), style: bg }, { text: right, style: { color: palette.faint, ...bg } }];
}

function activityText(state: AppState): string {
  if (state.status === "tool") {
    const running = [...state.messages]
      .reverse()
      .flatMap((message) => message.parts)
      .find((part) => part.kind === "tool" && part.tool.status === "running");
    if (running && running.kind === "tool") {
      const preview = running.tool.preview ? ` · ${running.tool.preview}` : "";
      return `running ${running.tool.name}${preview}`;
    }
    return "running a tool";
  }
  if (state.status === "thinking") return "thinking";
  if (state.status === "responding") return "responding";
  return "working";
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

export function bannerLines(props: TuiViewProps, width: number, height: number): Line[] {
  const innerWidth = Math.max(16, Math.min(width - 8, 62));
  const bg = { backgroundColor: palette.panel };
  const lines: Line[] = [];

  const field = (name: string, value: string, valueColor = palette.text): Line => [
    { text: `  ${pad(name, 10)}`, style: { color: palette.faint, ...bg } },
    { text: truncateToWidth(value, innerWidth - 14), style: { color: valueColor, ...bg } },
  ];

  lines.push([]);
  lines.push([
    { text: "  buka ai", style: { color: palette.accent, bold: true, ...bg } },
    { text: ` · ${props.version}`, style: { color: palette.faint, ...bg } },
  ]);
  lines.push([{ text: "  terminal coding agent", style: { color: palette.muted, ...bg } }]);
  lines.push([]);
  lines.push(field("model", props.state.modelRef, palette.accent));
  if (props.state.model && props.state.model !== props.state.modelRef) {
    lines.push(field("wire", props.state.model));
  }
  lines.push(field("cwd", displayCwd(props.cwd)));
  lines.push(field("tools", `${props.toolCount} available`));
  lines.push([]);
  lines.push([{ text: "  keys", style: { color: palette.faint, ...bg } }]);
  lines.push([
    { text: "  /help commands", style: { color: palette.muted, ...bg } },
    { text: "   ctrl+p palette", style: { color: palette.muted, ...bg } },
  ]);
  lines.push([
    { text: "  ctrl+x sessions", style: { color: palette.muted, ...bg } },
    { text: "   ctrl+k model", style: { color: palette.muted, ...bg } },
  ]);
  lines.push([
    { text: "  ctrl+b sidebar", style: { color: palette.muted, ...bg } },
    { text: "    alt+enter newline", style: { color: palette.muted, ...bg } },
  ]);
  lines.push([]);

  return card(lines, width, height);
}

/** Draws a rounded card around pre-built content, centered in the viewport. */
function card(content: Line[], width: number, height: number): Line[] {
  const boxWidth = clamp(Math.max(...content.map(lineWidth), 18) + 4, 24, Math.max(24, width - 2));
  const innerWidth = boxWidth - 4;
  const bg = { backgroundColor: palette.panel };
  const border = { color: palette.borderStrong, ...bg };

  const framed: Line[] = [
    [
      { text: "╭", style: border },
      { text: "─".repeat(boxWidth - 2), style: border },
      { text: "╮", style: border },
    ],
  ];
  for (const line of content) framed.push(dialoglessRow(line, innerWidth, bg, border));
  framed.push([
    { text: "╰", style: border },
    { text: "─".repeat(boxWidth - 2), style: border },
    { text: "╯", style: border },
  ]);

  const topPad = Math.max(0, Math.floor((height - framed.length) / 2));
  const leftPad = Math.max(0, Math.floor((width - boxWidth) / 2));
  const out: Line[] = [];
  for (let index = 0; index < topPad; index++) out.push([]);
  for (const line of framed) {
    const used = lineWidth(line);
    out.push([
      ...(leftPad > 0 ? [{ text: " ".repeat(leftPad) }] : []),
      ...line,
      ...(width - leftPad - used > 0 ? [{ text: " ".repeat(width - leftPad - used) }] : []),
    ]);
  }
  while (out.length < height) out.push([]);
  return out.slice(0, height);
}

function dialoglessRow(content: Line, innerWidth: number, bg: Segment["style"], border: Segment["style"]): Line {
  const fitted = row(innerWidth, bg, content);
  return [
    { text: "│", style: border },
    { text: " ", style: bg },
    ...fitted,
    { text: " ", style: bg },
    { text: "│", style: border },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function displayCwd(cwd: string): string {
  const home = process.env["HOME"];
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`;
  return cwd;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function lineWidth(line: Line): number {
  return line.reduce((sum, segment) => sum + stringWidth(segment.text), 0);
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}
