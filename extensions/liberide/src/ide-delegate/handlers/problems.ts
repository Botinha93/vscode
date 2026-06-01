import * as vscode from "vscode";
import { relativePath } from "./helpers";

export async function handleProblemsByOwner(payload: Record<string, unknown>): Promise<unknown> {
  const filePaths = payload.filePaths as string[] | undefined;
  const filter = filePaths ? new Set(filePaths.map((p) => p.replace(/\\/g, "/"))) : undefined;
  const byOwner = new Map<string, Array<Record<string, unknown>>>();

  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file") continue;
    const path = relativePath(uri.fsPath);
    if (filter && !filter.has(path)) continue;
    for (const diag of diagnostics) {
      const owner = diag.source ?? "unknown";
      const list = byOwner.get(owner) ?? [];
      list.push({
        path,
        message: diag.message,
        severity: vscode.DiagnosticSeverity[diag.severity],
        code: typeof diag.code === "object" ? diag.code.value : diag.code,
        range: {
          startLine: diag.range.start.line + 1,
          startCharacter: diag.range.start.character,
          endLine: diag.range.end.line + 1,
          endCharacter: diag.range.end.character,
        },
      });
      byOwner.set(owner, list);
    }
  }

  return {
    owners: [...byOwner.entries()].map(([owner, problems]) => ({ owner, problems, count: problems.length })),
    totalProblems: [...byOwner.values()].reduce((sum, items) => sum + items.length, 0),
  };
}
