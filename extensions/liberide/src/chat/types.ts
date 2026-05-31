export type Provider = "openai" | "openrouter" | "google" | "copilot" | "ollama" | "llamacpp" | "lmstudio" | "custom";
export type ConfiguredProvider = Provider | "ollama-internal";
export type Role = "system" | "user" | "assistant" | "tool";
export type ChatModelSelectionMode = "auto" | "manual";
export type ConversationChatMode = "normal" | "agent";

export type ModelCapability =
  | "chat"
  | "tools"
  | "agents"
  | "vision"
  | "audio"
  | "embeddings"
  | "image-generation"
  | "code"
  | "function-calling"
  | "long-context"
  | "local";

export interface ConfiguredModel {
  id: string;
  provider: ConfiguredProvider;
  modelId: string;
  displayName: string;
  description?: string;
  capabilities: ModelCapability[];
  apiKeyConfigured: boolean;
  baseURL?: string;
  contextWindow?: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  argumentHint?: string;
  tools?: string[];
  skillIds?: string[];
  agentIds?: string[];
  disableModelInvocation?: boolean;
  builtIn?: boolean;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  enabledForUser?: boolean;
  builtIn?: boolean;
}

export interface McpServer {
  id: string;
  name: string;
  enabled: boolean;
  enabledForUser?: boolean;
}

export interface DocumentRecord {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  contentKind: "text" | "image" | "audio";
  indexedAt?: string;
  createdAt: string;
}

export interface SharingFolder {
  id: string;
  ownerUserId?: string;
  name: string;
  color?: string;
  icon?: string;
  parentFolderId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  ownerUserId?: string;
  systemPrompt?: string;
  provider?: Provider;
  model?: string;
  modelSelection?: ChatModelSelectionMode;
  chatMode?: ConversationChatMode;
  agentId?: string;
  allowedAgentIds?: string[];
  folder?: string;
  folderIds?: string[];
  tags?: string[];
  pinned?: boolean;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  provider?: Provider;
  model?: string;
  createdAt: string;
}

export interface AppConfig {
  configuredModels: ConfiguredModel[];
  skills: Skill[];
  agents: AgentDefinition[];
  mcpServers?: McpServer[];
  maxAgentSpawns: number;
}

export interface IdeToolContextPayload {
  sessionId: string;
  userId: string;
  projectPath: string;
  mode: "web" | "desktop";
  terminalExecutor?: "server" | "client";
  conversationId?: string;
  agentRunId?: string;
}

export interface TerminalDelegateEvent {
  delegateId: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  projectPath: string;
  sessionId?: string;
  conversationId?: string;
}

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
  agentId?: string;
  allowedAgentIds: string[];
  maxAgentSpawns: number;
  ideContext?: IdeToolContextPayload;
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
