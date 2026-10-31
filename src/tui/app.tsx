import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Box, render, useApp, useInput, useWindowSize } from "ink";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { runAgent } from "../agent/loop.js";
import { createDefaultTools } from "../agent/tools/index.js";
import type { PermissionRequest } from "../agent/tools/types.js";
import type { ProviderSetupResult } from "../config/setup.js";
import { SetupApp } from "../setup/app.js";
import type { ChatMessage, ToolCall } from "../provider/types.js";
import type { Runtime } from "../runtime.js";
import { SessionStore, type Session, type StoredPart, type ToolResultRecord } from "../session/store.js";
import { readGitBranch } from "../util/git.js";
import { messagesToLines } from "./blocks.js";
import { extractChangedFiles } from "./changes.js";
import { TuiView, type CompletionView } from "./chrome.js";
import {
  commandItems,
  helpText,
  matchingCommands,
  runCommand,
  type CommandContext,
} from "./commands.js";
import type { DialogSpec, PickerItem } from "./dialogs.js";
import {
  backspace,
  createEditor,
  deleteForward,
  deleteWordBefore,
  editorRows,
  insertText,
  killToLineStart,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveVertical,
  type EditorState,
} from "./editor.js";
import { computeLayout, sidebarWidth, type SidebarMode } from "./layout.js";
import { setActiveTheme, resolveTheme, themeNames } from "./theme.js";
import { sessionToViews } from "./session-view.js";
import {
  initialState,
  messageReasoning,
  messageTools,
  reducer,
  type AppState,
} from "./types.js";

export interface TuiOptions {
  runtime: Runtime;
  cwd: string;
  yolo?: boolean;
  verbose?: boolean;
  /** Resume an existing session instead of starting a new one. */
  session?: Session;
  /** Override the session directory (used by tests). */
  store?: SessionStore;
  /** Test/debug hook: receives every committed state. */
  onState?: (state: AppState) => void;
}

type Overlay = null | "models" | "sessions" | "commands" | "queue" | "providers";

const COMPACT_PROMPT = [
  "Summarise the conversation above so it can replace the transcript as working context.",
  "Keep, in this order, and omit everything else:",
  "1. What the user asked for and any constraints or preferences they stated.",
  "2. Files read or modified, with paths, and what changed in them.",
  "3. Decisions made and why, plus approaches that were rejected.",
  "4. Commands run and their relevant results (pass/fail, key output).",
  "5. Anything still open or unresolved.",
  "Be specific about paths, symbol names and commands. Aim for under 500 words.",
].join("\n");

/** Re-exported for the documentation drift test. */
export const HELP_TEXT = helpText();

const OVERLAY_TITLES: Record<Exclude<Overlay, null>, string> = {
  models: "select model",
  sessions: "resume session",
  commands: "commands",
  queue: "queued messages",
  providers: "providers",
};

const OVERLAY_HINTS: Record<Exclude<Overlay, null>, string> = {
  models: "enter select · type to filter · esc close",
  sessions: "enter resume · type to filter · esc close",
  commands: "enter run · type to filter · esc close",
  queue: "enter remove · esc close",
  providers: "enter choose model · a add provider · type to filter · esc close",
};

const MAX_COMPLETIONS = 6;

export async function launchTui(options: TuiOptions): Promise<number> {
  const app = render(<App {...options} />, {
    exitOnCtrlC: false,
    patchConsole: false,
    alternateScreen: true,
    maxFps: 30,
  });

  try {
    await app.waitUntilExit();
    return 0;
  } finally {
    app.cleanup();
  }
}

export function App({ runtime, cwd, yolo, session, store, onState }: TuiOptions): ReactElement {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();

  const sessionStore = useMemo(() => store ?? new SessionStore(), [store]);
  const resume = session;

  const [state, dispatch] = useReducer(reducer, undefined, () =>
    initialState({
      model: resume?.metaSnapshot.model ?? runtime.model.modelId,
      modelRef: resume?.metaSnapshot.modelRef ?? `${runtime.model.providerId}/${runtime.model.key}`,
      ...(resume ? { messages: sessionToViews(resume) } : {}),
    }),
  );

  const [editor, setEditor] = useState<EditorState>(() => createEditor());
  const [activeModel, setActiveModel] = useState(() => ({
    provider: runtime.model.provider,
    modelId: resume?.metaSnapshot.model ?? runtime.model.modelId,
    reference:
      resume?.metaSnapshot.modelRef ?? `${runtime.model.providerId}/${runtime.model.key}`,
  }));
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [providerSetup, setProviderSetup] = useState(false);
  const [picker, setPicker] = useState<{ items: PickerItem[]; index: number }>({
    items: [],
    index: 0,
  });
  const [filter, setFilter] = useState("");
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() => runtime.config.tui.sidebar);

  const [theme, setThemeState] = useState(() => {
    const resolved = resolveTheme(runtime.config.tui.theme);
    setActiveTheme(resolved);
    return resolved;
  });
  const changeTheme = useCallback((name: string) => {
    const resolved = resolveTheme(name);
    setActiveTheme(resolved);
    setThemeState(resolved);
  }, []);

  const tools = useMemo(() => createDefaultTools(cwd), [cwd]);
  // Resolved once at startup from SYSTEM_PROMPT.md, so switching models or
  // resuming a session never drifts from what print mode sends.
  const systemPrompt = runtime.systemPrompt;

  const sessionRef = useRef<Session | undefined>(resume);
  const messagesRef = useRef<ChatMessage[]>([
    { role: "system", content: systemPrompt },
    ...(resume ? resume.toChatMessages() : []),
  ]);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const permissionResolveRef = useRef<((allowed: boolean) => void) | null>(null);
  const alwaysAllowRef = useRef<Set<string>>(new Set());
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const historyDraftRef = useRef<EditorState | null>(null);
  const queueRef = useRef<string[]>([]);
  const runStartedAtRef = useRef<number | null>(null);
  const disposedRef = useRef(false);

  useEffect(
    () => () => {
      disposedRef.current = true;
    },
    [],
  );

  const requestPermission = useCallback(
    (request: PermissionRequest): Promise<boolean> => {
      if (yolo || alwaysAllowRef.current.has(request.tool)) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        permissionResolveRef.current = resolve;
        dispatch({ type: "permission", tool: request.tool, preview: request.preview });
      });
    },
    [yolo],
  );

  useEffect(() => {
    onState?.(state);
  }, [state, onState]);

  const answerPermission = useCallback((allowed: boolean): void => {
    const resolve = permissionResolveRef.current;
    permissionResolveRef.current = null;
    dispatch({ type: "permission_clear" });
    resolve?.(allowed);
  }, []);

  /**
   * Two independent timers: the spinner only while a turn is live, and the
   * welcome mascot while the empty banner is on screen. Disabled in non-TTY
   * runs so tests and pipes stay still.
   */
  const [tick, setTick] = useState(0);
  const [brandTick, setBrandTick] = useState(0);
  const busy = state.status !== "idle";
  const showBrand = state.messages.length === 0 && overlay === null && !providerSetup;
  const animations =
    runtime.config.tui.animations &&
    process.env["BUKA_NO_ANIMATION"] === undefined &&
    Boolean(process.stdout.isTTY);
  useEffect(() => {
    if (!busy || !animations) return;
    const timer = setInterval(() => setTick((value) => (value + 1) % 100_000), 90);
    return () => clearInterval(timer);
  }, [busy, animations]);
  useEffect(() => {
    if (!showBrand || !animations) return;
    const timer = setInterval(() => setBrandTick((value) => (value + 1) % 100_000), 700);
    return () => clearInterval(timer);
  }, [showBrand, animations]);

  // ---------------------------------------------------------------------------
  // Derived view state
  // ---------------------------------------------------------------------------
  const sidebar = sidebarWidth(columns, sidebarMode);
  const mainWidth = Math.max(8, columns - sidebar);
  const editorTextWidth = Math.max(1, mainWidth - 4);
  const editorRowCount = editorRows(editor.value, editorTextWidth).length;

  const completionItems = useMemo(
    () => (completionDismissed || overlay !== null ? [] : matchingCommands(editor.value)),
    [completionDismissed, editor.value, overlay],
  );
  const visibleCompletions = completionItems.slice(0, MAX_COMPLETIONS);
  const completionOpen = visibleCompletions.length > 0;
  const completion: CompletionView | null = completionOpen
    ? {
        items: visibleCompletions,
        index: Math.min(completionIndex, visibleCompletions.length - 1),
      }
    : null;

  const layout = useMemo(
    () =>
      computeLayout({
        columns,
        rows,
        editorRows: editorRowCount,
        queuedRows: state.queued.length,
        completionRows: completion ? completion.items.length + 2 : 0,
        permission: state.pendingPermission !== null,
        sidebar: sidebarMode,
      }),
    [columns, rows, editorRowCount, state.queued.length, completion, state.pendingPermission, sidebarMode],
  );

  const lines = useMemo(
    () =>
      messagesToLines(state.messages, {
        width: layout.main,
        showThinking: runtime.config.tui.showThinking,
      }),
    [state.messages, layout.main, runtime.config.tui.showThinking, theme.id],
  );

  const maxScroll = Math.max(0, lines.length - layout.transcript);
  const offset = state.scroll.pinned
    ? maxScroll
    : Math.min(Math.max(0, state.scroll.offset), maxScroll);

  const changedFiles = useMemo(() => extractChangedFiles(state), [state.messages]);

  const contextWindow = useMemo(() => {
    try {
      return runtime.registry.resolve(activeModel.reference).config?.context;
    } catch {
      return undefined;
    }
  }, [runtime.registry, activeModel.reference]);

  const branch = useMemo(() => readGitBranch(cwd), [cwd]);

  // ---------------------------------------------------------------------------
  // Overlay items
  // ---------------------------------------------------------------------------
  const overlayItems = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (query.length === 0) return picker.items;
    return picker.items.filter(
      (item) =>
        item.reference.toLowerCase().includes(query) || item.detail.toLowerCase().includes(query),
    );
  }, [picker.items, filter]);

  const dialog: DialogSpec | null = overlay
    ? {
        title: OVERLAY_TITLES[overlay],
        ...(pickerLoading || pickerError ? {} : { subtitle: `${overlayItems.length}` }),
        filter,
        filterLabel: overlay === "commands" ? "search" : "filter",
        items: overlayItems,
        index: Math.min(picker.index, Math.max(0, overlayItems.length - 1)),
        hint: OVERLAY_HINTS[overlay],
        empty: pickerError ?? (pickerLoading ? "loading..." : emptyText(overlay)),
      }
    : null;

  const hint = state.pendingPermission
    ? "y allow · n deny · a always allow"
    : completionOpen
      ? "↑↓ select · tab complete · enter run · esc close"
      : busy
        ? "esc stop · enter queues"
        : "enter send · alt+enter newline · ctrl+p palette · /help";

  // ---------------------------------------------------------------------------
  // Queue (Hermes-style: type while the agent is running)
  // ---------------------------------------------------------------------------
  const enqueue = useCallback((text: string) => {
    queueRef.current = [...queueRef.current, text];
    dispatch({ type: "queue_add", text });
  }, []);

  const removeQueued = useCallback((index: number) => {
    queueRef.current = queueRef.current.filter((_, position) => position !== index);
    dispatch({ type: "queue_remove", index });
  }, []);

  const clearQueue = useCallback(() => {
    queueRef.current = [];
  }, []);

  // ---------------------------------------------------------------------------
  // Run
  // ---------------------------------------------------------------------------
  const runTurn = useCallback(
    async (prompt: string): Promise<void> => {
      busyRef.current = true;
      runStartedAtRef.current = Date.now();
      const controller = new AbortController();
      abortRef.current = controller;

      const active = sessionRef.current;
      active?.recordUser(prompt);

      dispatch({ type: "user", text: prompt });
      dispatch({ type: "assistant_start" });
      dispatch({ type: "status", status: "thinking" });

      // Accumulated for the session log; kept out of React state so the record
      // is exactly what the stream produced, independent of render timing. The
      // part order mirrors the view so a resumed session replays identically.
      let model = activeModel.modelId;
      let error: string | undefined;
      const parts: StoredPart[] = [];
      const toolCalls: ToolCall[] = [];
      const toolResults = new Map<string, ToolResultRecord>();
      const toolStartedAt = new Map<string, number>();

      const appendPart = (kind: "text" | "thinking", delta: string): void => {
        const last = parts[parts.length - 1];
        if (last && last.kind === kind) last.text += delta;
        else parts.push({ kind, text: delta });
      };

      try {
        for await (const event of runAgent({
          provider: activeModel.provider,
          model: activeModel.modelId,
          messages: [...messagesRef.current, { role: "user", content: prompt }],
          tools,
          permission: runtime.config.permission,
          cwd,
          signal: controller.signal,
          requestPermission,
        })) {
          switch (event.type) {
            case "turn_start":
              dispatch({ type: "turn", turn: event.turn });
              break;
            case "model":
              model = event.model;
              dispatch({ type: "model", model: event.model });
              break;
            case "reasoning":
              appendPart("thinking", event.delta);
              dispatch({ type: "reasoning", text: event.delta });
              break;
            case "text":
              appendPart("text", event.delta);
              dispatch({ type: "delta", text: event.delta });
              dispatch({ type: "status", status: "responding" });
              break;
            case "tool_start":
              toolCalls.push(event.call);
              parts.push({ kind: "tool", id: event.call.id });
              toolStartedAt.set(event.call.id, Date.now());
              toolResults.set(event.call.id, {
                id: event.call.id,
                name: event.call.function.name,
                preview: event.preview,
                output: "",
                isError: false,
              });
              dispatch({ type: "status", status: "tool" });
              dispatch({
                type: "tool_start",
                id: event.call.id,
                name: event.call.function.name,
                preview: event.preview,
              });
              break;
            case "tool_end": {
              const existing = toolResults.get(event.call.id);
              const startedAt = toolStartedAt.get(event.call.id);
              const durationMs = startedAt === undefined ? undefined : Date.now() - startedAt;
              const diff =
                typeof event.metadata?.["diff"] === "string" ? event.metadata["diff"] : undefined;
              toolResults.set(event.call.id, {
                id: event.call.id,
                name: event.call.function.name,
                preview: existing?.preview ?? event.call.function.name,
                output: event.output,
                isError: event.isError,
                ...(event.summary !== undefined ? { summary: event.summary } : {}),
                ...(diff !== undefined ? { diff } : {}),
              });
              dispatch({
                type: "tool_end",
                id: event.call.id,
                output: event.output,
                isError: event.isError,
                ...(event.summary !== undefined ? { summary: event.summary } : {}),
                ...(durationMs !== undefined ? { durationMs } : {}),
                ...(diff !== undefined ? { diff } : {}),
              });
              dispatch({ type: "status", status: "thinking" });
              break;
            }
            case "usage":
              dispatch({ type: "usage", usage: event.usage });
              break;
            case "error":
              error = event.error.message;
              dispatch({ type: "error", message: error });
              break;
            case "done":
              messagesRef.current = event.messages;
              dispatch({ type: "done", reason: event.reason });
              break;
            default:
              break;
          }
        }
      } finally {
        if (permissionResolveRef.current) answerPermission(false);
        busyRef.current = false;
        abortRef.current = null;
        runStartedAtRef.current = null;
        dispatch({ type: "done", reason: "complete" });
        active?.completeAssistant({
          parts,
          text: parts
            .filter((part) => part.kind === "text")
            .map((part) => part.text)
            .join("\n\n"),
          reasoning: parts
            .filter((part) => part.kind === "thinking")
            .map((part) => part.text)
            .join("\n"),
          model,
          toolCalls,
          toolResults: [...toolResults.values()],
          ...(error !== undefined ? { error } : {}),
        });

        // Drain anything typed while this turn was running.
        const next = queueRef.current[0];
        if (next !== undefined && !disposedRef.current) {
          queueRef.current = queueRef.current.slice(1);
          dispatch({ type: "queue_shift" });
          setTimeout(() => {
            if (!disposedRef.current) void runTurn(next);
          }, 0);
        }
      }
    },
    [
      activeModel.modelId,
      activeModel.provider,
      answerPermission,
      cwd,
      requestPermission,
      runtime.config.permission,
      tools,
    ],
  );

  const stop = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  // ---------------------------------------------------------------------------
  // Model picker
  // ---------------------------------------------------------------------------
  const switchModel = useCallback(
    (reference: string): void => {
      try {
        const resolved = runtime.registry.resolve(reference);
        setActiveModel({ provider: resolved.provider, modelId: resolved.modelId, reference });
        dispatch({ type: "set_model", modelRef: reference, model: resolved.modelId });
        setPickerError(null);
        sessionRef.current?.setModel(reference, resolved.modelId);
        // The transcript survives a model switch, but the system prompt embeds
        // the tool list, so rebuild it and keep the conversation.
        messagesRef.current = [
          { role: "system", content: systemPrompt },
          ...messagesRef.current.filter((message) => message.role !== "system"),
        ];
      } catch (cause) {
        setPickerError((cause as Error).message);
      }
    },
    [runtime.registry, systemPrompt],
  );

  const openModelPicker = useCallback(async (providerId?: string): Promise<void> => {
    setOverlay("models");
    setFilter("");
    setPickerError(null);
    setPickerLoading(true);
    try {
      const models = (await runtime.registry.listModels()).filter(
        (model) => providerId === undefined || model.providerId === providerId,
      );
      const items = models.map((model) => ({
        reference: model.reference,
        detail: [
          model.info.tools ? "tools" : "",
          model.info.reasoning ? "reasoning" : "",
          model.info.input?.includes("image") ? "vision" : "",
        ]
          .filter(Boolean)
          .join(" "),
      }));
      setPicker({
        items,
        index: Math.max(
          0,
          items.findIndex((item) => item.reference === activeModel.reference),
        ),
      });
    } catch (cause) {
      setPickerError((cause as Error).message);
    } finally {
      setPickerLoading(false);
    }
  }, [activeModel.reference, runtime.registry]);

  const openProviderPicker = useCallback((): void => {
    setOverlay("providers");
    setFilter("");
    setPickerError(null);
    setPickerLoading(false);
    const items: PickerItem[] = [
      { reference: "+add", detail: "add a provider and API key" },
      ...Object.entries(runtime.config.providers).map(([id, provider]) => {
        const modelCount = Object.keys(provider.models).length;
        const key = provider.apiKey
          ? provider.apiKey.startsWith("{env:")
            ? "env key"
            : "key saved"
          : "no key";
        return {
          reference: id,
          detail: `${provider.name} · ${modelCount || "?"} models · ${key}`,
        };
      }),
    ];
    setPicker({ items, index: 0 });
  }, [runtime.config.providers]);

  const finishProviderSetup = useCallback(
    (result: ProviderSetupResult): void => {
      try {
        runtime.reload();
        const resolved = runtime.registry.resolve(result.modelRef);
        runtime.model = resolved;
        setActiveModel({
          provider: resolved.provider,
          modelId: resolved.modelId,
          reference: result.modelRef,
        });
        dispatch({ type: "set_model", modelRef: result.modelRef, model: resolved.modelId });
        sessionRef.current?.setModel(result.modelRef, resolved.modelId);
        messagesRef.current = [
          { role: "system", content: systemPrompt },
          ...messagesRef.current.filter((message) => message.role !== "system"),
        ];
        setProviderSetup(false);
        setPickerError(null);
      } catch (cause) {
        setPickerError((cause as Error).message);
      }
    },
    [runtime, systemPrompt],
  );

  const openCommandPalette = useCallback((): void => {
    setOverlay("commands");
    setFilter("");
    setPickerError(null);
    setPickerLoading(false);
    setPicker({ items: commandItems(), index: 0 });
  }, []);

  const openQueuePicker = useCallback((): void => {
    setOverlay("queue");
    setFilter("");
    setPickerError(null);
    setPickerLoading(false);
    setPicker({
      items: queueRef.current.map((text) => ({
        reference: text,
        detail: "remove from queue",
      })),
      index: 0,
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------
  const ensureSession = useCallback((): Session => {
    if (!sessionRef.current) {
      sessionRef.current = sessionStore.create({
        cwd,
        modelRef: activeModel.reference,
        model: activeModel.modelId,
      });
    }
    return sessionRef.current;
  }, [activeModel.modelId, activeModel.reference, cwd, sessionStore]);

  const openSessionPicker = useCallback(async (): Promise<void> => {
    setOverlay("sessions");
    setFilter("");
    setPickerError(null);
    setPickerLoading(true);
    try {
      const summaries = sessionStore.list();
      const items: PickerItem[] = summaries.map((summary) => ({
        reference: summary.id,
        detail: `${relativeTime(summary.updatedAt)}  ${summary.messages} msg  ${summary.title}`,
      }));
      const currentIndex = Math.max(
        0,
        items.findIndex((item) => item.reference === sessionRef.current?.id),
      );
      setPicker({ items, index: currentIndex });
    } catch (cause) {
      setPickerError((cause as Error).message);
    } finally {
      setPickerLoading(false);
    }
  }, [sessionStore]);

  const resumeSession = useCallback(
    (id: string): void => {
      try {
        const loaded = sessionStore.load(id);
        sessionRef.current = loaded;
        messagesRef.current = [{ role: "system", content: systemPrompt }, ...loaded.toChatMessages()];
        const meta = loaded.metaSnapshot;
        dispatch({
          type: "seed",
          messages: sessionToViews(loaded),
          modelRef: meta.modelRef,
          model: meta.model,
        });
        clearQueue();
        try {
          const resolved = runtime.registry.resolve(meta.modelRef);
          setActiveModel({ provider: resolved.provider, modelId: resolved.modelId, reference: meta.modelRef });
        } catch {
          // The stored model may no longer exist; keep the transcript and let
          // the user pick a model.
        }
        setPickerError(null);
      } catch (cause) {
        setPickerError((cause as Error).message);
      }
    },
    [clearQueue, runtime.registry, sessionStore, systemPrompt],
  );

  const startNewSession = useCallback((): void => {
    sessionRef.current = undefined;
    messagesRef.current = [{ role: "system", content: systemPrompt }];
    clearQueue();
    dispatch({ type: "reset" });
  }, [clearQueue, systemPrompt]);

  /**
   * Replaces the context with a model-written summary, and records the boundary
   * in the session log — so resuming continues from the summary instead of
   * reloading every turn.
   *
   * The log itself is never rewritten: it stays the append-only record of what
   * actually happened. Only what gets sent to the provider shrinks.
   */
  const compactContext = useCallback(async (): Promise<void> => {
    const history = messagesRef.current.filter((message) => message.role !== "system");
    const active = ensureSession();
    active.recordUser("/compact");
    dispatch({ type: "user", text: "/compact" });
    dispatch({ type: "assistant_start" });

    if (history.length < 4) {
      dispatch({ type: "delta", text: "Not enough conversation to compact yet." });
      dispatch({ type: "done", reason: "complete" });
      return;
    }

    dispatch({ type: "status", status: "thinking" });
    let summary = "";
    let failure: string | undefined;

    try {
      for await (const event of runAgent({
        provider: activeModel.provider,
        model: activeModel.modelId,
        messages: [
          {
            role: "system",
            content:
              "You compress coding-session transcripts. Reply with the summary only, no preamble.",
          },
          ...history,
          { role: "user", content: COMPACT_PROMPT },
        ],
        enableTools: false,
        maxTurns: 1,
        cwd,
        signal: new AbortController().signal,
      })) {
        switch (event.type) {
          case "text":
            summary += event.delta;
            dispatch({ type: "delta", text: event.delta });
            break;
          case "error":
            failure = event.error.message;
            break;
          case "usage":
            dispatch({ type: "usage", usage: event.usage });
            break;
          default:
            break;
        }
      }
    } catch (cause) {
      failure = (cause as Error).message;
    }

    if (failure !== undefined || summary.trim().length === 0) {
      dispatch({
        type: "error",
        message: failure ?? "compaction produced no summary; context left unchanged",
      });
      dispatch({ type: "done", reason: "complete" });
      return;
    }

    const cleaned = summary.trim();
    dispatch({ type: "done", reason: "complete" });

    active.compact(cleaned);
    messagesRef.current = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `[Summary of the earlier conversation]\n${cleaned}` },
    ];
    dispatch({ type: "compacted", summary: cleaned });
  }, [activeModel.modelId, activeModel.provider, cwd, ensureSession, systemPrompt]);

  const commandContext: CommandContext = {
    dispatch,
    exit,
    openModelPicker,
    openProviderPicker,
    openSessionPicker,
    startNewSession,
    compactContext,
    switchModel,
    ensureSession,
    sessionRef,
    state,
    tools,
    runtime,
    themeName: theme.id,
    setTheme: changeTheme,
    themeNames,
  };

  // ---------------------------------------------------------------------------
  // Submit + slash commands
  // ---------------------------------------------------------------------------
  const submit = useCallback(
    (raw: string): void => {
      const text = raw.trim();
      if (text.length === 0) return;

      historyRef.current = [...historyRef.current.filter((entry) => entry !== text), text];
      historyIndexRef.current = null;
      historyDraftRef.current = null;
      setEditor(createEditor());
      setCompletionDismissed(false);
      setCompletionIndex(0);

      if (runCommand(text, commandContext)) return;

      if (busyRef.current) {
        if (runtime.config.tui.busyInput === "queue") enqueue(text);
        return;
      }

      // Interactive runs are always persisted, so make sure a session exists
      // before the first turn is written to it.
      ensureSession();
      void runTurn(text);
    },
    [commandContext, enqueue, ensureSession, runTurn, runtime.config.tui.busyInput],
  );

  const choose = useCallback(
    (item: PickerItem): void => {
      if (overlay === "models") {
        switchModel(item.reference);
        setOverlay(null);
        return;
      }
      if (overlay === "sessions") {
        resumeSession(item.reference);
        setOverlay(null);
        return;
      }
      if (overlay === "commands") {
        setOverlay(null);
        runCommand(item.reference, commandContext);
        return;
      }
      if (overlay === "queue") {
        const index = picker.items.indexOf(item);
        if (index >= 0) removeQueued(index);
        setOverlay(null);
        return;
      }
      if (overlay === "providers") {
        if (item.reference === "+add" && busyRef.current) {
          setPicker({ items: [], index: 0 });
          setPickerError("stop the current run before adding a provider");
          return;
        }
        setOverlay(null);
        if (item.reference === "+add") {
          setProviderSetup(true);
          return;
        }
        void openModelPicker(item.reference);
        return;
      }
    },
    [
      commandContext,
      openModelPicker,
      overlay,
      picker.items,
      removeQueued,
      resumeSession,
      switchModel,
    ],
  );

  // ---------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------
  useInput((input, key) => {
    // The embedded setup wizard owns the keyboard while it is open.
    if (providerSetup) return;

    // 1. Permission prompt owns the keyboard.
    if (state.pendingPermission) {
      if (input === "y" || input === "Y") answerPermission(true);
      else if (input === "n" || input === "N" || key.escape) answerPermission(false);
      else if (input === "a" || input === "A") {
        alwaysAllowRef.current.add(state.pendingPermission.tool);
        answerPermission(true);
      } else if (key.ctrl && input === "c") {
        answerPermission(false);
        stop();
      }
      return;
    }

    // 2. Overlays own the keyboard.
    if (overlay !== null) {
      if (key.ctrl && input === "c") {
        exit();
        return;
      }
      if (key.escape) {
        setOverlay(null);
        setFilter("");
        return;
      }
      if (overlay === "providers" && input === "a" && !key.ctrl && !key.meta) {
        if (busyRef.current) {
          setPicker({ items: [], index: 0 });
          setPickerError("stop the current run before adding a provider");
          return;
        }
        setOverlay(null);
        setFilter("");
        setProviderSetup(true);
        return;
      }
      if (key.backspace || key.delete) {
        setFilter((current) => current.slice(0, -1));
        return;
      }
      if (key.upArrow) {
        setPicker((current) => ({ ...current, index: Math.max(0, current.index - 1) }));
        return;
      }
      if (key.downArrow) {
        setPicker((current) => ({
          ...current,
          index: Math.min(Math.max(0, overlayItems.length - 1), current.index + 1),
        }));
        return;
      }
      if (key.return) {
        const chosen = overlayItems[Math.min(picker.index, Math.max(0, overlayItems.length - 1))];
        if (chosen) choose(chosen);
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        const printable = input.replace(/[\u0000-\u001f\u007f]/g, "");
        if (printable.length > 0) {
          setFilter((current) => current + printable);
          setPicker((current) => ({ ...current, index: 0 }));
        }
      }
      return;
    }

    // 3. Global controls.
    if (key.ctrl && input === "c") {
      if (busyRef.current) stop();
      else if (editor.value.length > 0) setEditor(createEditor());
      else if (queueRef.current.length > 0) clearQueue();
      else exit();
      return;
    }

    if (key.ctrl && input === "k") {
      void openModelPicker();
      return;
    }

    if (key.ctrl && input === "p") {
      openCommandPalette();
      return;
    }

    if (key.ctrl && input === "x") {
      if (queueRef.current.length > 0) openQueuePicker();
      else void openSessionPicker();
      return;
    }

    if (key.ctrl && input === "b") {
      setSidebarMode((current) => (current === false ? "auto" : false));
      return;
    }

    if (key.ctrl && input === "t") {
      const last = [...state.messages]
        .reverse()
        .find((message) => message.role === "assistant" && messageReasoning(message).length > 0);
      if (last) dispatch({ type: "toggle_thinking", id: last.id });
      return;
    }

    if (key.ctrl && input === "o") {
      const last = [...state.messages]
        .reverse()
        .find((message) => messageTools(message).some((tool) => tool.output));
      const tool = last ? messageTools(last).filter((candidate) => candidate.output).pop() : undefined;
      if (last && tool) dispatch({ type: "toggle_tool", messageId: last.id, id: tool.id });
      return;
    }

    if (key.ctrl && input === "l") {
      dispatch({ type: "reset" });
      return;
    }

    if (key.escape) {
      if (completionOpen) {
        setCompletionDismissed(true);
        return;
      }
      if (busyRef.current) stop();
      return;
    }

    // 4. Scrolling.
    if (key.pageUp || (key.shift && key.upArrow)) {
      dispatch({ type: "scroll", delta: -(layout.transcript - 2), maxScroll });
      return;
    }
    if (key.pageDown || (key.shift && key.downArrow)) {
      dispatch({ type: "scroll", delta: layout.transcript - 2, maxScroll });
      return;
    }
    if (key.ctrl && input === "g") {
      dispatch({ type: "pin" });
      return;
    }

    // 5. Slash-command completion.
    if (completion !== null) {
      if (key.tab) {
        const chosen = completion.items[completion.index];
        if (chosen) {
          setEditor(createEditor(`${chosen.reference} `));
          setCompletionIndex(0);
        }
        return;
      }
      if (key.upArrow) {
        setCompletionIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (key.downArrow) {
        setCompletionIndex((current) => Math.min(completion.items.length - 1, current + 1));
        return;
      }
      if (key.return) {
        const chosen = completion.items[completion.index];
        if (chosen) {
          submit(chosen.reference);
          return;
        }
      }
    }

    // 6. Input editing.
    if (key.return || input === "\n") {
      const wantsNewline = input === "\n" || key.meta || key.shift;
      if (wantsNewline) setEditor((current) => insertText(current, "\n"));
      else submit(editor.value);
      return;
    }

    // Terminals may deliver typed characters and Enter in a single chunk (fast
    // typing, IMEs, some multiplexers). Treat a short chunk that ends in a
    // newline as a submit, but never hijack a genuine multi-line paste.
    if (input.length <= 256 && /[\r\n]$/.test(input) && !/[\r\n]/.test(input.slice(0, -1))) {
      const text = input.slice(0, -1).replace(/[\u0000-\u001f\u007f]/g, "");
      setEditor(createEditor());
      submit(editor.value + text);
      return;
    }

    if (key.ctrl && input === "j") {
      setEditor((current) => insertText(current, "\n"));
      return;
    }

    if (key.backspace || key.delete) {
      setEditor((current) => (key.ctrl || key.meta ? deleteWordBefore(current) : backspace(current)));
      setCompletionIndex(0);
      setCompletionDismissed(false);
      return;
    }

    if (key.home) {
      setEditor((current) => moveHome(current));
      return;
    }
    if (key.end) {
      setEditor((current) => moveEnd(current));
      return;
    }
    if (key.leftArrow) {
      setEditor((current) => moveLeft(current));
      return;
    }
    if (key.rightArrow) {
      setEditor((current) => moveRight(current));
      return;
    }

    if (key.upArrow) {
      const movedUp = moveVertical(editor, editorTextWidth, -1);
      if (movedUp.cursor !== editor.cursor) {
        setEditor(movedUp);
        return;
      }
      const history = historyRef.current;
      if (history.length === 0) return;
      if (historyIndexRef.current === null) {
        historyDraftRef.current = editor;
        historyIndexRef.current = history.length - 1;
      } else {
        historyIndexRef.current = Math.max(0, historyIndexRef.current - 1);
      }
      const entry = history[historyIndexRef.current];
      if (entry !== undefined) setEditor(createEditor(entry));
      return;
    }

    if (key.downArrow) {
      if (historyIndexRef.current !== null) {
        const history = historyRef.current;
        if (historyIndexRef.current < history.length - 1) {
          historyIndexRef.current += 1;
          setEditor(createEditor(history[historyIndexRef.current]!));
        } else {
          historyIndexRef.current = null;
          setEditor(historyDraftRef.current ?? createEditor());
        }
        return;
      }
      setEditor((current) => moveVertical(current, editorTextWidth, 1));
      return;
    }

    if (key.ctrl && input === "a") {
      setEditor((current) => moveHome(current));
      return;
    }
    if (key.ctrl && input === "e") {
      setEditor((current) => moveEnd(current));
      return;
    }
    if (key.ctrl && input === "u") {
      setEditor((current) => killToLineStart(current));
      return;
    }
    if (key.ctrl && input === "w") {
      setEditor((current) => deleteWordBefore(current));
      return;
    }
    if (key.ctrl && input === "d") {
      setEditor((current) => deleteForward(current));
      return;
    }

    if (key.tab) return;

    if (input.length > 0 && !key.ctrl && !key.meta) {
      const printable = input.replace(/[\u0000-\u001f\u007f]/g, "");
      if (printable.length > 0) {
        setEditor((current) => insertText(current, printable));
        setCompletionIndex(0);
        setCompletionDismissed(false);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  if (providerSetup) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <SetupApp
          width={columns}
          height={rows}
          {...(runtime.configPath ? { configPath: runtime.configPath } : {})}
          onSaved={finishProviderSetup}
          onCancel={() => setProviderSetup(false)}
        />
      </Box>
    );
  }

  return (
    <TuiView
      state={state}
      layout={layout}
      lines={lines}
      offset={offset}
      editor={editor}
      sessionTitle={sessionRef.current?.title}
      cwd={cwd}
      branch={branch}
      version={runtimeVersion()}
      toolCount={tools.names().length}
      contextWindow={contextWindow}
      changedFiles={changedFiles}
      dialog={dialog}
      completing={completion}
      hint={hint}
      spinnerTick={tick}
      brandTick={brandTick}
      runStartedAt={runStartedAtRef.current}
      now={Date.now()}
      showTokens={runtime.config.tui.showTokenUsage}
    />
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function emptyText(overlay: Overlay): string {
  if (overlay === "models") return "no models available";
  if (overlay === "sessions") return "no saved sessions yet";
  if (overlay === "queue") return "nothing queued";
  if (overlay === "providers") return "no providers configured";
  return "no commands";
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "?";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

let cachedVersion: string | undefined;
function runtimeVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const here = fileURLToPath(import.meta.url);
    const pkg = JSON.parse(readFileSync(`${here}/../../package.json`, "utf8")) as { version?: string };
    cachedVersion = pkg.version ?? "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}
