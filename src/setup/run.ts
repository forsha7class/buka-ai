import { render } from "ink";
import { createElement } from "react";

import type { ProviderSetupResult } from "../config/setup.js";
import { SetupApp } from "./app.js";

export interface RunSetupOptions {
  configPath?: string;
  onSaved?: (result: ProviderSetupResult) => void | Promise<void>;
}

/**
 * Runs the provider wizard as its own full-screen Ink render. Returns null when
 * the user cancels, so the caller can exit without treating it as success.
 */
export async function runSetup(options: RunSetupOptions = {}): Promise<ProviderSetupResult | null> {
  let saved: ProviderSetupResult | null = null;
  let cancelled = false;

  const app = render(
    createElement(SetupApp, {
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      standalone: true,
      onSaved: (result) => {
        saved = result;
        return options.onSaved?.(result);
      },
      onCancel: () => {
        cancelled = true;
      },
    }),
    {
      exitOnCtrlC: false,
      patchConsole: false,
      alternateScreen: true,
    },
  );

  try {
    await app.waitUntilExit();
  } finally {
    app.cleanup();
  }

  return cancelled ? null : saved;
}
