/**
 * Text measurement and wrapping.
 *
 * Done by hand instead of pulling in `string-width`/`wrap-ansi` because the TUI
 * owns its layout: we slice rendered lines ourselves to implement scrolling, so
 * the wrap must produce plain, style-free strings whose width we can trust.
 */

/** Cost of a single code point in terminal cells (0, 1 or 2). */
export function charWidth(char: string): number {
  const code = char.codePointAt(0);
  if (code === undefined) return 0;
  if (code === 0) return 0;

  // Combining marks and zero-width joiners take no space.
  if (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0xfeff ||
    (code >= 0xfe00 && code <= 0xfe0f)
  ) {
    return 0;
  }

  // Wide: CJK, Hangul, Kana, fullwidth forms, and most emoji.
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f9ff) ||
    (code >= 0x1f000 && code <= 0x1f2ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }

  return 1;
}

export function stringWidth(text: string): number {
  let total = 0;
  for (const char of text) total += charWidth(char);
  return total;
}

/** Splits text into cells-safe chunks no wider than `width`. */
export function hardWrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const char of text) {
    const w = charWidth(char);
    if (currentWidth + w > width && current.length > 0) {
      lines.push(current);
      current = "";
      currentWidth = 0;
    }
    current += char;
    currentWidth += w;
  }
  lines.push(current);
  return lines;
}

export interface WrapOptions {
  /** Break at word boundaries where possible (prose) vs. anywhere (code). */
  wordWrap?: boolean;
  /** Number of cells to indent continuation lines by. */
  indent?: number;
}

/**
 * Wraps text to `width`, honoring explicit newlines. With `wordWrap`, long
 * words are still hard-broken so nothing ever overflows the viewport.
 */
export function wrapText(text: string, width: number, options: WrapOptions = {}): string[] {
  const { wordWrap = true, indent = 0 } = options;
  const usable = Math.max(1, width);
  const out: string[] = [];

  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      out.push("");
      continue;
    }

    if (!wordWrap) {
      out.push(...hardWrap(paragraph, usable));
      continue;
    }

    const words = paragraph.split(/(\s+)/).filter((piece) => piece.length > 0);
    let line = "";
    let lineWidth = 0;

    const push = (): void => {
      out.push(line);
      line = "";
      lineWidth = 0;
    };

    for (const word of words) {
      const wordWidth = stringWidth(word);

      // A word that cannot fit on any line gets hard-broken.
      if (wordWidth > usable && !/^\s+$/.test(word)) {
        for (const piece of hardWrap(word, usable)) {
          if (lineWidth > 0) push();
          out.push(piece);
        }
        continue;
      }

      if (lineWidth + wordWidth > usable && lineWidth > 0) {
        push();
        // Never start a wrapped line with the whitespace that caused the break.
        if (/^\s+$/.test(word)) continue;
      }

      line += word;
      lineWidth += wordWidth;
    }

    if (line.length > 0 || out.length === 0) out.push(line);
  }

  // Trailing empty line from a trailing "\n" is meaningful for the input box,
  // but for message rendering it is noise.
  if (out.length > 1 && out[out.length - 1] === "" && text.endsWith("\n")) out.pop();

  return indent > 0 ? out.map((line, index) => (index === 0 ? line : " ".repeat(indent) + line)) : out;
}

export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text;
  const ellipsis = "…";
  const budget = width - stringWidth(ellipsis);
  let out = "";
  let used = 0;
  for (const char of text) {
    const w = charWidth(char);
    if (used + w > budget) break;
    out += char;
    used += w;
  }
  return out + ellipsis;
}

/** Pads with spaces to exactly `width` cells (uses ASCII spaces, not ANSI). */
export function padToWidth(text: string, width: number): string {
  const current = stringWidth(text);
  return current >= width ? text : text + " ".repeat(width - current);
}
