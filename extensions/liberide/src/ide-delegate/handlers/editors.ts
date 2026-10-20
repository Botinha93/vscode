import * as vscode from "vscode";
import { isInWorkspace, relativePath } from "./helpers";
import { redactIfSecret } from "./redaction";

/** A document of this request's workspace folder (not another project, not ~/.env). */
function inWorkspace(uri: vscode.Uri): boolean {
  return uri.scheme === "file" && isInWorkspace(uri.fsPath);
}

/** A tab's path when it belongs to the workspace; other tabs are listed by label only. */
function tabPath(uri: vscode.Uri | undefined, label: string): string {
  return uri && inWorkspace(uri) ? relativePath(uri.fsPath) : label;
}

export async function handleOpenEditors(): Promise<unknown> {
  const groups = vscode.window.tabGroups.all.map((group) => ({
    activeTab: group.activeTab
      ? {
          label: group.activeTab.label,
          input: tabPath(group.activeTab.input instanceof vscode.TabInputText ? group.activeTab.input.uri : undefined, group.activeTab.label),
        }
      : null,
    tabs: group.tabs.map((tab) => {
      const input = tab.input;
      const filePath = tabPath(
        input instanceof vscode.TabInputText
          ? input.uri
          : input instanceof vscode.TabInputTextDiff
            ? input.modified
            : undefined,
        tab.label,
      );
      return {
        label: tab.label,
        path: filePath,
        isDirty: tab.isDirty,
        isPreview: tab.isPreview,
      };
    }),
  }));

  const active = vscode.window.activeTextEditor;
  return {
    tabGroups: groups,
    activeEditor: active && inWorkspace(active.document.uri)
      ? {
          path: relativePath(active.document.uri.fsPath),
          languageId: active.document.languageId,
          isDirty: active.document.isDirty,
          viewColumn: active.viewColumn,
          line: active.selection.active.line + 1,
          character: active.selection.active.character,
        }
      : null,
  };
}

export async function handleDirtyBuffers(payload: Record<string, unknown>): Promise<unknown> {
  const maxChars = Number(payload.maxChars ?? 500_000);
  const buffers: Array<{ path: string; languageId: string; content: string; truncated: boolean; redacted?: boolean }> = [];
  for (const doc of vscode.workspace.textDocuments) {
    if (!doc.isDirty) continue;
    // Only this workspace's files: an unsaved ~/.env or another project's
    // buffer is not the model's business.
    if (!inWorkspace(doc.uri)) continue;
    const { text, redacted } = redactIfSecret(doc.uri.fsPath, doc.getText());
    let content = text;
    let truncated = false;
    if (content.length > maxChars) {
      content = content.slice(0, maxChars);
      truncated = true;
    }
    buffers.push({
      path: relativePath(doc.uri.fsPath),
      languageId: doc.languageId,
      content,
      truncated,
      ...(redacted ? { redacted } : {}),
    });
  }
  return { buffers, count: buffers.length };
}

export async function handleActiveSelection(): Promise<unknown> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return { available: false };
  // Same scope as dirty buffers: a selection in another project is not shared.
  if (!inWorkspace(editor.document.uri)) return { available: false, reason: "The active editor is outside this workspace folder" };
  const sel = editor.selection;
  const { text, redacted } = redactIfSecret(editor.document.uri.fsPath, editor.document.getText(sel));
  return {
    path: relativePath(editor.document.uri.fsPath),
    text,
    ...(redacted ? { redacted } : {}),
    startLine: sel.start.line + 1,
    startCharacter: sel.start.character,
    endLine: sel.end.line + 1,
    endCharacter: sel.end.character,
    isEmpty: sel.isEmpty,
  };
}
