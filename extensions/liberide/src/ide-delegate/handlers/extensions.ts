import * as vscode from "vscode";

export async function handleExtensionsList(): Promise<unknown> {
  return {
    extensions: vscode.extensions.all.map((ext) => ({
      id: ext.id,
      version: ext.packageJSON.version,
      isActive: ext.isActive,
      name: ext.packageJSON.name,
      displayName: ext.packageJSON.displayName,
      publisher: ext.packageJSON.publisher,
    })),
    count: vscode.extensions.all.length,
  };
}
