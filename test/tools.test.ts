/**
 * Tool behaviour tests. These run real filesystem operations inside a temp
 * directory and assert on both the returned text and the side effects.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { readTool } from "../src/agent/tools/read.js";
import { writeTool } from "../src/agent/tools/write.js";
import { editTool } from "../src/agent/tools/edit.js";
import { globTool, isIgnored } from "../src/agent/tools/glob.js";
import { grepTool, globToRegExp } from "../src/agent/tools/grep.js";
import { listTool } from "../src/agent/tools/list.js";
import { bashTool } from "../src/agent/tools/bash.js";
import { truncateLines } from "../src/agent/tools/shared.js";
import type { Tool, ToolContext, ToolResult } from "../src/agent/tools/types.js";

let cwd: string;

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    requestPermission: async () => true,
    ...overrides,
  };
}

/** Runs a tool and fails loudly if it throws instead of returning a result. */
async function run(tool: Tool, args: unknown, ctx = context()): Promise<ToolResult> {
  return tool.execute(args, ctx);
}

before(() => {
  cwd = mkdtempSync(join(tmpdir(), "buka-tools-"));
  mkdirSync(join(cwd, "src", "nested"), { recursive: true });
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(cwd, "src", "nested", "b.ts"), "export const c = 3;\n");
  writeFileSync(join(cwd, "node_modules", "pkg", "index.ts"), "export const noise = 1;\n");
  writeFileSync(join(cwd, "notes.md"), "TODO: write tests\nDONE: nothing\n");
  writeFileSync(join(cwd, "binary.bin"), Buffer.from([0x00, 0x01, 0x02]));
});

after(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("read", () => {
  it("numbers lines and reports the range", async () => {
    const result = await run(readTool, { filePath: "src/a.ts" });
    assert.equal(result.isError, undefined);
    assert.match(result.output, /1│ export const a = 1;/);
    assert.match(result.output, /2│ export const b = 2;/);
    assert.match(result.summary ?? "", /2 of 2 lines/);
  });

  it("honours offset and limit", async () => {
    const result = await run(readTool, { filePath: "src/a.ts", offset: 2, limit: 1 });
    assert.match(result.output, /2│ export const b = 2;/);
    assert.ok(!result.output.includes("export const a"));
    assert.match(result.output, /lines 2-2 of 2/);
  });

  it("reports a missing file without throwing", async () => {
    const result = await run(readTool, { filePath: "nope.txt" });
    assert.equal(result.isError, true);
    assert.match(result.output, /File not found/);
  });

  it("refuses directories and binaries with useful guidance", async () => {
    const dir = await run(readTool, { filePath: "src" });
    assert.match(dir.output, /is a directory.*"list" tool/s);

    const bin = await run(readTool, { filePath: "binary.bin" });
    assert.equal(bin.isError, true);
    assert.match(bin.output, /binary file/);
  });

  it("rejects invalid arguments", async () => {
    await assert.rejects(() => run(readTool, {}), /filePath/);
    await assert.rejects(() => run(readTool, { filePath: "x", offset: -1 }), /offset/);
  });
});

describe("write", () => {
  it("creates parent directories and reports the result", async () => {
    const result = await run(writeTool, {
      filePath: "deep/new/file.txt",
      content: "hello\nworld",
    });
    assert.match(result.output, /Created deep\/new\/file\.txt \(2 lines/);
    assert.equal(readFileSync(join(cwd, "deep/new/file.txt"), "utf8"), "hello\nworld");
  });

  it("reports overwriting an existing file", async () => {
    const result = await run(writeTool, { filePath: "deep/new/file.txt", content: "changed" });
    assert.match(result.output, /Overwrote/);
  });
});

describe("edit", () => {
  const fixture = (): void => {
    writeFileSync(join(cwd, "edit-me.ts"), "const a = 1;\nconst b = 2;\nconst c = 2;\n");
  };

  it("replaces a unique string", async () => {
    fixture();
    const result = await run(editTool, {
      filePath: "edit-me.ts",
      oldString: "const a = 1;",
      newString: "const a = 42;",
    });
    assert.match(result.output, /1 replacement/);
    assert.equal(readFileSync(join(cwd, "edit-me.ts"), "utf8").split("\n")[0], "const a = 42;");
  });

  it("refuses an ambiguous match rather than guessing", async () => {
    fixture();
    const before = readFileSync(join(cwd, "edit-me.ts"), "utf8");
    // "= 2;" occurs on two lines.
    const result = await run(editTool, {
      filePath: "edit-me.ts",
      oldString: "= 2;",
      newString: "= 3;",
    });
    assert.equal(result.isError, true);
    assert.match(result.output, /appears 2 times/);
    assert.match(result.output, /replaceAll: true/);
    assert.equal(readFileSync(join(cwd, "edit-me.ts"), "utf8"), before, "file untouched");
  });

  it("replaces every occurrence when asked", async () => {
    fixture();
    const result = await run(editTool, {
      filePath: "edit-me.ts",
      oldString: "= 2;",
      newString: "= 20;",
      replaceAll: true,
    });
    assert.match(result.output, /2 replacements/);
    const content = readFileSync(join(cwd, "edit-me.ts"), "utf8");
    assert.ok(!content.includes("= 2;"));
  });

  it("explains a zero-match failure", async () => {
    fixture();
    const result = await run(editTool, {
      filePath: "edit-me.ts",
      oldString: "const z = 9;",
      newString: "const z = 10;",
    });
    assert.equal(result.isError, true);
    assert.match(result.output, /No match for oldString/);
    assert.match(result.output, /whitespace and indentation/);
  });

  it("rejects no-op and empty edits", async () => {
    fixture();
    await assert.rejects(
      () => run(editTool, { filePath: "edit-me.ts", oldString: "x", newString: "x" }),
      /identical/,
    );
    await assert.rejects(
      () => run(editTool, { filePath: "edit-me.ts", oldString: "", newString: "x" }),
      /must not be empty/,
    );
  });

  it("reports a missing file", async () => {
    const result = await run(editTool, { filePath: "ghost.ts", oldString: "a", newString: "b" });
    assert.equal(result.isError, true);
    assert.match(result.output, /Could not read/);
  });
});

describe("glob", () => {
  it("finds files recursively and skips ignored directories", async () => {
    const result = await run(globTool, { pattern: "**/*.ts" });
    assert.match(result.output, /src\/a\.ts/);
    assert.match(result.output, /src\/nested\/b\.ts/);
    assert.ok(!result.output.includes("node_modules"), "node_modules is skipped");
  });

  it("supports brace expansion and reports no matches", async () => {
    const braces = await run(globTool, { pattern: "**/*.{ts,md}" });
    assert.match(braces.output, /notes\.md/);

    const none = await run(globTool, { pattern: "**/*.zzz" });
    assert.match(none.output, /No files match/);
  });

  it("recognises ignored path segments", () => {
    assert.equal(isIgnored("node_modules/x/y.ts"), true);
    assert.equal(isIgnored("src/deep/.git/config"), true);
    assert.equal(isIgnored("src/keep.ts"), false);
  });
});

describe("grep", () => {
  it("finds matching lines with file and line numbers", async () => {
    const result = await run(grepTool, { pattern: "TODO" });
    assert.match(result.output, /notes\.md:1:/);
    assert.match(result.output, /TODO: write tests/);
  });

  it("supports case-insensitive search and glob filters", async () => {
    const result = await run(grepTool, { pattern: "todo", ignoreCase: true });
    assert.match(result.output, /TODO: write tests/);

    const filtered = await run(grepTool, { pattern: "export", glob: "*.md" });
    assert.match(filtered.output, /No matches/);
  });

  it("rejects an invalid regex with a clear message", async () => {
    const result = await run(grepTool, { pattern: "([unclosed" });
    assert.equal(result.isError, true);
    assert.match(result.output, /Invalid regular expression/);
  });

  it("converts globs to anchored regexes", () => {
    assert.ok(globToRegExp("*.ts").test("a.ts"));
    assert.ok(!globToRegExp("*.ts").test("a.js"));
    assert.ok(globToRegExp("*.{ts,tsx}").test("a.tsx"));
    assert.ok(globToRegExp("a?c").test("abc"));
    assert.ok(!globToRegExp("*.ts").test("dir/a.ts"), "does not cross directory separators");
  });
});

describe("list", () => {
  it("lists entries with directories first and hides ignored ones", async () => {
    const result = await run(listTool, {});
    assert.match(result.output, /src\//);
    assert.ok(!result.output.includes("node_modules"), "ignored by default");

    const all = await run(listTool, { all: true });
    assert.match(all.output, /node_modules\//);
  });

  it("reports a missing directory", async () => {
    const result = await run(listTool, { path: "no-such-dir" });
    assert.equal(result.isError, true);
    assert.match(result.output, /Could not list/);
  });
});

describe("bash", () => {
  it("captures stdout and reports a zero exit code", async () => {
    const result = await run(bashTool, { command: "echo hello" });
    assert.match(result.output, /hello/);
    assert.match(result.output, /exit code 0/);
    assert.notEqual(result.isError, true);
  });

  it("captures stderr and flags a non-zero exit code", async () => {
    const result = await run(bashTool, { command: "echo oops 1>&2; exit 3" });
    assert.equal(result.isError, true);
    assert.match(result.output, /\[stderr\]/);
    assert.match(result.output, /oops/);
    assert.match(result.output, /exit code 3/);
  });

  it("runs in the session working directory", async () => {
    const result = await run(bashTool, { command: "pwd" });
    // macOS /tmp is a symlink, so compare the basename instead of the full path.
    assert.match(result.output, /buka-tools-/);
  });

  it("does not leak credentials into the child environment", async () => {
    process.env["BUKA_TEST_TOKEN"] = "super-secret";
    process.env["OPENAI_API_KEY"] = "sk-should-not-leak";
    try {
      const result = await run(bashTool, {
        command: 'echo "token=[$BUKA_TEST_TOKEN] openai=[$OPENAI_API_KEY]"',
      });
      assert.match(result.output, /token=\[\] openai=\[\]/);
      assert.ok(!result.output.includes("super-secret"));
    } finally {
      delete process.env["BUKA_TEST_TOKEN"];
      delete process.env["OPENAI_API_KEY"];
    }
  });

  it("kills a command that exceeds its timeout", async () => {
    const result = await run(bashTool, { command: "sleep 30", timeout: 300 });
    assert.equal(result.isError, true);
    assert.match(result.output, /timed out after 300ms/);
  });

  it("stops when the session is aborted", async () => {
    const controller = new AbortController();
    const promise = run(bashTool, { command: "sleep 30" }, context({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 200);
    const result = await promise;
    assert.match(result.output, /aborted/);
  });

  it("rejects an empty command", async () => {
    await assert.rejects(() => run(bashTool, { command: "   " }), /must not be empty/);
  });
});

describe("truncation", () => {
  it("caps line count and says how much was hidden", () => {
    const text = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
    const result = truncateLines(text, 10);
    assert.equal(result.truncated, true);
    assert.equal(result.totalLines, 100);
    assert.match(result.text, /showing 10 of 100 lines/);
    assert.ok(!result.text.includes("line 50"));
  });

  it("leaves short output untouched", () => {
    const result = truncateLines("a\nb", 10);
    assert.equal(result.truncated, false);
    assert.equal(result.text, "a\nb");
  });

  it("caps character count too", () => {
    const result = truncateLines("x".repeat(500), 100, 100);
    assert.equal(result.truncated, true);
    assert.ok(result.text.length < 250);
  });
});

describe("write tool side effects", () => {
  it("does not leave partial directories behind on invalid input", async () => {
    await assert.rejects(() => run(writeTool, { filePath: "x/y.txt" }), /content/);
    assert.equal(existsSync(join(cwd, "x")), false);
  });
});
