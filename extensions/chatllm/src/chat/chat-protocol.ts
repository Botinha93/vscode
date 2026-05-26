import type { ChatllmSettings } from "../settings";
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

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  status?: "pending" | "streaming" | "complete" | "error";
  error?: string;
}

export interface ChatOverrides {
  provider?: ConfiguredProvider;
  model?: string;
  chatMode?: ConversationChatMode;
  useRag?: boolean;
  toolsEnabled?: boolean;
  agentIds?: string[];
  skillIds?: string[];
  mcpServerIds?: string[];
}

export interface ChatSession {
  id: string;
  conversationId?: string;
  title: string;
  messages: ChatMessage[];
  overrides: ChatOverrides;
  remote: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SessionSummary {
  id: string;
  conversationId?: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  overrides: ChatOverrides;
  remote: boolean;
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
}

export type BackendStatus = "ok" | "unauthorized" | "unreachable" | "unconfigured";

export type ChatHostToWebview =
  | {
      type: "init";
      settings: ChatllmSettings;
      sessions: SessionSummary[];
      activeSessionId: string | null;
      activeSession: ChatSession | null;
      project: ProjectInfo;
      catalog: BackendCatalog;
      backendStatus: BackendStatus;
      apiOrigin: string;
    }
  | { type: "settings"; settings: ChatllmSettings }
  | { type: "catalog"; catalog: BackendCatalog; backendStatus: BackendStatus }
  | { type: "openSettings" }
  | { type: "sessions"; sessions: SessionSummary[]; activeSessionId: string | null }
  | { type: "session"; session: ChatSession }
  | { type: "messageAppend"; sessionId: string; messageId: string; chunk: string }
  | { type: "messageComplete"; sessionId: string; messageId: string; conversationId?: string }
  | { type: "messageError"; sessionId: string; messageId: string; error: string }
  | { type: "toolEvent"; sessionId: string; name: string; arguments: Record<string, unknown> }
  | { type: "log"; message: string };

export type ChatWebviewToHost =
  | { type: "ready" }
  | { type: "newSession" }
  | { type: "openSession"; sessionId: string }
  | { type: "deleteSession"; sessionId: string }
  | { type: "renameSession"; sessionId: string; title: string }
  | { type: "sendMessage"; sessionId: string; content: string }
  | { type: "cancelMessage"; sessionId: string }
  | { type: "setOverrides"; sessionId: string; overrides: ChatOverrides }
  | { type: "refreshCatalog" }
  | { type: "refreshSessions" }
  | { type: "updateSetting"; key: string; value: unknown }
  | { type: "openSettings" }
  | { type: "openPipeline" };
