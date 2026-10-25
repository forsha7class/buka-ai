import type { Session } from "../session/store.js";
import type { MessageView, ToolView } from "./types.js";

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
    if (record.t === "user") {
      views.push({
        id: `s${index}`,
        role: "user",
        text: record.text,
        reasoning: "",
        streaming: false,
        thinkingExpanded: false,
        tools: [],
      });
      continue;
    }

    const tools: ToolView[] = record.toolResults.map((result, toolIndex) => ({
      id: `${result.id || `t${index}-${toolIndex}`}`,
      name: result.name,
      preview: result.preview,
      status: result.isError ? ("error" as const) : ("done" as const),
      output: result.output,
      ...(result.summary !== undefined ? { summary: result.summary } : {}),
      expanded: false,
    }));

    views.push({
      id: `s${index}`,
      role: "assistant",
      text: record.text,
      reasoning: record.reasoning,
      streaming: false,
      thinkingExpanded: false,
      tools,
      ...(record.model ? { model: record.model } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
    });
  }

  return views;
}
