import * as vscode from "vscode";
import * as path from "node:path";
import { delegateContext, getDelegateConversationId, getDelegateRoot } from "./delegate-context";
import { isPathInside, resolveInsideRootSync } from "./path-containment";

export { isPathInside, resolveInsideRootSync } from "./path-containment";
export { resolveContainedRelativePath, assertContainedGlobPattern } from "./path-containment";

/** Run a handler with `workspaceFolder()` bound to the request's folder (each socket serves one folder). */
export function withRequestRoot<T>(root: string, run: () => Promise<T>, conversationId?: string): Promise<T> {
  return delegateContext.run({ root, conversationId }, run);
}

/** The conversation whose turn issued the current request, when the server sent one. */
export function requestConversationId(): string | undefined {
  return getDelegateConversationId();
}

/**
 * The workspace folder a request targets: the one its socket serves in a
 * multi-root workspace, otherwise the first folder.
 */
export function workspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const root = getDelegateRoot();
  if (root) {
    const target = path.resolve(root);
    const match = folders.find((folder) => path.resolve(folder.uri.fsPath) === target);
    if (match) return match;
  }
  return folders[0];
}

/** Whether an absolute path is inside the request's folder. */
export function isInWorkspace(fsPath: string): boolean {
  const root = workspaceFolder()?.uri.fsPath;
  if (!root) return false;
  return isPathInside(root, fsPath);
}

export function relativePath(fsPath: string): string {
  const root = workspaceFolder()?.uri.fsPath;
  if (!root) return fsPath;
  return path.relative(root, fsPath).replace(/\\/g, "/") || fsPath;
}

export async function resolveInsideRoot(root: string, relative: string, options: { forWrite?: boolean } = {}): Promise<string> {
  return resolveInsideRootSync(root, relative, options);
}

export function resolveFileUri(relative: string): vscode.Uri {
  const folder = workspaceFolder();
  if (!folder) throw new Error("No workspace folder open");
  if (folder.uri.scheme !== "file") {
    // Virtual workspaces: lexical containment only.
    const normalized = path.posix.normalize(relative.replace(/\\/g, "/"));
    if (normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)) {
      throw new Error("Path escapes the workspace folder");
    }
    return vscode.Uri.joinPath(folder.uri, normalized);
  }
  return vscode.Uri.file(resolveInsideRootSync(folder.uri.fsPath, relative));
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
