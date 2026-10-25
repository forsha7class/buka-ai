import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** `~/.config/buka-ai` (XDG-aware). */
export function configDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "buka-ai");
}

/** `~/.local/share/buka-ai` — session logs and other state. */
export function dataDir(): string {
  const xdg = process.env["XDG_DATA_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, "buka-ai");
}

export function sessionsDir(): string {
  return join(dataDir(), "sessions");
}

export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

export function toAbsolute(input: string, base = process.cwd()): string {
  const expanded = expandHome(input);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

export const CONFIG_FILENAMES = ["buka.jsonc", "buka.json", ".bukarc.jsonc"];

export function globalConfigPaths(): string[] {
  const dir = configDir();
  return CONFIG_FILENAMES.map((name) => join(dir, name));
}

export function projectConfigPaths(cwd = process.cwd()): string[] {
  return CONFIG_FILENAMES.map((name) => join(cwd, name));
}
