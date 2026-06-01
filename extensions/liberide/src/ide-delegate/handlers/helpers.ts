import * as vscode from "vscode";
import * as path from "node:path";

export function workspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

export function relativePath(fsPath: string): string {
  const root = workspaceFolder()?.uri.fsPath;
  if (!root) return fsPath;
  return path.relative(root, fsPath).replace(/\\/g, "/") || fsPath;
}

export function resolveFileUri(relative: string): vscode.Uri {
  const folder = workspaceFolder();
  if (!folder) throw new Error("No workspace folder open");
  return vscode.Uri.joinPath(folder.uri, relative);
}

export function rangeFromPayload(payload: Record<string, unknown>): vscode.Range {
  const startLine = Number(payload.startLine ?? payload.line ?? 1) - 1;
  const startChar = Number(payload.startChar ?? payload.startCharacter ?? payload.character ?? 0);
  const endLine = Number(payload.endLine ?? payload.line ?? 1) - 1;
  const endChar = Number(payload.endChar ?? payload.endCharacter ?? payload.character ?? 0);
  return new vscode.Range(startLine, startChar, endLine, endChar);
}

export function rangeToJson(range: vscode.Range): Record<string, number> {
  return {
    startLine: range.start.line + 1,
    startCharacter: range.start.character,
    endLine: range.end.line + 1,
    endCharacter: range.end.character,
  };
}

export function positionFromPayload(payload: Record<string, unknown>): vscode.Position {
  return new vscode.Position(Number(payload.line ?? 1) - 1, Number(payload.character ?? 0));
}
