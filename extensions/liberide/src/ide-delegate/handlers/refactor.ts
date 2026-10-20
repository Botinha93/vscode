import * as vscode from "vscode";
import { positionFromPayload, rangeFromPayload, relativePath, resolveFileUri } from "./helpers";
import { applyTrackedEdit, saveDocuments, touchedByEdit } from "./edit-apply";
import { countRedactionPlaceholders } from "./redaction";

/** Lazy code actions only carry `edit`/`command` once resolved; resolve this many per request. */
const CODE_ACTION_RESOLVE_COUNT = 50;

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
  // The command takes one kind string; several kinds are filtered after.
  const kinds = payload.only ? String(payload.only).split(",").map((kind) => kind.trim()).filter(Boolean) : [];
  const provided =
    (await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      uri,
      range,
      kinds.length === 1 ? kinds[0] : undefined,
      CODE_ACTION_RESOLVE_COUNT
    )) ?? [];
  const actions = kinds.length > 1
    ? provided.filter((action) => kinds.some((kind) => action.kind?.value === kind || action.kind?.value.startsWith(`${kind}.`)))
    : provided;
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
  if (action.disabled) throw new Error(`Code action '${action.title}' is disabled: ${action.disabled.reason}`);
  if (!action.edit && !action.command) {
    throw new Error(`Code action '${action.title}' has nothing to apply (no edit or command after resolving)`);
  }
  const touched = action.edit ? touchedByEdit(action.edit) : [];
  if (action.edit) {
    const { applied } = await applyTrackedEdit(action.edit, touched);
    if (!applied) throw new Error("Failed to apply code action edit");
  }
  if (action.command) {
    await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments ?? []));
    // A command may edit buffers too; persist what is dirty among the touched files.
    await saveDocuments(touched.map((resource) => resource.uri));
  }
  codeActionCache.delete(actionId);
  return { applied: true, title: action.title, changedFiles: touched.filter((r) => r.uri.scheme === "file").map((r) => relativePath(r.uri.fsPath)) };
}

export async function handleRenameSymbol(payload: Record<string, unknown>): Promise<unknown> {
  const uri = resolveFileUri(String(payload.path ?? ""));
  const position = positionFromPayload(payload);
  const newName = String(payload.newName ?? "");
  if (!newName) throw new Error("newName is required");
  if (countRedactionPlaceholders(newName) > 0) throw new Error("newName contains a [REDACTED] placeholder");
  const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
    "vscode.executeDocumentRenameProvider",
    uri,
    position,
    newName
  );
  if (!edit) throw new Error("Rename provider returned no edit");
  const touched = touchedByEdit(edit);
  const { applied, saved } = await applyTrackedEdit(edit, touched);
  return { applied, newName, changedFiles: touched.filter((r) => r.uri.scheme === "file").map((r) => relativePath(r.uri.fsPath)), saved };
}

function formattingOptions(uri: vscode.Uri): vscode.FormattingOptions {
  const config = vscode.workspace.getConfiguration("editor", uri);
  return { tabSize: Number(config.get("tabSize", 4)), insertSpaces: config.get<boolean>("insertSpaces") !== false };
}

/** Apply formatter edits through the tracked path (snapshot, save) instead of the focused editor. */
async function applyFormatEdits(filePath: string, uri: vscode.Uri, edits: vscode.TextEdit[] | undefined): Promise<unknown> {
  if (!edits?.length) return { path: filePath, formatted: false, reason: "No formatter changes (or no formatter for this file)" };
  const edit = new vscode.WorkspaceEdit();
  edit.set(uri, edits);
  const { applied, saved } = await applyTrackedEdit(edit, [{ uri, operation: "edit" }]);
  return { path: filePath, formatted: applied, edits: edits.length, saved: saved.length > 0 };
}

export async function handleFormatDocument(payload: Record<string, unknown>): Promise<unknown> {
  const filePath = String(payload.path ?? "");
  const uri = resolveFileUri(filePath);
  await vscode.workspace.openTextDocument(uri);
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    "vscode.executeFormatDocumentProvider",
    uri,
    formattingOptions(uri)
  );
  return applyFormatEdits(filePath, uri, edits);
}

export async function handleFormatRange(payload: Record<string, unknown>): Promise<unknown> {
  const filePath = String(payload.path ?? "");
  const uri = resolveFileUri(filePath);
  await vscode.workspace.openTextDocument(uri);
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    "vscode.executeFormatRangeProvider",
    uri,
    rangeFromPayload(payload),
    formattingOptions(uri)
  );
  return applyFormatEdits(filePath, uri, edits);
}
