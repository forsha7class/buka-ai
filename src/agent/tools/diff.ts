/**
 * A small, honest diff for the TUI.
 *
 * Tools know exactly what they changed, so there is no need for a full Myers
 * implementation: trimming the common prefix and suffix and showing the
 * changed middle produces the hunk a reviewer wants for a single edit, and
 * degrades to "everything between these two points changed" for scattered
 * replacements. The output is unified-diff shaped so the existing diff
 * highlighter and the model-facing tool output can share a vocabulary.
 */

const MAX_LINES = 160;

export function simpleDiff(before: string, after: string, filePath: string): string {
  if (before === after) return "";

  const a = toLines(before);
  const b = toLines(after);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const context = 3;
  const from = Math.max(0, start - context);
  const toA = Math.min(a.length, endA + context);
  const toB = Math.min(b.length, endB + context);

  const out: string[] = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${from + 1},${toA - from} +${from + 1},${toB - from} @@`,
  ];

  for (let index = from; index < start; index += 1) out.push(` ${a[index] ?? ""}`);
  for (let index = start; index < endA; index += 1) out.push(`-${a[index] ?? ""}`);
  for (let index = start; index < endB; index += 1) out.push(`+${b[index] ?? ""}`);
  for (let index = endA; index < toA; index += 1) out.push(` ${a[index] ?? ""}`);

  if (out.length > MAX_LINES) {
    out.length = MAX_LINES;
    out.push(`… diff truncated at ${MAX_LINES} lines`);
  }

  return out.join("\n");
}

/** Splits text into lines without inventing a trailing empty line. */
function toLines(text: string): string[] {
  if (text.length === 0) return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** Counts added and removed lines in a unified diff. */
export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}
