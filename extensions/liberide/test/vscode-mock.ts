/**
 * Minimal `vscode` module for unit tests (run with `bun test`). Only the
 * surface the tested modules touch is implemented; register it with
 * `mock.module("vscode", () => vscodeMock)` before importing them.
 */

type Listener<T> = (value: T) => void;

export class EventEmitter<T> {
  private listeners = new Set<Listener<T>>();
  event = (listener: Listener<T>) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class CancellationTokenSource {
  token = { isCancellationRequested: false };
  cancel(): void {
    this.token.isCancellationRequested = true;
  }
  dispose(): void {}
}

export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(public callId: string, public name: string, public input: object) {}
}

export class LanguageModelToolResultPart {
  constructor(public callId: string, public content: unknown[]) {}
}

export class LanguageModelDataPart {
  constructor(public data: Uint8Array, public mimeType: string) {}
  static image(data: Uint8Array, mimeType: string) {
    return new LanguageModelDataPart(data, mimeType);
  }
}

export const LanguageModelChatMessage = {
  User: (content: unknown) => ({ role: "user", content }),
  Assistant: (content: unknown) => ({ role: "assistant", content }),
};

export const LanguageModelChatToolMode = { Auto: 1, Required: 2 };

export class Uri {
  constructor(public scheme: string, public fsPath: string) {}
  static file(fsPath: string) {
    return new Uri("file", fsPath);
  }
  static joinPath(base: Uri, ...segments: string[]) {
    return new Uri(base.scheme, [base.fsPath, ...segments].join("/"));
  }
}

/** Terminals created through `window.createTerminal({ pty })`; tests read what was written. */
export const createdTerminals: Array<{ name: string; written: string; pty: { open: () => void; close: () => void; handleInput?: (data: string) => void }; disposed: boolean }> = [];

export const window = {
  activeTextEditor: undefined as undefined | { document: { uri: Uri } },
  createTerminal(options: { name: string; pty: { onDidWrite: (listener: Listener<string>) => unknown; open: () => void; close: () => void; handleInput?: (data: string) => void } }) {
    const record = { name: options.name, written: "", pty: options.pty, disposed: false };
    options.pty.onDidWrite((chunk) => { record.written += chunk; });
    createdTerminals.push(record);
    // VS Code opens the pseudoterminal once the tab is shown.
    queueMicrotask(() => options.pty.open());
    return {
      name: options.name,
      show: () => undefined,
      dispose: () => { record.disposed = true; },
    };
  },
};

export const workspace = {
  workspaceFolders: [] as Array<{ name: string; uri: Uri }>,
  isTrusted: true,
  getWorkspaceFolder: (_uri: Uri) => workspace.workspaceFolders[0],
};

export const lm = {
  models: [] as unknown[],
  selectChatModels: async (_selector: unknown) => lm.models,
};

export const env = { appRoot: "/nonexistent-vscode-app-root", sessionId: "test-window" };

export const vscodeMock = {
  env,
  EventEmitter,
  CancellationTokenSource,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelDataPart,
  LanguageModelChatMessage,
  LanguageModelChatToolMode,
  Uri,
  window,
  workspace,
  lm,
};
