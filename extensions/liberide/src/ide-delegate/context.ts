import * as vscode from "vscode";
import type { IdeToolContextPayload } from "../chat/types";
import { currentIdeUserId } from "./identity";
import { getWorkspaceIntelligence } from "../workspace/intelligence";

function resolveContextFolder(): vscode.WorkspaceFolder | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const folder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (folder) return folder;
  }
  return vscode.workspace.workspaceFolders?.[0];
}

export function buildIdeContextPayload(conversationId?: string): IdeToolContextPayload | undefined {
  const folder = resolveContextFolder();
  if (!folder) return undefined;
  return {
    sessionId: `vscode-${folder.name}`,
    userId: currentIdeUserId(),
    ideUserId: currentIdeUserId(),
    ideSessionId: `vscode-${folder.name}`,
    projectPath: folder.uri.fsPath,
    mode: "desktop",
    terminalExecutor: "client",
    conversationId,
    workspaceIntelligence: getWorkspaceIntelligence(folder.uri.fsPath),
  };
}
