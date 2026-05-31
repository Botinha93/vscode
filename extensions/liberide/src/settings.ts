import * as vscode from "vscode";

export interface LiberideSettings {
  modelSelection: "auto" | "manual";
  chatMode: "normal" | "agent";
  useRag: boolean;
  toolsEnabled: boolean;
  systemPrompt: string;
  copilotUiEnabled: boolean;
  copilotModelsEnabled: boolean;
  /** Global default callable agents applied to new conversations. */
  defaultAllowedAgentIds: string[];
}

const SECTION = "liberide";

export function readSettings(): LiberideSettings {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    modelSelection: cfg.get<"auto" | "manual">("modelSelection") ?? "manual",
    chatMode: "agent",
    useRag: cfg.get<boolean>("useRag") ?? false,
    toolsEnabled: true,
    systemPrompt: cfg.get<string>("systemPrompt") ?? "",
    copilotUiEnabled: cfg.get<boolean>("copilot.enabled") ?? false,
    copilotModelsEnabled: cfg.get<boolean>("copilot.modelsEnabled") ?? true,
    defaultAllowedAgentIds: cfg.get<string[]>("defaultAllowedAgentIds") ?? [],
  };
}

const FLAT_TO_DOTTED: Partial<Record<keyof LiberideSettings, string>> = {
  copilotUiEnabled: "copilot.enabled",
  copilotModelsEnabled: "copilot.modelsEnabled",
};

export async function writeSetting<K extends keyof LiberideSettings>(key: K, value: LiberideSettings[K]): Promise<void> {
  const dotted = FLAT_TO_DOTTED[key] ?? (key as string);
  await vscode.workspace
    .getConfiguration(SECTION)
    .update(dotted, value, vscode.ConfigurationTarget.Global);
}

export function onSettingsChange(listener: (settings: LiberideSettings) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(SECTION)) listener(readSettings());
  });
}
