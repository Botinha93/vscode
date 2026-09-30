import * as vscode from "vscode";
import { workspaceFolder } from "./helpers";

/**
 * Workspace-scoped targets only: user (global) settings apply to every
 * project and include security switches such as workspace trust.
 */
const TARGET_MAP: Record<string, vscode.ConfigurationTarget> = {
  workspace: vscode.ConfigurationTarget.Workspace,
  workspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder,
};

/** Settings the agent may never change, even in the workspace. */
const PROTECTED_SECTIONS = /^(security|liberide|extensions|http|terminal\.integrated\.(env|shell|profiles|automationProfile))/;

export async function handleConfigRead(payload: Record<string, unknown>): Promise<unknown> {
  const section = String(payload.section ?? "");
  const key = payload.key ? String(payload.key) : undefined;
  if (!section && !key) throw new Error("section or key is required; reading every setting is not supported");
  const folder = workspaceFolder();
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
  const target = TARGET_MAP[targetName];
  if (target === undefined) throw new Error(`Setting target '${targetName}' is not allowed; use 'workspace' or 'workspaceFolder'`);
  const fullKey = section ? `${section}.${key}` : key;
  if (!key || PROTECTED_SECTIONS.test(fullKey)) throw new Error(`Setting '${fullKey}' cannot be changed by the agent`);
  const folder = workspaceFolder();
  const config = folder
    ? vscode.workspace.getConfiguration(section || undefined, folder.uri)
    : vscode.workspace.getConfiguration(section || undefined);
  await config.update(key, value, target);
  return { section, key, target: targetName, updated: true };
}
