import * as vscode from "vscode";

export interface ChatllmSettings {
  modelSelection: "auto" | "manual";
  chatMode: "normal" | "agent";
  useRag: boolean;
  toolsEnabled: boolean;
  systemPrompt: string;
  copilotUiEnabled: boolean;
  copilotModelsEnabled: boolean;
}

const SECTION = "chatllm";

export function readSettings(): ChatllmSettings {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    modelSelection: cfg.get<"auto" | "manual">("modelSelection") ?? "manual",
    chatMode: cfg.get<"normal" | "agent">("chatMode") ?? "normal",
    useRag: cfg.get<boolean>("useRag") ?? false,
    toolsEnabled: cfg.get<boolean>("toolsEnabled") ?? true,
    systemPrompt: cfg.get<string>("systemPrompt") ?? "",
    copilotUiEnabled: cfg.get<boolean>("copilot.enabled") ?? false,
    copilotModelsEnabled: cfg.get<boolean>("copilot.modelsEnabled") ?? true,
  };
}

const FLAT_TO_DOTTED: Partial<Record<keyof ChatllmSettings, string>> = {
  copilotUiEnabled: "copilot.enabled",
  copilotModelsEnabled: "copilot.modelsEnabled",
};

export async function writeSetting<K extends keyof ChatllmSettings>(key: K, value: ChatllmSettings[K]): Promise<void> {
  const dotted = FLAT_TO_DOTTED[key] ?? (key as string);
  await vscode.workspace
    .getConfiguration(SECTION)
    .update(dotted, value, vscode.ConfigurationTarget.Global);
}

export function onSettingsChange(listener: (settings: ChatllmSettings) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(SECTION)) listener(readSettings());
  });
}
