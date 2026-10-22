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
  get path() {
    return this.fsPath;
  }
  toString() {
    return `${this.scheme}://${this.fsPath}`;
  }
  static file(fsPath: string) {
    return new Uri("file", fsPath);
  }
  static joinPath(base: Uri, ...segments: string[]) {
    return new Uri(base.scheme, [base.fsPath, ...segments].join("/"));
  }
}

export class Position {
  constructor(public line: number, public character: number) {}
}

export class Range {
  start: Position;
  end: Position;
  constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
    this.start = new Position(startLine, startChar);
    this.end = new Position(endLine, endChar);
  }
}

export class TextEdit {
  constructor(public range: Range, public newText: string) {}
}

/** Records operations; `entries()` returns the text edits like the real class. */
export class WorkspaceEdit {
  readonly textEdits = new Map<string, { uri: Uri; edits: TextEdit[] }>();
  readonly fileOps: Array<{ kind: string; uri: Uri; newUri?: Uri; options?: unknown }> = [];
  set(uri: Uri, edits: TextEdit[]) {
    this.textEdits.set(uri.fsPath, { uri, edits });
  }
  replace(uri: Uri, range: Range, newText: string, _metadata?: unknown) {
    const entry = this.textEdits.get(uri.fsPath) ?? { uri, edits: [] };
    entry.edits.push(new TextEdit(range, newText));
    this.textEdits.set(uri.fsPath, entry);
  }
  renameFile(uri: Uri, newUri: Uri, options?: unknown) {
    this.fileOps.push({ kind: "rename", uri, newUri, options });
  }
  createFile(uri: Uri, options?: unknown) {
    this.fileOps.push({ kind: "create", uri, options });
  }
  deleteFile(uri: Uri, options?: unknown) {
    this.fileOps.push({ kind: "delete", uri, options });
  }
  entries(): Array<[Uri, TextEdit[]]> {
    return [...this.textEdits.values()].map(({ uri, edits }) => [uri, edits]);
  }
}

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

/** Edits handed to `workspace.applyEdit`, for assertions. */
export const appliedEdits: WorkspaceEdit[] = [];

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
  /** Settings: every key reads as its default (`liberide.confirmEdits` → "off"). */
  getConfiguration: (_section?: string) => ({
    get: <T>(_key: string, defaultValue?: T) => defaultValue,
    inspect: (_key: string) => undefined,
    update: async () => undefined,
  }),
  textDocuments: [] as Array<{ uri: Uri; isDirty: boolean; save: () => Promise<boolean>; getText: (range?: Range) => string }>,
  async applyEdit(edit: WorkspaceEdit) {
    appliedEdits.push(edit);
    return true;
  },
  async openTextDocument(uri: Uri) {
    const doc = workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (!doc) throw new Error(`not open: ${uri.fsPath}`);
    return doc;
  },
};

/** Results for `commands.executeCommand`, by command id. */
export const commandResults = new Map<string, unknown>();

export const commands = {
  async executeCommand(command: string, ..._args: unknown[]) {
    return commandResults.get(command);
  },
};

export const SymbolKind: Record<number, string> = { 11: "Function", 4: "Class" };

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
  Position,
  Range,
  TextEdit,
  WorkspaceEdit,
  ConfigurationTarget,
  SymbolKind,
  commands,
  window,
  workspace,
  lm,
};
