import type { AgentApprovalRequest, ModelCapability, ModelProfileV1, ModelRoutingResolution, Provider } from "@nexus/shared";

export type { AgentApprovalRequest } from "@nexus/shared";
export type FallbackRequiredResolution = Extract<ModelRoutingResolution, { status: "approval_required" }>;
export type RoutingUnsatisfiedResolution = Extract<ModelRoutingResolution, { status: "unsatisfied" }>;
/** Server-side turn state persisted on assistant messages. */
export type MessageTurnStatus = "failed" | "cancelled" | "awaiting_approval" | "resolved";
export type { ModelCapability, ModelFeature, ModelOperation, ModelProfileV1, ModelSupport, Provider } from "@nexus/shared";
import type { WorkspaceIntelligence } from "../workspace/intelligence";
export type ConfiguredProvider = Provider | "ollama-internal";
export type Role = "system" | "user" | "assistant" | "tool";
export type ChatModelSelectionMode = "auto" | "manual";
export type ConversationChatMode = "normal" | "agent";

export interface ConfiguredModel {
  id: string;
  provider: ConfiguredProvider;
  modelId: string;
  displayName: string;
  description?: string;
  /** @deprecated Display-only legacy data; may be omitted by newer servers. Prefer `profile`. */
  capabilities?: ModelCapability[];
  apiKeyConfigured: boolean;
  baseURL?: string;
  contextWindow?: number;
  /** Resolved v1 profile; the source of truth for operations and features. */
  profile?: ModelProfileV1;
  /** Whether this enabled model may be considered by auto routing. */
  routingEnabled?: boolean;
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
  /** What to show for a user message whose `content` is app-built text. */
  displayContent?: string;
  provider?: Provider;
  model?: string;
  /** Set when an execution graph produces (or will produce) this message's content. */
  executionGraphId?: string;
  status?: MessageTurnStatus;
  approvalId?: string;
  pausedAgentRunId?: string;
  /** Final graph status once the graph finished and delivered its result. */
  graphStatus?: string;
  error?: string;
  warnings?: string[];
  resolution?: string;
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
  ideUserId?: string;
  ideSessionId?: string;
  projectPath: string;
  mode: "web" | "desktop";
  terminalExecutor?: "server" | "client";
  conversationId?: string;
  agentRunId?: string;
  delegateAvailable?: boolean;
  machineId?: string;
  workspaceId?: string;
  workspaceIntelligence?: WorkspaceIntelligence;
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
  /** `turn`: the system prompt applies to this turn only (not saved on the conversation). */
  systemPromptScope?: "turn";
  /** What the user sees for this message when `content` differs (e.g. the typed `/tasks …`). */
  displayContent?: string;
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
  assistantMessage?: Partial<ConversationMessage> & { id: string; content: string };
  toolEvents?: ToolCallEvent[];
  approvals?: AgentApprovalRequest[];
  context?: { warnings?: string[] };
  executionGraphId?: string;
}
