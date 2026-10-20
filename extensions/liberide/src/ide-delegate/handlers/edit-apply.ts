import * as vscode from "vscode";
import * as path from "node:path";
import { isInWorkspace, relativePath, workspaceFolder } from "./helpers";
import { snapshotBeforeChange } from "./fs";
import { assertNoRedactionPlaceholders, countRedactionPlaceholders } from "./redaction";

/**
 * Shared path for every agent change made through a WorkspaceEdit (apply
 * workspace edit, rename, format, code actions, notebook edits):
 *  - refuse the workspace root and anything inside `.git`;
 *  - refuse `[REDACTED]` placeholders the agent copied from a redacted read;
 *  - snapshot each touched file first, so Undo restores it exactly;
 *  - save the touched documents afterwards, so the disk (which `vscode.fs.*`
 *    reads) matches the buffers and a later user save cannot overwrite the
 *    agent's next disk write with a stale buffer.
 */

export type EditOperation = "edit" | "create" | "delete" | "rename";

export interface TouchedResource {
  uri: vscode.Uri;
  operation: EditOperation;
}

function relativeToFolder(uri: vscode.Uri): string {
  const folder = workspaceFolder();
  if (!folder) throw new Error("No workspace folder open");
  if (uri.scheme === "file" && folder.uri.scheme === "file") {
    if (!isInWorkspace(uri.fsPath)) throw new Error(`Refusing to change a file outside the workspace folder: ${uri.fsPath}`);
    return path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
  }
  const rel = path.posix.relative(folder.uri.path, uri.path);
  if (uri.scheme !== folder.uri.scheme || rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel)) {
    throw new Error(`Refusing to change a file outside the workspace folder: ${uri.toString()}`);
  }
  return rel;
}

/** The root itself and `.git` internals are never edited, renamed, created or deleted by the agent. */
export function assertEditableResource(resource: TouchedResource): void {
  const rel = relativeToFolder(resource.uri);
  if (rel === "" || rel === ".") throw new Error(`Refusing to ${resource.operation} the workspace root`);
  if (rel.split("/")[0]?.toLowerCase() === ".git") throw new Error(`Refusing to ${resource.operation} inside .git: ${rel}`);
}

/** Every text edit's new text must not add `[REDACTED]` placeholders to the range it replaces. */
export async function guardRedactedText(uri: vscode.Uri, edits: ReadonlyArray<{ range: vscode.Range; newText: string }>): Promise<void> {
  if (!edits.some((edit) => countRedactionPlaceholders(edit.newText) > 0)) return;
  const doc = await vscode.workspace.openTextDocument(uri).then((d) => d, () => undefined);
  const label = uri.scheme === "file" ? relativePath(uri.fsPath) : uri.toString();
  for (const edit of edits) assertNoRedactionPlaceholders(doc?.getText(edit.range) ?? "", edit.newText, label);
}

/** The text edits a provider-built WorkspaceEdit carries, as touched resources. */
export function touchedByEdit(edit: vscode.WorkspaceEdit): TouchedResource[] {
  return edit.entries().map(([uri]) => ({ uri, operation: "edit" as const }));
}

/** Save the open, dirty documents among `uris`. Returns the saved paths. */
export async function saveDocuments(uris: Iterable<vscode.Uri>): Promise<string[]> {
  const saved: string[] = [];
  const seen = new Set<string>();
  for (const uri of uris) {
    const key = uri.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (doc?.isDirty && (await doc.save())) saved.push(uri.scheme === "file" ? relativePath(uri.fsPath) : key);
  }
  return saved;
}

/** Validate, snapshot, apply and save. Throws before applying anything when a resource is refused. */
export async function applyTrackedEdit(
  edit: vscode.WorkspaceEdit,
  touched: TouchedResource[],
): Promise<{ applied: boolean; saved: string[] }> {
  for (const resource of touched) assertEditableResource(resource);
  for (const [uri, edits] of edit.entries()) await guardRedactedText(uri, edits as vscode.TextEdit[]);
  for (const resource of touched) {
    if (resource.uri.scheme === "file") await snapshotBeforeChange(resource.uri.fsPath);
  }
  const applied = await vscode.workspace.applyEdit(edit);
  const saved = applied ? await saveDocuments(touched.map((resource) => resource.uri)) : [];
  return { applied, saved };
}
