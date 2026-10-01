import * as vscode from "vscode";
import { relativePath, resolveFileUri, rangeToJson } from "./helpers";
import { applyTrackedEdit, type TouchedResource } from "./edit-apply";

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

/** Build the edit and the list of resources it touches (for validation, snapshots and saving). */
export function buildWorkspaceEdit(payload: Record<string, unknown>): { edit: vscode.WorkspaceEdit; touched: TouchedResource[] } {
  const edit = new vscode.WorkspaceEdit();
  const touched: TouchedResource[] = [];
  const changes = payload.changes as Record<string, TextEditPayload[]> | undefined;
  if (changes) {
    for (const [filePath, edits] of Object.entries(changes)) {
      const uri = resolveFileUri(filePath);
      edit.set(uri, edits.map((e) => new vscode.TextEdit(rangeFromEditPayload(e), e.newText)));
      touched.push({ uri, operation: "edit" });
    }
  }
  const documentChanges = payload.documentChanges as Array<Record<string, unknown>> | undefined;
  if (documentChanges) {
    for (const change of documentChanges) {
      if (change.kind === "rename") {
        const oldUri = resolveFileUri(String(change.oldPath ?? ""));
        const newUri = resolveFileUri(String(change.newPath ?? ""));
        const options = change.options as { overwrite?: boolean; ignoreIfExists?: boolean } | undefined;
        edit.renameFile(oldUri, newUri, options);
        touched.push({ uri: oldUri, operation: "rename" }, { uri: newUri, operation: "rename" });
      } else if (change.kind === "create") {
        const uri = resolveFileUri(String(change.path ?? ""));
        const options = change.options as { overwrite?: boolean; ignoreIfExists?: boolean } | undefined;
        edit.createFile(uri, options);
        touched.push({ uri, operation: "create" });
      } else if (change.kind === "delete") {
        const uri = resolveFileUri(String(change.path ?? ""));
        const options = change.options as { recursive?: boolean; ignoreIfNotExists?: boolean } | undefined;
        edit.deleteFile(uri, options);
        touched.push({ uri, operation: "delete" });
      } else if (change.textEdits) {
        const uri = resolveFileUri(String(change.path ?? ""));
        const edits = change.textEdits as TextEditPayload[];
        edit.set(uri, edits.map((e) => new vscode.TextEdit(rangeFromEditPayload(e), e.newText)));
        touched.push({ uri, operation: "edit" });
      }
    }
  }
  return { edit, touched };
}

export async function handleApplyWorkspaceEdit(payload: Record<string, unknown>): Promise<unknown> {
  const { edit, touched } = buildWorkspaceEdit(payload);
  const { applied, saved } = await applyTrackedEdit(edit, touched);
  const changedFiles = touched.filter((resource) => resource.uri.scheme === "file").map((resource) => relativePath(resource.uri.fsPath));
  return { applied, changedFiles: [...new Set(changedFiles)], saved };
}

export { rangeToJson };
