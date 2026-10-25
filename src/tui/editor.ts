/**
 * Pure text-editing operations for the prompt input.
 *
 * Kept separate from React so the editing semantics are testable and the
 * keybinding map in `app.tsx` stays a thin translation layer.
 */

export interface EditorState {
  value: string;
  /** Index into `value` (UTF-16 code units, matching `String.prototype.slice`). */
  cursor: number;
}

export function createEditor(value = ""): EditorState {
  return { value, cursor: value.length };
}

export function insertText(state: EditorState, text: string): EditorState {
  if (text.length === 0) return state;
  return {
    value: state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor),
    cursor: state.cursor + text.length,
  };
}

export function backspace(state: EditorState): EditorState {
  if (state.cursor === 0) return state;
  return {
    value: state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor),
    cursor: state.cursor - 1,
  };
}

export function deleteForward(state: EditorState): EditorState {
  if (state.cursor >= state.value.length) return state;
  return {
    value: state.value.slice(0, state.cursor) + state.value.slice(state.cursor + 1),
    cursor: state.cursor,
  };
}

/** Deletes the word before the cursor, plus any whitespace before the cursor. */
export function deleteWordBefore(state: EditorState): EditorState {
  if (state.cursor === 0) return state;
  const before = state.value.slice(0, state.cursor);
  // Readline semantics: drop trailing whitespace first, then the word before it.
  const withoutTrailingSpace = before.replace(/\s+$/, "");
  const wordStart = withoutTrailingSpace.replace(/\S+$/, "");
  return { value: wordStart + state.value.slice(state.cursor), cursor: wordStart.length };
}

export function killToLineStart(state: EditorState): EditorState {
  const start = lineStart(state.value, state.cursor);
  return { value: state.value.slice(0, start) + state.value.slice(state.cursor), cursor: start };
}

export function moveHome(state: EditorState): EditorState {
  return { ...state, cursor: lineStart(state.value, state.cursor) };
}

export function moveEnd(state: EditorState): EditorState {
  return { ...state, cursor: lineEnd(state.value, state.cursor) };
}

export function moveLeft(state: EditorState): EditorState {
  if (state.cursor === 0) return state;
  return { ...state, cursor: state.cursor - 1 };
}

export function moveRight(state: EditorState): EditorState {
  if (state.cursor >= state.value.length) return state;
  return { ...state, cursor: state.cursor + 1 };
}

/**
 * Moves the cursor one visual line up/down, preserving the column as closely as
 * the target line allows. `width` must match the render width or the cursor
 * will jump around on wrapped input.
 */
export function moveVertical(state: EditorState, width: number, direction: -1 | 1): EditorState {
  const rows = visualRows(state.value, width);
  const cursorRow = rows.findIndex((row) => state.cursor >= row.start && state.cursor <= row.end);
  if (cursorRow === -1) return state;

  const column = state.cursor - rows[cursorRow]!.start;
  const targetIndex = cursorRow + direction;
  const target = rows[targetIndex];
  if (!target) return state;

  const offset = Math.min(column, target.end - target.start);
  return { ...state, cursor: target.start + offset };
}

export function lineStart(value: string, cursor: number): number {
  const index = value.lastIndexOf("\n", cursor - 1);
  return index === -1 ? 0 : index + 1;
}

export function lineEnd(value: string, cursor: number): number {
  const index = value.indexOf("\n", cursor);
  return index === -1 ? value.length : index;
}

export interface VisualRow {
  /** Character range of this visual row within `value`. */
  start: number;
  end: number;
}

/**
 * Splits the value into visual rows of `width` cells, accounting for hard
 * newlines. Index-based (not width-based) so cursor arithmetic stays exact:
 * a row always covers a contiguous range of characters.
 */
export function visualRows(value: string, width: number): VisualRow[] {
  const safeWidth = Math.max(1, width);
  const rows: VisualRow[] = [];
  let start = 0;

  for (let i = 0; i <= value.length; i++) {
    const atNewline = i < value.length && value[i] === "\n";
    const tooLong = i - start >= safeWidth;

    if (atNewline || tooLong || i === value.length) {
      rows.push({ start, end: i });
      start = atNewline ? i + 1 : i;
      if (i === value.length) break;
    }
  }

  if (rows.length === 0) rows.push({ start: 0, end: 0 });
  return rows;
}

/** Renders the value as display rows, dropping the hard newlines. */
export function editorRows(value: string, width: number): string[] {
  return visualRows(value, width).map((row) => value.slice(row.start, row.end).replace(/\n/g, ""));
}
