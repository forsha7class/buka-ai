import { palette, type Line, type MessageView, type Segment, type Style, type ToolView } from "./types.js";
import { padToWidth, stringWidth, wrapText } from "./text.js";

export function seg(text: string, style?: Style): Segment {
  return style ? { text, style } : { text };
}

export function line(...segments: Segment[]): Line {
  return segments;
}

const INDENT = 2;

export interface BuildOptions {
  width: number;
  showThinking: boolean;
}

/** Renders one message (header + body + tools) into display lines. */
export function messageToLines(message: MessageView, options: BuildOptions): Line[] {
  const { width } = options;
  const bodyWidth = Math.max(8, width - INDENT);
  const out: Line[] = [];

  const header =
    message.role === "user"
      ? [seg("▸ ", { color: palette.user }), seg("you", { color: palette.user, bold: true })]
      : [
          seg("◂ ", { color: palette.accent }),
          seg("buka", { color: palette.accent, bold: true }),
          ...(message.model ? [seg(`  ${message.model}`, { color: palette.dimmer })] : []),
        ];

  out.push(line(...header));

  // Thinking block (chain-of-thought) sits above the answer, like the model
  // produced it.
  if (options.showThinking && message.reasoning.trim().length > 0) {
    out.push(...thinkingLines(message, bodyWidth));
  }

  if (message.text.trim().length > 0 || message.streaming) {
    out.push(...markdownLines(message.text, bodyWidth, message.streaming));
  }

  for (const tool of message.tools) {
    out.push(...toolLines(tool, bodyWidth));
  }

  if (message.error) {
    out.push(line(seg("  ✗ ", { color: palette.error }), seg(message.error, { color: palette.error })));
  }

  out.push(line());
  return out;
}

function thinkingLines(message: MessageView, width: number): Line[] {
  const out: Line[] = [];
  const chars = stringWidth(message.reasoning);
  const label: Segment[] = [
    seg("  ✻ ", { color: palette.thinking }),
    seg("thinking", { color: palette.thinking, italic: true }),
    seg(`  ${chars} chars`, { color: palette.dimmer }),
    seg(message.thinkingExpanded ? "  (ctrl+t)" : "  (ctrl+t to show)", { color: palette.dimmer }),
  ];
  out.push(line(...label));

  if (message.thinkingExpanded) {
    for (const wrapped of wrapText(message.reasoning, width - INDENT, { wordWrap: true })) {
      out.push(line(seg(`  ${wrapped}`, { color: palette.thinking, italic: true })));
    }
  }
  return out;
}

function toolLines(tool: ToolView, width: number): Line[] {
  const out: Line[] = [];
  const status = {
    running: seg(" …", { color: palette.warn }),
    done: seg(" ✓", { color: palette.ok }),
    error: seg(" ✗", { color: palette.error }),
  }[tool.status];

  out.push(
    line(
      seg("  ⚙ ", { color: palette.tool }),
      seg(tool.name, { color: palette.tool, bold: true }),
      seg(`  ${tool.preview}`, { color: palette.dim }),
      status,
      tool.summary && tool.status === "done" ? seg(`  ${tool.summary}`, { color: palette.dimmer }) : seg(""),
      tool.output ? seg("  (ctrl+o)", { color: palette.dimmer }) : seg(""),
    ),
  );

  const shouldShowOutput = tool.expanded || tool.status === "error";
  if (shouldShowOutput && tool.output) {
    const style: Style = {
      color: tool.status === "error" ? palette.error : palette.thinking,
    };
    const body = tool.output.trimEnd();
    const lines = body.split("\n");
    const limit = tool.expanded ? lines.length : Math.min(lines.length, 12);
    for (const raw of lines.slice(0, limit)) {
      for (const wrapped of wrapText(raw, width - INDENT, { wordWrap: false })) {
        out.push(line(seg(`    ${wrapped}`, style)));
      }
    }
    if (lines.length > limit) {
      out.push(line(seg(`    … ${lines.length - limit} more lines`, { color: palette.dimmer })));
    }
  }

  return out;
}

const CODE_FENCE = /^\s*```/;

/**
 * A deliberately small markdown renderer: fenced code blocks, headings,
 * bullets, inline code / bold / italic. Anything more elaborate (tables,
 * links, nested lists) is out of scope — we optimize for legible streaming.
 */
export function markdownLines(text: string, width: number, streaming = false): Line[] {
  const out: Line[] = [];
  const source = text.length > 0 ? text : "";
  const rawLines = source.split("\n");

  let inCode = false;
  let codeBuffer: string[] = [];
  let codeLang = "";

  const flushCode = (): void => {
    if (codeBuffer.length === 0) return;
    if (codeLang.length > 0) {
      out.push(line(seg(`  ${codeLang}`, { color: palette.dimmer })));
    }
    for (const codeLine of codeBuffer) {
      out.push(line(seg(`  ${padToWidth(codeLine, width - INDENT)}`, {
        color: palette.code,
        backgroundColor: palette.codeBg,
      })));
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

    // Headings.
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      const level = heading[1]!.length;
      const body = heading[2]!;
      for (const wrapped of wrapText(body, width - INDENT)) {
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

    // Bullets and numbered lists.
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(raw);
    if (bullet) {
      out.push(...prefixedLines("• ", bullet[2]!, width, Number(bullet[1]!.length)));
      continue;
    }
    if (numbered) {
      out.push(...prefixedLines(`${numbered[2]}. `, numbered[3]!, width, Number(numbered[1]!.length)));
      continue;
    }

    // Blockquote.
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

function prefixedLines(prefix: string, body: string, width: number, indent: number): Line[] {
  const out: Line[] = [];
  const pad = " ".repeat(indent);
  const wrapped = wrapText(body, width - INDENT - stringWidth(prefix) - indent);
  wrapped.forEach((text, index) => {
    if (index === 0) {
      out.push(line(seg(`  ${pad}${prefix}`, { color: palette.dim }), ...inline(text, { color: palette.text })));
    } else {
      out.push(line(seg(`  ${pad}${" ".repeat(stringWidth(prefix))}`), ...inline(text, { color: palette.text })));
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
export function messagesToLines(
  messages: MessageView[],
  options: BuildOptions,
): Line[] {
  const out: Line[] = [];
  for (const message of messages) out.push(...messageToLines(message, options));
  return out;
}
