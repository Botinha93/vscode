export type IdeDelegateKind =
  | "terminal.run"
  | "vscode.openEditors"
  | "vscode.dirtyBuffers"
  | "vscode.activeSelection"
  | "vscode.diagnostics"
  | "vscode.workspaceSymbols"
  | "vscode.documentSymbols"
  | "vscode.definition"
  | "vscode.references"
  | "vscode.hover"
  | "vscode.findFiles"
  | "vscode.git.status"
  | "vscode.git.log"
  | "vscode.git.diff"
  | "vscode.git.blame"
  | "vscode.terminalSession"
  | "vscode.codeActions"
  | "vscode.codeActions.apply"
  | "vscode.rename"
  | "vscode.formatDocument"
  | "vscode.formatRange"
  | "vscode.applyWorkspaceEdit"
  | "vscode.tasks.list"
  | "vscode.tasks.run"
  | "vscode.tasks.cancel"
  | "vscode.tests.list"
  | "vscode.tests.run"
  | "vscode.tests.status"
  | "vscode.debug.start"
  | "vscode.debug.stop"
  | "vscode.debug.list"
  | "vscode.debug.stackTrace"
  | "vscode.notebook.read"
  | "vscode.notebook.edit"
  | "vscode.notebook.execute"
  | "vscode.config.read"
  | "vscode.config.write"
  | "vscode.extensions.list"
  | "vscode.problemsByOwner"
  | "vscode.semanticTokens";

export interface IdeDelegatePayload {
  delegateId: string;
  kind: IdeDelegateKind;
  payload: Record<string, unknown>;
  target: {
    userId: string;
    projectPath: string;
    sessionId?: string;
    conversationId?: string;
  };
  timeoutMs: number;
}
