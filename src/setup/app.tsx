import { Box, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import {
  CUSTOM_PROVIDER_ID,
  PROVIDER_PRESETS,
  isCustomPreset,
  presetById,
  presetEnv,
  type ProviderPreset,
} from "../config/providers.js";
import {
  detect9RouterDefaults,
  discoverModels,
  existingProviderDefaults,
  normalizeBaseURL,
  saveProviderSetup,
  uniqueProviderId,
  validateProviderId,
  type ProviderSetupResult,
} from "../config/setup.js";
import type { ModelInfo } from "../provider/types.js";
import { LineList } from "../tui/components.js";
import { dialogLines, formLines, type PickerItem } from "../tui/dialogs.js";
import {
  backspace,
  createEditor,
  deleteWordBefore,
  insertText,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  type EditorState,
} from "../tui/editor.js";
import type { Line } from "../tui/types.js";

export interface SetupAppProps {
  /** Explicit config file to write. Defaults to the global buka.jsonc. */
  configPath?: string;
  /** Fill the whole terminal (first run) or a pane (inside the TUI). */
  width?: number;
  height?: number;
  /** True when setup is its own Ink render; false when embedded in the TUI. */
  standalone?: boolean;
  /** Called after a successful save, before the wizard closes. */
  onSaved?: (result: ProviderSetupResult) => void | Promise<void>;
  onCancel?: () => void;
}

interface Target {
  preset: ProviderPreset;
  providerId: string;
  name: string;
  baseURL: string;
  custom: boolean;
  initialApiKey?: string;
  keyNote?: string;
}

interface KeyInfo {
  apiKey?: string;
  apiKeyRef?: string;
}

type Screen =
  | { kind: "provider"; index: number; filter: string }
  | { kind: "custom-id"; value: EditorState; error?: string }
  | { kind: "custom-name"; value: EditorState; providerId: string; error?: string }
  | ({ kind: "endpoint"; value: EditorState; error?: string } & Target)
  | ({ kind: "apikey"; value: EditorState; error?: string } & Target)
  | ({ kind: "validating" } & Target & KeyInfo)
  | ({ kind: "models"; models: ModelInfo[]; index: number; filter: string } & Target & KeyInfo)
  | ({ kind: "manual-model"; value: EditorState; error?: string } & Target & KeyInfo)
  | ({ kind: "error"; message: string; index: number } & Target & KeyInfo)
  | ({ kind: "saving"; model: ModelInfo } & Target & KeyInfo)
  | { kind: "done"; result: ProviderSetupResult };

type TextScreen = Extract<
  Screen,
  { kind: "custom-id" | "custom-name" | "endpoint" | "apikey" | "manual-model" }
>;

/** Carries provider/key state between wizard steps without leaking `kind`. */
function carry(screen: Target & Partial<KeyInfo>): Target & KeyInfo {
  return {
    preset: screen.preset,
    providerId: screen.providerId,
    name: screen.name,
    baseURL: screen.baseURL,
    custom: screen.custom,
    ...(screen.initialApiKey ? { initialApiKey: screen.initialApiKey } : {}),
    ...(screen.keyNote ? { keyNote: screen.keyNote } : {}),
    ...(screen.apiKey ? { apiKey: screen.apiKey } : {}),
    ...(screen.apiKeyRef ? { apiKeyRef: screen.apiKeyRef } : {}),
  };
}

function errorItems(): PickerItem[] {
  return [
    { reference: "retry", detail: "try the endpoint again" },
    { reference: "edit credentials", detail: "change the endpoint or API key" },
    { reference: "enter model manually", detail: "skip /models discovery" },
    { reference: "cancel", detail: "leave setup" },
  ];
}

export function SetupApp(props: SetupAppProps): ReactElement {
  const { exit } = useApp();
  const window = useWindowSize();
  const width = props.width ?? window.columns;
  const height = props.height ?? window.rows;
  const standalone = props.standalone ?? false;

  const [screen, setScreen] = useState<Screen>({ kind: "provider", index: 0, filter: "" });

  const cancel = useCallback((): void => {
    props.onCancel?.();
    if (standalone) exit();
  }, [exit, props, standalone]);

  const filteredProviders = useMemo(() => {
    if (screen.kind !== "provider") return [];
    const query = screen.filter.trim().toLowerCase();
    if (query.length === 0) return PROVIDER_PRESETS;
    return PROVIDER_PRESETS.filter(
      (preset) =>
        preset.id.includes(query) ||
        preset.name.toLowerCase().includes(query) ||
        preset.description.toLowerCase().includes(query),
    );
  }, [screen]);

  const choosePreset = useCallback(
    (id: string): void => {
      const preset = presetById(id);
      if (!preset) return;

      if (isCustomPreset(preset)) {
        setScreen({
          kind: "custom-id",
          value: createEditor(uniqueProviderId(CUSTOM_PROVIDER_ID, props.configPath)),
        });
        return;
      }

      let baseURL = preset.baseURL;
      let initialApiKey: string | undefined;
      let keyNote: string | undefined;
      if (preset.id === "9router") {
        const found = detect9RouterDefaults();
        baseURL = found.baseURL;
        initialApiKey = found.apiKey;
        keyNote = found.source ? `key found in ${found.source}` : undefined;
      } else {
        const existing = existingProviderDefaults(preset.id, props.configPath);
        if (existing.baseURL) baseURL = existing.baseURL;
        initialApiKey = existing.apiKey;
        keyNote = existing.keySource ? `key found in ${existing.keySource}` : undefined;
      }

      setScreen({
        kind: "endpoint",
        preset,
        providerId: preset.id,
        name: preset.name,
        baseURL: "",
        custom: false,
        ...(initialApiKey ? { initialApiKey } : {}),
        ...(keyNote ? { keyNote } : {}),
        value: createEditor(baseURL),
      });
    },
    [props.configPath],
  );

  const startValidation = useCallback((target: Target, apiKey?: string, apiKeyRef?: string): void => {
    setScreen({
      ...carry(target),
      kind: "validating",
      ...(apiKey ? { apiKey } : {}),
      ...(apiKeyRef ? { apiKeyRef } : {}),
    });
  }, []);

  // Validate the endpoint with the real adapter, then move to model selection.
  useEffect(() => {
    if (screen.kind !== "validating") return;
    const controller = new AbortController();
    let active = true;
    const { preset, providerId, name, baseURL, apiKey, apiKeyRef } = screen;

    discoverModels(
      {
        providerId,
        name,
        type: preset.type,
        baseURL,
        ...(apiKey ? { apiKey } : {}),
        ...(apiKeyRef ? { apiKeyRef } : {}),
      },
      { signal: controller.signal },
    )
      .then((models) => {
        if (!active) return;
        if (models.length === 0) {
          setScreen({
            ...carry(screen),
            kind: "manual-model",
            value: createEditor(""),
          });
          return;
        }
        const preferred = preferredModel(models, preset) ?? models[0]!;
        setScreen({
          ...carry(screen),
          kind: "models",
          models,
          filter: "",
          index: Math.max(0, models.indexOf(preferred)),
        });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setScreen({
          ...carry(screen),
          kind: "error",
          message: (cause as Error).message,
          index: 0,
        });
      });

    return () => {
      active = false;
      controller.abort();
    };
    // The screen object is the state being validated; rerunning when its kind is
    // unchanged would restart the request on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  // Persist once a model has been chosen.
  useEffect(() => {
    if (screen.kind !== "saving") return;
    try {
      const result = saveProviderSetup(
        {
          providerId: screen.providerId,
          name: screen.name,
          type: screen.preset.type,
          baseURL: screen.baseURL,
          modelId: screen.model.id,
          model: screen.model,
          ...(screen.apiKey ? { apiKey: screen.apiKey } : {}),
          ...(screen.apiKeyRef ? { apiKeyRef: screen.apiKeyRef } : {}),
        },
        props.configPath ? { configPath: props.configPath } : {},
      );
      setScreen({ kind: "done", result });
      void Promise.resolve(props.onSaved?.(result)).catch((cause: unknown) => {
        setScreen({
          ...carry(screen),
          kind: "error",
          message: (cause as Error).message,
          index: 0,
        });
      });
    } catch (cause) {
      setScreen({
        ...carry(screen),
        kind: "error",
        message: (cause as Error).message,
        index: 0,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  useEffect(() => {
    if (screen.kind !== "done" || !standalone) return;
    const timer = setTimeout(() => exit(), 500);
    return () => clearTimeout(timer);
  }, [exit, screen.kind, standalone]);

  const submitText = useCallback(
    (current: TextScreen): void => {
      const value = current.value.value.trim();

      if (current.kind === "custom-id") {
        // Reusing an id updates that provider; blank keys preserve the old one.
        const error = validateProviderId(value);
        if (error) {
          setScreen({ ...current, error });
          return;
        }
        const existing = existingProviderDefaults(value, props.configPath);
        setScreen({
          kind: "custom-name",
          providerId: value,
          value: createEditor(existing.name ?? "Custom"),
        });
        return;
      }

      if (current.kind === "custom-name") {
        if (value.length === 0) {
          setScreen({ ...current, error: "Display name is required" });
          return;
        }
        const preset = presetById(CUSTOM_PROVIDER_ID)!;
        const existing = existingProviderDefaults(current.providerId, props.configPath);
        setScreen({
          kind: "endpoint",
          preset,
          providerId: current.providerId,
          name: value,
          baseURL: "",
          custom: true,
          ...(existing.apiKey ? { initialApiKey: existing.apiKey } : {}),
          ...(existing.keySource ? { keyNote: `key found in ${existing.keySource}` } : {}),
          value: createEditor(existing.baseURL ?? ""),
        });
        return;
      }

      if (current.kind === "endpoint") {
        const normalized = normalizeBaseURL(value);
        if (normalized.error || !normalized.value) {
          setScreen({ ...current, error: normalized.error ?? "Invalid endpoint" });
          return;
        }
        setScreen({
          ...carry(current),
          kind: "apikey",
          baseURL: normalized.value,
          value: createEditor(current.initialApiKey ?? ""),
        });
        return;
      }

      if (current.kind === "apikey") {
        const typed = current.value.value.trim();
        if (typed.length > 0) {
          startValidation(current, typed);
          return;
        }
        const env = presetEnv(current.preset);
        if (env) {
          startValidation(current, undefined, `{env:${env.name}}`);
          return;
        }
        if (current.preset.keyOptional) {
          startValidation(current);
          return;
        }
        setScreen({ ...current, error: "API key is required for this provider" });
        return;
      }

      if (current.kind === "manual-model") {
        if (value.length === 0) {
          setScreen({ ...current, error: "Model id is required" });
          return;
        }
        setScreen({ ...carry(current), kind: "saving", model: { id: value } });
      }
    },
    [props.configPath, startValidation],
  );

  useInput((input, key) => {
    if (screen.kind === "done") {
      if (key.ctrl && input === "c") {
        if (standalone) exit();
        return;
      }
      if (key.return || key.escape) {
        if (standalone) exit();
        else props.onCancel?.();
      }
      return;
    }

    if (key.ctrl && input === "c") {
      cancel();
      return;
    }

    if (screen.kind === "validating" || screen.kind === "saving") {
      if (key.escape) cancel();
      return;
    }

    if (screen.kind === "provider" || screen.kind === "models" || screen.kind === "error") {
      const isProvider = screen.kind === "provider";
      const isModels = screen.kind === "models";
      const isError = screen.kind === "error";
      const items = isProvider
        ? filteredProviders.map((preset) => ({
            reference: preset.id,
            detail: preset.description,
          }))
        : isModels
          ? modelItems(screen.models, screen.filter)
          : errorItems();
      const index = isProvider || isModels
        ? Math.min(screen.index, Math.max(0, items.length - 1))
        : Math.min(screen.index, Math.max(0, items.length - 1));

      if (key.escape) {
        if (isProvider) cancel();
        else {
          setScreen({
            ...carry(screen),
            kind: "apikey",
            value: createEditor(screen.apiKey ?? ""),
            error: undefined,
          });
        }
        return;
      }
      if (key.upArrow) {
        if (!isProvider && !isModels && !isError) return;
        setScreen({ ...screen, index: Math.max(0, index - 1) });
        return;
      }
      if (key.downArrow) {
        setScreen({ ...screen, index: Math.min(Math.max(0, items.length - 1), index + 1) });
        return;
      }
      if (key.return) {
        const chosen = items[index];
        if (!chosen) return;
        if (isProvider) {
          choosePreset(chosen.reference);
          return;
        }
        if (isModels) {
          if (chosen.reference === "__manual__") {
            setScreen({ ...carry(screen), kind: "manual-model", value: createEditor("") });
            return;
          }
          const model = screen.models.find((candidate) => candidate.id === chosen.reference);
          if (model) setScreen({ ...carry(screen), kind: "saving", model });
          return;
        }
        if (chosen.reference === "retry") {
          setScreen({
            ...carry(screen),
            kind: "validating",
          });
        } else if (chosen.reference === "edit credentials") {
          setScreen({
            ...carry(screen),
            kind: "apikey",
            value: createEditor(screen.apiKey ?? ""),
            error: undefined,
          });
        } else if (chosen.reference === "enter model manually") {
          setScreen({ ...carry(screen), kind: "manual-model", value: createEditor("") });
        } else {
          cancel();
        }
        return;
      }
      if (key.backspace || key.delete) {
        if (isProvider) setScreen({ ...screen, filter: screen.filter.slice(0, -1), index: 0 });
        else if (isModels) setScreen({ ...screen, filter: screen.filter.slice(0, -1), index: 0 });
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        const printable = input.replace(/[\u0000-\u001f\u007f]/g, "");
        if (printable.length > 0) {
          if (isProvider) setScreen({ ...screen, filter: screen.filter + printable, index: 0 });
          else if (isModels) setScreen({ ...screen, filter: screen.filter + printable, index: 0 });
        }
      }
      return;
    }

    if (key.escape) {
      if (screen.kind === "custom-id") {
        setScreen({ kind: "provider", index: 0, filter: "" });
      } else if (screen.kind === "custom-name") {
        setScreen({ kind: "custom-id", value: createEditor(screen.providerId) });
      } else if (screen.kind === "endpoint") {
        setScreen({ kind: "provider", index: 0, filter: "" });
      } else if (screen.kind === "apikey") {
        setScreen({
          ...carry(screen),
          kind: "endpoint",
          value: createEditor(screen.baseURL),
          error: undefined,
        });
      } else if (screen.kind === "manual-model") {
        setScreen({
          ...carry(screen),
          kind: "apikey",
          value: createEditor(screen.apiKey ?? ""),
        });
      }
      return;
    }

    if (key.return) {
      submitText(screen);
      return;
    }

    if (key.ctrl && input === "u") {
      setScreen({ ...screen, value: createEditor(), error: undefined });
      return;
    }

    if (key.backspace || key.delete) {
      setScreen({ ...screen, value: key.ctrl || key.meta ? deleteWordBefore(screen.value) : backspace(screen.value), error: undefined });
      return;
    }
    if (key.home) {
      setScreen({ ...screen, value: moveHome(screen.value) });
      return;
    }
    if (key.end) {
      setScreen({ ...screen, value: moveEnd(screen.value) });
      return;
    }
    if (key.leftArrow) {
      setScreen({ ...screen, value: moveLeft(screen.value) });
      return;
    }
    if (key.rightArrow) {
      setScreen({ ...screen, value: moveRight(screen.value) });
      return;
    }
    if (input.length > 0 && !key.ctrl && !key.meta) {
      const printable = input.replace(/[\u0000-\u001f\u007f]/g, "");
      if (printable.length > 0) {
        setScreen({ ...screen, value: insertText(screen.value, printable), error: undefined });
      }
    }
  });

  const lines = useMemo<Line[]>(() => {
    if (screen.kind === "provider") {
      const items = filteredProviders.map((preset) => ({
        reference: preset.id,
        detail: preset.description,
      }));
      return dialogLines(
        {
          title: "buka ai · setup",
          subtitle: "choose a provider",
          filter: screen.filter,
          filterLabel: "search",
          items,
          index: Math.min(screen.index, Math.max(0, items.length - 1)),
          hint: "↑↓ select · type to filter · enter continue · esc cancel",
          empty: "no matching providers",
        },
        width,
        height,
      );
    }

    if (screen.kind === "models") {
      const items = modelItems(screen.models, screen.filter);
      return dialogLines(
        {
          title: "buka ai · setup",
          subtitle: `${screen.name} · choose a model`,
          filter: screen.filter,
          filterLabel: "search",
          items,
          index: Math.min(screen.index, Math.max(0, items.length - 1)),
          hint: "↑↓ select · type to filter · enter continue · esc back",
          empty: "no matching models",
        },
        width,
        height,
      );
    }

    if (screen.kind === "error") {
      return dialogLines(
        {
          title: "buka ai · setup",
          subtitle: "provider check failed",
          note: screen.message,
          items: errorItems(),
          index: Math.min(screen.index, errorItems().length - 1),
          hint: "↑↓ select · enter continue · esc back",
          empty: screen.message,
        },
        width,
        height,
      );
    }

    if (screen.kind === "validating") {
      return formLines(
        {
          title: "buka ai · setup",
          subtitle: `${screen.name} · ${screen.baseURL}`,
          label: "Status",
          value: "Checking endpoint and models…",
          note: "The API key is sent only to this endpoint.",
          hint: "esc cancel",
        },
        width,
        height,
      );
    }

    if (screen.kind === "saving") {
      return formLines(
        {
          title: "buka ai · setup",
          subtitle: screen.name,
          label: "Status",
          value: "Saving configuration…",
          note: screen.model.id,
          hint: "esc cancel",
        },
        width,
        height,
      );
    }

    if (screen.kind === "done") {
      return formLines(
        {
          title: "buka ai · setup",
          subtitle: "ready",
          label: "Configuration saved",
          value: screen.result.configPath,
          note: `model: ${screen.result.modelRef}`,
          hint: "enter to start buka",
        },
        width,
        height,
      );
    }

    if (screen.kind === "custom-id" || screen.kind === "custom-name") {
      return formLines(
        {
          title: "buka ai · setup",
          subtitle: screen.kind === "custom-id" ? "custom provider" : "custom provider",
          label: screen.kind === "custom-id" ? "Provider id" : "Display name",
          value: screen.value.value,
          ...(screen.error ? { error: screen.error } : {}),
          hint: "enter continue · esc back",
        },
        width,
        height,
      );
    }

    if (screen.kind === "endpoint") {
      return formLines(
        {
          title: "buka ai · setup",
          subtitle: `provider: ${screen.name}`,
          label: "Endpoint",
          value: screen.value.value,
          note: screen.preset.type === "anthropic"
            ? "Anthropic native endpoint, e.g. https://api.anthropic.com/v1"
            : screen.preset.type === "google"
              ? "Gemini native endpoint, e.g. https://generativelanguage.googleapis.com/v1beta"
              : "OpenAI-compatible base URL, usually ending in /v1",
          ...(screen.error ? { error: screen.error } : {}),
          hint: "enter continue · esc back",
        },
        width,
        height,
      );
    }

    if (screen.kind === "apikey") {
      const env = presetEnv(screen.preset);
      return formLines(
        {
          title: "buka ai · setup",
          subtitle: `provider: ${screen.name}`,
          label: "API key",
          value: screen.value.value,
          masked: true,
          note: env
            ? `leave blank to use $${env.name}${screen.keyNote ? ` · ${screen.keyNote}` : ""}`
            : screen.preset.keyOptional
              ? screen.keyNote ?? "optional for local endpoints"
              : screen.keyNote ?? "paste the provider API key",
          ...(screen.error ? { error: screen.error } : {}),
          hint: "enter continue · esc back",
        },
        width,
        height,
      );
    }

    return formLines(
      {
        title: "buka ai · setup",
        subtitle: `provider: ${screen.name}`,
        label: "Model id",
        value: screen.value.value,
        note: "For endpoints without /models, type the wire model id exactly.",
        ...(screen.error ? { error: screen.error } : {}),
        hint: "enter continue · esc back",
      },
      width,
      height,
    );
  }, [choosePreset, filteredProviders, height, screen, width]);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <LineList lines={lines} offset={0} height={height} />
    </Box>
  );
}

function modelItems(models: ModelInfo[], filter: string): PickerItem[] {
  const query = filter.trim().toLowerCase();
  const visible = models.filter(
    (model) =>
      query.length === 0 ||
      model.id.toLowerCase().includes(query) ||
      (model.name ?? "").toLowerCase().includes(query),
  );
  const items: PickerItem[] = visible.map((model) => ({
    reference: model.id,
    detail: [
      model.name && model.name !== model.id ? model.name : "",
      model.tools ? "tools" : "",
      model.reasoning ? "reasoning" : "",
      model.input?.includes("image") ? "vision" : "",
    ]
      .filter(Boolean)
      .join(" "),
  }));
  items.push({ reference: "__manual__", detail: "type a model id manually" });
  return items;
}

function preferredModel(models: ModelInfo[], preset: ProviderPreset): ModelInfo | undefined {
  if (preset.id === "9router") {
    const davo = models.find((model) => model.id.toLowerCase() === "davo");
    if (davo) return davo;
  }
  return models.find((model) => model.tools !== false) ?? models[0];
}

export type { Screen as SetupScreen };
