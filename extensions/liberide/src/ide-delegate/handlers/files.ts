import * as vscode from "vscode";
import * as path from "node:path";

function relativePath(fsPath: string): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return fsPath;
  return path.relative(root, fsPath).replace(/\\/g, "/") || fsPath;
}

export async function handleFindFiles(payload: Record<string, unknown>): Promise<unknown> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("No workspace folder open");
  const pattern = String(payload.pattern ?? "**/*");
  const maxResults = Number(payload.maxResults ?? 200);
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, pattern),
    "**/{node_modules,.git,dist,build,out}/**",
    maxResults
  );
  return {
    files: uris.map((uri) => relativePath(uri.fsPath)),
    count: uris.length,
  };
}
