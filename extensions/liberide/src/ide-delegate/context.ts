import * as vscode from "vscode";
import type { IdeToolContextPayload } from "../chat/types";

export function buildIdeContextPayload(conversationId?: string): IdeToolContextPayload | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  return {
    sessionId: `vscode-${folder.name}`,
    userId: "default",
    projectPath: folder.uri.fsPath,
    mode: "desktop",
    terminalExecutor: "client",
    conversationId,
  };
}
