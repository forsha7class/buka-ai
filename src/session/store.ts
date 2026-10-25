import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { sessionsDir } from "../config/paths.js";
import type { ChatMessage, ToolCall } from "../provider/types.js";

/**
 * Append-only JSONL session log.
 *
 * One file per session under `~/.local/share/buka-ai/sessions`. Line 0 is the
 * metadata record; every later line is a user or assistant turn. Appending is
 * atomic enough for our purposes (small writes, single writer) and means a
 * crash mid-run still leaves a readable transcript.
 *
 * Tool results are stored alongside the assistant turn that requested them, so
 * a resumed session can rebuild both the display transcript and the exact
 * message array the provider expects.
 */

export interface ToolResultRecord {
  id: string;
  name: string;
  preview: string;
  output: string;
  isError: boolean;
  summary?: string;
}

export interface SessionMetaRecord {
  t: "meta";
  id: string;
  title: string;
  cwd: string;
  modelRef: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
}

export interface UserRecord {
  t: "user";
  text: string;
  ts: string;
}

export interface AssistantRecord {
  t: "assistant";
  text: string;
  reasoning: string;
  model: string;
  toolCalls: ToolCall[];
  toolResults: ToolResultRecord[];
  error?: string;
  ts: string;
}

export type SessionRecord = SessionMetaRecord | UserRecord | AssistantRecord;

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  modelRef: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  /** Number of user+assistant turns stored. */
  messages: number;
}

export interface CompleteAssistantOptions {
  text: string;
  reasoning: string;
  model: string;
  toolCalls: ToolCall[];
  toolResults: ToolResultRecord[];
  error?: string;
}

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export function newSessionId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export class SessionStore {
  readonly dir: string;

  constructor(dir: string = sessionsDir()) {
    this.dir = dir;
  }

  private path(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }

  /** Sessions newest-first. Malformed files are skipped, never fatal. */
  list(): SessionSummary[] {
    if (!existsSync(this.dir)) return [];
    const summaries: SessionSummary[] = [];

    for (const entry of readdirSync(this.dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const id = entry.slice(0, -".jsonl".length);
      try {
        const content = readFileSync(this.path(id), "utf8");
        const records = parseRecords(content);
        const meta = records.find((record): record is SessionMetaRecord => record.t === "meta");
        if (!meta) continue;
        summaries.push({
          id: meta.id,
          title: meta.title,
          cwd: meta.cwd,
          modelRef: meta.modelRef,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          turns: meta.turns,
          messages: records.filter((record) => record.t !== "meta").length,
        });
      } catch {
        continue;
      }
    }

    // A total order, not just "newest first": two sessions created in the same
    // millisecond would otherwise come back in filesystem order, and `latest()`
    // decides what `buka -c` resumes.
    return summaries.sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) ||
        b.createdAt.localeCompare(a.createdAt) ||
        b.id.localeCompare(a.id),
    );
  }

  /** Most recently updated session, optionally restricted to one directory. */
  latest(cwd?: string): SessionSummary | undefined {
    return this.list().find((summary) => cwd === undefined || summary.cwd === cwd);
  }

  exists(id: string): boolean {
    return existsSync(this.path(id));
  }

  load(id: string): Session {
    const path = this.path(id);
    if (!existsSync(path)) {
      throw new SessionError(`Session not found: ${id}`);
    }
    const records = parseRecords(readFileSync(path, "utf8"));
    const meta = records.find((record): record is SessionMetaRecord => record.t === "meta");
    if (!meta) throw new SessionError(`Session ${id} has no metadata record`);
    return new Session(this, meta, records.filter((record) => record.t !== "meta"), path);
  }

  create(options: { cwd: string; modelRef: string; model: string; title?: string }): Session {
    const id = newSessionId();
    const now = new Date().toISOString();
    const meta: SessionMetaRecord = {
      t: "meta",
      id,
      title: options.title ?? "untitled",
      cwd: options.cwd,
      modelRef: options.modelRef,
      model: options.model,
      createdAt: now,
      updatedAt: now,
      turns: 0,
    };
    const path = this.path(id);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(meta)}\n`, "utf8");
    return new Session(this, meta, [], path);
  }

  remove(id: string): void {
    const path = this.path(id);
    if (existsSync(path)) rmSync(path);
  }

  /** @internal — used by Session to serialize appends. */
  writeMeta(path: string, records: SessionRecord[], meta: SessionMetaRecord): void {
    const body = [meta, ...records].map((record) => JSON.stringify(record)).join("\n");
    writeFileSync(path, `${body}\n`, "utf8");
  }
}

export class Session {
  private readonly store: SessionStore;
  private readonly path: string;
  private meta: SessionMetaRecord;
  private history: Array<UserRecord | AssistantRecord>;

  constructor(
    store: SessionStore,
    meta: SessionMetaRecord,
    history: Array<UserRecord | AssistantRecord>,
    path: string,
  ) {
    this.store = store;
    this.meta = meta;
    this.history = history;
    this.path = path;
  }

  get id(): string {
    return this.meta.id;
  }

  get title(): string {
    return this.meta.title;
  }

  get metaSnapshot(): SessionMetaRecord {
    return { ...this.meta };
  }

  get records(): ReadonlyArray<UserRecord | AssistantRecord> {
    return this.history;
  }

  get isEmpty(): boolean {
    return this.history.length === 0;
  }

  recordUser(text: string): void {
    this.append({ t: "user", text, ts: new Date().toISOString() });
    // Naming the session after the first thing the user asked is a good enough
    // heuristic and costs nothing.
    if (this.meta.title === "untitled") this.meta.title = deriveTitle(text);
    this.touch();
  }

  completeAssistant(options: CompleteAssistantOptions): void {
    const record: AssistantRecord = {
      t: "assistant",
      text: options.text,
      reasoning: options.reasoning,
      model: options.model,
      toolCalls: options.toolCalls,
      toolResults: options.toolResults,
      ...(options.error !== undefined ? { error: options.error } : {}),
      ts: new Date().toISOString(),
    };
    this.append(record);
    this.meta.turns += 1;
    this.touch();
  }

  rename(title: string): void {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    this.meta.title = trimmed;
    this.touch();
  }

  setModel(modelRef: string, model: string): void {
    this.meta.modelRef = modelRef;
    this.meta.model = model;
    this.touch();
  }

  /**
   * Rebuilds the provider message array: assistant turns carry their tool_calls
   * and the matching tool results follow as `role: "tool"` messages, which is
   * exactly the shape `/chat/completions` requires.
   */
  toChatMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [];

    for (const record of this.history) {
      if (record.t === "user") {
        messages.push({ role: "user", content: record.text });
        continue;
      }

      messages.push({
        role: "assistant",
        content: record.text.length > 0 ? record.text : null,
        ...(record.toolCalls.length > 0 ? { tool_calls: record.toolCalls } : {}),
      });

      for (const result of record.toolResults) {
        messages.push({
          role: "tool",
          tool_call_id: result.id,
          content: result.output,
        });
      }
    }

    return messages;
  }

  private append(record: UserRecord | AssistantRecord): void {
    this.history.push(record);
    mkdirSync(this.store.dir, { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }

  private touch(): void {
    this.meta.updatedAt = new Date().toISOString();
    this.store.writeMeta(this.path, this.history, this.meta);
  }
}

function parseRecords(content: string): SessionRecord[] {
  const records: SessionRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as SessionRecord;
      if (parsed && typeof parsed === "object" && typeof parsed.t === "string") records.push(parsed);
    } catch {
      // A truncated final line (interrupted write) is expected; skip it.
      continue;
    }
  }
  return records;
}

export function deriveTitle(text: string, max = 60): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1)}…`;
}
