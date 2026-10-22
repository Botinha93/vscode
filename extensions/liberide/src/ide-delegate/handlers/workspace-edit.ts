import * as vscode from "vscode";
import { relativePath, resolveFileUri, rangeToJson } from "./helpers";
import { applyTrackedEdit, type TouchedResource } from "./edit-apply";
import { readSettings } from "../../settings";
import { shouldConfirmEdit } from "./edit-confirm";

type TextEditPayload = {
  range: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
  newText: string;
};

function rangeFromEditPayload(edit: TextEditPayload): vscode.Range {
  return new vscode.Range(
    edit.range.startLine - 1,
    edit.range.startCharacter,
    edit.range.endLine - 1,
    edit.range.endCharacter
  );
}

/**
 * Build the edit and the list of resources it touches (for validation,
 * snapshots and saving). When `meta` is provided, every entry is tagged with
 * `needsConfirmation` so `vscode.workspace.applyEdit` opens the native
 * refactor-preview (multi-file diff + per-change checkboxes). The granular
 * `replace/createFile/...` forms are required because `edit.set` cannot carry
 * per-entry metadata.
 */
export function buildWorkspaceEdit(
  payload: Record<string, unknown>,
  meta?: vscode.WorkspaceEditEntryMetadata,
): { edit: vscode.WorkspaceEdit; touched: TouchedResource[] } {
  const edit = new vscode.WorkspaceEdit();
  const touched: TouchedResource[] = [];
  const addEdits = (uri: vscode.Uri, edits: TextEditPayload[]): void => {
    for (const e of edits) edit.replace(uri, rangeFromEditPayload(e), e.newText, meta);
    touched.push({ uri, operation: "edit" });
  };
  const changes = payload.changes as Record<string, TextEditPayload[]> | undefined;
  if (changes) {
    for (const [filePath, edits] of Object.entries(changes)) addEdits(resolveFileUri(filePath), edits);
  }
  const documentChanges = payload.documentChanges as Array<Record<string, unknown>> | undefined;
  if (documentChanges) {
    for (const change of documentChanges) {
      if (change.kind === "rename") {
        const oldUri = resolveFileUri(String(change.oldPath ?? ""));
        const newUri = resolveFileUri(String(change.newPath ?? ""));
        const options = change.options as { overwrite?: boolean; ignoreIfExists?: boolean } | undefined;
        edit.renameFile(oldUri, newUri, options, meta);
        touched.push({ uri: oldUri, operation: "rename" }, { uri: newUri, operation: "rename" });
      } else if (change.kind === "create") {
        const uri = resolveFileUri(String(change.path ?? ""));
        const options = change.options as { overwrite?: boolean; ignoreIfExists?: boolean } | undefined;
        edit.createFile(uri, options, meta);
        touched.push({ uri, operation: "create" });
      } else if (change.kind === "delete") {
        const uri = resolveFileUri(String(change.path ?? ""));
        const options = change.options as { recursive?: boolean; ignoreIfNotExists?: boolean } | undefined;
        edit.deleteFile(uri, options, meta);
        touched.push({ uri, operation: "delete" });
      } else if (change.textEdits) {
        addEdits(resolveFileUri(String(change.path ?? "")), change.textEdits as TextEditPayload[]);
      }
    }
  }
  return { edit, touched };
}

export async function handleApplyWorkspaceEdit(payload: Record<string, unknown>): Promise<unknown> {
  // Opt-in diff preview (liberide.confirmEdits): the native refactor preview lets the user accept or drop changes.
  const confirm = shouldConfirmEdit(payload, readSettings().confirmEdits);
  const meta: vscode.WorkspaceEditEntryMetadata | undefined = confirm
    ? { needsConfirmation: true, label: "LiberIDE agent edit" }
    : undefined;
  const { edit, touched } = buildWorkspaceEdit(payload, meta);
  const { applied, saved } = await applyTrackedEdit(edit, touched);
  const changedFiles = touched.filter((resource) => resource.uri.scheme === "file").map((resource) => relativePath(resource.uri.fsPath));
  return { applied, changedFiles: [...new Set(changedFiles)], saved, ...(confirm ? { previewed: true } : {}) };
}

export { rangeToJson };
