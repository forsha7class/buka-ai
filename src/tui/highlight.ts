/**
 * A small, stateful, line-by-line syntax highlighter.
 *
 * Hand-written on purpose. `highlight.js`/`shiki` cost megabytes and startup
 * time for a CLI that mostly prints fragments of JavaScript and shell; a
 * scanner with correct string/comment handling and per-language keyword sets
 * covers what actually shows up in a coding session, with no dependency and no
 * lazy-loading machinery.
 *
 * The scanner runs per line but carries state across lines so block comments and
 * template literals / triple-quoted strings are coloured correctly, and it
 * highlights `$variables` inside shell double quotes (the common case for the
 * commands this tool prints).
 *
 * Deliberately conservative: an unknown language is not guessed at, it is left
 * plain, so prose in an unlabelled fence is never mangled.
 */

export type TokenKind =
  | "plain"
  | "keyword"
  | "type"
  | "builtin"
  | "function"
  | "property"
  | "string"
  | "number"
  | "comment"
  | "operator"
  | "punct"
  | "added"
  | "removed"
  | "meta";

export interface Token {
  text: string;
  kind: TokenKind;
}

interface QuoteSpec {
  open: string;
  close: string;
  /** May run past the end of the line. */
  multiline: boolean;
  /** Honor backslash escapes. */
  escape: boolean;
  /** Highlight `$var` / `$1` inside the quotes (shell). */
  interpolate?: boolean;
}

interface LangSpec {
  keywords: Set<string>;
  types?: Set<string>;
  builtins?: Set<string>;
  lineComments: string[];
  blockComment?: [string, string];
  quotes: QuoteSpec[];
  /** Highlight a bare `$name` / `${...}` outside strings (shell). */
  variables?: boolean;
  /** Highlight `identifier:` as a key (json/yaml). */
  keyValue?: boolean;
}

interface ScanState {
  inBlockComment: boolean;
  /** Quote that is still open from a previous line. */
  multiline: QuoteSpec | null;
}

const C_LIKE_QUOTES: QuoteSpec[] = [
  { open: "`", close: "`", multiline: true, escape: true },
  { open: '"', close: '"', multiline: false, escape: true },
  { open: "'", close: "'", multiline: false, escape: true },
];

function set(words: string): Set<string> {
  return new Set(words.split(/\s+/).filter((word) => word.length > 0));
}

const JS_KEYWORDS = set(`
  const let var function return if else for while do switch case default break continue
  new class extends super this typeof instanceof in of await async yield try catch finally
  throw delete void import from export as static get set null undefined true false
`);

const JS_TYPES = set(`
  string number boolean any unknown never object symbol bigint Array Promise Record Map Set
  Partial Readonly Pick Omit Exclude Extract NonNullable
`);

const JS_BUILTINS = set(`
  console Math JSON Object Array String Number Boolean Symbol BigInt Promise Date RegExp Error
  process require module exports globalThis setTimeout setInterval fetch
`);

const PY_KEYWORDS = set(`
  def return if elif else for while in not and or is None True False import from as class
  try except finally raise with lambda pass break continue global nonlocal yield assert del
  async await match case
`);

const PY_TYPES = set(`str int float bool bytes list dict set tuple frozenset object type`);

const PY_BUILTINS = set(`
  print len range enumerate zip map filter sorted sum min max abs round open isinstance
  super self repr format input iter next hasattr getattr setattr
`);

const SH_KEYWORDS = set(`
  if then else elif fi for while until do done case esac function return in export local
  readonly source unset set trap exit shift break continue declare
`);

const SH_BUILTINS = set(`
  echo printf cd pwd ls cat grep sed awk find xargs head tail sort uniq cut tr wc test
  curl wget git npm npx node python python3 pip make docker kubectl jq tee mkdir rm cp mv
`);

const YAML_KEYWORDS = set(`true false null yes no on off`);

const SPECS: Record<string, LangSpec> = {
  javascript: {
    keywords: JS_KEYWORDS,
    types: JS_TYPES,
    builtins: JS_BUILTINS,
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: C_LIKE_QUOTES,
  },
  typescript: {
    keywords: new Set([
      ...JS_KEYWORDS,
      ...set(
        "interface type enum implements public private protected readonly declare namespace abstract satisfies keyof infer",
      ),
    ]),
    types: JS_TYPES,
    builtins: JS_BUILTINS,
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: C_LIKE_QUOTES,
  },
  json: {
    keywords: set("true false null"),
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: [{ open: '"', close: '"', multiline: false, escape: true }],
    keyValue: true,
  },
  python: {
    keywords: PY_KEYWORDS,
    types: PY_TYPES,
    builtins: PY_BUILTINS,
    lineComments: ["#"],
    // Longest delimiters first so `"""` wins over `"`.
    quotes: [
      { open: '"""', close: '"""', multiline: true, escape: true },
      { open: "'''", close: "'''", multiline: true, escape: true },
      { open: '"', close: '"', multiline: false, escape: true },
      { open: "'", close: "'", multiline: false, escape: true },
    ],
  },
  shell: {
    keywords: SH_KEYWORDS,
    builtins: SH_BUILTINS,
    lineComments: ["#"],
    quotes: [
      { open: '"', close: '"', multiline: true, escape: true, interpolate: true },
      { open: "'", close: "'", multiline: true, escape: false },
    ],
    variables: true,
  },
  yaml: {
    keywords: YAML_KEYWORDS,
    lineComments: ["#"],
    quotes: [
      { open: '"', close: '"', multiline: false, escape: true },
      { open: "'", close: "'", multiline: false, escape: false },
    ],
    keyValue: true,
  },
};

/** Aliases → canonical spec key. `null` means "known but not highlighted". */
const ALIASES: Record<string, string | null> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  javascript: "javascript",
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  json: "json",
  jsonc: "json",
  json5: "json",
  py: "python",
  python: "python",
  python3: "python",
  sh: "shell",
  bash: "shell",
  shell: "shell",
  zsh: "shell",
  console: "shell",
  yml: "yaml",
  yaml: "yaml",
  diff: "diff",
  patch: "diff",
  text: null,
  txt: null,
  plain: null,
  "": null,
};

const DIFF_META = /^(diff |index |new file|deleted file|similarity |rename |--- |\+\+\+ |@@)/;
const SHELL_VARIABLE = /^\$\{[^}]*\}|^\$[A-Za-z_][A-Za-z0-9_]*|^\$[?#@!$*0-9]/;

export function normalizeLanguage(language: string): string {
  const key = language.trim().toLowerCase();
  return key in ALIASES ? (ALIASES[key] ?? "") : "";
}

export function supportsLanguage(language: string): boolean {
  return normalizeLanguage(language).length > 0;
}

/**
 * Tokenizes code into one token list per line, so the caller can render it line
 * by line and keep its own wrapping.
 */
export function highlightLines(code: string, language: string): Token[][] {
  const canonical = normalizeLanguage(language);
  const lines = code.split("\n");

  if (canonical === "diff") return lines.map(highlightDiffLine);

  const spec = SPECS[canonical];
  if (!spec) return lines.map((line) => [{ text: line, kind: "plain" as const }]);

  let state: ScanState = { inBlockComment: false, multiline: null };
  return lines.map((line) => {
    const result = scanLine(line, state, spec);
    state = result.state;
    return result.tokens;
  });
}

function highlightDiffLine(line: string): Token[] {
  if (DIFF_META.test(line)) return [{ text: line, kind: "meta" }];
  if (line.startsWith("+")) return [{ text: line, kind: "added" }];
  if (line.startsWith("-")) return [{ text: line, kind: "removed" }];
  return [{ text: line, kind: "plain" }];
}

interface ScanResult {
  tokens: Token[];
  state: ScanState;
}

function scanLine(line: string, incoming: ScanState, spec: LangSpec): ScanResult {
  const tokens: Token[] = [];
  let state: ScanState = { ...incoming };
  let index = 0;

  const push = (text: string, kind: TokenKind): void => {
    if (text.length === 0) return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) last.text += text;
    else tokens.push({ text, kind });
  };

  // Finish a construct carried over from the previous line.
  if (state.multiline !== null) {
    const quote = state.multiline;
    const scanned = scanString(line, 0, 0, quote, push);
    index = scanned.index;
    state = { ...state, multiline: scanned.closed ? null : quote };
  }

  while (index < line.length) {
    const rest = line.slice(index);
    const char = line[index]!;

    if (state.inBlockComment) {
      const close = spec.blockComment![1];
      const end = line.indexOf(close, index);
      if (end === -1) {
        push(rest, "comment");
        return { tokens, state };
      }
      push(line.slice(index, end + close.length), "comment");
      index = end + close.length;
      state = { ...state, inBlockComment: false };
      continue;
    }

    const lineComment = spec.lineComments.find((marker) => rest.startsWith(marker));
    if (lineComment !== undefined) {
      push(rest, "comment");
      break;
    }

    if (spec.blockComment && rest.startsWith(spec.blockComment[0])) {
      // Strings are matched below, so reaching here means we are not inside one.
      state = { ...state, inBlockComment: true };
      index += spec.blockComment[0].length;
      continue;
    }

    const quote = spec.quotes.find((candidate) => rest.startsWith(candidate.open));
    if (quote) {
      const firstToken = tokens.length;
      const scanned = scanString(line, index, index + quote.open.length, quote, push);
      // A quoted key (`"name":`) reads as a property, not as a value string.
      if (scanned.closed && spec.keyValue === true && line[scanned.index] === ":") {
        for (let token = firstToken; token < tokens.length; token++) {
          tokens[token]!.kind = "property";
        }
      }
      index = scanned.index;
      if (!scanned.closed && quote.multiline) state = { ...state, multiline: quote };
      if (!scanned.closed) return { tokens, state };
      continue;
    }

    if (spec.variables && char === "$") {
      const match = SHELL_VARIABLE.exec(rest);
      if (match) {
        push(match[0], "builtin");
        index += match[0].length;
        continue;
      }
    }

    const previous = index > 0 ? line[index - 1]! : "";

    if (char >= "0" && char <= "9" && !/[\w$.]/.test(previous)) {
      const match = /^\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?/.exec(rest);
      if (match) {
        push(match[0], "number");
        index += match[0].length;
        continue;
      }
    }

    if (/[A-Za-z_$]/.test(char)) {
      const match = /^[A-Za-z_$][\w$]*/.exec(rest)!;
      const word = match[0];
      const after = line[index + word.length];
      const isKey = spec.keyValue === true && after === ":";

      let kind: TokenKind = "plain";
      if (isKey) kind = "property";
      else if (spec.keywords.has(word)) kind = "keyword";
      else if (spec.types?.has(word)) kind = "type";
      else if (spec.builtins?.has(word)) kind = "builtin";
      // Order matters: a capitalised name reads as a type even when called
      // (`new Widget()`), while `console.log(` reads as a function.
      else if (/^[A-Z]/.test(word)) kind = "type";
      else if (after === "(") kind = "function";
      else if (previous === ".") kind = "property";

      push(word, kind);
      index += word.length;
      continue;
    }

    if ("+-*/%=<>!&|^~?".includes(char)) {
      const match = /^[+\-*/%=<>!&|^~?]+/.exec(rest)!;
      push(match[0], "operator");
      index += match[0].length;
      continue;
    }

    if ("(){}[];,".includes(char)) {
      push(char, "punct");
      index += 1;
      continue;
    }

    push(char, "plain");
    index += 1;
  }

  return { tokens, state };
}

/**
 * Scans one string literal.
 *
 * `literalStart` is where the coloured run begins (the opening delimiter, or 0
 * when resuming a multi-line string); `scanFrom` is where scanning begins.
 * With `interpolate`, `$var` inside the quotes is emitted as a variable token,
 * which is how shell code is normally read.
 */
function scanString(
  line: string,
  literalStart: number,
  scanFrom: number,
  quote: QuoteSpec,
  push: (text: string, kind: TokenKind) => void,
): { index: number; closed: boolean } {
  let index = scanFrom;
  let literalStartCursor = literalStart;

  const flushLiteral = (end: number): void => {
    if (end > literalStartCursor) push(line.slice(literalStartCursor, end), "string");
  };

  while (index < line.length) {
    const char = line[index]!;

    if (quote.escape && char === "\\") {
      index += 2;
      continue;
    }

    if (quote.interpolate && char === "$") {
      const match = SHELL_VARIABLE.exec(line.slice(index));
      if (match) {
        flushLiteral(index);
        push(match[0], "builtin");
        index += match[0].length;
        literalStartCursor = index;
        continue;
      }
    }

    if (line.startsWith(quote.close, index)) {
      index += quote.close.length;
      flushLiteral(index);
      return { index, closed: true };
    }

    index += 1;
  }

  flushLiteral(line.length);
  return { index: line.length, closed: false };
}

export { SPECS as LANGUAGE_SPECS };
