import * as vscode from "vscode";
import { relativePath, workspaceFolder } from "./helpers";
import { assertContainedGlobPattern } from "./path-containment";

export async function handleFindFiles(payload: Record<string, unknown>): Promise<unknown> {
  const folder = workspaceFolder();
  if (!folder) throw new Error("No workspace folder open");
  const pattern = assertContainedGlobPattern(String(payload.pattern ?? "**/*"));
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
