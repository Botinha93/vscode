import * as vscode from "vscode";
import { positionFromPayload, rangeFromPayload, resolveFileUri } from "./helpers";

const codeActionCache = new Map<string, vscode.CodeAction>();

function cacheAction(action: vscode.CodeAction): string {
  const id = crypto.randomUUID();
  codeActionCache.set(id, action);
  if (codeActionCache.size > 200) {
    const first = codeActionCache.keys().next().value;
    if (first) codeActionCache.delete(first);
  }
  return id;
}

export async function handleCodeActions(payload: Record<string, unknown>): Promise<unknown> {
  const uri = resolveFileUri(String(payload.path ?? ""));
  const range = rangeFromPayload(payload);
  const only = payload.only ? (String(payload.only).split(",") as vscode.CodeActionKind[]) : undefined;
  const actions =
    (await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      uri,
      range,
      only ? { only } : undefined
    )) ?? [];
  return {
    actions: actions.map((action) => ({
      id: cacheAction(action),
      title: action.title,
      kind: action.kind?.value,
      isPreferred: action.isPreferred ?? false,
      disabled: action.disabled?.reason,
    })),
  };
}

export async function handleApplyCodeAction(payload: Record<string, unknown>): Promise<unknown> {
  const actionId = String(payload.actionId ?? "");
  const action = codeActionCache.get(actionId);
  if (!action) throw new Error(`Unknown code action id: ${actionId}`);
  if (action.edit) {
    const applied = await vscode.workspace.applyEdit(action.edit);
    if (!applied) throw new Error("Failed to apply code action edit");
  }
  if (action.command) {
    await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments ?? []));
  }
  codeActionCache.delete(actionId);
  return { applied: true, title: action.title };
}

export async function handleRenameSymbol(payload: Record<string, unknown>): Promise<unknown> {
  const uri = resolveFileUri(String(payload.path ?? ""));
  const position = positionFromPayload(payload);
  const newName = String(payload.newName ?? "");
  if (!newName) throw new Error("newName is required");
  const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
    "vscode.executeDocumentRenameProvider",
    uri,
    position,
    newName
  );
  if (!edit) throw new Error("Rename provider returned no edit");
  const applied = await vscode.workspace.applyEdit(edit);
  return { applied, newName };
}

export async function handleFormatDocument(payload: Record<string, unknown>): Promise<unknown> {
  const filePath = String(payload.path ?? "");
  const uri = resolveFileUri(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
  await vscode.commands.executeCommand("editor.action.formatDocument");
  return { path: filePath, formatted: true, isDirty: editor.document.isDirty };
}

export async function handleFormatRange(payload: Record<string, unknown>): Promise<unknown> {
  const filePath = String(payload.path ?? "");
  const uri = resolveFileUri(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
  const range = rangeFromPayload(payload);
  editor.selection = new vscode.Selection(range.start, range.end);
  await vscode.commands.executeCommand("editor.action.formatSelection");
  return { path: filePath, formatted: true, isDirty: editor.document.isDirty };
}
