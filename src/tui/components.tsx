import { Box, Text } from "ink";
import type { ReactElement } from "react";

import type { AppState, Line, RunStatus } from "./types.js";
import { palette } from "./types.js";
import { editorRows, visualRows, type EditorState } from "./editor.js";
import { padToWidth, stringWidth, truncateToWidth } from "./text.js";

export function Segments({ segments }: { segments: Line }): ReactElement {
  if (segments.length === 0) return <Text> </Text>;
  // `wrap="truncate"` is load-bearing: the viewport slices a fixed number of
  // display lines, so a Line must never wrap into two rows.
  return (
    <Text wrap="truncate">
      {segments.map((segment, index) => (
        <Text key={index} {...(segment.style ?? {})}>
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}

export function LineList({
  lines,
  offset,
  height,
}: {
  lines: Line[];
  /** Index of the first visible line. */
  offset: number;
  height: number;
}): ReactElement {
  const visible = lines.slice(offset, offset + height);
  return (
    <Box flexDirection="column">
      {visible.map((segments, index) => (
        <Segments key={offset + index} segments={segments} />
      ))}
    </Box>
  );
}

const STATUS_LABEL: Record<RunStatus, { text: string; color: string }> = {
  idle: { text: "ready", color: palette.ok },
  thinking: { text: "thinking", color: palette.accent },
  responding: { text: "responding", color: palette.user },
  tool: { text: "running tool", color: palette.tool },
  permission: { text: "waiting for you", color: palette.warn },
};

export function Header({
  state,
  width,
  session,
}: {
  state: AppState;
  width: number;
  session?: string;
}): ReactElement {
  const status = STATUS_LABEL[state.status];
  const totals = state.totals;
  const tokens =
    totals.prompt + totals.completion > 0
      ? `  ${formatTokens(totals.prompt + totals.completion)} tok` +
        (totals.cached > 0 ? ` (${formatTokens(totals.cached)} cached)` : "")
      : "";

  const badge = " buka ai ";
  const statusText = `● ${status.text} `;
  const model = `${state.modelRef}${state.model && state.model !== state.modelRef ? ` · ${state.model}` : ""}${tokens}`;
  const sessionText = session && session !== "new session" ? session : "";

  // Budget the row explicitly: the viewport height math assumes the header is
  // exactly one line, so every part is truncated rather than allowed to wrap.
  //
  // The target is `width - 1` rather than `width`: a one-cell margin absorbs
  // any disagreement with the terminal over the width of ambiguous characters
  // (the status dot), which would otherwise truncate the status text.
  const target = Math.max(12, width - 1);
  const available = Math.max(8, target - stringWidth(badge) - stringWidth(statusText) - 2);
  const sessionBudget = sessionText ? Math.min(stringWidth(sessionText), Math.floor(available / 3)) : 0;
  const modelBudget = Math.max(8, available - (sessionBudget > 0 ? sessionBudget + 3 : 0));
  const modelText = truncateToWidth(model, modelBudget);
  const sessionPart = sessionBudget > 0 ? ` · ${truncateToWidth(sessionText, sessionBudget)}` : "";
  const gap = Math.max(
    1,
    target -
      stringWidth(badge) -
      stringWidth(modelText) -
      stringWidth(sessionPart) -
      stringWidth(statusText),
  );

  return (
    <Text wrap="truncate">
      <Text backgroundColor={palette.border} color={palette.accent} bold>
        {badge}
      </Text>
      <Text color={palette.dim}>{` ${modelText}`}</Text>
      <Text color={palette.dimmer}>{sessionPart}</Text>
      <Text>{" ".repeat(gap)}</Text>
      <Text color={status.color} bold>
        {statusText}
      </Text>
    </Text>
  );
}

export function PromptInput({
  editor,
  width,
  placeholder,
  disabled,
}: {
  editor: EditorState;
  width: number;
  placeholder: string;
  disabled: boolean;
}): ReactElement {
  const inner = Math.max(1, width - 2);
  const rows = editorRows(editor.value, inner);
  const ranges = visualRows(editor.value, inner);

  const cursorRowIndex = Math.max(
    0,
    ranges.findIndex((range) => editor.cursor >= range.start && editor.cursor <= range.end),
  );

  if (editor.value.length === 0 && placeholder.length > 0) {
    return (
      <Box>
        <Text color={palette.accent} bold>{"> "}</Text>
        <Text color={palette.dimmer}>{truncateToWidth(placeholder, inner)}</Text>
        {!disabled ? <Text inverse> </Text> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {rows.map((row, index) => {
        if (index !== cursorRowIndex) {
          return (
            <Box key={index}>
              <Text color={palette.accent} bold wrap="truncate">{index === 0 ? "> " : "  "}</Text>
              <Text color={palette.text} wrap="truncate">{row}</Text>
            </Box>
          );
        }

        const column = editor.cursor - (ranges[index]?.start ?? 0);
        const before = row.slice(0, column);
        const at = row.slice(column, column + 1);
        const after = row.slice(column + 1);

        return (
          <Box key={index}>
            <Text color={palette.accent} bold wrap="truncate">{index === 0 ? "> " : "  "}</Text>
            <Text color={palette.text} wrap="truncate">{before}</Text>
            <Text inverse color={palette.text} wrap="truncate">
              {at.length > 0 ? at : " "}
            </Text>
            <Text color={palette.text} wrap="truncate">{after}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function StatusBar({
  state,
  width,
  hint,
}: {
  state: AppState;
  width: number;
  hint: string;
}): ReactElement {
  const left =
    state.status === "idle"
      ? hint
      : state.status === "permission"
        ? "y allow · n deny · a always allow"
        : "esc stop";

  const right =
    state.lastStop === "max-turns"
      ? "turn limit reached"
      : state.turn > 0
        ? `turn ${state.turn}`
        : "";

  const rightWidth = stringWidth(right);
  const target = Math.max(8, width - 1);
  const available = Math.max(4, target - rightWidth);
  const leftText = truncateToWidth(left, available);
  const padding = Math.max(1, target - stringWidth(leftText) - rightWidth);
  return (
    <Text wrap="truncate">
      <Text color={palette.dimmer}>{leftText}</Text>
      <Text color={palette.dimmer}>{`${" ".repeat(padding)}${right}`}</Text>
    </Text>
  );
}

export function PermissionPrompt({
  state,
  width,
}: {
  state: AppState;
  width: number;
}): ReactElement {
  const request = state.pendingPermission!;
  return (
    <Box flexDirection="column">
      <Text color={palette.warn} bold>
        {"  ⚠ permission required  "}
        <Text color={palette.tool}>{request.tool}</Text>
      </Text>
      <Text color={palette.dim}>{`  ${truncateToWidth(request.preview, Math.max(10, width - 4))}`}</Text>
    </Box>
  );
}

export function ModelPicker({
  items,
  index,
  width,
  title = "select model",
}: {
  items: Array<{ reference: string; detail: string }>;
  index: number;
  width: number;
  title?: string;
}): ReactElement {
  const height = 12;
  const half = Math.floor(height / 2);
  const start = Math.max(0, Math.min(items.length - height, index - half));
  const visible = items.slice(start, start + height);
  // The bordered box spends two columns on the frame; budget the content to the
  // remaining width so a long reference or detail never wraps.
  const inner = Math.max(10, width - 2);
  const detailWidth = Math.max(0, Math.min(22, Math.floor(inner / 4)));
  const referenceWidth = Math.max(8, inner - 3 - 1 - detailWidth);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.accent} width={width}>
      <Text color={palette.accent} bold wrap="truncate">
        {truncateToWidth(` ${title} (${items.length}) `, inner)}
      </Text>
      {visible.map((model, offset) => {
        const absolute = start + offset;
        const selected = absolute === index;
        return (
          <Text key={model.reference} {...(selected ? { backgroundColor: palette.selection } : {})} wrap="truncate">
            <Text color={selected ? palette.accent : palette.dim}>{selected ? " ▸ " : "   "}</Text>
            <Text color={palette.text}>
              {padToWidth(truncateToWidth(model.reference, referenceWidth), referenceWidth)}
            </Text>
            <Text color={palette.dimmer}>{` ${truncateToWidth(model.detail, detailWidth)}`}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

export function Banner({ state, width }: { state: AppState; width: number }): ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={palette.accent} bold>
          {"buka ai"}
        </Text>
        <Text color={palette.dimmer}>{`  ${state.modelRef} · terminal coding agent`}</Text>
      </Box>
      <Text color={palette.dim}>
        {truncateToWidth(
          "Enter send · Alt+Enter newline · Esc stop · Ctrl+P sessions · Ctrl+K model · /help",
          Math.max(10, width),
        )}
      </Text>
    </Box>
  );
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
