/**
 * Syntax highlighter tests.
 *
 * The scanner is the one part of the renderer where a subtle bug is invisible
 * in a screenshot but wrong in the corpus: a `//` inside a string becoming a
 * comment, a template literal not carrying across lines, `$HOME` in shell
 * losing its colour. These pin the behaviours that matter.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  highlightLines,
  normalizeLanguage,
  supportsLanguage,
  type Token,
  type TokenKind,
} from "../src/tui/highlight.js";
import { wrapTokens } from "../src/tui/blocks.js";
import { stringWidth } from "../src/tui/text.js";

/** Maps each token to `kind:text` for compact assertions. */
const dump = (line: Token[]): string[] => line.map((token) => `${token.kind}:${token.text}`);

function kindsOf(code: string, language: string): TokenKind[][] {
  return highlightLines(code, language).map((line) => line.map((token) => token.kind));
}

function textOf(code: string, language: string): string[] {
  return highlightLines(code, language).map((line) =>
    line.map((token) => token.text).join(""),
  );
}

describe("language detection", () => {
  it("maps aliases to a canonical name", () => {
    assert.equal(normalizeLanguage("TS"), "typescript");
    assert.equal(normalizeLanguage("jsx"), "javascript");
    assert.equal(normalizeLanguage("py"), "python");
    assert.equal(normalizeLanguage("bash"), "shell");
    assert.equal(normalizeLanguage("yml"), "yaml");
  });

  it("refuses to guess at unknown languages", () => {
    assert.equal(supportsLanguage("brainfuck"), false);
    assert.equal(supportsLanguage(""), false);
    assert.equal(supportsLanguage("text"), false);
    assert.equal(normalizeLanguage("rust"), "");
  });

  it("leaves unknown languages completely plain", () => {
    assert.deepEqual(kindsOf("const a = /* not a comment */ 1", "rust"), [
      ["plain"],
    ]);
  });
});

describe("javascript", () => {
  it("classifies keywords, strings, numbers and comments", () => {
    const decl = highlightLines("const a = 1;", "ts")[0]!;
    assert.equal(decl[0]!.kind, "keyword");
    assert.equal(decl[0]!.text, "const");
    assert.ok(decl.some((token) => token.kind === "plain" && token.text.includes("a")));
    assert.equal(decl.find((token) => token.text === "=")?.kind, "operator");
    assert.equal(decl.find((token) => token.text === "1")?.kind, "number");
    assert.equal(decl.at(-1)!.kind, "punct");

    const withString = highlightLines('const s = "hi";', "ts")[0]!;
    assert.equal(withString.find((token) => token.text === '"hi"')?.kind, "string");
  });

  it("does not treat // inside a string as a comment", () => {
    const line = highlightLines('const url = "https://example.com";', "ts")[0]!;
    assert.ok(
      line.some((token) => token.kind === "string" && token.text.includes("https://example.com")),
    );
    assert.ok(!line.some((token) => token.kind === "comment"), "no comment token expected");
  });

  it("handles a line comment", () => {
    const line = highlightLines("const a = 1; // trailing", "ts")[0]!;
    assert.equal(line.at(-1)!.kind, "comment");
    assert.equal(line.at(-1)!.text, "// trailing");
  });

  it("carries a block comment across lines", () => {
    const kinds = kindsOf("/* start\nstill comment\nend */ const a = 1", "ts");
    assert.deepEqual(kinds[0], ["comment"]);
    assert.deepEqual(kinds[1], ["comment"]);
    assert.equal(kinds[2]![0], "comment", "the tail of the comment closes on this line");
    assert.ok(kinds[2]!.includes("keyword"), "and normal code resumes after it");
  });

  it("carries a template literal across lines", () => {
    const kinds = kindsOf("const t = `line one\nstill string`;", "ts");
    assert.equal(kinds[0]![0], "keyword");
    assert.equal(kinds[0]!.at(-1), "string", "the template opens and stays open");
    assert.deepEqual(kinds[1], ["string", "punct"]);
  });

  it("marks calls as functions, properties after a dot, and capitalised names as types", () => {
    const line = highlightLines("console.log(fetchData(new Widget()))", "ts")[0]!;
    const byText = new Map(line.map((token) => [token.text, token.kind]));
    assert.equal(byText.get("console"), "builtin");
    assert.equal(byText.get("log"), "function");
    assert.equal(byText.get("fetchData"), "function");
    assert.equal(byText.get("Widget"), "type");
  });

  it("does not treat a digit inside an identifier as a number", () => {
    const line = highlightLines("const v2 = 2;", "ts")[0]!;
    const numbers = line.filter((token) => token.kind === "number");
    assert.equal(numbers.length, 1, "only the literal 2 is a number");
    assert.equal(numbers[0]!.text, "2");
  });

  it("handles escapes in strings", () => {
    const line = highlightLines('const s = "a\\"b";', "ts")[0]!;
    assert.ok(line.some((token) => token.kind === "string" && token.text === '"a\\"b"'));
  });
});

describe("python", () => {
  it("uses # for comments and highlights builtins", () => {
    assert.deepEqual(dump(highlightLines("print(x)  # show it", "py")[0]!), [
      "builtin:print",
      "punct:(",
      "plain:x",
      "punct:)",
      "plain:  ",
      "comment:# show it",
    ]);
  });

  it("carries a triple-quoted docstring across lines", () => {
    const kinds = kindsOf('"""Doc\nmore\n"""\ndef f():\n    pass', "python");
    assert.deepEqual(kinds[0], ["string"]);
    assert.deepEqual(kinds[1], ["string"]);
    assert.equal(kinds[2]![0], "string");
    assert.ok(kinds[3]!.includes("keyword"));
  });

  it("does not confuse ''' with '", () => {
    const line = highlightLines("x = '''multi'''", "python")[0]!;
    assert.ok(line.some((token) => token.text === "'''multi'''"));
  });
});

describe("shell", () => {
  it("highlights variables with and without braces", () => {
    const line = highlightLines('echo "$HOME" ${PATH} $1', "sh")[0]!;
    const variables = line.filter((token) => token.kind === "builtin").map((token) => token.text);
    assert.deepEqual(variables, ["echo", "$HOME", "${PATH}", "$1"]);
  });

  it("treats # as a comment", () => {
    const line = highlightLines("ls -la # list", "bash")[0]!;
    assert.equal(line.at(-1)!.kind, "comment");
  });

  it("keeps single quotes literal so escapes do not leak", () => {
    const line = highlightLines("echo 'a\\' b'", "sh")[0]!;
    const string = line.find((token) => token.kind === "string");
    assert.equal(string?.text, "'a\\'");
  });
});

describe("json and yaml", () => {
  it("highlights json keys as properties", () => {
    const line = highlightLines('{"name": "buka", "count": 3}', "json")[0]!;
    const properties = line.filter((token) => token.kind === "property").map((token) => token.text);
    assert.deepEqual(properties, ['"name"', '"count"']);
    assert.ok(
      line.some((token) => token.kind === "string" && token.text === '"buka"'),
      "values stay strings",
    );
  });

  it("highlights yaml keys and booleans", () => {
    const kinds = kindsOf("enabled: true\nname: buka", "yaml");
    assert.equal(kinds[0]![0], "property");
    assert.ok(kinds[0]!.includes("keyword"));
    assert.equal(kinds[1]![0], "property");
  });
});

describe("diff", () => {
  it("marks added, removed and meta lines", () => {
    const kinds = kindsOf(
      ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-const a = 1", "+const a = 2", " context"].join("\n"),
      "diff",
    );
    assert.deepEqual(kinds.map((line) => line[0]!), [
      "meta",
      "meta",
      "meta",
      "removed",
      "added",
      "plain",
    ]);
  });
});

describe("scanner invariants", () => {
  const CORPUS: Array<[string, string]> = [
    ["ts", "export function f(a: string): number { return a.length }"],
    ["ts", "const re = /a\\/b/g; // ratio"],
    ["ts", "if (x) { y = `a${b}c` }"],
    ["python", "def f(x: int) -> str:\n    return f'{x}'"],
    ["sh", "if [ -f \"$1\" ]; then echo ok; fi"],
    ["json", '{"a": [1, 2, {"b": null}]}'],
    ["yaml", "key: value # note\nlist:\n  - a"],
    ["diff", "-old\n+new"],
  ];

  it("never loses or invents characters", () => {
    for (const [language, code] of CORPUS) {
      assert.deepEqual(
        textOf(code, language),
        code.split("\n"),
        `round-trip failed for ${language}: ${code}`,
      );
    }
  });

  it("never throws on malformed input", () => {
    const nasty = ["```", '"', "'", "/*", "`", "\\", "$${", "'''", '"""', "\u0000", "🚀"];
    for (const code of nasty) {
      for (const language of ["ts", "python", "sh", "json", "yaml", "diff", "rust"]) {
        assert.doesNotThrow(() => highlightLines(code, language), `${language} / ${JSON.stringify(code)}`);
      }
    }
  });

  it("keeps state local to each call", () => {
    // An unterminated block comment must not leak into the next highlight call.
    highlightLines("/* never closed", "ts");
    const after = highlightLines("const a = 1", "ts");
    assert.equal(after[0]![0]!.kind, "keyword");
  });
});

describe("token wrapping", () => {
  it("never exceeds the width and preserves content", () => {
    const tokens = highlightLines("const greeting = 'hello world, this is long';", "ts")[0]!;
    for (const width of [10, 20, 39]) {
      const wrapped = wrapTokens(tokens, width);
      for (const line of wrapped) {
        const text = line.map((token) => token.text).join("");
        assert.ok(stringWidth(text) <= width, `overflow at ${width}: ${JSON.stringify(text)}`);
      }
      assert.equal(wrapped.map((line) => line.map((t) => t.text).join("")).join(""), tokens.map((t) => t.text).join(""));
    }
  });

  it("keeps colour runs together where possible", () => {
    const tokens: Token[] = [
      { text: "const", kind: "keyword" },
      { text: " ", kind: "plain" },
      { text: "value", kind: "plain" },
    ];
    const wrapped = wrapTokens(tokens, 40);
    assert.equal(wrapped.length, 1);
    assert.deepEqual(
      wrapped[0]!.map((token) => token.kind),
      ["keyword", "plain"],
      "adjacent plain tokens merge",
    );
  });

  it("makes progress on a character wider than the line", () => {
    const tokens: Token[] = [
      { text: "日本", kind: "string" },
      { text: "ab", kind: "plain" },
    ];
    const wrapped = wrapTokens(tokens, 1);
    assert.ok(wrapped.length >= 2);
    assert.equal(wrapped.map((line) => line.map((t) => t.text).join("")).join(""), "日本ab");
  });

  it("handles an empty token stream", () => {
    assert.deepEqual(wrapTokens([], 10), [[]]);
  });
});
