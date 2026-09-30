import * as vscode from "vscode";
import * as path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

/** The folder the current RPC request is for (each socket serves one folder). */
const requestRoot = new AsyncLocalStorage<string>();

/** Run a handler with `workspaceFolder()` bound to the request's folder. */
export function withRequestRoot<T>(root: string, run: () => Promise<T>): Promise<T> {
  return requestRoot.run(root, run);
}

/**
 * The workspace folder a request targets: the one its socket serves in a
 * multi-root workspace, otherwise the first folder.
 */
export function workspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const root = requestRoot.getStore();
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
  const rel = path.relative(root, fsPath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export function relativePath(fsPath: string): string {
  const root = workspaceFolder()?.uri.fsPath;
  if (!root) return fsPath;
  return path.relative(root, fsPath).replace(/\\/g, "/") || fsPath;
}

/**
 * Resolve a model-supplied path inside `root`. Rejects absolute paths, NUL
 * bytes, `..` escapes and symlinks whose real target leaves the root (checked
 * on the nearest existing ancestor so not-yet-created files are covered too).
 */
export function resolveInsideRootSync(root: string, relative: string): string {
  if (relative.includes("\0")) throw new Error("Path contains invalid characters");
  if (path.isAbsolute(relative) || /^[a-zA-Z]:[\\/]/.test(relative)) {
    throw new Error("Path must be relative to the workspace folder");
  }
  const base = path.resolve(root);
  const full = path.resolve(base, relative);
  if (!isInside(base, full)) throw new Error("Path escapes the workspace folder");
  let probe = full;
  while (!existsSync(probe) && probe !== base) probe = path.dirname(probe);
  if (existsSync(probe)) {
    const realBase = realpathSync(base);
    const realProbe = realpathSync(probe);
    if (!isInside(realBase, realProbe)) throw new Error("Path escapes the workspace folder");
  }
  return full;
}

export async function resolveInsideRoot(root: string, relative: string): Promise<string> {
  return resolveInsideRootSync(root, relative);
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
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
