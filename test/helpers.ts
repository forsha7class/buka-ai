/**
 * Shared builders for view fixtures.
 *
 * Not a `.test.ts` file, so the runner ignores it; imported by the suites that
 * need to build messages.
 */
import type { MessagePart, MessageView, ToolView } from "../src/tui/types.js";

export function text(value: string): MessagePart {
  return { kind: "text", text: value };
}

export function thinking(value: string): MessagePart {
  return { kind: "thinking", text: value };
}

export function tool(partial: Partial<ToolView> & { name: string }): MessagePart {
  return {
    kind: "tool",
    tool: {
      id: partial.id ?? "t1",
      name: partial.name,
      preview: partial.preview ?? "",
      status: partial.status ?? "done",
      expanded: partial.expanded ?? false,
      ...(partial.output !== undefined ? { output: partial.output } : {}),
      ...(partial.summary !== undefined ? { summary: partial.summary } : {}),
    },
  };
}

export function assistant(parts: MessagePart[], overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: overrides.id ?? "m1",
    role: "assistant",
    parts,
    streaming: false,
    thinkingExpanded: false,
    ...overrides,
  };
}

export function user(value: string, overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: overrides.id ?? "u1",
    role: "user",
    parts: [text(value)],
    streaming: false,
    thinkingExpanded: false,
    ...overrides,
  };
}

export function compaction(summary: string): MessageView {
  return {
    id: "c1",
    role: "compact",
    parts: [text(summary)],
    streaming: false,
    thinkingExpanded: false,
  };
}
