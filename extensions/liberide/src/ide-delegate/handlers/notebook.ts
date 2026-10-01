import * as vscode from "vscode";
import { relativePath, resolveFileUri } from "./helpers";
import { assertEditableResource } from "./edit-apply";
import { snapshotBeforeChange } from "./fs";
import { assertNoRedactionPlaceholders } from "./redaction";

function cellToJson(cell: vscode.NotebookCell): Record<string, unknown> {
  return {
    index: cell.index,
    kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
    languageId: cell.document.languageId,
    value: cell.document.getText(),
    metadata: cell.metadata,
  };
}

export async function handleNotebookRead(payload: Record<string, unknown>): Promise<unknown> {
  const filePath = String(payload.path ?? "");
  const uri = resolveFileUri(filePath);
  const notebook = await vscode.workspace.openNotebookDocument(uri);
  return {
    path: filePath,
    cellCount: notebook.cellCount,
    cells: [...notebook.getCells()].map(cellToJson),
  };
}

export async function handleNotebookEdit(payload: Record<string, unknown>): Promise<unknown> {
  const filePath = String(payload.path ?? "");
  const uri = resolveFileUri(filePath);
  assertEditableResource({ uri, operation: "edit" });
  const notebook = await vscode.workspace.openNotebookDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  const cellIndex = Number(payload.cellIndex ?? 0);
  const newText = payload.newText != null ? String(payload.newText) : undefined;
  const cellKind =
    payload.kind === "markdown" ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;

  if (payload.operation === "insert") {
    assertNoRedactionPlaceholders("", newText ?? "", filePath);
    const cellData = new vscode.NotebookCellData(cellKind, newText ?? "", String(payload.languageId ?? "python"));
    edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(cellIndex, [cellData])]);
  } else if (payload.operation === "delete") {
    edit.set(notebook.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(cellIndex, cellIndex + 1))]);
  } else if (payload.operation === "replace" && newText != null) {
    const cell = notebook.cellAt(cellIndex);
    assertNoRedactionPlaceholders(cell.document.getText(), newText, filePath);
    edit.set(notebook.uri, [
      vscode.NotebookEdit.updateCellMetadata(cellIndex, cell.metadata),
      vscode.NotebookEdit.replaceCells(
        new vscode.NotebookRange(cellIndex, cellIndex + 1),
        [new vscode.NotebookCellData(cell.kind, newText, cell.document.languageId)]
      ),
    ]);
  } else {
    throw new Error("notebook edit requires operation: insert | delete | replace");
  }
  // Snapshot for Undo, then save so the file on disk matches the notebook.
  if (uri.scheme === "file") await snapshotBeforeChange(uri.fsPath);
  const applied = await vscode.workspace.applyEdit(edit);
  const saved = applied && notebook.isDirty ? await notebook.save() : false;
  return { path: filePath, applied, operation: payload.operation, saved };
}

export async function handleNotebookExecute(payload: Record<string, unknown>): Promise<unknown> {
  const filePath = String(payload.path ?? "");
  const uri = resolveFileUri(filePath);
  const notebook = await vscode.workspace.openNotebookDocument(uri);
  // The execute commands act on a notebook editor: show this one, then pass its uri.
  await vscode.window.showNotebookDocument(notebook, { preserveFocus: true, preview: false });
  const cellIndex = payload.cellIndex != null ? Number(payload.cellIndex) : undefined;
  if (cellIndex != null) {
    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= notebook.cellCount) {
      throw new Error(`cellIndex ${String(payload.cellIndex)} is out of range (0..${notebook.cellCount - 1})`);
    }
    await vscode.commands.executeCommand("notebook.cell.execute", { ranges: [{ start: cellIndex, end: cellIndex + 1 }], document: notebook.uri });
  } else {
    await vscode.commands.executeCommand("notebook.execute", notebook.uri);
  }
  return { path: relativePath(uri.fsPath), executed: true, cellIndex: cellIndex ?? null };
}
