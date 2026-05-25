export type Provider = "openai" | "openrouter" | "google" | "ollama" | "llamacpp" | "lmstudio" | "custom";

export interface ChatRequest {
  conversationId?: string;
  provider: Provider;
  model: string;
  modelSelection?: "auto" | "manual";
  chatMode?: "normal" | "agent";
  content: string;
  systemPrompt?: string;
  skillIds: string[];
  documentIds: string[];
  useRag: boolean;
  toolsEnabled: boolean;
  mcpServerIds: string[];
  agentIds: string[];
  maxAgentSpawns: number;
}

export interface ToolCallEvent {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  createdAt: string;
}

export interface ChatResponse {
  conversation?: { id: string; title?: string };
  assistantMessage?: { id: string; content: string };
  toolEvents?: ToolCallEvent[];
  executionGraphId?: string;
}

export interface ConfiguredModel {
  provider: Provider;
  model: string;
  capability?: string;
}

export interface AppConfig {
  configuredModels?: ConfiguredModel[];
}
