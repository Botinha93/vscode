/** Minimal mirrors of @chatllm/shared types for the bundled extension. */

export type Provider =
  | "openai"
  | "openrouter"
  | "google"
  | "ollama"
  | "llamacpp"
  | "lmstudio"
  | "custom";

export type ConversationChatMode = "normal" | "agent";
export type ChatModelSelectionMode = "auto" | "manual";

export interface ChatRequest {
  conversationId?: string;
  provider: Provider;
  model: string;
  modelSelection?: ChatModelSelectionMode;
  chatMode?: ConversationChatMode;
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

export interface Message {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
}

export interface ChatResponse {
  conversation: Conversation;
  userMessage: Message;
  assistantMessage: Message;
  toolEvents: ToolCallEvent[];
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
