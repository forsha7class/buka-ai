/**
 * TUI colour themes.
 *
 * The interface is drawn by hand (see `blocks.ts` / `chrome.tsx`), so the theme
 * is just a palette plus a few glyph choices — no styling framework. The
 * `palette` export is a live view over the active theme: components read it
 * during render, and the app re-renders when the user switches themes.
 *
 * The default is charcoal with a warm amber accent (OpenCode's neutral
 * structure, Hermes' warmth). `classic` keeps the lavender palette from 0.3.0
 * so an existing screenshot or preference still has a home.
 */

export interface Palette {
  /** Sidebar and top-bar background. */
  readonly panel: string;
  /** Slightly raised panel (selected rows, composer hints). */
  readonly panelAlt: string;
  readonly border: string;
  readonly borderStrong: string;
  readonly text: string;
  readonly muted: string;
  readonly faint: string;
  readonly accent: string;
  readonly accentSoft: string;
  readonly user: string;
  readonly tool: string;
  readonly ok: string;
  readonly warn: string;
  readonly error: string;
  readonly thinking: string;
  readonly code: string;
  readonly codeBg: string;
  readonly selection: string;
  readonly selectionText: string;
  readonly userBg: string;
  readonly toolBg: string;
}

export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  colors: Palette;
}

const buka: Theme = {
  id: "buka",
  name: "buka",
  dark: true,
  colors: {
    panel: "#15171c",
    panelAlt: "#1c1f26",
    border: "#2b3038",
    borderStrong: "#3d4452",
    text: "#e7e9ee",
    muted: "#9aa3b2",
    faint: "#6b7383",
    accent: "#e0a370",
    accentSoft: "#8a6a4d",
    user: "#79c0ff",
    tool: "#c3a6ff",
    ok: "#7ee2b8",
    warn: "#f2c86b",
    error: "#f38ba8",
    thinking: "#8b93a7",
    code: "#d7baff",
    codeBg: "#1d2027",
    selection: "#3a3029",
    selectionText: "#ffffff",
    userBg: "#1a2431",
    toolBg: "#1b1a26",
  },
};

const opencode: Theme = {
  id: "opencode",
  name: "opencode",
  dark: true,
  colors: {
    panel: "#101014",
    panelAlt: "#17171d",
    border: "#26262e",
    borderStrong: "#3a3a46",
    text: "#e6e6e6",
    muted: "#9a9aa5",
    faint: "#6a6a75",
    accent: "#7aa2f7",
    accentSoft: "#3d5a8a",
    user: "#7dcfff",
    tool: "#bb9af7",
    ok: "#9ece6a",
    warn: "#e0af68",
    error: "#f7768e",
    thinking: "#8b93a7",
    code: "#c0caf5",
    codeBg: "#1a1b26",
    selection: "#283457",
    selectionText: "#ffffff",
    userBg: "#16202e",
    toolBg: "#1c1a2b",
  },
};

const hermes: Theme = {
  id: "hermes",
  name: "hermes",
  dark: true,
  colors: {
    panel: "#191410",
    panelAlt: "#211a14",
    border: "#3a2f22",
    borderStrong: "#54432f",
    text: "#f0e6d8",
    muted: "#b3a48f",
    faint: "#7d705f",
    accent: "#e0b36a",
    accentSoft: "#8c6b3f",
    user: "#e8a87c",
    tool: "#c9a0ff",
    ok: "#b7d98f",
    warn: "#e8c07d",
    error: "#e07a6a",
    thinking: "#a89a86",
    code: "#e3c99b",
    codeBg: "#221b14",
    selection: "#3d2f1f",
    selectionText: "#fff6e8",
    userBg: "#2a2018",
    toolBg: "#241c26",
  },
};

const light: Theme = {
  id: "light",
  name: "light",
  dark: false,
  colors: {
    panel: "#f1f2f4",
    panelAlt: "#e8eaee",
    border: "#d6d9de",
    borderStrong: "#b8bdc6",
    text: "#1f2328",
    muted: "#5c6570",
    faint: "#8b939e",
    accent: "#b45309",
    accentSoft: "#d9a878",
    user: "#0969da",
    tool: "#8250df",
    ok: "#1a7f37",
    warn: "#9a6700",
    error: "#cf222e",
    thinking: "#5c6570",
    code: "#6639ba",
    codeBg: "#eceef1",
    selection: "#dbe4f5",
    selectionText: "#1f2328",
    userBg: "#e8f0fb",
    toolBg: "#f1ebff",
  },
};

const classic: Theme = {
  id: "classic",
  name: "classic",
  dark: true,
  colors: {
    panel: "#111318",
    panelAlt: "#171a21",
    border: "#374151",
    borderStrong: "#4b5563",
    text: "#e5e7eb",
    muted: "#6b7280",
    faint: "#4b5563",
    accent: "#c4b5fd",
    accentSoft: "#6d5ea8",
    user: "#7dd3fc",
    tool: "#f0abfc",
    ok: "#6ee7b7",
    warn: "#fcd34d",
    error: "#fca5a5",
    thinking: "#94a3b8",
    code: "#d8b4fe",
    codeBg: "#1f2937",
    selection: "#312e81",
    selectionText: "#ffffff",
    userBg: "#18222e",
    toolBg: "#241a2b",
  },
};

export const THEMES: Record<string, Theme> = { buka, opencode, hermes, light, classic };

/** Aliases kept so pre-0.4 configs (`theme: "dark"`) keep working. */
const ALIASES: Record<string, string> = {
  dark: "buka",
  auto: "auto",
};

let active: Theme = buka;

export function currentTheme(): Theme {
  return active;
}

export function setActiveTheme(theme: Theme): void {
  active = theme;
}

export function themeById(id: string): Theme | undefined {
  return THEMES[id] ?? THEMES[ALIASES[id] ?? ""];
}

/**
 * Picks a theme from explicit config, `$BUKA_THEME`, or the terminal's own
 * background hint. `auto` only ever chooses between the dark default and the
 * light variant; a named theme is always honoured.
 */
export function resolveTheme(
  name: string | undefined,
  env: Record<string, string | undefined> = process.env,
): Theme {
  // An explicit choice (config or `/theme`) wins; the environment only fills
  // in when the caller asked for `auto`.
  const requested = (name ?? "auto").trim().toLowerCase();
  if (requested !== "" && requested !== "auto") {
    return themeById(requested) ?? themeById(env["BUKA_THEME"] ?? "") ?? buka;
  }
  const fromEnv = (env["BUKA_THEME"] ?? "").trim().toLowerCase();
  if (fromEnv !== "" && fromEnv !== "auto") return themeById(fromEnv) ?? buka;

  const hint = env["COLORFGBG"];
  if (hint) {
    const background = Number.parseInt(hint.split(";").pop() ?? "", 10);
    // 7 is the conventional "light grey" background; 15 is bright white.
    if (background === 7 || background === 15) return light;
  }

  return buka;
}

export const themeNames = Object.keys(THEMES);

/**
 * Live palette. Getters (not a copy) so a theme switch is visible to every
 * component on the next render without threading a Theme through pure
 * renderers. Never read this at module scope — the value would be frozen to
 * whichever theme was active during import.
 */
export const palette: Palette & { readonly dim: string; readonly dimmer: string } = {
  get panel() {
    return active.colors.panel;
  },
  get panelAlt() {
    return active.colors.panelAlt;
  },
  get border() {
    return active.colors.border;
  },
  get borderStrong() {
    return active.colors.borderStrong;
  },
  get text() {
    return active.colors.text;
  },
  get muted() {
    return active.colors.muted;
  },
  get faint() {
    return active.colors.faint;
  },
  /** Pre-0.4 aliases: `dim`/`dimmer` are `muted`/`faint`. */
  get dim() {
    return active.colors.muted;
  },
  get dimmer() {
    return active.colors.faint;
  },
  get accent() {
    return active.colors.accent;
  },
  get accentSoft() {
    return active.colors.accentSoft;
  },
  get user() {
    return active.colors.user;
  },
  get tool() {
    return active.colors.tool;
  },
  get ok() {
    return active.colors.ok;
  },
  get warn() {
    return active.colors.warn;
  },
  get error() {
    return active.colors.error;
  },
  get thinking() {
    return active.colors.thinking;
  },
  get code() {
    return active.colors.code;
  },
  get codeBg() {
    return active.colors.codeBg;
  },
  get selection() {
    return active.colors.selection;
  },
  get selectionText() {
    return active.colors.selectionText;
  },
  get userBg() {
    return active.colors.userBg;
  },
  get toolBg() {
    return active.colors.toolBg;
  },
};
