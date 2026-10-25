import type { SSEEvent } from "../util/sse.js";
import { parseSSE } from "../util/sse.js";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface StreamHttpResponse {
  status: number;
  ok: boolean;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

/**
 * Turns an errored HTTP response into a useful message. Gateways in front of
 * LLM APIs love returning 200-with-an-error, or a 500 with a JSON blob, so we
 * never assume a shape.
 */
export async function readErrorMessage(res: StreamHttpResponse): Promise<string> {
  const raw = await safeText(res);
  const trimmed = raw.trim();
  if (!trimmed) return `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const err = parsed["error"];
    if (typeof err === "string") return `HTTP ${res.status}: ${err}`;
    if (err && typeof err === "object") {
      const msg = (err as Record<string, unknown>)["message"];
      if (typeof msg === "string") return `HTTP ${res.status}: ${msg}`;
    }
    const msg = parsed["message"];
    if (typeof msg === "string") return `HTTP ${res.status}: ${msg}`;
  } catch {
    // Not JSON — fall through to raw text.
  }
  return `HTTP ${res.status}: ${trimmed.slice(0, 500)}`;
}

async function safeText(res: StreamHttpResponse): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Decodes the JSON payloads out of an SSE stream, dropping `[DONE]` sentinels
 * and silently skipping payloads that don't parse (some upstreams append
 * non-JSON garbage after the last real chunk).
 */
export async function* decodeJsonEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown, void, undefined> {
  for await (const event of parseSSE(body)) {
    const data = event.data.trim();
    if (data === "" || data === "[DONE]") continue;
    try {
      yield JSON.parse(data);
    } catch {
      // Tolerate trailing junk such as `data: [DONE]` glued to the last object.
      continue;
    }
  }
}

export type { SSEEvent };

/**
 * Extracts the first complete top-level JSON object from a string, ignoring
 * anything after it.
 *
 * Needed because some gateways answer a `stream: false` request with a plain
 * JSON body followed by SSE garbage (`{"id":...}}data: [DONE]`), which
 * `JSON.parse` rejects outright.
 */
export function extractFirstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }

  return undefined;
}
