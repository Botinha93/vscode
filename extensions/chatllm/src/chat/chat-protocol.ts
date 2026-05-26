import type { ChatllmSettings } from "../settings";
import type { Provider } from "./types";

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
  provider?: Provider;
  model?: string;
  chatMode?: "normal" | "agent";
  useRag?: boolean;
  toolsEnabled?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  conversationId?: string;
  messages: ChatMessage[];
  overrides: ChatOverrides;
  createdAt: number;
  updatedAt: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  overrides: ChatOverrides;
}

export interface ModelOption {
  provider: Provider;
  modelId: string;
  name: string;
  detail?: string;
}

export interface ProviderModelGroup {
  provider: Provider;
  label: string;
  models: ModelOption[];
}

export type ChatHostToWebview =
  | {
      type: "init";
      settings: ChatllmSettings;
      sessions: SessionSummary[];
      activeSessionId: string | null;
      activeSession: ChatSession | null;
      modelCatalog: ProviderModelGroup[];
    }
  | { type: "settings"; settings: ChatllmSettings }
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
  | { type: "updateSetting"; key: string; value: unknown }
  | { type: "openSettings" }
  | { type: "openPipeline" };
