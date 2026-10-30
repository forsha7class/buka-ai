import { Box, Text } from "ink";
import type { ReactElement } from "react";

import type { Line, Segment, Style } from "./types.js";
import { stringWidth, takeWidth, truncateToWidth } from "./text.js";

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

/**
 * Builds one display row of exactly `width` cells from styled parts.
 *
 * Parts are laid out left to right and truncated to the remaining budget; the
 * tail is filled with `pad` so a background colour can span the full pane
 * without the row ever changing height.
 */
export function row(width: number, pad: Style | undefined, parts: Segment[]): Line {
  const out: Line = [];
  let used = 0;

  for (const part of parts) {
    const remaining = width - used;
    if (remaining <= 0) break;

    const partWidth = stringWidth(part.text);
    const text =
      partWidth <= remaining
        ? part.text
        : remaining >= 4
          ? truncateToWidth(part.text, remaining)
          : takeWidth(part.text, remaining);

    if (text.length > 0) {
      out.push(part.style ? { text, style: part.style } : { text });
      used += stringWidth(text);
    }
    if (partWidth > remaining) break;
  }

  if (used < width) {
    const padding = " ".repeat(width - used);
    out.push(pad ? { text: padding, style: pad } : { text: padding });
  }

  return out;
}

/** An empty full-width row, useful for padding a panel to its height. */
export function blankRow(width: number, pad: Style | undefined): Line {
  return row(width, pad, []);
}

/** A horizontal rule made of a single repeated glyph. */
export function ruleRow(width: number, glyph: string, style: Style): Line {
  return [{ text: glyph.repeat(Math.max(1, width)), style }];
}
