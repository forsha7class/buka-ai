/**
 * Tiny JSONC reader: JSON with `//`, `/* *\/` comments and trailing commas.
 * Implemented as a single character scan (string-aware) so we don't pull in a
 * parser dependency and don't corrupt string contents that look like comments.
 */

export function stripJsonc(input: string): string {
  let out = "";
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i]!;
    const next = input[i + 1];

    // Inside a string: copy verbatim, honoring escapes.
    if (ch === '"') {
      out += ch;
      i++;
      while (i < len) {
        const c = input[i]!;
        if (c === "\\") {
          out += c + (input[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += c;
        i++;
        if (c === '"') break;
      }
      continue;
    }

    // Line comment.
    if (ch === "/" && next === "/") {
      while (i < len && input[i] !== "\n") i++;
      continue;
    }

    // Block comment.
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < len && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // Trailing comma: drop it if the next meaningful char closes an object/array.
    if (ch === ",") {
      let j = i + 1;
      while (j < len && /\s/.test(input[j]!)) j++;
      if (input[j] === "}" || input[j] === "]") {
        i++;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

export function parseJsonc<T = unknown>(input: string): T {
  return JSON.parse(stripJsonc(input)) as T;
}
