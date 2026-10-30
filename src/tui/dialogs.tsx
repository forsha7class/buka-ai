/**
 * Modal dialogs, built as fixed-width line arrays.
 *
 * Ink has no overlay or z-index, so a dialog replaces the transcript area. It
 * is drawn by hand (box drawing, padding, centering) so a dialog row is exactly
 * one display row — the same invariant the transcript relies on.
 */
import { row } from "./components.js";
import { palette } from "./theme.js";
import type { Line } from "./types.js";
import { padToWidth, stringWidth, truncateToWidth } from "./text.js";

export interface PickerItem {
  reference: string;
  detail: string;
}

export interface DialogSpec {
  title: string;
  /** Right-aligned in the title bar, e.g. `3 of 17`. */
  subtitle?: string;
  /** Enables the filter input row and renders the current text. */
  filter?: string;
  filterLabel?: string;
  items: PickerItem[];
  index: number;
  hint: string;
  /** Shown in place of the list when there is nothing to list. */
  empty: string;
}

const MAX_ITEMS = 12;

/**
 * Renders a centered dialog into exactly `height` rows of `width` cells.
 * The caller is responsible for the vertical space; everything below the box
 * is padded out so the transcript never shifts.
 */
export function dialogLines(spec: DialogSpec, width: number, height: number): Line[] {
  const boxWidth = clamp(Math.min(width - 4, 78), 20, Math.max(20, width));
  const innerWidth = boxWidth - 4;
  const hasFilter = spec.filter !== undefined;

  const reserved = 2 /* top + bottom border */ + (hasFilter ? 1 : 0);
  const listMax = clamp(height - reserved, 0, MAX_ITEMS);
  const listRows = spec.items.length === 0 ? 1 : Math.min(spec.items.length, listMax);

  // Window the list around the selection.
  const half = Math.floor(listRows / 2);
  const start = clamp(spec.index - half, 0, Math.max(0, spec.items.length - listRows));
  const visible = spec.items.slice(start, start + listRows);

  const box: Line[] = [];
  box.push(titleBar(spec, boxWidth));
  if (hasFilter) box.push(contentRow(filterRow(spec, innerWidth), innerWidth));
  if (spec.items.length === 0) {
    box.push(contentRow([{ text: spec.empty, style: { color: palette.muted } }], innerWidth));
  } else {
    for (let offset = 0; offset < listRows; offset++) {
      const item = visible[offset];
      if (!item) break;
      const selected = start + offset === spec.index;
      box.push(
        contentRow(itemRow(item, selected, innerWidth), innerWidth, selected ? palette.selection : palette.panel),
      );
    }
  }
  box.push(hintBar(spec.hint, boxWidth));

  // Center vertically, then pad the remainder so the caller gets `height` rows.
  const topPad = Math.max(0, Math.floor((height - box.length) / 2));
  const out: Line[] = [];
  for (let index = 0; index < topPad; index++) out.push([]);
  for (const line of box) out.push(center(line, width, boxWidth));
  while (out.length < height) out.push([]);

  return out;
}

/**
 * The slash-command palette that floats just above the composer. Unlike a full
 * dialog it has no filter row (the input itself is the filter) and no hint row
 * (the status line carries the keys), so its height is exactly items + 2.
 */
export function completionLines(items: PickerItem[], index: number, width: number): Line[] {
  const boxWidth = clamp(Math.min(width - 4, 84), 20, Math.max(20, width));
  const innerWidth = boxWidth - 4;
  const out: Line[] = [];

  const count = items.length === 0 ? "0" : `${Math.min(index + 1, items.length)}/${items.length}`;
  out.push(
    centeredBar(` commands  ${count} `, boxWidth, "╭", "╮", { color: palette.accent, bold: true }),
  );

  items.forEach((item, position) => {
    const selected = position === index;
    out.push(
      contentRow(itemRow(item, selected, innerWidth), innerWidth, selected ? palette.selection : palette.panel),
    );
  });
  out.push(centeredBar("", boxWidth, "╰", "╯", { color: palette.muted }));

  return out.map((line) => center(line, width, boxWidth));
}

function centeredBar(
  label: string,
  boxWidth: number,
  left: string,
  right: string,
  labelStyle: { color: string; bold?: boolean },
): Line {
  let text = label;
  if (stringWidth(text) > boxWidth - 3) text = truncateToWidth(text, Math.max(1, boxWidth - 3));
  const fill = Math.max(1, boxWidth - 3 - stringWidth(text));
  return [
    { text: `${left}─`, style: { color: palette.borderStrong } },
    ...(text.length > 0 ? [{ text, style: labelStyle }] : []),
    { text: "─".repeat(fill), style: { color: palette.borderStrong } },
    { text: right, style: { color: palette.borderStrong } },
  ];
}

function titleBar(spec: DialogSpec, boxWidth: number): Line {
  const subtitle = spec.subtitle ? `  ${spec.subtitle}` : "";
  let label = ` ${spec.title}${subtitle} `;
  if (stringWidth(label) > boxWidth - 4) label = truncateToWidth(label, Math.max(1, boxWidth - 4));
  const fill = Math.max(1, boxWidth - 3 - stringWidth(label));
  return [
    { text: "╭─", style: { color: palette.borderStrong } },
    { text: label, style: { color: palette.accent, bold: true } },
    { text: "─".repeat(fill), style: { color: palette.borderStrong } },
    { text: "╮", style: { color: palette.borderStrong } },
  ];
}

function hintBar(hint: string, boxWidth: number): Line {
  let label = ` ${hint} `;
  if (stringWidth(label) > boxWidth - 4) label = truncateToWidth(label, Math.max(1, boxWidth - 4));
  const fill = Math.max(1, boxWidth - 3 - stringWidth(label));
  return [
    { text: "╰─", style: { color: palette.borderStrong } },
    { text: label, style: { color: palette.muted } },
    { text: "─".repeat(fill), style: { color: palette.borderStrong } },
    { text: "╯", style: { color: palette.borderStrong } },
  ];
}

function filterRow(spec: DialogSpec, innerWidth: number): Line {
  const label = `${spec.filterLabel ?? "filter"} `;
  const text = `${spec.filter ?? ""}▏`;
  const budget = Math.max(1, innerWidth - stringWidth(label));
  return [
    { text: label, style: { color: palette.muted } },
    { text: truncateToWidth(text, budget), style: { color: palette.text } },
  ];
}

function itemRow(item: PickerItem, selected: boolean, innerWidth: number): Line {
  const marker = selected ? "▸ " : "  ";
  const detailBudget = Math.max(0, Math.min(38, Math.floor(innerWidth * 0.45)));
  const referenceBudget = Math.max(6, innerWidth - 2 - detailBudget - 2);
  const reference = padToWidth(truncateToWidth(item.reference, referenceBudget), referenceBudget);
  const detail = detailBudget > 0 ? truncateToWidth(item.detail, detailBudget) : "";
  const base = selected
    ? { color: palette.selectionText, bold: true }
    : { color: palette.text };
  const parts: Line = [
    {
      text: marker,
      style: selected ? { color: palette.accent, bold: true } : { color: palette.faint },
    },
    { text: reference, style: base },
  ];
  if (detail.length > 0) {
    parts.push({
      text: ` ${detail}`,
      style: { color: selected ? palette.selectionText : palette.faint },
    });
  }
  return parts;
}

/** Wraps a content row in the box frame, padded so backgrounds span it. */
function contentRow(content: Line, innerWidth: number, background = palette.panel): Line {
  const frame = { color: palette.borderStrong, backgroundColor: background };
  const fitted = row(innerWidth, { backgroundColor: background }, content);
  return [
    { text: "│", style: frame },
    { text: " ", style: { backgroundColor: background } },
    ...fitted,
    { text: " ", style: { backgroundColor: background } },
    { text: "│", style: frame },
  ];
}

/** Pads a box row to `width` by centering it, leaving the sides untouched. */
function center(line: Line, width: number, boxWidth: number): Line {
  const used = line.reduce((sum, segment) => sum + stringWidth(segment.text), 0);
  const left = Math.max(0, Math.floor((width - boxWidth) / 2));
  const right = Math.max(0, width - left - used);
  return [
    ...(left > 0 ? [{ text: " ".repeat(left) }] : []),
    ...line,
    ...(right > 0 ? [{ text: " ".repeat(right) }] : []),
  ];
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}
