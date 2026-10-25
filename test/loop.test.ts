/**
 * Agent loop tests, driven by a scripted fake provider.
 *
 * The loop is the heart of the product — it decides when to call tools, how to
 * feed results back and when to stop. Testing it directly (instead of only
 * end-to-end) makes multi-turn behaviour, tool errors and stop conditions
 * deterministic and instant.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runAgent, type AgentEvent } from "../src/agent/loop.js";
import { ToolRegistry } from "../src/agent/tools/registry.js";
import type { Tool } from "../src/agent/tools/types.js";
import type {
  ChatRequest,
  ChatMessage,
  FinishReason,
  Provider,
  ProviderEvent,
  ToolCall,
} from "../src/provider/types.js";

/** One scripted provider turn. */
interface ScriptedTurn {
  text?: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** Provider that replays a fixed script of turns and records what it received. */
class FakeProvider implements Provider {
  readonly id = "fake";
  readonly name = "Fake";
  readonly requests: ChatRequest[] = [];

  constructor(private readonly script: ScriptedTurn[]) {}

  listModels() {
    return Promise.resolve([]);
  }

  async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, undefined> {
    this.requests.push(req);
    const turn = this.script.shift() ?? {};
    yield { type: "start", model: "fake-model" };

    if (turn.reasoning) yield { type: "reasoning", delta: turn.reasoning };

    // Emit text in two chunks so accumulators are exercised.
    if (turn.text) {
      const half = Math.ceil(turn.text.length / 2);
      yield { type: "text", delta: turn.text.slice(0, half) };
      yield { type: "text", delta: turn.text.slice(half) };
    }

    for (const [index, call] of (turn.toolCalls ?? []).entries()) {
      yield { type: "tool_call_start", index, id: call.id, name: call.function.name };
      yield { type: "tool_call_args", index, delta: call.function.arguments };
    }

    const reason: FinishReason = (turn.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop";
    yield {
      type: "finish",
      reason,
      model: "fake-model",
      text: turn.text ?? "",
      reasoning: turn.reasoning ?? "",
      toolCalls: turn.toolCalls ?? [],
      ...(turn.usage ? { usage: turn.usage } : {}),
    };
  }
}

const echo: Tool = {
  name: "echo",
  description: "echo",
  parameters: { type: "object" },
  summarize: (args) => `echo ${JSON.stringify(args)}`,
  // Permission is the registry's job; the tool itself only runs when allowed.
  execute: async (args) => ({ output: `echoed ${JSON.stringify(args)}`, summary: "ok" }),
};

const registry = new ToolRegistry([echo]);

function call(id: string, args: object): ToolCall {
  return { id, type: "function", function: { name: "echo", arguments: JSON.stringify(args) } };
}

async function collect(provider: Provider, overrides: Partial<Parameters<typeof runAgent>[0]> = {}) {
  const events: AgentEvent[] = [];
  for await (const event of runAgent({
    provider,
    model: "fake-model",
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }],
    tools: registry,
    cwd: process.cwd(),
    ...overrides,
  })) {
    events.push(event);
  }
  return events;
}

const textOf = (events: AgentEvent[]): string =>
  events
    .filter((event): event is Extract<AgentEvent, { type: "text" }> => event.type === "text")
    .map((event) => event.delta)
    .join("");

describe("agent loop", () => {
  it("stops after one turn when there are no tool calls", async () => {
    const provider = new FakeProvider([{ text: "hello" }]);
    const events = await collect(provider);

    assert.equal(textOf(events), "hello");
    assert.equal(provider.requests.length, 1);
    const done = events.at(-1);
    assert.deepEqual(done, {
      type: "done",
      reason: "complete",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "go" },
        { role: "assistant", content: "hello" },
      ],
    });
  });

  it("forwards reasoning separately from text", async () => {
    const provider = new FakeProvider([{ text: "answer", reasoning: "thought" }]);
    const events = await collect(provider);
    const reasoning = events
      .filter((event): event is Extract<AgentEvent, { type: "reasoning" }> => event.type === "reasoning")
      .map((event) => event.delta)
      .join("");
    assert.equal(reasoning, "thought");
    assert.equal(textOf(events), "answer");
  });

  it("executes tool calls and feeds results back for a second turn", async () => {
    const provider = new FakeProvider([
      { text: "let me check", toolCalls: [call("c1", { n: 1 })] },
      { text: "all done" },
    ]);
    const events = await collect(provider);

    const starts = events.filter((event) => event.type === "tool_start");
    assert.equal(starts.length, 1);
    const ends = events.filter((event) => event.type === "tool_end");
    assert.equal(ends.length, 1);
    assert.equal((ends[0] as Extract<AgentEvent, { type: "tool_end" }>).isError, false);

    // Second request must carry the assistant tool_calls plus the tool result.
    const second = provider.requests[1]!;
    assert.deepEqual(
      second.messages.map((message) => message.role),
      ["system", "user", "assistant", "tool"],
    );
    const assistant = second.messages[2] as ChatMessage;
    assert.equal(assistant.tool_calls?.[0]!.id, "c1");
    assert.equal(second.messages[3]!.tool_call_id, "c1");
    assert.match(String(second.messages[3]!.content), /echoed/);
    assert.equal(second.tools?.length, 1, "tools are re-sent on every turn");

    // The request array is a snapshot, so a provider holding onto it never sees
    // the loop's later pushes.
    assert.equal(second.messages.length, 4, "request messages must not be mutated afterwards");
  });

  it("separates text produced in different turns", async () => {
    // Regression: consecutive turns used to concatenate with no separator, so
    // "…`/not found/`." fused with the next turn's leading word.
    const provider = new FakeProvider([
      { text: "first part.", toolCalls: [call("c1", {})] },
      { text: "second part." },
    ]);
    const events = await collect(provider);
    assert.equal(textOf(events), "first part.\n\nsecond part.");
  });

  it("does not add a separator when only one turn produced text", async () => {
    const provider = new FakeProvider([{ toolCalls: [call("c1", {})] }, { text: "only text" }]);
    const events = await collect(provider);
    assert.equal(textOf(events), "only text");
  });

  it("a turn with no tool calls ends the run, even without text", async () => {
    const provider = new FakeProvider([{ text: "" }]);
    const events = await collect(provider);
    assert.equal(provider.requests.length, 1, "no second turn is requested");
    assert.equal(textOf(events), "");
    assert.equal((events.at(-1) as Extract<AgentEvent, { type: "done" }>).reason, "complete");
  });

  it("reports a denied tool to the model instead of retrying", async () => {
    const provider = new FakeProvider([{ toolCalls: [call("c1", {})] }, { text: "understood" }]);
    const events = await collect(provider, { requestPermission: async () => false });

    const end = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_end" }> => event.type === "tool_end",
    );
    assert.equal(end?.isError, true);
    assert.match(String(provider.requests[1]!.messages[3]!.content), /denied/i);
  });

  it("consults the permission config for a mapped tool", async () => {
    const bashish = new ToolRegistry([{ ...echo, name: "bash", summarize: () => "echo" }]);

    const attempt = async (mode: "ask" | "allow" | "deny") => {
      const asked: string[] = [];
      const provider = new FakeProvider([
        { toolCalls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
        { text: "ok" },
      ]);
      const events: AgentEvent[] = [];
      for await (const event of runAgent({
        provider,
        model: "fake-model",
        messages: [{ role: "user", content: "go" }],
        tools: bashish,
        cwd: process.cwd(),
        permission: {
          read: "allow",
          glob: "allow",
          grep: "allow",
          list: "allow",
          bash: mode,
          write: "allow",
          edit: "allow",
        },
        requestPermission: async (request) => {
          asked.push(request.tool);
          return true;
        },
      })) {
        events.push(event);
      }
      const end = events.find(
        (event): event is Extract<AgentEvent, { type: "tool_end" }> => event.type === "tool_end",
      );
      return { asked, end };
    };

    assert.deepEqual((await attempt("ask")).asked, ["bash"], "ask mode prompts");
    assert.deepEqual((await attempt("allow")).asked, [], "allow mode never prompts");

    const denied = await attempt("deny");
    assert.deepEqual(denied.asked, [], "deny mode refuses without prompting");
    assert.equal(denied.end?.isError, true);
    assert.match(String(denied.end?.output), /Permission denied/);
  });

  it("defaults an unmapped tool to ask rather than running unattended", async () => {
    const asked: string[] = [];
    const provider = new FakeProvider([{ toolCalls: [call("c1", {})] }, { text: "ok" }]);
    await collect(provider, {
      permission: {
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: "allow",
        write: "allow",
        edit: "allow",
      },
      requestPermission: async (request) => {
        asked.push(request.tool);
        return true;
      },
    });
    // Every configured tool is "allow", yet the scripted "echo" tool has no
    // config key, so it must still ask.
    assert.deepEqual(asked, ["echo"]);
  });

  it("stops at the turn ceiling", async () => {
    // A provider that always asks for another tool would loop forever.
    const provider = new FakeProvider(
      Array.from({ length: 10 }, () => ({ toolCalls: [call("c", {})] })),
    );
    const events = await collect(provider, { maxTurns: 3 });
    assert.equal(provider.requests.length, 3);
    assert.deepEqual(events.at(-1), {
      type: "done",
      reason: "max-turns",
      messages: (events.at(-1) as Extract<AgentEvent, { type: "done" }>).messages,
    });
  });

  it("reports a provider failure as an error event", async () => {
    const failing: Provider = {
      id: "boom",
      name: "Boom",
      listModels: () => Promise.resolve([]),
      async *stream() {
        yield { type: "start", model: "x" } as ProviderEvent;
        throw new Error("connection reset");
      },
    };
    const events = await collect(failing);
    const error = events.at(-1);
    assert.equal(error?.type, "error");
    assert.equal((error as Extract<AgentEvent, { type: "error" }>).error.message, "connection reset");
  });

  it("stops cleanly when aborted mid-run", async () => {
    const controller = new AbortController();
    const aborting: Provider = {
      id: "aborting",
      name: "Aborting",
      listModels: () => Promise.resolve([]),
      async *stream() {
        yield { type: "start", model: "x" } as ProviderEvent;
        yield { type: "text", delta: "partial" } as ProviderEvent;
        controller.abort();
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    };

    const events = await collect(aborting, { signal: controller.signal });
    assert.equal(textOf(events), "partial");
    assert.equal(
      (events.at(-1) as Extract<AgentEvent, { type: "done" }>).reason,
      "aborted",
    );
  });

  it("does not start a turn once the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new FakeProvider([{ text: "never" }]);
    const events = await collect(provider, { signal: controller.signal });
    assert.equal(provider.requests.length, 0);
    assert.equal((events.at(-1) as Extract<AgentEvent, { type: "done" }>).reason, "aborted");
  });

  it("passes usage through", async () => {
    const provider = new FakeProvider([
      { text: "hi", usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } },
    ]);
    const events = await collect(provider);
    const usage = events.find(
      (event): event is Extract<AgentEvent, { type: "usage" }> => event.type === "usage",
    );
    assert.equal(usage?.usage?.totalTokens, 12);
    assert.equal(usage?.model, "fake-model");
  });

  it("omits the tools array when tools are disabled", async () => {
    const provider = new FakeProvider([{ text: "hi" }]);
    await collect(provider, { enableTools: false });
    assert.equal(provider.requests[0]!.tools, undefined);
  });

  it("survives malformed tool arguments", async () => {
    const provider = new FakeProvider([
      {
        toolCalls: [
          { id: "c1", type: "function", function: { name: "echo", arguments: "{not json" } },
        ],
      },
      { text: "done" },
    ]);
    const events = await collect(provider);
    const end = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_end" }> => event.type === "tool_end",
    );
    // The raw string is handed to the tool rather than crashing the loop.
    assert.equal(end?.isError, false);
    assert.match(String(end?.output), /__raw/);
  });

  it("reports an unknown tool as an error result", async () => {
    const provider = new FakeProvider([
      { toolCalls: [{ id: "c1", type: "function", function: { name: "nope", arguments: "{}" } }] },
      { text: "ok" },
    ]);
    const events = await collect(provider);
    const end = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_end" }> => event.type === "tool_end",
    );
    assert.equal(end?.isError, true);
    assert.match(String(end?.output), /Unknown tool/);
  });
});
