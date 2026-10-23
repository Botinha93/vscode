import type { LiberideSettings } from "../settings";
import type { WorkspaceIntelligence } from "../workspace/intelligence";
import type { ContextBlockChip } from "./context-blocks";
import type { AgentRunView } from "./agent-runs";
import type { ApprovalMode } from "./approval-mode";
import type {
  AgentDefinition,
  ConfiguredModel,
  ConfiguredProvider,
  ConversationChatMode,
  DocumentRecord,
  McpServer,
  MessageTurnStatus,
  Provider,
  Skill,
} from "./types";

export type Role = "user" | "assistant";

export interface ToolTimelineEntry {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Category used for UI activity indicators. */
  activityKind?: "reading" | "searching" | "writing" | "executing" | "agent" | "web" | "mcp" | "approval";
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
  /** Workspace folder `path` is relative to (multi-root: Undo/Review use it). */
  root?: string;
  /** Number of full overwrites via ide_write_file. */
  writes: number;
  /** Number of search-and-replace edits via ide_edit_file. */
  edits: number;
  additions: number;
  deletions: number;
}

/** Approval card state for a turn paused on a tool/plan approval. */
export interface ApprovalCardView {
  id: string;
  action: string;
  reason?: string;
  details?: string;
  risk?: string;
  kind?: string;
  status: "pending" | "approved" | "rejected" | "auto_approved";
  /** True while the PATCH / resume stream is in flight. */
  busy?: boolean;
  error?: string;
}

export interface GraphStepView {
  nodeId: string;
  title?: string;
  status: string;
  /** Full error of a failed node. */
  error?: string;
  /** The node's output/summary, when the server sent it. */
  output?: string;
  /** Swarm task the node works on: steps of one task are drawn as one branch. */
  taskId?: string;
}

/** Live progress of the execution graph producing a message. */
export interface GraphProgressView {
  graphId: string;
  status: string;
  steps: GraphStepView[];
  /** Connection problems while following the graph. */
  error?: string;
  reconnecting?: boolean;
  cancelling?: boolean;
}

/** Offered when the pinned model cannot serve the request. */
export interface FallbackProposalView {
  prompt: string;
  reason?: string;
  alternatives: Array<{ provider: Provider; model: string }>;
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
  /** Server-side turn state (failed / cancelled / awaiting approval / resolved). */
  turnStatus?: MessageTurnStatus;
  /** Degradations reported for this turn. */
  warnings?: string[];
  /** Streamed reasoning, if the model exposes it. */
  thinking?: string;
  /** The run's current plan (update_plan), shown as a checklist. */
  todos?: Array<{ id?: string; label: string; status?: string; done?: boolean }>;
  approval?: ApprovalCardView;
  graph?: GraphProgressView;
  fallback?: FallbackProposalView;
  /** Set on the server's agent-run anchor cards. */
  agentRunId?: string;
  /** Model that produced this reply (the routed one for auto turns). */
  model?: { provider?: string; model?: string };
  /** A local note in the transcript (run actions, errors), not a model reply. */
  note?: "info" | "warning" | "error";
}

/** A pending approval raised by an agent run (not a paused chat turn). */
export interface RunApprovalView extends ApprovalCardView {
  agentRunId?: string;
}

export interface ChatOverrides {
  provider?: ConfiguredProvider;
  model?: string;
  /** `auto`: the server routes each turn (model `auto`); `manual`: the pinned model. */
  modelSelection?: "auto" | "manual";
  chatMode?: ConversationChatMode;
  toolGroupIds?: string[];
  useRag?: boolean;
  toolsEnabled?: boolean;
  agentId?: string;
  allowedAgentIds?: string[];
  skillIds?: string[];
  mcpServerIds?: string[];
  documentIds?: string[];
  /**
   * Per-chat approval mode. For a saved chat it mirrors the server's
   * conversation (changing it PATCHes the conversation); a draft keeps it
   * until its conversation is created.
   */
  approvalMode?: ApprovalMode;
}

/** Offered after switching to a looser approval mode: pending approvals it would auto-approve. */
export interface ApprovalModeOfferView {
  sessionId: string;
  mode: ApprovalMode;
  approvals: Array<{ id: string; action: string; reason?: string; risk?: string }>;
  busy?: boolean;
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
  /** Model the last auto-routed reply ran on ("Auto → …" on the chip). */
  routedModel?: { provider?: string; model?: string };
  /** Agent runs of this chat, drawn as cards inside their graph / parent / anchor. */
  agentRuns?: AgentRunView[];
  /** Pending approvals of this chat's agent runs. */
  runApprovals?: RunApprovalView[];
  /** False while the live agent-run stream is reconnecting. */
  agentsConnected?: boolean;
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
  workspaceIntelligence?: WorkspaceIntelligence;
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
  /** Most permissive approval mode the admin allows; options above it are disabled. */
  maxApprovalMode?: ApprovalMode;
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
  | { type: "messageComplete"; sessionId: string; messageId: string; conversationId?: string; completedAt: number; serverMessageId?: string }
  /** Merge fields into a message and re-render it (approval, graph, thinking, warnings, status). */
  | { type: "messagePatch"; sessionId: string; messageId: string; patch: Partial<ChatMessage> }
  /** Put text back in the composer (e.g. the send was refused because a turn is running). */
  | { type: "restoreDraft"; sessionId: string; content: string }
  | { type: "messageError"; sessionId: string; messageId: string; error: string; completedAt: number }
  | { type: "toolUpdate"; sessionId: string; messageId: string; entry: ToolTimelineEntry; editedFiles: EditedFileSummary[] }
  | { type: "project"; project: ProjectInfo }
  | { type: "openSidebar" }
  | { type: "contextBlocks"; blocks: ContextBlockChip[] }
  /** Upsert agent runs of a session (live output, tool calls, status). */
  | { type: "agentRuns"; sessionId: string; runs: AgentRunView[]; connected?: boolean }
  | { type: "runApprovals"; sessionId: string; approvals: RunApprovalView[] }
  /** Expand and scroll to a graph node's step (Runs view → Show Node Detail). */
  | { type: "revealGraphNode"; sessionId: string; graphId: string; nodeId: string }
  /** Pending approvals the new approval mode would auto-approve (null clears the offer). */
  | { type: "approvalModeOffer"; offer: ApprovalModeOfferView | null }
  | { type: "log"; message: string; severity?: "info" | "warning" | "error" };

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
  | { type: "revealFile"; path: string; root?: string }
  | { type: "undoEdits"; sessionId: string; files: Array<{ path: string; root?: string }> }
  | { type: "resolveApproval"; sessionId: string; messageId: string; approvalId: string; decision: "approved" | "rejected"; response?: string }
  | { type: "cancelGraph"; sessionId: string; messageId: string; graphId: string }
  | { type: "retryWithModel"; sessionId: string; messageId: string; provider: Provider; model: string; content: string }
  | { type: "removeContextBlock"; id: string }
  | { type: "resolveNodeApproval"; sessionId: string; messageId: string; graphId: string; nodeId: string; decision: "approved" | "rejected" }
  | { type: "resolveRunApproval"; sessionId: string; approvalId: string; decision: "approved" | "rejected" }
  | { type: "replayNode"; sessionId: string; graphId: string; nodeId: string }
  /** Re-run a stopped graph's failed/blocked steps (completed ones are kept). */
  | { type: "retryGraph"; sessionId: string; graphId: string }
  | { type: "loadRunToolCalls"; sessionId: string; runId: string }
  | { type: "autoResolveApprovals"; sessionId: string; ids: string[] }
  | { type: "dismissApprovalModeOffer"; sessionId: string };
