/** ANSI styling helpers with automatic TTY / NO_COLOR handling. */

const enabled =
  process.env["NO_COLOR"] === undefined &&
  process.env["TERM"] !== "dumb" &&
  (process.stdout.isTTY ?? false);

type Code = number | [number, number, number];

const wrap = (open: string, close: string) => (text: string): string =>
  enabled ? `${open}${text}${close}` : text;

const fg = (code: Code): ((text: string) => string) =>
  Array.isArray(code)
    ? wrap(`\u001b[38;2;${code[0]};${code[1]};${code[2]}m`, "\u001b[39m")
    : wrap(`\u001b[38;5;${code}m`, "\u001b[39m");

export const color = {
  red: fg(203),
  green: fg(114),
  yellow: fg(179),
  blue: fg(110),
  magenta: fg(176),
  cyan: fg(80),
  gray: fg(244),
  dimGray: fg(240),
  white: fg(252),
} as const;

export const style = {
  bold: wrap("\u001b[1m", "\u001b[22m"),
  dim: wrap("\u001b[2m", "\u001b[22m"),
  italic: wrap("\u001b[3m", "\u001b[23m"),
  underline: wrap("\u001b[4m", "\u001b[24m"),
} as const;

export const symbol = {
  ok: enabled ? "✓" : "+",
  fail: enabled ? "✗" : "x",
  warn: enabled ? "!" : "!",
  bullet: enabled ? "•" : "-",
  arrow: enabled ? "▸" : ">",
  tool: enabled ? "⚙" : "*",
  think: enabled ? "✻" : "~",
  user: enabled ? "▸" : ">",
  assistant: enabled ? "◂" : "<",
} as const;
