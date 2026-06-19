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
  /** When enabled, feature dispatch runs the swarm graph: independent, non-blocking tasks implemented in parallel, gated on hard blockers. */
  swarm: boolean;
  /** Isolation for parallel branches: `worktree` (one git worktree per branch, merged at the end) or `shared` working tree. */
  isolation: "worktree" | "shared";
  /** Gate agent file edits behind VS Code's refactor-preview: `off` (apply directly), `always`, or `multiFileAndDeletes`. */
  confirmEdits: "off" | "always" | "multiFileAndDeletes";
  /** When true, dispatch queues immediately without showing the plan-preview confirmation. */
  dispatchSkipPreview: boolean;
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
    swarm: cfg.get<boolean>("swarm") ?? false,
    isolation: cfg.get<"worktree" | "shared">("isolation") ?? "shared",
    confirmEdits: cfg.get<"off" | "always" | "multiFileAndDeletes">("confirmEdits") ?? "off",
    dispatchSkipPreview: cfg.get<boolean>("dispatch.skipPreview") ?? false,
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
