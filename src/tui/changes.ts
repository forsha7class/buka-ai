import { messageTools, type AppState } from "./types.js";

/**
 * Files touched by the edit/write tools, most recent last.
 *
 * The sidebar shows this as a compact "changed" list. Read straight from the
 * transcript so it stays correct when a session is resumed, and deduplicated
 * so a file edited five times appears once.
 */
export function extractChangedFiles(state: AppState): string[] {
  const seen = new Set<string>();
  for (const message of state.messages) {
    for (const tool of messageTools(message)) {
      if (tool.name !== "edit" && tool.name !== "write") continue;
      const path = tool.preview.split(/\s{2,}/)[0]?.trim();
      if (!path || path === "?") continue;
      seen.delete(path);
      seen.add(path);
    }
  }
  return [...seen].slice(-5);
}
