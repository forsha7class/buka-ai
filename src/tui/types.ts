import type { Usage } from "../provider/types.js";
import type { StopReason } from "../agent/loop.js";

/** Inline styling, mirroring the subset of Ink's `<Text>` props we use. */
export interface Style {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dimColor?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface Segment {
  text: string;
  style?: Style;
}

/** One rendered display line, made of inline segments. */
export type Line = Segment[];

export interface ToolView {
  id: string;
  name: string;
  preview: string;
  status: "running" | "done" | "error";
  output?: string;
  summary?: string;
  expanded: boolean;
}

export interface MessageView {
  id: string;
  role: "user" | "assistant";
  text: string;
  reasoning: string;
  streaming: boolean;
  thinkingExpanded: boolean;
  tools: ToolView[];
  error?: string;
  /** Upstream model that actually served this turn (may differ from the request). */
  model?: string;
}

export type RunStatus = "idle" | "thinking" | "responding" | "tool" | "permission";

export interface PendingPermission {
  tool: string;
  preview: string;
}

export interface AppState {
  messages: MessageView[];
  status: RunStatus;
  /** Wire model id, e.g. `Davo`. */
  model: string;
  /** Provider-qualified reference, e.g. `9router/davo`. */
  modelRef: string;
  usage: Usage | undefined;
  /** Cumulative token totals for the session header. */
  totals: { prompt: number; completion: number; cached: number };
  turn: number;
  pendingPermission: PendingPermission | null;
  /**
   * Absolute index of the first visible line, plus whether the view is pinned
   * to the newest output. `pinned` wins over `offset` so streaming keeps the
   * cursor at the bottom without fighting the user's scroll position.
   */
  scroll: { pinned: boolean; offset: number };
  error: string | null;
  lastStop: StopReason | null;
}

export type Action =
  | { type: "user"; text: string }
  | { type: "assistant_start" }
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "model"; model: string }
  | { type: "turn"; turn: number }
  | { type: "tool_start"; id: string; name: string; preview: string }
  | { type: "tool_end"; id: string; output: string; isError: boolean; summary?: string }
  | { type: "permission"; tool: string; preview: string }
  | { type: "permission_clear" }
  | { type: "status"; status: RunStatus }
  | { type: "usage"; usage: Usage | undefined }
  | { type: "error"; message: string }
  | { type: "done"; reason: StopReason }
  | { type: "scroll"; delta: number; maxScroll: number }
  | { type: "pin" }
  | { type: "toggle_thinking"; id: string }
  | { type: "toggle_tool"; id: string }
  | { type: "set_model"; modelRef: string; model: string }
  | { type: "seed"; messages: MessageView[]; modelRef: string; model: string }
  | { type: "reset" };

export const palette = {
  user: "#7dd3fc",
  accent: "#c4b5fd",
  text: "#e5e7eb",
  tool: "#f0abfc",
  ok: "#6ee7b7",
  error: "#fca5a5",
  warn: "#fcd34d",
  dim: "#6b7280",
  dimmer: "#4b5563",
  border: "#374151",
  code: "#d8b4fe",
  codeBg: "#1f2937",
  thinking: "#94a3b8",
  selection: "#312e81",
} as const;

export function initialState(options: {
  model: string;
  modelRef: string;
  /** Seed transcript, used when resuming a stored session. */
  messages?: MessageView[];
}): AppState {
    return {
      messages: options.messages ? [...options.messages] : [],
      status: "idle",
      model: options.model,
      modelRef: options.modelRef,
      usage: undefined,
      totals: { prompt: 0, completion: 0, cached: 0 },
      turn: 0,
      pendingPermission: null,
      scroll: { pinned: true, offset: 0 },
      error: null,
      lastStop: null,
    };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "user":
      return {
        ...state,
        messages: [...state.messages, newMessage("user", action.text)],
        error: null,
        scroll: { ...state.scroll, pinned: true },
      };

    case "assistant_start":
      return {
        ...state,
        messages: [...state.messages, { ...newMessage("assistant", ""), streaming: true }],
        scroll: { ...state.scroll, pinned: true },
      };

    case "delta":
      return mapLast(state, (message) => ({
        ...message,
        text: message.text + action.text,
      }));

    case "reasoning":
      return mapLast(state, (message) => ({
        ...message,
        reasoning: message.reasoning + action.text,
      }));

    case "model":
      return mapLast({ ...state, model: action.model }, (message) => ({
        ...message,
        model: action.model,
      }));

    case "turn":
      return { ...state, turn: action.turn };

    case "tool_start":
      return mapLast(state, (message) => ({
        ...message,
        tools: [
          ...message.tools,
          {
            id: action.id,
            name: action.name,
            preview: action.preview,
            status: "running" as const,
            expanded: false,
          },
        ],
      }));

    case "tool_end":
      return mapLast(state, (message) => ({
        ...message,
        tools: message.tools.map((tool) =>
          tool.id === action.id
            ? {
                ...tool,
                status: action.isError ? ("error" as const) : ("done" as const),
                output: action.output,
                ...(action.summary !== undefined ? { summary: action.summary } : {}),
              }
            : tool,
        ),
      }));

    case "permission":
      return {
        ...state,
        status: "permission",
        pendingPermission: { tool: action.tool, preview: action.preview },
      };

    case "permission_clear":
      return { ...state, pendingPermission: null };

    case "status":
      return { ...state, status: action.status };

    case "usage": {
      if (!action.usage) return { ...state, usage: undefined };
      return {
        ...state,
        usage: action.usage,
        totals: {
          prompt: state.totals.prompt + action.usage.promptTokens,
          completion: state.totals.completion + action.usage.completionTokens,
          cached: state.totals.cached + (action.usage.cachedTokens ?? 0),
        },
      };
    }

    case "error":
      return errorOnLast({ ...state, error: action.message }, action.message);

    case "done":
      return {
        ...state,
        status: "idle",
        lastStop: action.reason,
        messages: state.messages.map((message) =>
          message.streaming ? { ...message, streaming: false } : message,
        ),
      };

    case "scroll": {
      const base = state.scroll.pinned ? action.maxScroll : state.scroll.offset;
      const offset = Math.max(0, Math.min(action.maxScroll, base + action.delta));
      return {
        ...state,
        // Dragging back down to the bottom re-pins, matching terminal habits.
        scroll: { pinned: offset >= action.maxScroll, offset },
      };
    }

    case "pin":
      return { ...state, scroll: { pinned: true, offset: 0 } };

    case "toggle_thinking":
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === action.id
            ? { ...message, thinkingExpanded: !message.thinkingExpanded }
            : message,
        ),
      };

    case "toggle_tool":
      return {
        ...state,
        messages: state.messages.map((message) => ({
          ...message,
          tools: message.tools.map((tool) =>
            tool.id === action.id ? { ...tool, expanded: !tool.expanded } : tool,
          ),
        })),
      };

    case "set_model":
      return { ...state, modelRef: action.modelRef, model: action.model };

    case "reset":
      return {
        ...initialState({ model: state.model, modelRef: state.modelRef }),
        totals: { prompt: 0, completion: 0, cached: 0 },
      };

    case "seed":
      return {
        ...state,
        messages: [...action.messages],
        model: action.model,
        modelRef: action.modelRef,
        status: "idle",
        usage: undefined,
        totals: { prompt: 0, completion: 0, cached: 0 },
        turn: 0,
        error: null,
        lastStop: null,
        scroll: { pinned: true, offset: 0 },
      };

    default:
      return state;
  }
}

let counter = 0;
function newMessage(role: "user" | "assistant", text: string): MessageView {
  counter += 1;
  return {
    id: `m${counter}`,
    role,
    text,
    reasoning: "",
    streaming: false,
    thinkingExpanded: false,
    tools: [],
  };
}

function mapLast(state: AppState, fn: (message: MessageView) => MessageView): AppState {
  if (state.messages.length === 0) return state;
  const messages = [...state.messages];
  const last = messages[messages.length - 1]!;
  messages[messages.length - 1] = fn(last);
  return { ...state, messages };
}

function errorOnLast(state: AppState, message: string): AppState {
  return mapLast(state, (last) => ({ ...last, error: message, streaming: false }));
}
