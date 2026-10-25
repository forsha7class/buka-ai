/**
 * Minimal, spec-tolerant Server-Sent Events parser.
 *
 * Written by hand (no deps) because the upstream gateways we talk to are not
 * strict: some emit a trailing `data: [DONE]` even on non-streaming responses,
 * some send `\r\n`, some send bare `\n`. This parser handles all of it and
 * never throws on malformed payloads — decoding is the caller's job.
 */

export interface SSEEvent {
  /** `event:` field, if present. */
  event?: string;
  /** Concatenated `data:` lines (joined with `\n`), always present. */
  data: string;
  /** `id:` field, if present. */
  id?: string;
  /** `retry:` field in milliseconds, if present and numeric. */
  retry?: number;
}

export type ByteSource =
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>
  | Iterable<Uint8Array>;

export async function* parseSSE(input: ByteSource): AsyncGenerator<SSEEvent, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = "";

  // Fields of the event currently being assembled.
  let dataLines: string[] = [];
  let eventName: string | undefined;
  let lastId: string | undefined;
  let retry: number | undefined;

  const ready: SSEEvent[] = [];

  const handleLine = (rawLine: string): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    // Blank line dispatches the buffered event.
    if (line === "") {
      if (dataLines.length > 0) {
        ready.push({ event: eventName, data: dataLines.join("\n"), id: lastId, retry });
      }
      dataLines = [];
      eventName = undefined;
      lastId = undefined;
      retry = undefined;
      return;
    }

    // Comment / heartbeat.
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "data":
        dataLines.push(value);
        break;
      case "event":
        eventName = value;
        break;
      case "id":
        lastId = value;
        break;
      case "retry": {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) retry = parsed;
        break;
      }
      default:
        // Unknown field: ignored per spec.
        break;
    }
  };

  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handleLine(line);
      while (ready.length > 0) yield ready.shift()!;
      newline = buffer.indexOf("\n");
    }
  }

  // Flush whatever is left, including an event missing its trailing blank line.
  buffer += decoder.decode();
  if (buffer.length > 0) handleLine(buffer);
  if (dataLines.length > 0) {
    ready.push({ event: eventName, data: dataLines.join("\n"), id: lastId, retry });
  }
  while (ready.length > 0) yield ready.shift()!;
}
