import * as vscode from "vscode";

const TARGET_MAP: Record<string, vscode.ConfigurationTarget> = {
  global: vscode.ConfigurationTarget.Global,
  workspace: vscode.ConfigurationTarget.Workspace,
  workspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder,
};

export async function handleConfigRead(payload: Record<string, unknown>): Promise<unknown> {
  const section = String(payload.section ?? "");
  const key = payload.key ? String(payload.key) : undefined;
  const folder = vscode.workspace.workspaceFolders?.[0];
  const config = folder
    ? vscode.workspace.getConfiguration(section || undefined, folder.uri)
    : vscode.workspace.getConfiguration(section || undefined);
  if (key) {
    const inspected = config.inspect(key);
    return {
      section,
      key,
      value: config.get(key),
      defaultValue: inspected?.defaultValue,
      globalValue: inspected?.globalValue,
      workspaceValue: inspected?.workspaceValue,
      workspaceFolderValue: inspected?.workspaceFolderValue,
    };
  }
  return { section, values: config };
}

export async function handleConfigWrite(payload: Record<string, unknown>): Promise<unknown> {
  const section = String(payload.section ?? "");
  const key = String(payload.key ?? "");
  const value = payload.value;
  const targetName = String(payload.target ?? "workspace");
  const target = TARGET_MAP[targetName] ?? vscode.ConfigurationTarget.Workspace;
  const folder = vscode.workspace.workspaceFolders?.[0];
  const config = folder
    ? vscode.workspace.getConfiguration(section || undefined, folder.uri)
    : vscode.workspace.getConfiguration(section || undefined);
  await config.update(key, value, target);
  return { section, key, target: targetName, updated: true };
}
