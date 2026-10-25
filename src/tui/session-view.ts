import type { Session, StoredPart, ToolResultRecord } from "../session/store.js";
import type { MessagePart, MessageView, ToolView } from "./types.js";

/**
 * Rebuilds the display transcript from a stored session.
 *
 * Kept in the TUI layer so the session store stays a plain record log with no
 * dependency on view types.
 */
export function sessionToViews(session: Session): MessageView[] {
  const views: MessageView[] = [];
  let index = 0;

  for (const record of session.records) {
    index += 1;
    const id = `s${index}`;

    if (record.t === "compaction") {
      views.push({
        id,
        role: "compact",
        parts: [{ kind: "text", text: record.summary }],
        streaming: false,
        thinkingExpanded: false,
      });
      continue;
    }

    if (record.t === "user") {
      views.push({
        id,
        role: "user",
        parts: [{ kind: "text", text: record.text }],
        streaming: false,
        thinkingExpanded: false,
      });
      continue;
    }

    views.push({
      id,
      role: "assistant",
      parts: assistantParts(record.parts, record.reasoning, record.text, record.toolResults),
      streaming: false,
      thinkingExpanded: false,
      ...(record.model ? { model: record.model } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
    });
  }

  return views;
}

/**
 * Prefers the stored part order; falls back to the grouped layout used before
 * ordered parts existed, so older session files still load.
 */
function assistantParts(
  stored: StoredPart[] | undefined,
  reasoning: string,
  text: string,
  results: ToolResultRecord[],
): MessagePart[] {
  const byId = new Map(results.map((result) => [result.id, result]));

  if (stored && stored.length > 0) {
    const parts: MessagePart[] = [];
    const referenced = new Set<string>();

    for (const part of stored) {
      if (part.kind === "tool") {
        referenced.add(part.id);
        const result = byId.get(part.id);
        if (result) parts.push({ kind: "tool", tool: toToolView(result) });
        continue;
      }
      parts.push(part);
    }

    // Anything the snapshot missed (older writers) still shows up.
    for (const result of results) {
      if (!referenced.has(result.id)) parts.push({ kind: "tool", tool: toToolView(result) });
    }
    return parts;
  }

  const parts: MessagePart[] = [];
  if (reasoning.length > 0) parts.push({ kind: "thinking", text: reasoning });
  if (text.length > 0) parts.push({ kind: "text", text });
  for (const result of results) parts.push({ kind: "tool", tool: toToolView(result) });
  return parts;
}

function toToolView(result: ToolResultRecord): ToolView {
  return {
    id: result.id,
    name: result.name,
    preview: result.preview,
    status: result.isError ? "error" : "done",
    output: result.output,
    ...(result.summary !== undefined ? { summary: result.summary } : {}),
    expanded: false,
  };
}
