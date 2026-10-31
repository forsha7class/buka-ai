/**
 * Buka, the terminal ghost.
 *
 * Kept as plain rows so the welcome banner can draw it without an image
 * dependency. The SVG versions live in `assets/` for the README and avatar.
 */
export const MASCOT = [
  "  ╭───────────╮",
  "  │  ●     ●  │",
  "  │     >_    │",
  "  ╰──┬─────┬──╯",
  "     ╰─────╯",
];

/** A shorter version for 24-row terminals, where the full ghost would clip. */
export const MASCOT_COMPACT = [
  "  ╭───────────╮",
  "  │  ●  >_  ● │",
  "  ╰───────────╯",
];
