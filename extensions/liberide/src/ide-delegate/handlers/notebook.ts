import * as vscode from "vscode";
import { relativePath, resolveFileUri } from "./helpers";

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
  const notebook = await vscode.workspace.openNotebookDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  const cellIndex = Number(payload.cellIndex ?? 0);
  const newText = payload.newText != null ? String(payload.newText) : undefined;
  const cellKind =
    payload.kind === "markdown" ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;

  if (payload.operation === "insert") {
    const cellData = new vscode.NotebookCellData(cellKind, newText ?? "", String(payload.languageId ?? "python"));
    edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(cellIndex, [cellData])]);
  } else if (payload.operation === "delete") {
    edit.set(notebook.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(cellIndex, cellIndex + 1))]);
  } else if (payload.operation === "replace" && newText != null) {
    const cell = notebook.cellAt(cellIndex);
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
  const applied = await vscode.workspace.applyEdit(edit);
  return { path: filePath, applied, operation: payload.operation };
}

export async function handleNotebookExecute(payload: Record<string, unknown>): Promise<unknown> {
  const filePath = String(payload.path ?? "");
  const uri = resolveFileUri(filePath);
  await vscode.commands.executeCommand("notebook.execute");
  const cellIndex = payload.cellIndex != null ? Number(payload.cellIndex) : undefined;
  if (cellIndex != null) {
    await vscode.commands.executeCommand("notebook.cell.execute", { uri, cellIndex });
  }
  return { path: relativePath(uri.fsPath), executed: true, cellIndex: cellIndex ?? null };
}
