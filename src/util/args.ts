/**
 * A tiny, dependency-free CLI flag parser.
 *
 * Supports `--flag`, `--key=value`, `--key value`, `-x`, `-xvalue`, `-x value`
 * and `--` to stop parsing. Unknown flags are collected so callers can reject
 * them loudly instead of silently ignoring typos.
 */

export interface ParsedArgs {
  /** Positional arguments after the command. */
  positionals: string[];
  /** `--key value` / `--key=value` / short aliases, normalized to long names. */
  options: Map<string, string | boolean>;
  unknown: string[];
}

export interface FlagSpec {
  /** Long name without dashes, e.g. `model`. */
  name: string;
  /** Single-character alias, e.g. `m`. */
  alias?: string;
  /** Takes a value (consumes the next argv entry if not `=`-joined). */
  value?: boolean;
  /** May be repeated; values accumulate. */
  repeat?: boolean;
}

export function parseArgs(argv: string[], specs: FlagSpec[]): ParsedArgs {
  const byLong = new Map<string, FlagSpec>();
  const byShort = new Map<string, FlagSpec>();
  for (const spec of specs) {
    byLong.set(spec.name, spec);
    if (spec.alias) byShort.set(spec.alias, spec);
  }

  const positionals: string[] = [];
  const options = new Map<string, string | boolean>();
  const unknown: string[] = [];

  let i = 0;
  let passthrough = false;

  const assign = (spec: FlagSpec, value: string | boolean): void => {
    if (spec.repeat) {
      const key = `${spec.name}[]`;
      const current = options.get(key);
      const list =
        typeof current === "string" && current.length > 0 ? current.split("\u0000") : [];
      list.push(String(value));
      options.set(key, list.join("\u0000"));
      return;
    }
    options.set(spec.name, value);
  };

  while (i < argv.length) {
    const arg = argv[i]!;

    if (passthrough) {
      positionals.push(arg);
      i++;
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      i++;
      continue;
    }

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      const spec = byLong.get(name);
      if (!spec) {
        unknown.push(arg);
        i++;
        continue;
      }
      if (spec.value) {
        if (eq !== -1) {
          assign(spec, body.slice(eq + 1));
          i++;
        } else {
          const next = argv[i + 1];
          if (next === undefined) {
            unknown.push(arg);
            i++;
          } else {
            assign(spec, next);
            i += 2;
          }
        }
      } else {
        assign(spec, eq === -1 ? true : body.slice(eq + 1));
        i++;
      }
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      const short = arg[1]!;
      const spec = byShort.get(short);
      if (!spec) {
        unknown.push(arg);
        i++;
        continue;
      }
      const rest = arg.slice(2);
      if (spec.value) {
        if (rest.length > 0) {
          assign(spec, rest);
          i++;
        } else {
          const next = argv[i + 1];
          if (next === undefined) {
            unknown.push(arg);
            i++;
          } else {
            assign(spec, next);
            i += 2;
          }
        }
      } else {
        assign(spec, true);
        i++;
      }
      continue;
    }

    positionals.push(arg);
    i++;
  }

  return { positionals, options, unknown };
}

export function getString(args: ParsedArgs, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === "string" ? value : undefined;
}

export function getBool(args: ParsedArgs, name: string): boolean {
  return args.options.get(name) === true || args.options.get(name) === "true";
}

export function getList(args: ParsedArgs, name: string): string[] {
  const raw = args.options.get(`${name}[]`);
  if (typeof raw !== "string" || raw.length === 0) {
    const single = args.options.get(name);
    return typeof single === "string" ? [single] : [];
  }
  return raw.split("\u0000");
}
