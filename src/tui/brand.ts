/**
 * Buka, the terminal ghost.
 *
 * Kept as plain rows so the welcome banner can draw it without an image
 * dependency. The SVG versions live in `assets/` for the README and avatar.
 *
 * Each frame contains its own leading or trailing blank row, which is how the
 * mascot floats without changing the banner's height.
 */
const OPEN = [
  "  ╭───────────╮",
  "  │  ●     ●  │",
  "  │     >_    │",
  "  ╰──┬─────┬──╯",
  "     ╰─────╯",
];

const BLINK = [
  "  ╭───────────╮",
  "  │  ─     ─  │",
  "  │     >_    │",
  "  ╰──┬─────┬──╯",
  "     ╰─────╯",
];

const CURSOR = [
  "  ╭───────────╮",
  "  │  ●     ●  │",
  "  │     >     │",
  "  ╰──┬─────┬──╯",
  "     ╰─────╯",
];

const TAIL = [
  "  ╭───────────╮",
  "  │  ●     ●  │",
  "  │     >_    │",
  "  ╰──┬─────┬──╯",
  "      ╰─────╯",
];

const COMPACT_OPEN = [
  "  ╭───────────╮",
  "  │  ●  >_  ● │",
  "  ╰───────────╯",
];

const COMPACT_BLINK = [
  "  ╭───────────╮",
  "  │  ─  >_  ─ │",
  "  ╰───────────╯",
];

const COMPACT_CURSOR = [
  "  ╭───────────╮",
  "  │  ●  >   ● │",
  "  ╰───────────╯",
];

const low = (lines: string[]): string[] => ["", ...lines];
const high = (lines: string[]): string[] => [...lines, ""];

/** Full-size frames, including one blank row for the float. */
export const MASCOT_FRAMES: string[][] = [
  low(OPEN),
  low(OPEN),
  high(BLINK),
  high(OPEN),
  high(CURSOR),
  low(OPEN),
  low(TAIL),
  low(OPEN),
];

/** Compact frames for 24-row terminals. */
export const MASCOT_COMPACT_FRAMES: string[][] = [
  low(COMPACT_OPEN),
  low(COMPACT_OPEN),
  high(COMPACT_BLINK),
  high(COMPACT_OPEN),
  high(COMPACT_CURSOR),
  low(COMPACT_OPEN),
];
