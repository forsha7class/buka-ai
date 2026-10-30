import { diffStats } from "../agent/tools/diff.js";
import { highlightLines, type Token, type TokenKind } from "./highlight.js";
import {
  messageText,
  palette,
  type Line,
  type MessageView,
  type Segment,
  type Style,
  type ToolView,
} from "./types.js";
import { padToWidth, stringWidth, takeWidth, truncateToWidth, wrapText } from "./text.js";

export function seg(text: string, style?: Style): Segment {
  return style ? { text, style } : { text };
}

export function line(...segments: Segment[]): Line {
  return segments;
}

const INDENT = 2;

/**
 * Thinking bursts shorter than this are not rendered.
 *
 * A multi-turn run emits a reasoning fragment before nearly every tool call, and
 * most of them are throwaway ("checking the file"). Rendering a header line for
 * each one buries the actual transcript in noise. The full text is always in the
 * session log.
 */
const MIN_THINKING_CHARS = 40;

export interface BuildOptions {
  width: number;
  showThinking: boolean;
}

/**
 * Colours for highlighted code, derived from the active theme at render time.
 *
 * This must be a function: a module-level object would freeze the palette that
 * happened to be active when the file was imported, and `/theme` could never
 * change it.
 */
function tokenStyles(): Record<TokenKind, Style> {
  return {
    plain: { color: palette.text },
    keyword: { color: "#c792ea" },
    type: { color: "#ffcb6b" },
    builtin: { color: "#82aaff" },
    function: { color: "#82aaff" },
    property: { color: palette.text },
    string: { color: "#c3e88d" },
    number: { color: "#f78c6c" },
    comment: { color: palette.dimmer, italic: true },
    operator: { color: "#89ddff" },
    punct: { color: palette.dim },
    added: { color: palette.ok },
    removed: { color: palette.error },
    meta: { color: palette.accent },
  };
}

/**
 * Renders one message — header plus its parts, in the order they happened.
 *
 * Parts are ordered rather than grouped, because a single request can span many
 * provider turns: thinking, a sentence, a tool call, more thinking, more text.
 * Grouping by kind would silently reorder the work.
 */
export function messageToLines(message: MessageView, options: BuildOptions): Line[] {
  const { width } = options;
  const bodyWidth = Math.max(8, width - INDENT);
  const out: Line[] = [];

  if (message.role === "compact") {
    out.push(...compactLines(message, bodyWidth));
    out.push(line());
    return out;
  }

  out.push(
    ...(message.role === "user"
      ? [line(seg("▸ ", { color: palette.user }), seg("you", { color: palette.user, bold: true }))]
      : [
          line(
            seg("◂ ", { color: palette.accent }),
            seg("buka", { color: palette.accent, bold: true }),
            ...(message.model ? [seg(`  ${message.model}`, { color: palette.dimmer })] : []),
          ),
        ]),
  );

  const lastIndex = message.parts.length - 1;
  message.parts.forEach((part, index) => {
    switch (part.kind) {
      case "thinking":
        if (
          options.showThinking &&
          stringWidth(part.text.trim()) >= MIN_THINKING_CHARS
        ) {
          out.push(...thinkingLines(part.text, bodyWidth, message.thinkingExpanded));
        }
        break;

      case "text":
        out.push(
          ...(message.role === "user"
            ? userTextLines(part.text, bodyWidth)
            : markdownLines(part.text, bodyWidth, message.streaming && index === lastIndex)),
        );
        break;

      case "tool":
        out.push(...toolLines(part.tool, bodyWidth));
        break;

      default:
        break;
    }
  });

  // A streaming turn that has not produced text yet still needs a cursor, which
  // otherwise only markdownLines draws.
  if (message.streaming && !(message.parts[lastIndex]?.kind === "text")) {
    out.push(line(seg("  ▌", { color: palette.accent })));
  }

  if (message.error) {
    out.push(
      line(seg("  ✗ ", { color: palette.error }), seg(message.error, { color: palette.error })),
    );
  }

  out.push(line());
  return out;
}

function compactLines(message: MessageView, width: number): Line[] {
  const summary = messageText(message);
  const out: Line[] = [
    line(
      seg("  ⟳ ", { color: palette.accent }),
      seg("context compacted", { color: palette.accent, bold: true }),
      seg(`  ${summary.length} chars summarised`, { color: palette.dimmer }),
    ),
  ];

  // The preview is plain text rather than rendered markdown, so strip the
  // markers rather than showing raw `##` and `-` at the user.
  const cleaned = summary
    .split("\n")
    .map((text) => text.replace(/^\s*#{1,6}\s+/, "").replace(/^(\s*)[-*]\s+/, "$1• "))
    .join("\n");

  const wrapped = wrapText(cleaned.trim(), width - INDENT);
  const limit = Math.min(wrapped.length, 6);
  for (const text of wrapped.slice(0, limit)) {
    out.push(line(seg(`  ${text}`, { color: palette.thinking, italic: true })));
  }
  if (wrapped.length > limit) {
    out.push(line(seg(`  … ${wrapped.length - limit} more lines`, { color: palette.dimmer })));
  }
  return out;
}

function thinkingLines(text: string, width: number, expanded: boolean): Line[] {
  const out: Line[] = [];
  out.push(
    line(
      seg("  ✻ ", { color: palette.thinking }),
      seg("thinking", { color: palette.thinking, italic: true }),
      seg(`  ${stringWidth(text)} chars`, { color: palette.dimmer }),
      seg(expanded ? "  (ctrl+t)" : "  (ctrl+t to show)", { color: palette.dimmer }),
    ),
  );

  if (expanded) {
    for (const wrapped of wrapText(text, width - INDENT, { wordWrap: true })) {
      out.push(line(seg(`  ${wrapped}`, { color: palette.thinking, italic: true })));
    }
  }
  return out;
}

/** A user turn: a tinted block so prompts stand out from the model's prose. */
function userTextLines(text: string, width: number): Line[] {
  const out: Line[] = [];
  const inner = Math.max(2, width - INDENT);
  const bg: Style = { color: palette.text, backgroundColor: palette.userBg };
  const spans = wrapText(text, inner, { wordWrap: true });
  for (const span of spans.length > 0 ? spans : [""]) {
    out.push(line(seg("  "), seg(padToWidth(span, inner), bg)));
  }
  return out;
}

function toolLines(tool: ToolView, width: number): Line[] {
  const out: Line[] = [];
  const budget = Math.max(8, width);

  const glyph = {
    running: { text: "…", color: palette.warn },
    done: { text: "✓", color: palette.ok },
    error: { text: "✗", color: palette.error },
  }[tool.status];

  const duration = tool.durationMs !== undefined ? formatDuration(tool.durationMs) : "";
  const right: Segment[] = [];
  const pushRight = (text: string, color: string): void => {
    right.push({ text: right.length === 0 ? text : ` ${text}`, style: { color } });
  };
  if (tool.diff && tool.diff.length > 0) {
    const stats = diffStats(tool.diff);
    pushRight(`+${stats.added} −${stats.removed}`, palette.ok);
  }
  if (tool.summary && tool.status !== "running") {
    pushRight(truncateToWidth(tool.summary, 24), palette.dimmer);
  }
  if (duration.length > 0) pushRight(duration, palette.dimmer);
  pushRight(glyph.text, glyph.color);
  const rightWidth = right.reduce((sum, segment) => sum + stringWidth(segment.text), 0);

  const left = fitSegments(
    [
      { text: "  ⚙ ", style: { color: palette.tool } },
      { text: tool.name, style: { color: palette.tool, bold: true } },
      ...(tool.preview.length > 0 ? [{ text: `  ${tool.preview}`, style: { color: palette.dim } }] : []),
      ...(tool.output ? [{ text: "  ctrl+o", style: { color: palette.dimmer } }] : []),
    ],
    Math.max(4, budget - rightWidth - 1),
  );
  const used = left.reduce((sum, segment) => sum + stringWidth(segment.text), 0);
  out.push([
    ...left,
    seg(" ".repeat(Math.max(1, budget - used - rightWidth))),
    ...right,
  ]);

  // Edits show the change, not the tool's "Edited file" sentence.
  if (tool.diff && tool.diff.length > 0) {
    const diffLines = tool.diff.split("\n");
    const limit = tool.expanded ? diffLines.length : Math.min(diffLines.length, 8);
    for (const raw of diffLines.slice(0, limit)) {
      const colour = raw.startsWith("@@")
        ? palette.accent
        : raw.startsWith("+++") || raw.startsWith("---")
          ? palette.faint
          : raw.startsWith("+")
            ? palette.ok
            : raw.startsWith("-")
              ? palette.error
              : palette.muted;
      for (const wrapped of wrapText(raw, Math.max(4, budget - 4), { wordWrap: false })) {
        out.push(line(seg("  │ ", { color: palette.faint }), seg(wrapped, { color: colour })));
      }
    }
    if (diffLines.length > limit) {
      out.push(line(seg(`  │ … ${diffLines.length - limit} more diff lines`, { color: palette.dimmer })));
    }
    return out;
  }

  const shouldShowOutput = tool.expanded || tool.status === "error";
  if (shouldShowOutput && tool.output) {
    const rail = tool.status === "error" ? palette.error : palette.faint;
    const style: Style = { color: tool.status === "error" ? palette.error : palette.thinking };
    const lines = tool.output.trimEnd().split("\n");
    const limit = tool.expanded ? lines.length : Math.min(lines.length, 12);
    for (const raw of lines.slice(0, limit)) {
      for (const wrapped of wrapText(raw, Math.max(4, budget - 4), { wordWrap: false })) {
        out.push(line(seg("  │ ", { color: rail }), seg(wrapped, style)));
      }
    }
    if (lines.length > limit) {
      out.push(line(seg(`  │ … ${lines.length - limit} more lines`, { color: palette.dimmer })));
    }
  }

  return out;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** Truncates styled segments in order so they fit inside `width` cells. */
function fitSegments(parts: Segment[], width: number): Segment[] {
  const out: Segment[] = [];
  let used = 0;
  for (const part of parts) {
    const room = width - used;
    if (room <= 0) break;
    const partWidth = stringWidth(part.text);
    const text =
      partWidth <= room
        ? part.text
        : room >= 4
          ? truncateToWidth(part.text, room)
          : takeWidth(part.text, room);
    if (text.length > 0) {
      out.push(part.style ? { text, style: part.style } : { text });
      used += stringWidth(text);
    }
    if (partWidth > room) break;
  }
  return out;
}

const CODE_FENCE = /^\s*```/;

/**
 * A deliberately small markdown renderer: fenced code (syntax highlighted),
 * headings, bullets, blockquotes, inline code / bold / italic. Anything more
 * elaborate (tables, links, nested lists) is out of scope — we optimize for
 * legible streaming.
 */
export function markdownLines(text: string, width: number, streaming = false): Line[] {
  const out: Line[] = [];
  const rawLines = text.split("\n");

  let inCode = false;
  let codeLang = "";
  let codeBuffer: string[] = [];

  const flushCode = (): void => {
    if (codeBuffer.length === 0) return;
    const body = codeBuffer.join("\n");
    const tokenLines = highlightLines(body, codeLang);

    if (codeLang.trim().length > 0) {
      out.push(line(seg(`  ${codeLang.trim()}`, { color: palette.dimmer })));
    }
    for (const tokens of tokenLines) {
      // Wrap inside the token stream so colours survive a line break.
      for (const wrapped of wrapTokens(tokens, Math.max(1, width - INDENT))) {
        out.push(codeLine(wrapped, width));
      }
    }
    codeBuffer = [];
    codeLang = "";
  };

  for (const raw of rawLines) {
    if (CODE_FENCE.test(raw)) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
        codeLang = raw.trim().replace(/^```/, "").trim();
      }
      continue;
    }

    if (inCode) {
      codeBuffer.push(raw);
      continue;
    }

    if (raw.trim().length === 0) {
      out.push(line());
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      const level = heading[1]!.length;
      for (const wrapped of wrapText(heading[2]!, width - INDENT)) {
        out.push(
          line(
            seg(`  ${wrapped}`, {
              color: level <= 2 ? palette.accent : palette.text,
              bold: true,
            }),
          ),
        );
      }
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(raw);
    if (bullet) {
      out.push(...prefixedLines("• ", bullet[2]!, width, bullet[1]!.length));
      continue;
    }
    if (numbered) {
      out.push(...prefixedLines(`${numbered[2]}. `, numbered[3]!, width, numbered[1]!.length));
      continue;
    }

    if (raw.startsWith("> ")) {
      for (const wrapped of wrapText(raw.slice(2), width - INDENT)) {
        out.push(line(seg(`  │ ${wrapped}`, { color: palette.dim, italic: true })));
      }
      continue;
    }

    for (const wrapped of wrapText(raw, width - INDENT)) {
      out.push(line(seg("  "), ...inline(wrapped, { color: palette.text })));
    }
  }

  if (inCode) flushCode();

  if (streaming) {
    const last = out[out.length - 1];
    if (last) last.push(seg("▌", { color: palette.accent }));
    else out.push(line(seg("  ▌", { color: palette.accent })));
  }

  return out;
}

/** Renders one highlighted code line, padded so the background spans the width. */
function codeLine(tokens: Token[], width: number): Line {
  const styles = tokenStyles();
  const segments: Segment[] = [seg(" ".repeat(INDENT), { backgroundColor: palette.codeBg })];
  let used = INDENT;

  for (const token of tokens) {
    segments.push(seg(token.text, { ...styles[token.kind], backgroundColor: palette.codeBg }));
    used += stringWidth(token.text);
  }

  if (used < width) {
    segments.push(seg(" ".repeat(width - used), { backgroundColor: palette.codeBg }));
  }
  return segments;
}

/** Splits a token stream into lines of at most `width` cells, keeping colours. */
export function wrapTokens(tokens: Token[], width: number): Token[][] {
  if (width <= 0) return [tokens];

  const out: Token[][] = [];
  let current: Token[] = [];
  let used = 0;

  const flush = (): void => {
    out.push(current);
    current = [];
    used = 0;
  };

  for (const token of tokens) {
    let remaining = token.text;
    while (remaining.length > 0) {
      const room = width - used;
      if (room <= 0) {
        flush();
        continue;
      }

      const chunk = takeWidth(remaining, room);
      if (chunk.length === 0) {
        // The next character is wider than a whole line (or wider than what is
        // left of this one). Move to a fresh line, and if it still does not fit,
        // emit it anyway so the loop always makes progress.
        if (used > 0) {
          flush();
          continue;
        }
        const forced = [...remaining][0];
        if (forced === undefined) break;
        current.push({ text: forced, kind: token.kind });
        used += stringWidth(forced);
        remaining = remaining.slice(forced.length);
        continue;
      }

      const last = current[current.length - 1];
      if (last && last.kind === token.kind) last.text += chunk;
      else current.push({ text: chunk, kind: token.kind });
      used += stringWidth(chunk);
      remaining = remaining.slice(chunk.length);
    }
  }

  if (current.length > 0 || out.length === 0) flush();
  return out;
}

function prefixedLines(prefix: string, body: string, width: number, indent: number): Line[] {
  const out: Line[] = [];
  const pad = " ".repeat(indent);
  const wrapped = wrapText(body, width - INDENT - stringWidth(prefix) - indent);
  wrapped.forEach((text, index) => {
    if (index === 0) {
      out.push(
        line(
          seg(`  ${pad}${prefix}`, { color: palette.dim }),
          ...inline(text, { color: palette.text }),
        ),
      );
    } else {
      out.push(
        line(
          seg(`  ${pad}${" ".repeat(stringWidth(prefix))}`),
          ...inline(text, { color: palette.text }),
        ),
      );
    }
  });
  return out;
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g;

/** Minimal inline markdown: `code`, **bold**, *italic*. No nesting. */
export function inline(text: string, base: Style): Segment[] {
  const out: Segment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) out.push(seg(text.slice(lastIndex, index), base));
    const token = match[0]!;

    if (token.startsWith("`")) {
      out.push(seg(token.slice(1, -1), { ...base, color: palette.code }));
    } else if (token.startsWith("**")) {
      out.push(seg(token.slice(2, -2), { ...base, bold: true }));
    } else {
      out.push(seg(token.slice(1, -1), { ...base, italic: true }));
    }
    lastIndex = index + token.length;
  }

  if (lastIndex < text.length) out.push(seg(text.slice(lastIndex), base));
  return out.length > 0 ? out : [seg(text, base)];
}

/** Flattens a list of messages into display lines. */
export function messagesToLines(messages: MessageView[], options: BuildOptions): Line[] {
  const out: Line[] = [];
  for (const message of messages) out.push(...messageToLines(message, options));
  return out;
}
