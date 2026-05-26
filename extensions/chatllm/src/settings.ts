import * as vscode from "vscode";
import type { ChatRequest, Provider } from "./chat/types";

export interface ChatllmSettings {
  provider: Provider;
  model: string;
  modelSelection: "auto" | "manual";
  chatMode: "normal" | "agent";
  useRag: boolean;
  toolsEnabled: boolean;
  maxAgentSpawns: number;
  agentIds: string[];
  mcpServerIds: string[];
  skillIds: string[];
  documentIds: string[];
  systemPrompt: string;
  copilotEnabled: boolean;
}

const SECTION = "chatllm";

export function readSettings(): ChatllmSettings {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    provider: cfg.get<Provider>("provider") ?? "openai",
    model: cfg.get<string>("model") ?? "gpt-4o-mini",
    modelSelection: cfg.get<"auto" | "manual">("modelSelection") ?? "manual",
    chatMode: cfg.get<"normal" | "agent">("chatMode") ?? "normal",
    useRag: cfg.get<boolean>("useRag") ?? false,
    toolsEnabled: cfg.get<boolean>("toolsEnabled") ?? true,
    maxAgentSpawns: cfg.get<number>("maxAgentSpawns") ?? 3,
    agentIds: cfg.get<string[]>("agentIds") ?? [],
    mcpServerIds: cfg.get<string[]>("mcpServerIds") ?? [],
    skillIds: cfg.get<string[]>("skillIds") ?? [],
    documentIds: cfg.get<string[]>("documentIds") ?? [],
    systemPrompt: cfg.get<string>("systemPrompt") ?? "",
    copilotEnabled: cfg.get<boolean>("copilot.enabled") ?? false,
  };
}

const FLAT_TO_DOTTED: Partial<Record<keyof ChatllmSettings, string>> = {
  copilotEnabled: "copilot.enabled",
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

export function settingsToChatRequest(settings: ChatllmSettings, content: string, conversationId?: string): ChatRequest {
  return {
    conversationId,
    provider: settings.provider,
    model: settings.model,
    modelSelection: settings.modelSelection,
    chatMode: settings.chatMode,
    content,
    systemPrompt: settings.systemPrompt || undefined,
    skillIds: settings.skillIds,
    documentIds: settings.documentIds,
    useRag: settings.useRag,
    toolsEnabled: settings.toolsEnabled,
    mcpServerIds: settings.mcpServerIds,
    agentIds: settings.agentIds,
    maxAgentSpawns: settings.maxAgentSpawns,
  };
}
