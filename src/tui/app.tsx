import { writeFileSync } from "node:fs";

import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type RefObject,
} from "react";

import { runAgent } from "../agent/loop.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import { createDefaultTools } from "../agent/tools/index.js";
import type { ToolRegistry } from "../agent/tools/registry.js";
import type { PermissionRequest } from "../agent/tools/types.js";
import type { ChatMessage, ToolCall } from "../provider/types.js";
import type { Runtime } from "../runtime.js";
import { SessionStore, type Session, type ToolResultRecord } from "../session/store.js";
import { messagesToLines } from "./blocks.js";
import {
  Banner,
  Header,
  LineList,
  ModelPicker,
  PermissionPrompt,
  PromptInput,
  StatusBar,
} from "./components.js";
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
import { sessionToViews } from "./session-view.js";
import { initialState, palette, reducer, type Action, type AppState } from "./types.js";

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

type Overlay = null | "models" | "sessions";

interface PickerItem {
  reference: string;
  detail: string;
}

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

const HELP_TEXT = [
  "slash commands",
  "  /help              show this help",
  "  /model [ref]       switch model (no argument opens the picker)",
  "  /models            list every available model",
  "  /sessions          browse and resume past sessions",
  "  /new               start a fresh session",
  "  /rename <title>    name the current session",
  "  /clear             clear the visible transcript (session file is kept)",
  "  /compact           summarise the conversation to shrink the context window",
  "  /tools             list the tools the agent can use",
  "  /export [file]     write the conversation to a markdown file",
  "  /exit              quit",
  "",
  "keys",
  "  Enter              send",
  "  Alt+Enter          new line",
  "  Esc                stop the current run",
  "  PgUp / PgDn        scroll the transcript",
  "  Ctrl+K             model picker",
  "  Ctrl+P             session picker",
  "  Ctrl+T             expand / collapse thinking",
  "  Ctrl+O             expand / collapse tool output",
  "  Ctrl+L             clear the transcript",
  "  Ctrl+C             stop, then clear the input, then quit",
].join("\n");

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
  const [picker, setPicker] = useState<{ items: PickerItem[]; index: number }>({
    items: [],
    index: 0,
  });
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerLoading, setPickerLoading] = useState(false);

  const tools = useMemo(() => createDefaultTools(cwd), [cwd]);
  const systemPrompt = useMemo(
    () =>
      buildSystemPrompt({
        cwd,
        tools,
        ...(runtime.config.systemPrompt !== undefined
          ? { custom: runtime.config.systemPrompt }
          : {}),
      }),
    [cwd, tools, runtime.config.systemPrompt],
  );

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

  const lines = useMemo(
    () =>
      messagesToLines(state.messages, {
        width: columns,
        showThinking: runtime.config.tui.showThinking,
      }),
    [state.messages, columns, runtime.config.tui.showThinking],
  );

  const inputRows = Math.min(Math.max(1, editorRows(editor.value, columns - 2).length), 6);
  const inputHeight = state.pendingPermission ? inputRows + 3 : inputRows;
  const messageHeight = Math.max(3, rows - 3 - inputHeight);
  const maxScroll = Math.max(0, lines.length - messageHeight);
  const offset = state.scroll.pinned
    ? maxScroll
    : Math.min(Math.max(0, state.scroll.offset), maxScroll);
  const maxScrollRef = useRef(maxScroll);
  maxScrollRef.current = maxScroll;

  // ---------------------------------------------------------------------------
  // Run
  // ---------------------------------------------------------------------------
  const runTurn = useCallback(
    async (prompt: string): Promise<void> => {
      busyRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;

      const active = sessionRef.current;
      active?.recordUser(prompt);

      dispatch({ type: "user", text: prompt });
      dispatch({ type: "assistant_start" });
      dispatch({ type: "status", status: "thinking" });

      // Accumulated for the session log; kept out of React state so the record
      // is exactly what the stream produced, independent of render timing.
      let text = "";
      let reasoning = "";
      let model = activeModel.modelId;
      let error: string | undefined;
      const toolCalls: ToolCall[] = [];
      const toolResults = new Map<string, ToolResultRecord>();

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
              reasoning += event.delta;
              dispatch({ type: "reasoning", text: event.delta });
              break;
            case "text":
              text += event.delta;
              dispatch({ type: "delta", text: event.delta });
              dispatch({ type: "status", status: "responding" });
              break;
            case "tool_start":
              toolCalls.push(event.call);
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
              toolResults.set(event.call.id, {
                id: event.call.id,
                name: event.call.function.name,
                preview: existing?.preview ?? event.call.function.name,
                output: event.output,
                isError: event.isError,
                ...(event.summary !== undefined ? { summary: event.summary } : {}),
              });
              dispatch({
                type: "tool_end",
                id: event.call.id,
                output: event.output,
                isError: event.isError,
                ...(event.summary !== undefined ? { summary: event.summary } : {}),
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
        dispatch({ type: "done", reason: "complete" });
        active?.completeAssistant({
          text,
          reasoning,
          model,
          toolCalls,
          toolResults: [...toolResults.values()],
          ...(error !== undefined ? { error } : {}),
        });
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

  const openModelPicker = useCallback(async (): Promise<void> => {
    setOverlay("models");
    setPickerError(null);
    if (picker.items.length > 0) return;
    setPickerLoading(true);
    try {
      const models = await runtime.registry.listModels();
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
  }, [activeModel.reference, picker.items.length, runtime.registry]);

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
    [runtime.registry, sessionStore, systemPrompt],
  );

  const startNewSession = useCallback((): void => {
    sessionRef.current = undefined;
    messagesRef.current = [{ role: "system", content: systemPrompt }];
    dispatch({ type: "reset" });
  }, [systemPrompt]);

  /**
   * Replaces the in-memory context with a model-written summary.
   *
   * The session log is left untouched — it is the append-only record of what
   * actually happened, and rewriting history there would be a lie. Only the
   * provider context for this process shrinks.
   */
  const compactContext = useCallback(async (): Promise<void> => {
    const history = messagesRef.current.filter((message) => message.role !== "system");
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

    messagesRef.current = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `[Summary of the earlier conversation]\n${summary.trim()}` },
    ];

    dispatch({
      type: "delta",
      text: `\n\n— context compacted to ${summary.trim().length} chars. The full history stays in the session log.`,
    });
    dispatch({ type: "done", reason: "complete" });
  }, [activeModel.modelId, activeModel.provider, cwd, systemPrompt]);

  // ---------------------------------------------------------------------------
  // Submit + slash commands
  // ---------------------------------------------------------------------------
  const submit = useCallback(
    (raw: string): void => {
      const text = raw.trim();
      if (text.length === 0 || busyRef.current) return;

      historyRef.current = [...historyRef.current.filter((entry) => entry !== text), text];
      historyIndexRef.current = null;
      historyDraftRef.current = null;
      setEditor(createEditor());

      if (text.startsWith("/")) {
        const handled = handleSlashCommand(text, {
          dispatch,
          exit,
          openModelPicker,
          openSessionPicker,
          startNewSession,
          compactContext,
          switchModel,
          ensureSession,
          sessionRef,
          state,
          tools,
          runtime,
        });
        if (handled) return;
      }

      // Interactive runs are always persisted, so make sure a session exists
      // before the first turn is written to it.
      ensureSession();
      void runTurn(text);
    },
    [
      compactContext,
      ensureSession,
      exit,
      openModelPicker,
      openSessionPicker,
      runTurn,
      runtime,
      startNewSession,
      state,
      switchModel,
      tools,
    ],
  );

  // ---------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------
  useInput((input, key) => {
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

    // 2. Overlays.
    if (overlay !== null) {
      const close = key.escape || (overlay === "models" && key.ctrl && input === "k") || (overlay === "sessions" && key.ctrl && input === "p");
      if (close) {
        setOverlay(null);
        return;
      }
      if (key.upArrow || input === "k") {
        setPicker((current) => ({ ...current, index: Math.max(0, current.index - 1) }));
        return;
      }
      if (key.downArrow || input === "j") {
        setPicker((current) => ({
          ...current,
          index: Math.min(Math.max(0, current.items.length - 1), current.index + 1),
        }));
        return;
      }
      if (key.return) {
        const chosen = picker.items[picker.index];
        if (chosen) {
          if (overlay === "models") switchModel(chosen.reference);
          else resumeSession(chosen.reference);
        }
        setOverlay(null);
        return;
      }
      if (key.ctrl && input === "c") exit();
      return;
    }

    // 3. Global controls.
    if (key.ctrl && input === "c") {
      if (busyRef.current) stop();
      else if (editor.value.length > 0) setEditor(createEditor());
      else exit();
      return;
    }

    if (key.ctrl && input === "k") {
      void openModelPicker();
      return;
    }

    if (key.ctrl && input === "p") {
      void openSessionPicker();
      return;
    }

    if (key.ctrl && input === "t") {
      const last = [...state.messages]
        .reverse()
        .find((message) => message.role === "assistant" && message.reasoning.length > 0);
      if (last) dispatch({ type: "toggle_thinking", id: last.id });
      return;
    }

    if (key.ctrl && input === "o") {
      const last = [...state.messages]
        .reverse()
        .find((message) => message.tools.some((tool) => tool.output));
      const tool = last?.tools.filter((candidate) => candidate.output).pop();
      if (tool) dispatch({ type: "toggle_tool", id: tool.id });
      return;
    }

    if (key.ctrl && input === "l") {
      dispatch({ type: "reset" });
      return;
    }

    if (key.escape) {
      if (busyRef.current) stop();
      return;
    }

    // 4. Scrolling.
    if (key.pageUp || (key.shift && key.upArrow)) {
      dispatch({ type: "scroll", delta: -(messageHeight - 2), maxScroll: maxScrollRef.current });
      return;
    }
    if (key.pageDown || (key.shift && key.downArrow)) {
      dispatch({ type: "scroll", delta: messageHeight - 2, maxScroll: maxScrollRef.current });
      return;
    }
    if (key.ctrl && input === "g") {
      dispatch({ type: "pin" });
      return;
    }

    // 5. Input editing.
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
      const movedUp = moveVertical(editor, columns - 2, -1);
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
      setEditor((current) => moveVertical(current, columns - 2, 1));
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
      if (printable.length > 0) setEditor((current) => insertText(current, printable));
    }
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const hint = busyRef.current
    ? "esc stop · ctrl+c stop"
    : "Enter send · Alt+Enter newline · Ctrl+P sessions · /help";

  const sessionLabel = sessionRef.current
    ? `${sessionRef.current.title}`
    : "new session";

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Header state={state} width={columns} session={sessionLabel} />

      <Box flexDirection="column" height={messageHeight} overflow="hidden">
        {overlay !== null ? (
          picker.items.length > 0 ? (
            <ModelPicker
              items={picker.items}
              index={picker.index}
              width={columns}
              title={overlay === "models" ? "select model" : "resume session"}
            />
          ) : (
            <Text color={palette.dim}>
              {`  ${
                pickerError ??
                (pickerLoading
                  ? "loading…"
                  : overlay === "models"
                    ? "no models available"
                    : "no saved sessions yet")
              }`}
            </Text>
          )
        ) : lines.length === 0 ? (
          <Banner state={state} width={columns} />
        ) : (
          <LineList lines={lines} offset={offset} height={messageHeight} />
        )}
      </Box>

      <Text color={palette.border}>{"─".repeat(Math.max(1, columns))}</Text>

      {state.pendingPermission ? (
        <PermissionPrompt state={state} width={columns} />
      ) : (
        <PromptInput
          editor={editor}
          width={columns}
          placeholder={
            busyRef.current ? "streaming… (Esc to stop)" : "ask buka to do something, or /help"
          }
          disabled={busyRef.current}
        />
      )}

      <StatusBar state={state} width={columns} hint={hint} />
    </Box>
  );
}

// -----------------------------------------------------------------------------
// Slash commands
// -----------------------------------------------------------------------------

interface SlashContext {
  dispatch: Dispatch<Action>;
  exit: () => void;
  openModelPicker: () => Promise<void>;
  openSessionPicker: () => Promise<void>;
  startNewSession: () => void;
  compactContext: () => Promise<void>;
  switchModel: (reference: string) => void;
  ensureSession: () => Session;
  sessionRef: RefObject<Session | undefined>;
  state: AppState;
  tools: ToolRegistry;
  runtime: Runtime;
}

/** Returns true when the input was consumed as a command. */
function handleSlashCommand(raw: string, context: SlashContext): boolean {
  const [command, ...rest] = raw.slice(1).split(/\s+/);
  const args = rest.join(" ").trim();

  const reply = (text: string): void => {
    context.dispatch({ type: "user", text: raw });
    context.dispatch({ type: "assistant_start" });
    context.dispatch({ type: "delta", text });
    context.dispatch({ type: "done", reason: "complete" });
  };

  switch (command) {
    case "help":
      reply(HELP_TEXT);
      return true;

    case "exit":
    case "quit":
      context.exit();
      return true;

    case "clear":
      // Visibility only: the session file keeps the full transcript.
      context.dispatch({ type: "reset" });
      return true;

    case "new":
      context.startNewSession();
      return true;

    case "compact":
      void context.compactContext();
      return true;

    case "rename": {
      const session = context.ensureSession();
      if (args.length === 0) {
        reply(`current session: ${session.title}\nid: ${session.id}`);
        return true;
      }
      session.rename(args);
      reply(`renamed session to "${args}"`);
      return true;
    }

    case "sessions":
      void context.openSessionPicker();
      return true;

    case "tools": {
      const names = context.tools.names();
      reply(
        names.length === 0
          ? "no tools registered"
          : `tools (${names.length}):\n${names.map((name) => `  ${name}`).join("\n")}`,
      );
      return true;
    }

    case "models": {
      context.dispatch({ type: "user", text: raw });
      context.dispatch({ type: "assistant_start" });
      context.runtime.registry
        .listModels()
        .then((models) => {
          const text = models
            .map(
              (model) =>
                `${model.reference}${model.info.tools ? "  (tools)" : ""}${model.info.reasoning ? " (reasoning)" : ""}`,
            )
            .join("\n");
          context.dispatch({ type: "delta", text: `models (${models.length}):\n${text}` });
          context.dispatch({ type: "done", reason: "complete" });
        })
        .catch((cause: unknown) => {
          context.dispatch({ type: "error", message: (cause as Error).message });
          context.dispatch({ type: "done", reason: "complete" });
        });
      return true;
    }

    case "model": {
      if (args.length === 0) {
        void context.openModelPicker();
        return true;
      }
      context.switchModel(args);
      return true;
    }

    case "export": {
      const target = args.length > 0 ? args : `buka-${Date.now()}.md`;
      const session = context.sessionRef.current;
      const header = session
        ? `# ${session.title}\n\n- session: \`${session.id}\`\n- updated: ${session.metaSnapshot.updatedAt}\n\n`
        : "";
      const body = context.state.messages
        .map((message) => `## ${message.role}\n\n${message.text}\n`)
        .join("\n");
      try {
        writeFileSync(target, header + body, "utf8");
        reply(`exported ${context.state.messages.length} messages to ${target}`);
      } catch (cause) {
        reply(`export failed: ${(cause as Error).message}`);
      }
      return true;
    }

    default:
      reply(`unknown command "/${command}". Try /help.`);
      return true;
  }
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
