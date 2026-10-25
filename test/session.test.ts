/**
 * Session store tests. All filesystem work happens in a temp directory so the
 * developer's real session history is never touched.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { SessionStore, deriveTitle, type AssistantRecord } from "../src/session/store.js";

/** Narrows a stored record to an assistant turn, failing the test otherwise. */
function asAssistant(record: unknown): AssistantRecord {
  const value = record as AssistantRecord;
  assert.equal(value?.t, "assistant");
  return value;
}

/** Rewrites session metadata fields, so ordering tests are deterministic. */
function pinMeta(id: string, patch: Record<string, string>): void {
  const path = join(dir, `${id}.jsonl`);
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const meta = JSON.parse(lines[0]!) as Record<string, unknown>;
  Object.assign(meta, patch);
  lines[0] = JSON.stringify(meta);
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function pinUpdatedAt(id: string, iso: string): void {
  pinMeta(id, { updatedAt: iso });
}

/** An ISO timestamp `days` ahead of now, so ordering never depends on today's date. */
function futureIso(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

let dir: string;
let store: SessionStore;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "buka-sessions-"));
  store = new SessionStore(dir);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("session store", () => {
  it("creates an empty session with a metadata record", () => {
    const session = store.create({ cwd: "/work", modelRef: "p/m", model: "M" });
    assert.ok(session.id.length > 0);
    assert.ok(session.isEmpty);

    const raw = readFileSync(join(dir, `${session.id}.jsonl`), "utf8").trim().split("\n");
    assert.equal(raw.length, 1);
    const meta = JSON.parse(raw[0]!);
    assert.equal(meta.t, "meta");
    assert.equal(meta.cwd, "/work");
    assert.equal(meta.turns, 0);
  });

  it("appends turns and derives a title from the first user message", () => {
    const session = store.create({ cwd: "/work", modelRef: "p/m", model: "M" });
    session.recordUser("  explain   the auth flow  ");
    session.completeAssistant({
      text: "It works like this.",
      reasoning: "let me think",
      model: "M",
      toolCalls: [],
      toolResults: [],
    });

    assert.equal(session.title, "explain the auth flow");
    assert.equal(session.metaSnapshot.turns, 1);
    assert.equal(session.records.length, 2);
  });

  it("keeps a custom title once renamed", () => {
    const session = store.create({ cwd: "/work", modelRef: "p/m", model: "M" });
    session.recordUser("first question");
    session.rename("Auth refactor");
    session.recordUser("second question");
    assert.equal(session.title, "Auth refactor");
  });

  it("ignores an empty rename", () => {
    const session = store.create({ cwd: "/work", modelRef: "p/m", model: "M" });
    session.rename("   ");
    assert.equal(session.title, "untitled");
  });

  it("loads a session back with its transcript intact", () => {
    const session = store.create({ cwd: "/work", modelRef: "p/m", model: "M" });
    session.recordUser("hello");
    session.completeAssistant({
      text: "hi there",
      reasoning: "greeting",
      model: "M",
      toolCalls: [],
      toolResults: [],
    });

    const loaded = store.load(session.id);
    assert.equal(loaded.title, session.title);
    assert.equal(loaded.records.length, 2);
    assert.deepEqual(
      loaded.records.map((record) => record.t),
      ["user", "assistant"],
    );
    assert.equal(asAssistant(loaded.records[1]).reasoning, "greeting");
  });

  it("rebuilds provider messages including tool results in order", () => {
    const session = store.create({ cwd: "/work", modelRef: "p/m", model: "M" });
    session.recordUser("list files");
    session.completeAssistant({
      text: "Let me look.",
      reasoning: "",
      model: "M",
      toolCalls: [
        { id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
      ],
      toolResults: [
        { id: "call_1", name: "bash", preview: "ls", output: "a.txt", isError: false, summary: "exit code 0" },
      ],
    });
    session.recordUser("thanks");

    const messages = session.toChatMessages();
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant", "tool", "user"],
    );
    assert.equal(messages[1]!.tool_calls?.[0]!.function.name, "bash");
    assert.equal(messages[2]!.tool_call_id, "call_1");
    assert.equal(messages[2]!.content, "a.txt");
  });

  it("uses a null assistant content when the turn was tool-only", () => {
    const session = store.create({ cwd: "/work", modelRef: "p/m", model: "M" });
    session.recordUser("go");
    session.completeAssistant({
      text: "",
      reasoning: "",
      model: "M",
      toolCalls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}" } }],
      toolResults: [{ id: "c", name: "read", preview: "x", output: "content", isError: false }],
    });
    const assistant = session.toChatMessages()[1]!;
    assert.equal(assistant.content, null);
  });

  it("persists a failed turn with its error", () => {
    const session = store.create({ cwd: "/work", modelRef: "p/m", model: "M" });
    session.recordUser("boom");
    session.completeAssistant({
      text: "",
      reasoning: "",
      model: "M",
      toolCalls: [],
      toolResults: [],
      error: "provider exploded",
    });
    const loaded = store.load(session.id);
    const assistant = loaded.records[1]!;
    assert.equal(assistant.t === "assistant" && assistant.error, "provider exploded");
  });

  it("lists sessions newest first with summaries", () => {
    const older = store.create({ cwd: "/a", modelRef: "p/m", model: "M" });
    older.recordUser("older session");
    const newer = store.create({ cwd: "/b", modelRef: "p/m", model: "M" });
    newer.recordUser("newer session");

    // Timestamps come from the clock and can collide, so pin them well into the
    // future — newer than any other session this suite creates — making the
    // assertion about the sort, not about timing.
    pinUpdatedAt(older.id, futureIso(1));
    pinUpdatedAt(newer.id, futureIso(2));

    const list = store.list();
    assert.equal(list[0]!.id, newer.id, "most recently updated comes first");
    assert.equal(list[0]!.messages, 1);
    assert.equal(list[0]!.title, "newer session");
    assert.ok(list[0]!.createdAt.length > 0, "createdAt is exposed for tie-breaking");

    // The order must be identical on every read.
    assert.deepEqual(
      store.list().map((summary) => summary.id),
      list.map((summary) => summary.id),
    );
  });

  it("breaks ties deterministically when timestamps are identical", () => {
    const first = store.create({ cwd: "/tie", modelRef: "p/m", model: "M" });
    const second = store.create({ cwd: "/tie", modelRef: "p/m", model: "M" });
    first.recordUser("one");
    second.recordUser("two");

    // Both timestamps pinned identically, so only the id can order them.
    const stamp = futureIso(3);
    pinMeta(first.id, { updatedAt: stamp, createdAt: stamp });
    pinMeta(second.id, { updatedAt: stamp, createdAt: stamp });

    const ids = store.list().map((summary) => summary.id);
    const expected = [first.id, second.id].sort((a, b) => b.localeCompare(a));
    assert.deepEqual(ids.slice(0, 2), expected, "ties fall back to id, descending");
    assert.equal(store.latest("/tie")?.id, expected[0], "latest() is stable too");
  });

  it("filters the latest session by working directory", () => {
    const target = "/unique-cwd-for-test";
    const session = store.create({ cwd: target, modelRef: "p/m", model: "M" });
    session.recordUser("scoped");
    assert.equal(store.latest(target)?.id, session.id);
    assert.equal(store.latest("/definitely-not-a-session-cwd"), undefined);
  });

  it("skips a truncated final line instead of failing", () => {
    const session = store.create({ cwd: "/work", modelRef: "p/m", model: "M" });
    session.recordUser("complete");
    appendFileSync(join(dir, `${session.id}.jsonl`), '{"t":"assis', "utf8");

    const loaded = store.load(session.id);
    assert.equal(loaded.records.length, 1, "the partial record is dropped");
  });

  it("ignores files that are not valid sessions", () => {
    writeFileSync(join(dir, "garbage.jsonl"), "not json at all\n", "utf8");
    assert.ok(!store.list().some((summary) => summary.id === "garbage"));
  });

  it("throws a clear error for an unknown session", () => {
    assert.throws(() => store.load("no-such-session"), /Session not found/);
  });

  it("removes a session", () => {
    const session = store.create({ cwd: "/work", modelRef: "p/m", model: "M" });
    assert.equal(store.exists(session.id), true);
    store.remove(session.id);
    assert.equal(store.exists(session.id), false);
  });

  it("records a model switch", () => {
    const session = store.create({ cwd: "/work", modelRef: "p/m", model: "M" });
    session.setModel("other/model", "OtherModel");
    assert.equal(store.load(session.id).metaSnapshot.modelRef, "other/model");
    assert.equal(store.load(session.id).metaSnapshot.model, "OtherModel");
  });

  it("stores the ordered part list and rebuilds it", () => {
    const session = store.create({ cwd: "/work", modelRef: "p/m", model: "M" });
    session.recordUser("go");
    session.completeAssistant({
      text: "first",
      reasoning: "hmm",
      model: "M",
      toolCalls: [],
      toolResults: [],
      parts: [
        { kind: "thinking", text: "hmm" },
        { kind: "text", text: "first" },
        { kind: "tool", id: "c1" },
        { kind: "text", text: "second" },
      ],
    });

    const loaded = store.load(session.id);
    const assistant = loaded.records[1]!;
    assert.equal(assistant.t, "assistant");
    const parts = assistant.t === "assistant" ? assistant.parts : undefined;
    assert.deepEqual(parts, [
      { kind: "thinking", text: "hmm" },
      { kind: "text", text: "first" },
      { kind: "tool", id: "c1" },
      { kind: "text", text: "second" },
    ]);
  });
});

describe("compaction", () => {
  function seed(session: ReturnType<SessionStore["create"]>): void {
    session.recordUser("first question");
    session.completeAssistant({
      text: "first answer",
      reasoning: "",
      model: "M",
      toolCalls: [],
      toolResults: [],
    });
  }

  it("replaces earlier turns with the summary in the provider context", () => {
    const session = store.create({ cwd: "/work", modelRef: "p/m", model: "M" });
    seed(session);
    assert.equal(session.toChatMessages().length, 2, "before compaction");

    session.compact("the user asked one question");

    const messages = session.toChatMessages();
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.role, "user");
    assert.match(String(messages[0]!.content), /\[Summary of the earlier conversation\]/);
    assert.match(String(messages[0]!.content), /the user asked one question/);
    assert.ok(
      !messages.some((message) => message.content === "first answer"),
      "the replaced turn is gone from the context",
    );
  });

  it("survives a reload — this is what makes /compact persistent", () => {
    const session = store.create({ cwd: "/work", modelRef: "p/m", model: "M" });
    seed(session);
    session.compact("folded away");
    session.recordUser("second question");

    const reloaded = store.load(session.id);
    const messages = reloaded.toChatMessages();
    assert.equal(messages.length, 2, "summary plus the new question");
    assert.match(String(messages[0]!.content), /folded away/);
    assert.equal(messages[1]!.content, "second question");
  });

  it("keeps the full history on disk while shrinking the context", () => {
    const session = store.create({ cwd: "/work", modelRef: "p/m", model: "M" });
    seed(session);
    session.compact("summary text");

    const raw = readFileSync(join(dir, `${session.id}.jsonl`), "utf8");
    assert.ok(raw.includes("first question"), "the log is not rewritten");
    assert.ok(raw.includes("first answer"));
    assert.ok(raw.includes('"t":"compaction"'));

    const summary = store.list().find((entry) => entry.id === session.id)!;
    assert.equal(summary.compactions, 1);
    assert.equal(summary.messages, 2, "message count still reflects the real turns");
  });

  it("honours only the most recent compaction", () => {
    const session = store.create({ cwd: "/work", modelRef: "p/m", model: "M" });
    seed(session);
    session.compact("first summary");
    session.recordUser("middle question");
    session.compact("second summary");
    session.recordUser("last question");

    const messages = session.toChatMessages();
    assert.match(String(messages[0]!.content), /second summary/);
    assert.ok(!messages.some((message) => message.content === "first summary"));
    assert.equal(messages.at(-1)!.content, "last question");
  });

  it("keeps tool results after a compaction boundary", () => {
    const session = store.create({ cwd: "/work", modelRef: "p/m", model: "M" });
    seed(session);
    session.compact("summary");
    session.recordUser("now list files");
    session.completeAssistant({
      text: "",
      reasoning: "",
      model: "M",
      toolCalls: [
        { id: "c9", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
      ],
      toolResults: [{ id: "c9", name: "bash", preview: "ls", output: "a.txt", isError: false }],
    });

    const messages = session.toChatMessages();
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "user", "assistant", "tool"],
    );
    assert.equal(messages[3]!.tool_call_id, "c9");
  });
});

describe("title derivation", () => {
  it("collapses whitespace", () => {
    assert.equal(deriveTitle("  a \n b  "), "a b");
  });

  it("truncates with an ellipsis", () => {
    const title = deriveTitle("x".repeat(100), 20);
    assert.equal(title.length, 20);
    assert.ok(title.endsWith("…"));
  });
});
