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
  | "vscode.terminalSession";

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
