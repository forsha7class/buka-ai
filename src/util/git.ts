import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Reads the current branch without spawning a process.
 *
 * A `.git` entry is either a directory (normal clone) or a file containing
 * `gitdir: <path>` (worktrees and submodules). Both are handled, and a detached
 * HEAD falls back to the short commit hash. Anything unreadable returns
 * `undefined` — the TUI simply omits the branch.
 */
export function readGitBranch(cwd: string): string | undefined {
  const head = readHead(cwd);
  if (!head) return undefined;

  const ref = /^ref:\s*(.+)$/m.exec(head);
  if (ref) {
    const reference = ref[1]!.trim();
    const name = reference.replace(/^refs\/heads\//, "");
    return name.length > 0 ? name : undefined;
  }

  const hash = head.trim();
  return /^[0-9a-f]{7,40}$/i.test(hash) ? hash.slice(0, 7) : undefined;
}

function readHead(cwd: string): string | undefined {
  const gitPath = join(cwd, ".git");
  try {
    const stat = statSync(gitPath);
    if (stat.isDirectory()) {
      return readFileSync(join(gitPath, "HEAD"), "utf8");
    }
    if (stat.isFile()) {
      const pointer = readFileSync(gitPath, "utf8");
      const match = /^gitdir:\s*(.+)$/m.exec(pointer);
      if (!match) return undefined;
      const target = match[1]!.trim();
      const directory = isAbsolute(target) ? target : resolve(cwd, target);
      return readFileSync(join(directory, "HEAD"), "utf8");
    }
  } catch {
    return undefined;
  }
  return undefined;
}
