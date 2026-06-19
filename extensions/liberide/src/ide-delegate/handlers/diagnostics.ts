import * as vscode from "vscode";
import { relativePath, workspaceFolder } from "./helpers";
import { resolveContainedRelativePath } from "./path-containment";

export async function handleDiagnostics(payload: Record<string, unknown>): Promise<unknown> {
  const root = workspaceFolder()?.uri.fsPath;
  const filterPaths = Array.isArray(payload.filePaths)
    ? payload.filePaths.map(String).map((p) => {
        if (root) resolveContainedRelativePath(root, p);
        return p;
      })
    : undefined;
  const all = vscode.languages.getDiagnostics();
  const entries: Array<{
    path: string;
    diagnostics: Array<{ message: string; severity: string; line: number; character: number; source?: string; code?: string | number }>;
  }> = [];

  for (const [uri, diags] of all) {
    if (uri.scheme !== "file") continue;
    const rel = relativePath(uri.fsPath);
    if (filterPaths?.length && !filterPaths.some((p) => rel.includes(p) || p.includes(rel))) continue;
    entries.push({
      path: rel,
      diagnostics: diags.map((d) => ({
        message: d.message,
        severity: vscode.DiagnosticSeverity[d.severity] ?? String(d.severity),
        line: d.range.start.line + 1,
        character: d.range.start.character,
        source: d.source,
        code: typeof d.code === "object" ? d.code.value : d.code,
      })),
    });
  }
  return { files: entries, totalDiagnostics: entries.reduce((n, f) => n + f.diagnostics.length, 0) };
}
