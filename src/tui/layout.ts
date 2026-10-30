/**
 * Screen geometry.
 *
 * The TUI slices a fixed number of pre-wrapped lines to implement scrolling, so
 * every pane's height must be decided before render and must add up to exactly
 * the terminal height. Keeping the arithmetic here (pure, no Ink) is what makes
 * that testable at arbitrary sizes.
 */

export type SidebarMode = "auto" | boolean;

export interface LayoutInput {
  columns: number;
  rows: number;
  /** Visual rows the editor currently occupies (before borders). */
  editorRows: number;
  /** Rows reserved for the queued-message strip (0 when empty). */
  queuedRows?: number;
  /** Rows reserved for the slash-command completion panel (0 when closed). */
  completionRows?: number;
  /** The permission prompt replaces the composer with a slightly taller box. */
  permission?: boolean;
  sidebar?: SidebarMode;
}

export interface Layout {
  columns: number;
  rows: number;
  /** Total sidebar width including its divider column; 0 when hidden. */
  sidebar: number;
  sidebarContent: number;
  divider: number;
  /** Main pane width. */
  main: number;
  topBar: number;
  transcript: number;
  queue: number;
  completion: number;
  composer: number;
  status: number;
  dialogWidth: number;
  dialogHeight: number;
}

const EDITOR_MAX_ROWS = 6;

export function computeLayout(input: LayoutInput): Layout {
  const columns = Math.max(12, Math.floor(input.columns));
  const rows = Math.max(6, Math.floor(input.rows));

  const sidebar = sidebarWidth(columns, input.sidebar ?? "auto");
  const divider = sidebar > 0 ? 1 : 0;
  const sidebarContent = Math.max(0, sidebar - divider);
  const main = Math.max(8, columns - sidebar);

  const topBar = 1;
  const status = 1;
  let queue = (input.queuedRows ?? 0) > 0 ? 1 : 0;
  let completion = Math.max(0, Math.floor(input.completionRows ?? 0));
  const editorRows = clamp(Math.floor(input.editorRows), 1, EDITOR_MAX_ROWS);
  // The permission box spends two rows on the border and three on the prompt.
  const composer = input.permission === true ? 5 : editorRows + 2;

  const chrome = (): number => topBar + queue + completion + composer + status;
  let transcript = rows - chrome();

  // Give the transcript priority: shed optional strips entirely rather than
  // partially, because a half-height panel would render more rows than the
  // layout reserved and push the chrome off screen.
  if (transcript < 3 && completion > 0) {
    completion = 0;
    transcript = rows - chrome();
  }
  if (transcript < 3 && queue > 0) {
    queue = 0;
    transcript = rows - chrome();
  }
  transcript = Math.max(1, transcript);

  const dialogWidth = clamp(Math.min(main - 4, 78), 20, main);
  const dialogHeight = clamp(Math.min(transcript - 1, 16), 3, Math.max(3, transcript));

  return {
    columns,
    rows,
    sidebar,
    sidebarContent,
    divider,
    main,
    topBar,
    transcript,
    queue,
    completion,
    composer,
    status,
    dialogWidth,
    dialogHeight,
  };
}

export function sidebarWidth(columns: number, mode: SidebarMode): number {
  if (mode === false) return 0;
  if (mode === true) return columns >= 72 ? (columns >= 130 ? 32 : 28) : 0;
  if (columns < 100) return 0;
  return columns >= 130 ? 32 : 28;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}
