import * as vscode from "vscode";
import { relativePath, resolveFileUri, rangeToJson } from "./helpers";
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
 * Build the WorkspaceEdit. When `meta` is provided, every entry is tagged with
 * `needsConfirmation` so `vscode.workspace.applyEdit` opens the native
 * refactor-preview (multi-file diff + per-change checkboxes). The granular
 * `replace/createFile/...` forms are required because `edit.set` cannot carry
 * per-entry metadata.
 */
function buildWorkspaceEdit(
  payload: Record<string, unknown>,
  meta?: vscode.WorkspaceEditEntryMetadata,
): vscode.WorkspaceEdit {
  const edit = new vscode.WorkspaceEdit();
  const addEdits = (uri: vscode.Uri, edits: TextEditPayload[]): void => {
    for (const e of edits) edit.replace(uri, rangeFromEditPayload(e), e.newText, meta);
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
      } else if (change.kind === "create") {
        const uri = resolveFileUri(String(change.path ?? ""));
        const options = change.options as { overwrite?: boolean; ignoreIfExists?: boolean } | undefined;
        edit.createFile(uri, options, meta);
      } else if (change.kind === "delete") {
        const uri = resolveFileUri(String(change.path ?? ""));
        const options = change.options as { recursive?: boolean; ignoreIfNotExists?: boolean } | undefined;
        edit.deleteFile(uri, options, meta);
      } else if (change.textEdits) {
        addEdits(resolveFileUri(String(change.path ?? "")), change.textEdits as TextEditPayload[]);
      }
    }
  }
  return edit;
}

function changedFilesFromPayload(payload: Record<string, unknown>): string[] {
  const files = new Set<string>();
  const changes = payload.changes as Record<string, unknown> | undefined;
  if (changes) for (const p of Object.keys(changes)) files.add(p);
  const documentChanges = payload.documentChanges as Array<Record<string, unknown>> | undefined;
  if (documentChanges) {
    for (const change of documentChanges) {
      for (const key of ["path", "oldPath", "newPath"]) {
        const v = change[key];
        if (typeof v === "string" && v) files.add(v);
      }
    }
  }
  return [...files].map(relativePath);
}

export async function handleApplyWorkspaceEdit(payload: Record<string, unknown>): Promise<unknown> {
  const confirm = shouldConfirmEdit(payload, readSettings().confirmEdits);
  const meta: vscode.WorkspaceEditEntryMetadata | undefined = confirm
    ? { needsConfirmation: true, label: "LiberIDE agent edit" }
    : undefined;
  const workspaceEdit = buildWorkspaceEdit(payload, meta);
  const applied = await vscode.workspace.applyEdit(workspaceEdit);
  return { applied, changedFiles: changedFilesFromPayload(payload) };
}

export { rangeToJson };
