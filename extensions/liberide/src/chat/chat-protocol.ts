import type { LiberideSettings } from "../settings";
import type {
  AgentDefinition,
  ConfiguredModel,
  ConfiguredProvider,
  ConversationChatMode,
  DocumentRecord,
  McpServer,
  Skill,
} from "./types";

export type Role = "user" | "assistant";

export interface ToolTimelineEntry {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Short, human-friendly summary line, e.g. "Edited `src/foo.ts`". */
  summary?: string;
  startedAt: number;
  completedAt?: number;
  status: "running" | "complete" | "error";
  result?: string;
  error?: string;
}

export interface EditedFileSummary {
  path: string;
  /** Number of full overwrites via ide_write_file. */
  writes: number;
  /** Number of search-and-replace edits via ide_edit_file. */
  edits: number;
  additions: number;
  deletions: number;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  status?: "pending" | "streaming" | "complete" | "error";
  error?: string;
  startedAt?: number;
  completedAt?: number;
  tools?: ToolTimelineEntry[];
  editedFiles?: EditedFileSummary[];
  /** True when the inline pipeline-ready card on this message has already been acted on. */
  pipelineCardConsumed?: boolean;
}

export interface ChatOverrides {
  provider?: ConfiguredProvider;
  model?: string;
  chatMode?: ConversationChatMode;
  toolGroupIds?: string[];
  useRag?: boolean;
  toolsEnabled?: boolean;
  agentIds?: string[];
  skillIds?: string[];
  mcpServerIds?: string[];
  documentIds?: string[];
}

export type ChatSessionKind = "vibe" | "pipeline";

export interface ChatSession {
  id: string;
  conversationId?: string;
  title: string;
  messages: ChatMessage[];
  overrides: ChatOverrides;
  remote: boolean;
  createdAt: number;
  updatedAt: number;
  kind: ChatSessionKind;
}

export interface SessionSummary {
  id: string;
  conversationId?: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  overrides: ChatOverrides;
  remote: boolean;
  kind: ChatSessionKind;
}

export interface ProjectInfo {
  id: string;
  source: "git" | "folder" | "none";
  name: string;
  remoteUrl?: string;
  branch?: string;
  rootPath?: string;
  folderName: string;
}

export interface BackendCatalog {
  models: ConfiguredModel[];
  agents: AgentDefinition[];
  skills: Skill[];
  mcpServers: McpServer[];
  documents: DocumentRecord[];
  maxAgentSpawns: number;
  toolGroups?: Array<{ id: string; name: string; description: string; toolIds: string[] }>;
  promptTemplates?: Array<{ id: string; title: string; content: string; applyTo?: string }>;
  chatModes?: ConversationChatMode[];
  permissionPolicies?: Array<{ id: string; scope: string; autopilot?: boolean }>;
  sessionOrigins?: Array<"web" | "cli" | "cloud" | "extension" | "webhook">;
}

export type BackendStatus = "ok" | "unauthorized" | "unreachable" | "unconfigured";

export type ChatHostToWebview =
  | {
      type: "init";
      settings: LiberideSettings;
      sessions: SessionSummary[];
      activeSessionId: string | null;
      activeSession: ChatSession | null;
      project: ProjectInfo;
      catalog: BackendCatalog;
      backendStatus: BackendStatus;
      apiOrigin: string;
    }
  | { type: "settings"; settings: LiberideSettings }
  | { type: "catalog"; catalog: BackendCatalog; backendStatus: BackendStatus }
  | { type: "openSettings" }
  | { type: "sessions"; sessions: SessionSummary[]; activeSessionId: string | null }
  | { type: "session"; session: ChatSession }
  | { type: "messageStart"; sessionId: string; messageId: string; startedAt: number }
  | { type: "messageAppend"; sessionId: string; messageId: string; chunk: string }
  | { type: "messageComplete"; sessionId: string; messageId: string; conversationId?: string; completedAt: number }
  | { type: "messageError"; sessionId: string; messageId: string; error: string; completedAt: number }
  | { type: "toolUpdate"; sessionId: string; messageId: string; entry: ToolTimelineEntry; editedFiles: EditedFileSummary[] }
  | { type: "project"; project: ProjectInfo }
  | { type: "log"; message: string };

export type ChatWebviewToHost =
  | { type: "ready" }
  | { type: "newSession" }
  | { type: "openSession"; sessionId: string }
  | { type: "deleteSession"; sessionId: string }
  | { type: "renameSession"; sessionId: string; title: string }
  | { type: "sendMessage"; sessionId: string; content: string }
  | { type: "attachFiles"; sessionId: string }
  | { type: "removeAttachment"; sessionId: string; documentId: string }
  | { type: "cancelMessage"; sessionId: string }
  | { type: "setOverrides"; sessionId: string; overrides: ChatOverrides }
  | { type: "setSessionKind"; sessionId: string; kind: ChatSessionKind }
  | { type: "generatePipeline"; sessionId: string; featureName: string }
  | { type: "consumePipelineCard"; sessionId: string; messageId: string }
  | { type: "refreshCatalog" }
  | { type: "refreshSessions" }
  | { type: "updateSetting"; key: string; value: unknown }
  | { type: "copilotGithubLogin" }
  | { type: "openSettings" }
  | { type: "openPipeline" }
  | { type: "revealFile"; path: string }
  | { type: "undoEdit"; path: string };
