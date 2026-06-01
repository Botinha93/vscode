import * as vscode from "vscode";
import { relativePath, resolveFileUri, rangeToJson } from "./helpers";

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

function buildWorkspaceEdit(payload: Record<string, unknown>): vscode.WorkspaceEdit {
  const edit = new vscode.WorkspaceEdit();
  const changes = payload.changes as Record<string, TextEditPayload[]> | undefined;
  if (changes) {
    for (const [filePath, edits] of Object.entries(changes)) {
      const uri = resolveFileUri(filePath);
      edit.set(uri, edits.map((e) => new vscode.TextEdit(rangeFromEditPayload(e), e.newText)));
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
      } else if (change.kind === "create") {
        const uri = resolveFileUri(String(change.path ?? ""));
        const options = change.options as { overwrite?: boolean; ignoreIfExists?: boolean } | undefined;
        edit.createFile(uri, options);
      } else if (change.kind === "delete") {
        const uri = resolveFileUri(String(change.path ?? ""));
        const options = change.options as { recursive?: boolean; ignoreIfNotExists?: boolean } | undefined;
        edit.deleteFile(uri, options);
      } else if (change.textEdits) {
        const uri = resolveFileUri(String(change.path ?? ""));
        const edits = change.textEdits as TextEditPayload[];
        edit.set(uri, edits.map((e) => new vscode.TextEdit(rangeFromEditPayload(e), e.newText)));
      }
    }
  }
  return edit;
}

export async function handleApplyWorkspaceEdit(payload: Record<string, unknown>): Promise<unknown> {
  const workspaceEdit = buildWorkspaceEdit(payload);
  const applied = await vscode.workspace.applyEdit(workspaceEdit);
  const changedFiles: string[] = [];
  const changes = payload.changes as Record<string, TextEditPayload[]> | undefined;
  if (changes) changedFiles.push(...Object.keys(changes));
  return { applied, changedFiles: [...new Set(changedFiles.map(relativePath))] };
}

export { rangeToJson };
