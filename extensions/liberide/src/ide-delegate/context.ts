import * as vscode from "vscode";
import type { IdeToolContextPayload } from "../chat/types";
import { currentMachineId, workspaceIdFor } from "./machine";

/** The folder the user is working in: the active editor's, else the first. */
export function activeWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  return (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
}

export function buildIdeContextPayload(conversationId?: string): IdeToolContextPayload | undefined {
  const folder = activeWorkspaceFolder();
  if (!folder) return undefined;
  return {
    sessionId: `vscode-${folder.name}`,
    // Ignored by the server (it uses the authenticated user); kept for the payload type.
    userId: "",
    projectPath: folder.uri.fsPath,
    mode: "desktop",
    terminalExecutor: "client",
    conversationId,
    // Lets the server pin tool calls to this machine's window for the folder.
    machineId: currentMachineId(),
    workspaceId: workspaceIdFor(folder.uri.fsPath),
  };
}
