import * as vscode from "vscode";
import * as path from "node:path";

function relativePath(fsPath: string): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return fsPath;
  return path.relative(root, fsPath).replace(/\\/g, "/") || fsPath;
}

export async function handleOpenEditors(): Promise<unknown> {
  const groups = vscode.window.tabGroups.all.map((group) => ({
    activeTab: group.activeTab
      ? {
          label: group.activeTab.label,
          input: group.activeTab.input instanceof vscode.TabInputText
            ? relativePath(group.activeTab.input.uri.fsPath)
            : group.activeTab.label,
        }
      : null,
    tabs: group.tabs.map((tab) => {
      const input = tab.input;
      const filePath =
        input instanceof vscode.TabInputText
          ? relativePath(input.uri.fsPath)
          : input instanceof vscode.TabInputTextDiff
            ? relativePath(input.modified.fsPath)
            : tab.label;
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
    activeEditor: active
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
  const buffers: Array<{ path: string; languageId: string; content: string; truncated: boolean }> = [];
  for (const doc of vscode.workspace.textDocuments) {
    if (!doc.isDirty) continue;
    if (doc.uri.scheme !== "file") continue;
    let content = doc.getText();
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
    });
  }
  return { buffers, count: buffers.length };
}

export async function handleActiveSelection(): Promise<unknown> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return { available: false };
  const sel = editor.selection;
  const text = editor.document.getText(sel);
  return {
    path: relativePath(editor.document.uri.fsPath),
    text,
    startLine: sel.start.line + 1,
    startCharacter: sel.start.character,
    endLine: sel.end.line + 1,
    endCharacter: sel.end.character,
    isEmpty: sel.isEmpty,
  };
}
