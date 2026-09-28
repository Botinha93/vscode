import type { ConfiguredModel, ConfiguredProvider, ModelFeature, Provider } from "./types";

export const PROVIDER_LABELS: Record<ConfiguredProvider, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  google: "Google",
  anthropic: "Anthropic",
  copilot: "GitHub Copilot",
  moonshot: "Moonshot Kimi",
  zai: "Z.AI",
  qwen: "Qwen / DashScope",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  xiaomi: "Xiaomi MiMo",
  ollama: "Ollama",
  "ollama-internal": "Ollama (Internal)",
  llamacpp: "llama.cpp",
  lmstudio: "LM Studio",
  custom: "Custom",
};

export function providerLabel(provider: ConfiguredProvider): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * Provider as sent to the chat API. The backend treats "ollama-internal"
 * as the same wire provider ("ollama") with an internal flag.
 */
export function toWireProvider(provider: ConfiguredProvider): Provider {
  return provider === "ollama-internal" ? "ollama" : provider;
}

/**
 * Whether a configured model can serve chat. The backend's resolved profile is
 * authoritative; legacy `capabilities` are unreliable (every model claims
 * "chat"). Models without a profile (older servers) are kept.
 */
export function supportsTextGeneration(model: ConfiguredModel): boolean {
  const value = model.profile?.operations?.["text-generation"]?.value;
  return value === undefined || value === "supported";
}

const PROFILE_FEATURE_BADGES: ReadonlyArray<[ModelFeature, string]> = [
  ["tool-calling", "tools"],
  ["image-input", "vision"],
  ["reasoning", "reasoning"],
];

/** Short capability badges for pickers, from the profile when present, else legacy capabilities. */
export function modelCapabilityBadges(model: ConfiguredModel): string[] {
  const features = model.profile?.features;
  if (features) {
    return PROFILE_FEATURE_BADGES.filter(([feature]) => features[feature]?.value === "supported").map(([, badge]) => badge);
  }
  return [...(model.capabilities ?? [])];
}

export interface ModelGroup {
  provider: ConfiguredProvider;
  label: string;
  models: ConfiguredModel[];
}

export function groupConfiguredModels(models: readonly ConfiguredModel[]): ModelGroup[] {
  const map = new Map<ConfiguredProvider, ConfiguredModel[]>();
  for (const m of models) {
    if (!map.has(m.provider)) map.set(m.provider, []);
    map.get(m.provider)!.push(m);
  }
  return Array.from(map.entries())
    .map(([provider, group]) => ({
      provider,
      label: providerLabel(provider),
      models: [...group].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function findConfiguredModel(
  models: readonly ConfiguredModel[],
  provider: ConfiguredProvider | undefined,
  modelId: string | undefined,
): ConfiguredModel | undefined {
  if (!provider || !modelId) return undefined;
  return models.find((m) => m.provider === provider && m.modelId === modelId);
}

export function defaultEnabledModel(models: readonly ConfiguredModel[]): ConfiguredModel | undefined {
  return models.find((m) => m.enabled && m.apiKeyConfigured) ?? models.find((m) => m.enabled) ?? models[0];
}

export function describeModelLabel(
  models: readonly ConfiguredModel[],
  provider: ConfiguredProvider | undefined,
  modelId: string | undefined,
): string {
  if (!provider || !modelId) return "No model";
  const m = findConfiguredModel(models, provider, modelId);
  if (m) return m.displayName;
  return `${providerLabel(provider)} \u00b7 ${modelId}`;
}
