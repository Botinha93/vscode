import * as vscode from "vscode";
import { resetPreEditSnapshots, restorePreEditSnapshot } from "../ide-delegate/handlers/fs";
import { isPathInside, resolveInsideRootSync } from "../ide-delegate/handlers/helpers";
import { randomBytes } from "node:crypto";
import * as nodePath from "node:path";
import {
  addConversationToFolder,
  apiFetch,
  createConversation,
  createFolder,
  deleteConversation,
  fetchConfig,
  getApiOrigin,
  listAgentRunToolCalls,
  listConversationAgentRuns,
  listConversationMessages,
  listConversations,
  listDocuments,
  listFolders,
  onAuthChanged,
  patchConversation,
  probeBackend,
  subscribeConversationAgents,
  subscribeConversationListSync,
  uploadDocument,
  type ConversationListEvent,
} from "../api";
import { cancelExecutionGraph, isTerminalGraphStatus, nodeEventError, resolveNodeApproval, subscribeExecutionGraphEvents } from "../dispatch/client";
import { graphConversation, linkFeatureConversation, linkGraphConversation, type ChatRunLink } from "../dispatch/conversation-link";
import {
  agentRunFromAnchor,
  applyAgentStreamEvent,
  isActiveAgentRunStatus,
  mergeAgentRun,
  type AgentRunView,
} from "./agent-runs";
import { autoResolveApprovals, listAutoResolvableApprovals } from "../api";
import {
  approvalModeAllowed,
  changeConversationApprovalMode,
  conversationApprovalMode,
  isApprovalMode,
  maxApprovalModeFromConfig,
  setActiveChatApprovalContext,
} from "./approval-mode";
import { onSettingsChange, readSettings, writeSetting, type LiberideSettings } from "../settings";
import {
  conversationHasProjectTag,
  detectProjectIdentity,
  projectConversationTag,
  projectFolderName,
  type ProjectIdentity,
} from "../project/identity";
import { detectIdeSpecSlashCommand } from "@nexus/shared";
import { enrichMessageWithContext, toChips, type ContextBlock } from "./context-blocks";
import {
  PIPELINE_GENERATE_SYSTEM_PROMPT,
  PIPELINE_INTERVIEW_SYSTEM_PROMPT,
  SPEC_SYSTEM_PROMPTS,
  extractTaskBlocks,
} from "./commands";
import { effectiveModelSelection, resolveTurnModel, supportsTextGeneration, toWireProvider } from "./models";
import { listCopilotLmModels, streamCopilotChat } from "./copilot-lm";
import {
  BUSY_MESSAGE,
  ChatStreamError,
  isAgentRunResumed,
  listConversationApprovals,
  openTurnStream,
  resolveApproval,
  streamApprovalResume,
  streamChat,
  type ChatStreamHandlers,
} from "./stream-client";
import type {
  AppConfig,
  ChatRequest,
  IdeToolContextPayload,
  ConfiguredProvider,
  Conversation,
  ConversationMessage,
  Provider,
  SharingFolder,
  AgentDefinition,
  AgentApprovalRequest,
  ChatResponse,
  FallbackRequiredResolution,
} from "./types";
import type {
  ApprovalCardView,
  ApprovalModeOfferView,
  FallbackProposalView,
  GraphProgressView,
  BackendCatalog,
  BackendStatus,
  ChatHostToWebview,
  ChatMessage,
  ChatOverrides,
  ChatSession,
  ChatWebviewToHost,
  EditedFileSummary,
  ProjectInfo,
  RunApprovalView,
  SessionSummary,
  ChatSessionKind,
  ToolTimelineEntry,
} from "./chat-protocol";
import type { ToolCallEvent } from "./types";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { parseTaskContract } from "../spec/schema";
import type { SpecStore } from "../spec/store";
import { regenerateTasksIndex, scaffoldFeature, writeTaskContract, writeTextFile } from "../spec/writer";
import { activeWorkspaceFolder, buildIdeContextPayload } from "../ide-delegate/context";
import { getWorkspaceIntelligence } from "../workspace/intelligence";
import {
  buildKeptConversationIds,
  pruneConversationCaches,
} from "./cache-prune";

const OVERRIDES_STORAGE_KEY = "liberide.chat.overrides";
const ACTIVE_SESSION_STORAGE_KEY = "liberide.chat.activeSession";

function resolveAllowedAgentIds(agents: AgentDefinition[], configured: string[] | undefined): string[] {
  const invokable = agents.filter((agent) => !agent.disableModelInvocation).map((agent) => agent.id);
  if (!configured?.length) return invokable;
  return configured.filter((id) => invokable.includes(id));
}

interface OverridesCache {
  [conversationId: string]: ChatOverrides;
}

/** Cancel a running server turn; a missing turn (already finished) is fine. */
async function requestTurnCancel(serverConversationId: string): Promise<void> {
  await apiFetch(`/api/conversations/${encodeURIComponent(serverConversationId)}/turn/cancel`, { method: "POST" }).catch(() => undefined);
}

interface ActiveStream {
  abort: AbortController;
  /** Server conversation id of the turn (drafts learn it from the stream). */
  serverConversationId?: string;
  /** Stop pressed before the server id arrived: cancel when it does. */
  stopRequested?: boolean;
  messageId: string;
  startedAt: number;
  tools: Map<string, ToolTimelineEntry>;
  edits: Map<string, EditedFileSummary>;
  /** Workspace folder the turn's tools work in; edit cards carry it for Undo/Review. */
  root?: string;
}

interface GraphWatcher {
  conversationId: string;
  messageId: string;
  dispose: () => void;
}

/** Optimistic messages added for a turn, removed again if the server refuses it (busy). */
interface OptimisticTurn {
  userMessage?: ConversationMessage;
  content?: string;
}

function approvalCardFrom(request: AgentApprovalRequest): ApprovalCardView {
  return {
    id: request.id,
    action: request.action || "Approval required",
    reason: request.reason,
    details: request.details,
    risk: request.risk,
    kind: request.kind,
    status: request.status,
  };
}

function toolActivityKind(name: string): ToolTimelineEntry["activityKind"] {
  if (name === "request_approval") return "approval";
  if (name === "agent" || name === "agent_group" || name === "agent_result") return "agent";
  if (name === "web") return "web";
  if (name === "mcp" || name.startsWith("mcp_")) return "mcp";

  if (
    name === "ide_read_file" ||
    name === "ide_list_directory" ||
    name === "ide_open_editors" ||
    name === "ide_dirty_buffers" ||
    name === "ide_active_selection" ||
    name === "ide_workspace_diagnostics" ||
    name === "ide_workspace_symbols" ||
    name === "ide_document_symbols" ||
    name === "ide_definition" ||
    name === "ide_references" ||
    name === "ide_hover" ||
    name === "ide_find_files" ||
    name === "ide_git_status" ||
    name === "ide_git_log" ||
    name === "ide_git_diff" ||
    name === "ide_git_blame" ||
    name === "ide_code_actions" ||
    name === "ide_test_list" ||
    name === "ide_test_status" ||
    name === "ide_tasks_list" ||
    name === "ide_tasks_status" ||
    name === "ide_debug_list" ||
    name === "ide_debug_stacktrace" ||
    name === "ide_notebook_read" ||
    name === "ide_workspace_config_read" ||
    name === "ide_extensions_list" ||
    name === "ide_problems_by_owner" ||
    name === "ide_semantic_tokens" ||
    name === "read" ||
    name === "find_symbol" ||
    name === "find_references" ||
    name === "find_implementations" ||
    name === "find_callers" ||
    name === "find_dependencies" ||
    name === "find_test_for_file" ||
    name === "find_related_code"
  ) {
    return "reading";
  }

  if (name === "ide_search_code" || name === "search" || name === "recall") return "searching";

  if (name === "ide_write_file" || name === "ide_edit_file" || name === "userspace" || name === "artifact" ||
    name === "ide_rename_symbol" || name === "ide_format_document" || name === "ide_format_range" ||
    name === "ide_apply_workspace_edit" || name === "ide_apply_code_action" || name === "ide_notebook_edit") return "writing";

  if (name === "ide_terminal_session" || name === "terminal_run" || name === "ide_run_command" ||
    name === "ide_tasks_run" || name === "ide_tasks_cancel" || name === "ide_test_run" ||
    name === "ide_debug_start" || name === "ide_debug_stop" || name === "ide_notebook_execute" ||
    name === "ide_workspace_config_write") return "executing";

  return "executing";
}

interface AgentStreamState {
  dispose: () => void;
  connected: boolean;
  /** Closes the stream once no run has been active for a while. */
  idleTimer?: ReturnType<typeof setTimeout>;
}

/** Keep the agents stream this long after the last run finished (late events, follow-up runs). */
const AGENT_STREAM_IDLE_MS = 15_000;
/** Refresh the catalog on view focus at most this often. */
const CATALOG_FOCUS_REFRESH_MS = 10_000;

export class LiberideChatPanelController implements vscode.WebviewViewProvider, vscode.Disposable, ChatRunLink {
  static readonly viewType = "liberide.chat";

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly streams = new Map<string, ActiveStream>();
  private conversationSyncDispose?: () => void;

  private project: ProjectIdentity = { id: "none", source: "none", name: "" };
  private projectFolderId: string | null = null;
  private projectFolder?: SharingFolder;
  private catalog: BackendCatalog = emptyCatalog();
  private backendStatus: BackendStatus = "unconfigured";
  /** True when the backend itself exposes Copilot models; the local vscode.lm Copilot path is then suppressed. */
  private backendHasCopilotModels = false;

  private conversations = new Map<string, Conversation>();
  private messagesCache = new Map<string, ConversationMessage[]>();
  private static readonly MAX_CACHED_CONVERSATIONS = 20;
  private attachmentBytes = new Map<string, { data: Uint8Array; mimeType: string; name: string }>();
  /** Inline context chips applied to the next message in the active chat. */
  private pendingContextBlocks: ContextBlock[] = [];
  private overrides: OverridesCache = {};
  private sessionKinds = new Map<string, ChatSession["kind"]>();
  /** conversationId -> set of message ids whose pipeline-ready card has been consumed. */
  private consumedPipelineCards = new Map<string, Set<string>>();

  // Per-message UI state layered over the cached server messages (keyed by message id).
  private approvalCards = new Map<string, ApprovalCardView>();
  private graphViews = new Map<string, GraphProgressView>();
  private thinkingByMessage = new Map<string, string>();
  private fallbacks = new Map<string, FallbackProposalView>();
  private turnWarnings = new Map<string, string[]>();
  /** Local-only turn outcome until the server copy replaces the optimistic message. */
  private localTurnStatus = new Map<string, ConversationMessage["status"]>();
  /** graphId -> live subscription. */
  private graphWatchers = new Map<string, GraphWatcher>();
  /** Graphs already seen reaching a terminal state (never re-watched). */
  private finishedGraphs = new Set<string>();
  private hydratedApprovalConversations = new Set<string>();
  /** Conversations whose refresh was deferred because a turn was streaming. */
  private pendingRefresh = new Set<string>();
  private patchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** conversationId -> placeholder shown while a resumed sub-agent works; kept across refreshes until its result lands. */
  private agentResumeNotes = new Map<string, ConversationMessage>();
  /** conversationId -> runId -> run card state (anchors, run list, live stream). */
  private agentRuns = new Map<string, Map<string, AgentRunView>>();
  /** conversationId -> live `/agents/stream` subscription. */
  private agentStreams = new Map<string, AgentStreamState>();
  /** conversationId -> run ids changed since the last flush to the webview. */
  private agentRunChanges = new Map<string, Set<string>>();
  private agentRunFlushTimer?: ReturnType<typeof setTimeout>;
  /** Conversations whose run list was fetched (re-fetched on resync). */
  private hydratedAgentRuns = new Set<string>();
  /** conversationId -> pending approvals of its agent runs. */
  private runApprovals = new Map<string, RunApprovalView[]>();
  /** conversationId -> local notes in the transcript (run actions and their errors). */
  private localNotes = new Map<string, ChatMessage[]>();
  /** conversationId -> graph cards shown before the server posted the graph's message. */
  private pendingGraphAnchors = new Map<string, ConversationMessage[]>();
  private lastCatalogRefresh = 0;
  /** Node to reveal once the view has loaded. */
  private pendingReveal?: Extract<ChatHostToWebview, { type: "revealGraphNode" }>;

  /** Locally-staged session for "new chat" before the first message creates it on the backend. */
  /** Conversations opened from another surface: listed even when they are not this project's. */
  private readonly openedConversations = new Set<string>();
  /** Conversations whose running turn is being looked up (re-attach). */
  private readonly attaching = new Set<string>();
  private draftSession: ChatSession | null = null;
  private activeSessionId: string | null = null;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SpecStore,
    private readonly output: vscode.OutputChannel,
  ) {
    this.overrides = this.context.workspaceState.get<OverridesCache>(OVERRIDES_STORAGE_KEY, {});
    this.activeSessionId = this.context.workspaceState.get<string | null>(ACTIVE_SESSION_STORAGE_KEY, null);
    this.publishActiveContext();
    const storedKinds = this.context.workspaceState.get<Record<string, ChatSessionKind>>("liberide.chat.sessionKinds") ?? {};
    for (const [id, kind] of Object.entries(storedKinds)) this.sessionKinds.set(id, kind);
    this.disposables.push(
      onSettingsChange((settings) => this.broadcast({ type: "settings", settings })),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.onWorkspaceFoldersChanged();
      }),
    );
    this.conversationSyncDispose = subscribeConversationListSync((event) => {
      if (this.disposed) return;
      void this.onConversationListEvent(event);
    });
    const offAuth = onAuthChanged(() => {
      if (this.disposed) return;
      void this.refreshCatalog().then(() => this.refreshConversations());
    });
    this.disposables.push({ dispose: offAuth });
  }

  private async onConversationListEvent(event: ConversationListEvent): Promise<void> {
    if (this.disposed) return;
    if (event.type === "models_changed") {
      await this.refreshCatalog();
      return;
    }
    if (event.type === "agent_run_updated") {
      this.onAgentRunUpdated(event);
      return;
    }
    if (event.type === "approvals_changed") {
      const targets = event.conversationId ? [event.conversationId] : [...this.messagesCache.keys()];
      for (const id of targets) {
        if (!this.messagesCache.has(id)) continue;
        this.hydratedApprovalConversations.delete(id);
        void this.hydrateApprovals(id);
        void this.hydrateRunApprovals(id);
      }
      return;
    }
    if (event.type === "message_updated" && event.conversationId) {
      // A resumed sub-agent posted its result: the placeholder has served its purpose.
      this.agentResumeNotes.delete(event.conversationId);
      // A graph (or another client) changed a message: reload just that conversation.
      if (this.messagesCache.has(event.conversationId)) await this.refreshSingleConversation(event.conversationId);
      // An approval answered elsewhere may have resumed the turn: follow it here too.
      if (event.conversationId === this.activeSessionId) void this.attachRunningTurn(event.conversationId);
      return;
    }
    await this.refreshConversations();
    if (event.type === "resync" && this.activeSessionId && this.messagesCache.has(this.activeSessionId)) {
      this.hydratedAgentRuns.delete(this.activeSessionId);
      await this.refreshSingleConversation(this.activeSessionId);
      void this.refreshCatalog();
    }
  }

  private async onWorkspaceFoldersChanged(): Promise<void> {
    if (this.disposed) return;
    this.project = await detectProjectIdentity();
    await this.ensureProjectFolder();
    await this.refreshConversations();
    this.broadcast({ type: "project", project: this.projectInfo() });
  }

  /** Re-detect the active project (e.g. after the user picks a different root). */
  async reloadProject(): Promise<void> {
    await this.onWorkspaceFoldersChanged();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.bindWebview(view.webview);
    // Models changed on the web while the view was hidden: pick them up on focus.
    const visibility = view.onDidChangeVisibility(() => {
      if (!view.visible || this.disposed || Date.now() - this.lastCatalogRefresh < CATALOG_FOCUS_REFRESH_MS) return;
      void this.refreshCatalog();
    });
    view.onDidDispose(() => {
      visibility.dispose();
      if (this.view === view) this.view = undefined;
    });
  }

  show(): void {
    void vscode.commands.executeCommand(`${LiberideChatPanelController.viewType}.focus`);
  }

  async newSession(): Promise<void> {
    this.draftSession = this.makeDraft();
    this.activeSessionId = this.draftSession.id;
    await this.persistActive();
    this.broadcastSessions();
    this.broadcastActiveSession();
  }

  /** Show a conversation (opened from the web app or the quick pick), following its running turn. */
  async openConversation(conversationId: string): Promise<void> {
    this.openedConversations.add(conversationId);
    this.activeSessionId = conversationId;
    await this.persistActive();
    this.show();
    // Before the view is up, `ready` → sendInit opens the active session.
    if (this.view) await this.openSession(conversationId);
  }

  /** The active saved conversation (not a draft). */
  activeConversationId(): string | undefined {
    const id = this.activeSessionId;
    return id && !id.startsWith("draft:") && this.conversations.has(id) ? id : undefined;
  }

  openSettings(): void {
    this.show();
    this.broadcast({ type: "openSettings" });
  }

  openChatHistory(): void {
    this.show();
    this.broadcast({ type: "openSidebar" });
  }

  async renameActiveChat(): Promise<void> {
    this.show();
    const session = this.activeSession();
    if (!session) {
      void vscode.window.showInformationMessage("No active chat to rename.");
      return;
    }
    const next = await vscode.window.showInputBox({
      prompt: "Rename chat",
      value: session.title,
    });
    if (next == null) return;
    await this.renameSession(session.id, next);
  }

  dispose(): void {
    this.disposed = true;
    this.conversationSyncDispose?.();
    for (const d of this.disposables) d.dispose();
    for (const s of this.streams.values()) s.abort.abort();
    this.streams.clear();
    for (const watcher of this.graphWatchers.values()) watcher.dispose();
    this.graphWatchers.clear();
    for (const timer of this.patchTimers.values()) clearTimeout(timer);
    this.patchTimers.clear();
    for (const stream of this.agentStreams.values()) {
      stream.dispose();
      if (stream.idleTimer) clearTimeout(stream.idleTimer);
    }
    this.agentStreams.clear();
    if (this.agentRunFlushTimer) clearTimeout(this.agentRunFlushTimer);
  }

  // ---------------------------------------------------------------------------
  // Webview plumbing
  // ---------------------------------------------------------------------------

  private webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        vscode.Uri.joinPath(this.context.extensionUri, "resources"),
      ],
    };
  }

  private bindWebview(webview: vscode.Webview): void {
    webview.options = this.webviewOptions();
    webview.html = this.renderHtml(webview);
    const sub = webview.onDidReceiveMessage((message: ChatWebviewToHost) => {
      void this.handleMessage(message);
    });
    this.disposables.push(sub);
  }

  private broadcast(message: ChatHostToWebview): void {
    if (this.disposed) return;
    this.view?.webview.postMessage(message);
  }

  private broadcastSessions(): void {
    this.broadcast({
      type: "sessions",
      sessions: this.sessionSummaries(),
      activeSessionId: this.activeSessionId,
    });
  }

  private broadcastActiveSession(): void {
    const session = this.activeSession();
    // Spec dispatch (pipeline panel) starts graphs with the active chat's mode.
    setActiveChatApprovalContext({ conversationId: session?.conversationId, approvalMode: session?.overrides.approvalMode });
    if (this.approvalModeOffer && this.approvalModeOffer.sessionId !== session?.id) this.setApprovalModeOffer(null);
    if (session) this.broadcast({ type: "session", session });
  }

  /** Pending approvals the newly chosen (looser) approval mode would auto-approve. */
  private approvalModeOffer: ApprovalModeOfferView | null = null;

  private setApprovalModeOffer(offer: ApprovalModeOfferView | null): void {
    this.approvalModeOffer = offer;
    this.broadcast({ type: "approvalModeOffer", offer });
  }

  private async resolveApprovalModeOffer(sessionId: string, ids: string[]): Promise<void> {
    const offer = this.approvalModeOffer;
    if (!offer || offer.sessionId !== sessionId || !this.conversations.has(sessionId)) return;
    this.setApprovalModeOffer({ ...offer, busy: true });
    try {
      const result = await autoResolveApprovals(sessionId, ids.length ? ids : undefined);
      this.setApprovalModeOffer(null);
      const skipped = result.skipped.length ? ` (${result.skipped.length} skipped)` : "";
      this.broadcast({ type: "log", message: `Approved ${result.resolved.length} pending request${result.resolved.length === 1 ? "" : "s"}${skipped}.`, severity: "info" });
      await this.refreshSingleConversation(sessionId);
      void this.attachRunningTurn(sessionId);
    } catch (err) {
      this.setApprovalModeOffer({ ...offer, busy: false });
      this.broadcast({ type: "log", message: `Could not resolve pending approvals: ${err instanceof Error ? err.message : String(err)}`, severity: "error" });
    }
  }

  /** Change the chat's approval mode (PATCH for a saved chat; kept on a draft until it is created). */
  private async updateApprovalMode(id: string, next: unknown): Promise<void> {
    if (!isApprovalMode(next)) return;
    const max = this.catalog.maxApprovalMode;
    if (id.startsWith("draft:") && this.draftSession?.id === id) {
      if (!approvalModeAllowed(next, max)) return;
      this.draftSession.overrides = { ...this.draftSession.overrides, approvalMode: next };
      this.broadcastActiveSession();
      return;
    }
    const conversation = this.conversations.get(id);
    if (!conversation) return;
    const result = await changeConversationApprovalMode(
      { conversationId: id, previous: conversationApprovalMode(conversation), next, max },
      { patch: patchConversation, listAutoResolvable: listAutoResolvableApprovals },
    );
    if (!result.ok) {
      this.output.appendLine(`[chat.approvalMode] ${result.error}`);
      this.broadcast({ type: "log", message: result.error, severity: "warning" });
      this.broadcastActiveSession();
      return;
    }
    this.conversations.set(id, result.conversation);
    this.broadcastSessions();
    this.broadcastActiveSession();
    if (result.resolvable.length) {
      this.setApprovalModeOffer({
        sessionId: id,
        mode: result.mode,
        approvals: result.resolvable.map((a) => ({ id: a.id, action: a.action, reason: a.reason, risk: a.risk })),
      });
    } else if (this.approvalModeOffer?.sessionId === id) {
      this.setApprovalModeOffer(null);
    }
  }

  private async handleMessage(message: ChatWebviewToHost): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          await this.sendInit();
          break;
        case "newSession":
          await this.newSession();
          break;
        case "openSession":
          await this.openSession(message.sessionId);
          break;
        case "deleteSession": {
          // The webview sandbox has no modals (window.confirm is a no-op): confirm here.
          const title = this.findSession(message.sessionId)?.title ?? "this chat";
          const choice = await vscode.window.showWarningMessage(`Delete "${title}"? This cannot be undone.`, { modal: true }, "Delete");
          if (choice === "Delete") await this.removeSession(message.sessionId);
          break;
        }
        case "renameSession":
          await this.renameSession(message.sessionId, message.title);
          break;
        case "sendMessage":
          await this.sendChat(message.sessionId, message.content);
          break;
        case "attachFiles":
          await this.attachFiles(message.sessionId);
          break;
        case "removeAttachment":
          await this.removeAttachment(message.sessionId, message.documentId);
          break;
        case "removeContextBlock":
          this.pendingContextBlocks = this.pendingContextBlocks.filter((b) => b.id !== message.id);
          this.broadcastContextBlocks();
          break;
        case "cancelMessage":
          await this.cancelTurn(message.sessionId);
          break;
        case "resolveApproval":
          await this.resolveApprovalFromPanel(message.sessionId, message.messageId, message.approvalId, message.decision, message.response);
          break;
        case "cancelGraph":
          await this.cancelGraph(message.graphId, message.messageId);
          break;
        case "retryWithModel":
          await this.retryWithModel(message.sessionId, message.messageId, message.provider, message.model, message.content);
          break;
        case "setOverrides":
          await this.updateOverrides(message.sessionId, message.overrides);
          break;
        case "autoResolveApprovals":
          await this.resolveApprovalModeOffer(message.sessionId, message.ids);
          break;
        case "dismissApprovalModeOffer":
          if (this.approvalModeOffer?.sessionId === message.sessionId) this.setApprovalModeOffer(null);
          break;
        case "setSessionKind":
          await this.updateSessionKind(message.sessionId, message.kind);
          break;
        case "generatePipeline":
          await this.generatePipeline(message.sessionId, message.featureName);
          break;
        case "consumePipelineCard":
          this.markPipelineCardConsumed(message.sessionId, message.messageId);
          break;
        case "refreshCatalog":
          await this.refreshCatalog();
          break;
        case "refreshSessions":
          await this.refreshConversations();
          break;
        case "updateSetting":
          await writeSetting(message.key as keyof LiberideSettings, message.value as LiberideSettings[keyof LiberideSettings]);
          break;
        case "openSettings":
          this.broadcast({ type: "openSettings" });
          break;
        case "openPipeline":
          await vscode.commands.executeCommand("liberide.openPipeline", { conversationId: this.activeConversationId() });
          break;
        case "resolveNodeApproval":
          await this.resolveGraphNodeApproval(message.sessionId, message.graphId, message.nodeId, message.decision);
          break;
        case "resolveRunApproval":
          await this.resolveRunApproval(message.sessionId, message.approvalId, message.decision);
          break;
        case "replayNode":
          await vscode.commands.executeCommand("liberide.replayFromNode", { graphId: message.graphId, nodeId: message.nodeId });
          break;
        case "loadRunToolCalls":
          await this.loadRunToolCalls(message.sessionId, message.runId);
          break;
        case "copilotGithubLogin":
          await this.copilotGithubLogin();
          break;
        case "revealFile":
          await this.revealFile(message.path, message.root);
          break;
        case "undoEdits":
          await this.undoEdits(message.sessionId, message.files);
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[chat] ${msg}`);
      this.broadcast({ type: "log", message: msg });
    }
  }

  // ---------------------------------------------------------------------------
  // Initialisation: project, catalog, conversations
  // ---------------------------------------------------------------------------

  private async sendInit(): Promise<void> {
    this.project = await detectProjectIdentity();
    await this.refreshCatalog();
    await this.ensureProjectFolder();
    await this.refreshConversations();
    if (!this.activeSession()) {
      this.draftSession = this.makeDraft();
      this.activeSessionId = this.draftSession.id;
      await this.persistActive();
    }
    this.broadcast({
      type: "init",
      settings: readSettings(),
      sessions: this.sessionSummaries(),
      activeSessionId: this.activeSessionId,
      activeSession: this.activeSession(),
      project: this.projectInfo(),
      catalog: this.catalog,
      backendStatus: this.backendStatus,
      apiOrigin: getApiOrigin(),
    });
    if (this.activeSessionId) void this.attachRunningTurn(this.activeSessionId);
    if (this.pendingReveal?.sessionId === this.activeSessionId) this.broadcast(this.pendingReveal);
    this.pendingReveal = undefined;
  }

  private async refreshCatalog(): Promise<void> {
    this.lastCatalogRefresh = Date.now();
    const reachability = await probeBackend();
    if (reachability === "unconfigured") {
      this.backendStatus = "unconfigured";
      this.catalog = emptyCatalog();
      this.broadcast({ type: "catalog", catalog: this.catalog, backendStatus: this.backendStatus });
      return;
    }
    if (reachability === "unauthorized") {
      this.backendStatus = "unauthorized";
      this.catalog = emptyCatalog();
      this.broadcast({ type: "catalog", catalog: this.catalog, backendStatus: this.backendStatus });
      return;
    }
    if (reachability === "unreachable") {
      this.backendStatus = "unreachable";
      this.catalog = emptyCatalog();
      this.broadcast({ type: "catalog", catalog: this.catalog, backendStatus: this.backendStatus });
      return;
    }
    try {
      const [config, documents] = await Promise.all([fetchConfig(), listDocuments().catch(() => [])]);
      this.catalog = catalogFromConfig(config, documents);
      this.backendHasCopilotModels = (config.configuredModels ?? []).some(
        (m) => m.provider === "copilot" && m.enabled !== false,
      );
      // Merge locally-available Copilot LM models (VS Code vendor provider) into the catalog.
      // Only used as a fallback when the backend exposes no Copilot models, so the picker
      // doesn't show duplicates and backend-routed Copilot models aren't bypassed.
      try {
        if (!readSettings().copilotModelsEnabled) throw new Error("Copilot LM disabled");
        if (this.backendHasCopilotModels) throw new Error("Copilot models provided by backend");
        const localCopilot = await listCopilotLmModels();
        const merged = new Map<string, (typeof this.catalog.models)[number]>();
        for (const m of this.catalog.models) merged.set(`${m.provider}:${m.modelId}`, m);
        for (const m of localCopilot) merged.set(`${m.provider}:${m.modelId}`, m);
        this.catalog.models = [...merged.values()];
      } catch {
        // Ignore if VS Code LM API is unavailable or Copilot provider isn't active.
      }
      this.backendStatus = "ok";
      await this.ensureProjectFolder();
    } catch (err) {
      this.output.appendLine(`[chat.catalog] ${err instanceof Error ? err.message : String(err)}`);
      this.catalog = emptyCatalog();
      this.backendStatus = "unreachable";
    }
    this.broadcast({ type: "catalog", catalog: this.catalog, backendStatus: this.backendStatus });
  }

  private async ensureProjectFolder(): Promise<void> {
    if (this.backendStatus !== "ok") return;
    if (this.project.source === "none") {
      this.projectFolder = undefined;
      this.projectFolderId = null;
      return;
    }
    const folderName = projectFolderName(this.project);
    try {
      const folders = await listFolders("mine");
      let folder = folders.find((f) => f.name === folderName);
      if (!folder) {
        folder = await createFolder({ name: folderName, icon: this.project.source === "git" ? "git" : "folder" });
      }
      this.projectFolder = folder;
      this.projectFolderId = folder.id;
    } catch (err) {
      this.output.appendLine(`[chat.folder] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private conversationBelongsToProject(conv: Conversation): boolean {
    if (this.project.source === "none") return true;
    const folderName = projectFolderName(this.project);
    if (conv.folder === folderName) return true;
    if (this.projectFolderId && conv.folderIds?.includes(this.projectFolderId)) return true;
    if (conversationHasProjectTag(this.project, conv.tags)) return true;
    return false;
  }

  private conversationFullyAssignedToProject(conv: Conversation): boolean {
    if (!this.projectFolderId) return false;
    const folderName = projectFolderName(this.project);
    return conv.folder === folderName && Boolean(conv.folderIds?.includes(this.projectFolderId));
  }

  private async syncProjectConversations(all: Conversation[]): Promise<void> {
    if (this.project.source === "none" || this.backendStatus !== "ok") return;
    await this.ensureProjectFolder();
    if (!this.projectFolderId) return;

    for (const conv of all) {
      if (!this.conversationBelongsToProject(conv)) continue;
      if (this.conversationFullyAssignedToProject(conv)) continue;
      try {
        const updated = await this.assignConversationToProject(conv);
        if (updated) {
          const index = all.findIndex((item) => item.id === conv.id);
          if (index >= 0) all[index] = updated;
        }
      } catch (err) {
        this.output.appendLine(`[chat.sync] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async refreshConversations(): Promise<void> {
    if (this.disposed) return;
    if (this.backendStatus !== "ok") {
      this.broadcastSessions();
      return;
    }
    try {
      const all = await listConversations();
      if (this.disposed) return;
      await this.syncProjectConversations(all);
      const owned = all.filter((c) => this.conversationBelongsToProject(c) || this.openedConversations.has(c.id));
      const previous = new Map(this.conversations);
      this.conversations.clear();
      for (const c of owned) this.conversations.set(c.id, this.keepModelWhileStreaming(c, previous.get(c.id)));

      const keptIds = buildKeptConversationIds(
        owned.map((c) => c.id),
        this.activeSessionId,
        this.draftSession?.id,
      );
      pruneConversationCaches(keptIds, {
        messagesCache: this.messagesCache,
        overrides: this.overrides,
        sessionKinds: this.sessionKinds,
        consumedPipelineCards: this.consumedPipelineCards,
        attachmentBytes: this.attachmentBytes,
      });
      for (const id of [...this.agentRuns.keys(), ...this.agentStreams.keys()]) {
        if (!keptIds.has(id)) this.forgetAgentRuns(id);
      }
      void this.persistSessionKinds();
      void this.context.workspaceState.update(OVERRIDES_STORAGE_KEY, this.overrides);

      if (this.activeSessionId && this.activeSessionId.startsWith("draft:")) {
        // keep current draft
      } else if (!this.activeSessionId || !this.conversations.has(this.activeSessionId)) {
        const next = [...this.conversations.values()].sort((a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )[0];
        this.activeSessionId = next?.id ?? null;
        await this.persistActive();
      }
    } catch (err) {
      this.output.appendLine(`[chat.conversations] ${err instanceof Error ? err.message : String(err)}`);
    }
    this.broadcastSessions();
    if (this.activeSessionId && this.conversations.has(this.activeSessionId)) {
      await this.ensureMessagesLoaded(this.activeSessionId);
      this.broadcastActiveSession();
    }
  }

  private async ensureMessagesLoaded(conversationId: string): Promise<void> {
    if (this.messagesCache.has(conversationId)) {
      // Re-insert to mark as most-recently-used for LRU eviction.
      const cached = this.messagesCache.get(conversationId)!;
      this.messagesCache.delete(conversationId);
      this.messagesCache.set(conversationId, cached);
      return;
    }
    // Evict the oldest entry when the cache is at capacity.
    if (this.messagesCache.size >= LiberideChatPanelController.MAX_CACHED_CONVERSATIONS) {
      const oldest = this.messagesCache.keys().next().value;
      if (oldest) this.messagesCache.delete(oldest);
    }
    try {
      const messages = await listConversationMessages(conversationId);
      this.messagesCache.set(conversationId, messages);
      this.afterMessagesLoaded(conversationId);
    } catch (err) {
      this.output.appendLine(`[chat.messages] ${err instanceof Error ? err.message : String(err)}`);
      this.messagesCache.set(conversationId, []);
    }
  }

  /** Start graph watchers and fetch approval details for freshly loaded messages. */
  private afterMessagesLoaded(conversationId: string): void {
    const messages = this.messagesCache.get(conversationId) ?? [];
    this.mergeAnchorRuns(conversationId, messages);
    if (!this.hydratedAgentRuns.has(conversationId)) {
      this.hydratedAgentRuns.add(conversationId);
      void this.hydrateAgentRuns(conversationId);
      void this.hydrateRunApprovals(conversationId);
    }
    for (const m of messages) {
      if (m.role !== "assistant" || !m.executionGraphId) continue;
      // The server posted the graph's own message: move a local placeholder's card onto it.
      const watcher = this.graphWatchers.get(m.executionGraphId);
      if (watcher && watcher.conversationId === conversationId && watcher.messageId !== m.id) {
        const view = this.graphViews.get(watcher.messageId);
        if (view && !this.graphViews.has(m.id)) this.graphViews.set(m.id, view);
        this.graphViews.delete(watcher.messageId);
        watcher.messageId = m.id;
      }
      if (m.graphStatus && isTerminalGraphStatus(m.graphStatus)) {
        this.finishedGraphs.add(m.executionGraphId);
        const view = this.graphViews.get(m.id);
        if (view) view.status = m.graphStatus;
        continue;
      }
      this.watchGraph(conversationId, m.id, m.executionGraphId);
    }
    const needsApprovals = messages.some((m) => m.approvalId && m.status === "awaiting_approval" && !this.approvalCards.has(m.id));
    if (needsApprovals && !this.hydratedApprovalConversations.has(conversationId)) {
      this.hydratedApprovalConversations.add(conversationId);
      void this.hydrateApprovals(conversationId);
    }
  }

  private async hydrateApprovals(conversationId: string): Promise<void> {
    try {
      const approvals = await listConversationApprovals(conversationId);
      const byId = new Map(approvals.map((a) => [a.id, a] as const));
      for (const m of this.messagesCache.get(conversationId) ?? []) {
        const request = m.approvalId ? byId.get(m.approvalId) : undefined;
        if (!request) continue;
        const existing = this.approvalCards.get(m.id);
        this.approvalCards.set(m.id, { ...approvalCardFrom(request), busy: existing?.busy, error: existing?.error });
      }
      if (this.activeSessionId === conversationId) this.broadcastActiveSession();
    } catch (err) {
      // Details are optional; the card still works with just the approval id.
      this.hydratedApprovalConversations.delete(conversationId);
      this.output.appendLine(`[chat.approvals] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Agent runs: every run of a chat is drawn in it (graph nodes, sub-agents,
  // background agents), with its live output, tool calls and result/error.
  // ---------------------------------------------------------------------------

  private runsOf(conversationId: string): Map<string, AgentRunView> {
    let runs = this.agentRuns.get(conversationId);
    if (!runs) {
      runs = new Map();
      this.agentRuns.set(conversationId, runs);
    }
    return runs;
  }

  /** Fold the server's anchor cards (one message per run) into the run state. */
  private mergeAnchorRuns(conversationId: string, messages: ConversationMessage[]): void {
    let runs: Map<string, AgentRunView> | undefined;
    for (const m of messages) {
      const anchor = agentRunFromAnchor(m);
      if (!anchor) continue;
      runs ??= this.runsOf(conversationId);
      runs.set(anchor.runId, mergeAgentRun(runs.get(anchor.runId), anchor));
    }
    if (runs) this.syncAgentStream(conversationId);
  }

  private async hydrateAgentRuns(conversationId: string): Promise<void> {
    try {
      const list = await listConversationAgentRuns(conversationId);
      if (this.disposed) return;
      if (list.length) {
        const runs = this.runsOf(conversationId);
        for (const run of list) {
          runs.set(run.runId, mergeAgentRun(runs.get(run.runId), run));
          this.markAgentRunChanged(conversationId, run.runId);
        }
      }
      this.syncAgentStream(conversationId);
    } catch (err) {
      // Older servers have no run list: anchors and live events still work.
      this.output.appendLine(`[chat.agent-runs] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Pending approvals raised by the chat's agent runs (turn approvals have their own card). */
  private async hydrateRunApprovals(conversationId: string): Promise<void> {
    try {
      const approvals = await listConversationApprovals(conversationId);
      if (this.disposed) return;
      const turnApprovals = new Set((this.messagesCache.get(conversationId) ?? []).map((m) => m.approvalId).filter(Boolean));
      const previous = new Map((this.runApprovals.get(conversationId) ?? []).map((a) => [a.id, a] as const));
      const pending: RunApprovalView[] = approvals
        .filter((a) => a.status === "pending" && !turnApprovals.has(a.id))
        .map((a) => ({ ...approvalCardFrom(a), agentRunId: a.agentRunId, busy: previous.get(a.id)?.busy, error: previous.get(a.id)?.error }));
      if (pending.length) this.runApprovals.set(conversationId, pending);
      else this.runApprovals.delete(conversationId);
      this.broadcast({ type: "runApprovals", sessionId: conversationId, approvals: pending });
    } catch (err) {
      this.output.appendLine(`[chat.run-approvals] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** `agent_run_updated`: a run of a chat changed status (live output comes from the agents stream). */
  private onAgentRunUpdated(event: ConversationListEvent): void {
    const conversationId = event.conversationId;
    if (!conversationId) return;
    if (!this.messagesCache.has(conversationId) && conversationId !== this.activeSessionId) return;
    if (!event.runId) {
      // A node of the chat's graph moved before it has a run: the graph card
      // follows the graph itself; load the graph's message if it is new here.
      const known = event.graphId && (this.messagesCache.get(conversationId) ?? []).some((m) => m.executionGraphId === event.graphId);
      if (event.graphId && !known) this.scheduleConversationRefresh(conversationId);
      return;
    }
    const runs = this.runsOf(conversationId);
    const known = runs.get(event.runId);
    const status = event.status ?? known?.status ?? "running";
    runs.set(event.runId, mergeAgentRun(known, {
      runId: event.runId,
      status,
      text: "",
      toolCalls: [],
      ...(event.graphId ? { graphId: event.graphId } : {}),
      ...(event.nodeId ? { nodeId: event.nodeId } : {}),
      ...(event.parentRunId ? { parentRunId: event.parentRunId } : {}),
      ...(event.messageId ? { messageId: event.messageId } : {}),
    }));
    this.markAgentRunChanged(conversationId, event.runId);
    this.syncAgentStream(conversationId, isActiveAgentRunStatus(status));
    // A new anchor card, or a finished run's final excerpt: reload the messages.
    const hasAnchor = event.messageId && (this.messagesCache.get(conversationId) ?? []).some((m) => m.id === event.messageId);
    if (!known || !hasAnchor || !isActiveAgentRunStatus(status)) this.scheduleConversationRefresh(conversationId);
  }

  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Coalesce reloads triggered by bursts of run events. */
  private scheduleConversationRefresh(conversationId: string): void {
    if (this.refreshTimers.has(conversationId)) return;
    this.refreshTimers.set(conversationId, setTimeout(() => {
      this.refreshTimers.delete(conversationId);
      if (this.messagesCache.has(conversationId)) void this.refreshSingleConversation(conversationId);
    }, 400));
  }

  /**
   * Keep the conversation's agents stream open while any run is active
   * (`force`: a run just started), and close it a while after the last one ends.
   */
  private syncAgentStream(conversationId: string, force = false): void {
    if (this.disposed || conversationId.startsWith("draft:")) return;
    const runs = this.agentRuns.get(conversationId);
    const active = force || [...(runs?.values() ?? [])].some((run) => isActiveAgentRunStatus(run.status));
    const existing = this.agentStreams.get(conversationId);
    if (active) {
      if (existing?.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = undefined;
      }
      if (existing || this.backendStatus !== "ok") return;
      const state: AgentStreamState = { connected: true, dispose: () => undefined };
      this.agentStreams.set(conversationId, state);
      state.dispose = subscribeConversationAgents(conversationId, (event) => {
        if (this.disposed) return;
        const changed = applyAgentStreamEvent(this.runsOf(conversationId), event);
        for (const runId of changed) this.markAgentRunChanged(conversationId, runId);
        if (event.type === "status" && !isActiveAgentRunStatus(event.status)) this.scheduleConversationRefresh(conversationId);
        if (event.type === "snapshot" || event.type === "status") this.syncAgentStream(conversationId);
      }, {
        onConnectionChange: (connected) => {
          if (state.connected === connected) return;
          state.connected = connected;
          this.broadcast({ type: "agentRuns", sessionId: conversationId, runs: [], connected });
        },
        log: (message) => this.output.appendLine(`[chat.agents] ${message}`),
      });
      return;
    }
    if (!existing || existing.idleTimer) return;
    existing.idleTimer = setTimeout(() => {
      existing.idleTimer = undefined;
      const stillActive = [...(this.agentRuns.get(conversationId)?.values() ?? [])].some((run) => isActiveAgentRunStatus(run.status));
      if (stillActive || this.agentStreams.get(conversationId) !== existing) return;
      existing.dispose();
      this.agentStreams.delete(conversationId);
      if (!existing.connected) this.broadcast({ type: "agentRuns", sessionId: conversationId, runs: [], connected: true });
    }, AGENT_STREAM_IDLE_MS);
  }

  /** Batch run updates to the webview (streamed text arrives token by token). */
  private markAgentRunChanged(conversationId: string, runId: string): void {
    let changed = this.agentRunChanges.get(conversationId);
    if (!changed) {
      changed = new Set();
      this.agentRunChanges.set(conversationId, changed);
    }
    changed.add(runId);
    if (this.agentRunFlushTimer) return;
    this.agentRunFlushTimer = setTimeout(() => {
      this.agentRunFlushTimer = undefined;
      const pending = [...this.agentRunChanges];
      this.agentRunChanges.clear();
      for (const [id, runIds] of pending) {
        const runs = this.agentRuns.get(id);
        if (!runs) continue;
        const views = [...runIds].map((runId) => runs.get(runId)).filter((run): run is AgentRunView => Boolean(run));
        if (views.length) this.broadcast({ type: "agentRuns", sessionId: id, runs: views.map((run) => ({ ...run, toolCalls: [...run.toolCalls] })), connected: this.agentStreams.get(id)?.connected ?? true });
      }
    }, 100);
  }

  /** Tool calls of a finished run (the stream only carries those it saw live). */
  private async loadRunToolCalls(conversationId: string, runId: string): Promise<void> {
    const run = this.agentRuns.get(conversationId)?.get(runId);
    if (!run) return;
    try {
      const calls = await listAgentRunToolCalls(runId);
      run.toolCalls = mergeAgentRun({ ...run, toolCalls: [] }, { ...run, toolCalls: [...calls, ...run.toolCalls] }).toolCalls;
      this.markAgentRunChanged(conversationId, runId);
    } catch (err) {
      this.output.appendLine(`[chat.tool-calls] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private forgetAgentRuns(conversationId: string): void {
    const stream = this.agentStreams.get(conversationId);
    if (stream) {
      stream.dispose();
      if (stream.idleTimer) clearTimeout(stream.idleTimer);
      this.agentStreams.delete(conversationId);
    }
    this.agentRuns.delete(conversationId);
    this.hydratedAgentRuns.delete(conversationId);
    this.runApprovals.delete(conversationId);
    this.localNotes.delete(conversationId);
    this.pendingGraphAnchors.delete(conversationId);
  }

  /** Approve/reject a graph APPROVAL node from its step in the graph card. */
  private async resolveGraphNodeApproval(
    conversationId: string,
    graphId: string,
    nodeId: string,
    decision: "approved" | "rejected",
  ): Promise<void> {
    try {
      await resolveNodeApproval(graphId, nodeId, decision);
    } catch (err) {
      this.postNote(conversationId, `Could not ${decision === "approved" ? "approve" : "reject"} the step: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  /** Approve/reject an approval raised by an agent run; the server continues the run. */
  private async resolveRunApproval(conversationId: string, approvalId: string, decision: "approved" | "rejected"): Promise<void> {
    const cards = this.runApprovals.get(conversationId) ?? [];
    const card = cards.find((c) => c.id === approvalId);
    const publish = () => this.broadcast({ type: "runApprovals", sessionId: conversationId, approvals: this.runApprovals.get(conversationId) ?? [] });
    if (card) {
      card.busy = true;
      card.error = undefined;
      publish();
    }
    try {
      await resolveApproval(approvalId, decision, undefined, "server");
      const rest = (this.runApprovals.get(conversationId) ?? []).filter((c) => c.id !== approvalId);
      if (rest.length) this.runApprovals.set(conversationId, rest);
      else this.runApprovals.delete(conversationId);
    } catch (err) {
      if (card) {
        card.busy = false;
        card.error = err instanceof Error ? err.message : String(err);
      }
      if (err instanceof ChatStreamError && err.details.status === 404) void this.hydrateRunApprovals(conversationId);
    }
    publish();
  }

  /** While a turn streams, a list refresh keeps the chip's model (the turn may still change it). */
  private keepModelWhileStreaming(next: Conversation, previous: Conversation | undefined): Conversation {
    if (!previous || !this.streams.has(next.id)) return next;
    return { ...next, provider: previous.provider, model: previous.model, modelSelection: previous.modelSelection };
  }

  // ---------------------------------------------------------------------------
  // ChatRunLink: the pipeline, Runs view and workflow triggers report here
  // ---------------------------------------------------------------------------

  async ensureConversation(title: string): Promise<string | undefined> {
    const active = this.activeConversationId();
    if (active) return active;
    if (this.backendStatus !== "ok") await this.refreshCatalog();
    if (this.backendStatus !== "ok") return undefined;
    const draft = this.draftSession;
    const conversation = await this.createSessionConversation(title, draft?.overrides ?? {});
    if (!conversation) return undefined;
    this.conversations.set(conversation.id, conversation);
    this.messagesCache.set(conversation.id, []);
    this.hydratedAgentRuns.add(conversation.id);
    if (draft && this.activeSessionId === draft.id) {
      this.sessionKinds.set(conversation.id, this.sessionKinds.get(draft.id) ?? draft.kind);
      this.sessionKinds.delete(draft.id);
      this.draftSession = null;
      await this.persistSessionKinds();
    }
    this.activeSessionId = conversation.id;
    await this.persistActive();
    this.broadcastSessions();
    this.broadcastActiveSession();
    return conversation.id;
  }

  conversationForGraph(graphId: string): string | undefined {
    for (const [conversationId, messages] of this.messagesCache) {
      if (messages.some((m) => m.executionGraphId === graphId)) return conversationId;
    }
    const watcher = this.graphWatchers.get(graphId);
    if (watcher) return watcher.conversationId;
    for (const [conversationId, runs] of this.agentRuns) {
      for (const run of runs.values()) if (run.graphId === graphId) return conversationId;
    }
    return graphConversation(this.context.workspaceState, graphId);
  }

  async trackGraph(conversationId: string, graphId: string): Promise<void> {
    await linkGraphConversation(this.context.workspaceState, graphId, conversationId);
    if (!this.conversations.has(conversationId)) {
      this.openedConversations.add(conversationId);
      await this.refreshConversations();
    }
    await this.ensureMessagesLoaded(conversationId);
    const messages = this.messagesCache.get(conversationId) ?? [];
    let host = messages.find((m) => m.executionGraphId === graphId);
    if (!host) {
      // Shown right away; replaced by the server's graph message when it lands.
      host = {
        id: `local:graph:${graphId}`,
        conversationId,
        role: "assistant",
        content: "",
        executionGraphId: graphId,
        createdAt: new Date().toISOString(),
      };
      messages.push(host);
      this.messagesCache.set(conversationId, messages);
      this.pendingGraphAnchors.set(conversationId, [...(this.pendingGraphAnchors.get(conversationId) ?? []), host]);
    }
    this.watchGraph(conversationId, host.id, graphId);
    await this.showConversation(conversationId);
    this.scheduleConversationRefresh(conversationId);
  }

  async showConversation(conversationId: string): Promise<void> {
    if (!this.conversations.has(conversationId)) this.openedConversations.add(conversationId);
    this.show();
    if (this.activeSessionId !== conversationId) {
      this.activeSessionId = conversationId;
      await this.persistActive();
    }
    if (this.view) await this.openSession(conversationId);
    this.scheduleConversationRefresh(conversationId);
  }

  async revealGraphNode(graphId: string, nodeId: string): Promise<boolean> {
    const conversationId = this.conversationForGraph(graphId);
    if (!conversationId) return false;
    await this.showConversation(conversationId);
    if (!this.graphWatchers.has(graphId) && !this.finishedGraphs.has(graphId)) {
      const host = (this.messagesCache.get(conversationId) ?? []).find((m) => m.executionGraphId === graphId);
      if (host) this.watchGraph(conversationId, host.id, graphId);
    }
    const reveal = { type: "revealGraphNode" as const, sessionId: conversationId, graphId, nodeId };
    // A view still loading gets it after `init`.
    if (this.view) this.broadcast(reveal);
    else this.pendingReveal = reveal;
    return true;
  }

  postNote(conversationId: string, text: string, severity: "info" | "warning" | "error" = "info"): void {
    const note: ChatMessage = {
      id: `local:note:${randomId()}`,
      role: "assistant",
      content: text,
      createdAt: Date.now(),
      status: "complete",
      note: severity,
    };
    const notes = [...(this.localNotes.get(conversationId) ?? []), note].slice(-50);
    this.localNotes.set(conversationId, notes);
    if (this.activeSessionId === conversationId) this.broadcastActiveSession();
  }

  // ---------------------------------------------------------------------------
  // Session view models
  // ---------------------------------------------------------------------------

  private makeDraft(): ChatSession {
    const now = Date.now();
    const id = `draft:${randomId()}`;
    const kind: ChatSession["kind"] = "vibe";
    this.sessionKinds.set(id, kind);
    void this.persistSessionKinds();
    return {
      id,
      title: "New chat",
      messages: [],
      overrides: {},
      remote: false,
      createdAt: now,
      updatedAt: now,
      kind,
    };
  }

  private sessionSummaries(): SessionSummary[] {
    const summaries: SessionSummary[] = [];
    if (this.draftSession) {
      summaries.push({
        id: this.draftSession.id,
        title: this.draftSession.title,
        updatedAt: this.draftSession.updatedAt,
        messageCount: this.draftSession.messages.length,
        overrides: this.draftSession.overrides,
        remote: false,
        kind: this.draftSession.kind,
      });
    }
    for (const c of this.conversations.values()) {
      summaries.push({
        id: c.id,
        conversationId: c.id,
        title: c.title || "Untitled",
        updatedAt: new Date(c.updatedAt).getTime() || Date.now(),
        messageCount: this.messagesCache.get(c.id)?.length ?? 0,
        overrides: this.conversationOverrides(c),
        remote: true,
        kind: this.sessionKinds.get(c.id) ?? "vibe",
      });
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
  }

  private activeSession(): ChatSession | null {
    if (!this.activeSessionId) return null;
    if (this.activeSessionId.startsWith("draft:")) return this.draftSession;
    const conv = this.conversations.get(this.activeSessionId);
    if (!conv) return null;
    return this.sessionFromConversation(conv);
  }

  private sessionFromConversation(conv: Conversation): ChatSession {
    const cached = this.messagesCache.get(conv.id) ?? [];
    const consumed = this.consumedPipelineCards.get(conv.id);
    const messages: ChatMessage[] = cached
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => {
        const turnStatus = m.status ?? this.localTurnStatus.get(m.id);
        const streaming = this.streams.get(conv.id);
        const base: ChatMessage = {
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.role === "user" ? m.displayContent ?? m.content : m.content,
          createdAt: new Date(m.createdAt).getTime() || Date.now(),
          status: streaming?.messageId === m.id ? "streaming" : turnStatus === "failed" ? "error" : "complete",
        };
        if (streaming?.messageId === m.id) {
          base.startedAt = streaming.startedAt;
          base.tools = [...streaming.tools.values()];
          base.editedFiles = [...streaming.edits.values()];
        }
        if (m.role === "assistant") this.decorateAssistantMessage(base, m, turnStatus);
        if (consumed?.has(m.id)) base.pipelineCardConsumed = true;
        return base;
      });
    const notes = this.localNotes.get(conv.id) ?? [];
    for (const note of notes) {
      // Notes go in time order between the server's messages.
      const index = messages.findIndex((m) => m.createdAt > note.createdAt);
      if (index < 0) messages.push(note);
      else messages.splice(index, 0, note);
    }
    const kind = this.sessionKinds.get(conv.id) ?? "vibe";
    const runs = this.agentRuns.get(conv.id);
    const routed = [...cached].reverse().find((m) => m.role === "assistant" && m.model && m.model !== "auto" && !agentRunFromAnchor(m));
    return {
      id: conv.id,
      conversationId: conv.id,
      title: conv.title || "Untitled",
      messages,
      overrides: this.conversationOverrides(conv),
      remote: true,
      createdAt: new Date(conv.createdAt).getTime() || Date.now(),
      updatedAt: new Date(conv.updatedAt).getTime() || Date.now(),
      kind,
      ...(routed ? { routedModel: { provider: routed.provider, model: routed.model } } : {}),
      ...(runs?.size ? { agentRuns: [...runs.values()] } : {}),
      ...(this.runApprovals.get(conv.id)?.length ? { runApprovals: this.runApprovals.get(conv.id) } : {}),
      agentsConnected: this.agentStreams.get(conv.id)?.connected ?? true,
    };
  }

  private decorateAssistantMessage(
    view: ChatMessage,
    m: ConversationMessage,
    turnStatus: ConversationMessage["status"],
  ): void {
    if (turnStatus) view.turnStatus = turnStatus;
    if (m.error) view.error = m.error;
    const anchor = agentRunFromAnchor(m);
    if (anchor) view.agentRunId = anchor.runId;
    if (m.model) view.model = { provider: m.provider, model: m.model };
    const warnings = [...new Set([...(m.warnings ?? []), ...(this.turnWarnings.get(m.id) ?? [])])];
    if (warnings.length) view.warnings = warnings;
    const thinking = this.thinkingByMessage.get(m.id);
    if (thinking) view.thinking = thinking;
    const fallback = this.fallbacks.get(m.id);
    if (fallback) view.fallback = fallback;

    let approval = this.approvalCards.get(m.id);
    if (!approval && m.approvalId && turnStatus === "awaiting_approval") {
      approval = { id: m.approvalId, action: "Approval required", status: "pending" };
    }
    if (approval && turnStatus === "resolved" && approval.status === "pending" && !approval.busy) {
      approval = { ...approval, status: m.resolution === "rejected" ? "rejected" : "approved" };
    }
    if (approval) view.approval = approval;

    const graph = this.graphViews.get(m.id);
    if (graph) {
      view.graph = m.graphStatus && isTerminalGraphStatus(m.graphStatus) ? { ...graph, status: m.graphStatus, reconnecting: false } : graph;
    } else if (m.executionGraphId) {
      view.graph = { graphId: m.executionGraphId, status: m.graphStatus ?? "running", steps: [] };
    }
  }

  private markPipelineCardConsumed(conversationId: string, messageId: string): void {
    let set = this.consumedPipelineCards.get(conversationId);
    if (!set) {
      set = new Set<string>();
      this.consumedPipelineCards.set(conversationId, set);
    }
    if (set.has(messageId)) return;
    set.add(messageId);
    this.broadcastSessions();
    if (this.activeSessionId === conversationId) this.broadcastActiveSession();
  }

  private conversationOverrides(conv: Conversation): ChatOverrides {
    const stored = this.overrides[conv.id] ?? {};
    const settings = readSettings();
    const defaultAllowed = resolveAllowedAgentIds(this.catalog.agents, settings.defaultAllowedAgentIds);
    const model = conv.model ?? stored.model;
    return {
      provider: (conv.provider as ConfiguredProvider) ?? stored.provider,
      model,
      // The conversation's own mode (set here or on the web) wins over the local default.
      modelSelection: effectiveModelSelection(conv.modelSelection ?? stored.modelSelection, model, settings.modelSelection),
      chatMode: "agent",
      useRag: stored.useRag,
      toolsEnabled: true,
      agentId: conv.agentId ?? stored.agentId,
      allowedAgentIds: conv.allowedAgentIds?.length
        ? conv.allowedAgentIds
        : (stored.allowedAgentIds?.length ? stored.allowedAgentIds : defaultAllowed),
      skillIds: stored.skillIds,
      mcpServerIds: stored.mcpServerIds,
      documentIds: stored.documentIds ?? [],
      // The server's value wins (another surface may have changed it).
      approvalMode: conversationApprovalMode(conv),
    };
  }

  private projectInfo(): ProjectInfo {
    return {
      id: this.project.id,
      source: this.project.source,
      name: this.project.name,
      remoteUrl: this.project.remoteUrl,
      branch: this.project.branch,
      rootPath: this.project.rootPath,
      folderName: projectFolderName(this.project),
      workspaceIntelligence: this.project.rootPath ? getWorkspaceIntelligence(this.project.rootPath) : undefined,
    };
  }

  private async persistActive(): Promise<void> {
    this.publishActiveContext();
    await this.context.workspaceState.update(ACTIVE_SESSION_STORAGE_KEY, this.activeSessionId);
  }

  /** Enables "Continue in Browser" while a saved conversation is active. */
  private publishActiveContext(): void {
    void vscode.commands.executeCommand("setContext", "liberide.hasActiveConversation", Boolean(this.activeSessionId && !this.activeSessionId.startsWith("draft:")));
  }

  private async persistOverrides(): Promise<void> {
    await this.context.workspaceState.update(OVERRIDES_STORAGE_KEY, this.overrides);
  }

  private async persistSessionKinds(): Promise<void> {
    await this.context.workspaceState.update("liberide.chat.sessionKinds", Object.fromEntries(this.sessionKinds));
  }

  // ---------------------------------------------------------------------------
  // Session operations
  // ---------------------------------------------------------------------------

  private async openSession(id: string): Promise<void> {
    if (id.startsWith("draft:")) {
      if (!this.draftSession || this.draftSession.id !== id) this.draftSession = this.makeDraft();
      this.activeSessionId = this.draftSession.id;
      await this.persistActive();
      this.broadcastSessions();
      this.broadcastActiveSession();
      return;
    }
    if (!this.conversations.has(id)) {
      await this.refreshConversations();
      if (!this.conversations.has(id)) return;
    }
    this.activeSessionId = id;
    await this.persistActive();
    await this.ensureMessagesLoaded(id);
    this.broadcastSessions();
    this.broadcastActiveSession();
    void this.attachRunningTurn(id);
  }

  private async removeSession(id: string): Promise<void> {
    if (id.startsWith("draft:")) {
      if (this.draftSession?.id === id) {
        this.sessionKinds.delete(id);
        await this.persistSessionKinds();
        this.draftSession = null;
        if (this.activeSessionId === id) this.activeSessionId = null;
      }
    } else if (this.conversations.has(id)) {
      try {
        await deleteConversation(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`[chat.delete] ${message}`);
        this.broadcast({ type: "log", message: `Could not delete chat: ${message}`, severity: "error" });
        return;
      }
      this.conversations.delete(id);
      this.messagesCache.delete(id);
      delete this.overrides[id];
      this.sessionKinds.delete(id);
      this.consumedPipelineCards.delete(id);
      this.forgetAgentRuns(id);
      await this.persistOverrides();
      await this.persistSessionKinds();
      if (this.activeSessionId === id) this.activeSessionId = null;
    }
    if (!this.activeSessionId) {
      const next = [...this.conversations.values()].sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )[0];
      this.activeSessionId = next?.id ?? null;
      if (!this.activeSessionId) {
        this.draftSession = this.makeDraft();
        this.activeSessionId = this.draftSession.id;
      }
    }
    await this.persistActive();
    this.broadcastSessions();
    this.broadcastActiveSession();
  }

  private async renameSession(id: string, title: string): Promise<void> {
    const trimmed = title.trim() || "Untitled";
    if (id.startsWith("draft:") && this.draftSession?.id === id) {
      this.draftSession.title = trimmed;
      this.draftSession.updatedAt = Date.now();
    } else if (this.conversations.has(id)) {
      try {
        const updated = await patchConversation(id, { title: trimmed });
        this.conversations.set(id, updated);
      } catch (err) {
        this.output.appendLine(`[chat.rename] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.broadcastSessions();
    this.broadcastActiveSession();
  }

  private async updateSessionKind(id: string, kind: ChatSession["kind"]): Promise<void> {
    this.sessionKinds.set(id, kind);
    if (id.startsWith("draft:") && this.draftSession?.id === id) {
      this.draftSession.kind = kind;
      this.draftSession.updatedAt = Date.now();
    }
    await this.persistSessionKinds();
    this.broadcastSessions();
    this.broadcastActiveSession();
  }

  private broadcastContextBlocks(): void {
    this.broadcast({ type: "contextBlocks", blocks: toChips(this.pendingContextBlocks) });
  }

  private addContextBlock(block: ContextBlock): void {
    this.pendingContextBlocks.push(block);
    this.broadcastContextBlocks();
    this.show();
  }

  /** Attach the active editor selection (or whole line at cursor) as chat context. */
  async attachSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage("No active editor to attach a selection from.");
      return;
    }
    const sel = editor.selection;
    const range = sel.isEmpty ? editor.document.lineAt(sel.active.line).range : sel;
    const text = editor.document.getText(range);
    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    this.addContextBlock({
      id: randomId(),
      kind: "selection",
      label: `${rel}:${range.start.line + 1}-${range.end.line + 1}`,
      content: text,
      language: editor.document.languageId,
    });
  }

  /** Attach the active file's full contents as chat context. */
  async attachActiveFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage("No active editor to attach.");
      return;
    }
    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    this.addContextBlock({
      id: randomId(),
      kind: "file",
      label: rel,
      content: editor.document.getText(),
      language: editor.document.languageId,
    });
  }

  /** Pick a workspace file (the @-file mention) and attach its contents. */
  async attachFilePick(): Promise<void> {
    const uris = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,dist,out}/**", 2000);
    const pick = await vscode.window.showQuickPick(
      uris.map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u })),
      { placeHolder: "Attach a file as chat context" },
    );
    if (!pick) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(pick.uri);
      this.addContextBlock({
        id: randomId(),
        kind: "file",
        label: pick.label,
        content: new TextDecoder().decode(bytes),
        language: pick.label.split(".").pop(),
      });
    } catch (err) {
      void vscode.window.showErrorMessage(`Failed to read ${pick.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Attach the output of the active terminal's last shell execution. */
  async attachTerminalOutput(): Promise<void> {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      void vscode.window.showInformationMessage("No active terminal.");
      return;
    }
    // Shell integration doesn't expose history synchronously; capture the next
    // execution's output. Prompt the user to re-run their command.
    const note = await vscode.window.showInputBox({
      prompt: "Paste the terminal output to attach (shell history isn't readable via API)",
    });
    if (!note?.trim()) return;
    this.addContextBlock({ id: randomId(), kind: "terminal", label: terminal.name, content: note, language: "shell" });
  }

  /** Attach the working-tree git diff as chat context. */
  async attachGitDiff(): Promise<void> {
    try {
      const root = this.project.rootPath ?? activeWorkspaceFolder()?.uri.fsPath;
      if (!root) {
        void vscode.window.showInformationMessage("Open a workspace folder to attach its git diff.");
        return;
      }
      const { handleGitDiff } = await import("../ide-delegate/handlers/git");
      const result = (await handleGitDiff(root, {})) as { diff?: string };
      const diff = result.diff?.trim();
      if (!diff) {
        void vscode.window.showInformationMessage("No working-tree changes to attach.");
        return;
      }
      this.addContextBlock({ id: randomId(), kind: "diff", label: "working tree diff", content: diff, language: "diff" });
    } catch (err) {
      void vscode.window.showErrorMessage(`Failed to read git diff: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async attachFiles(sessionId: string): Promise<void> {
    if (this.backendStatus !== "ok") {
      this.broadcast({ type: "log", message: "Connect to the LiberIDE backend before attaching files." });
      return;
    }
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: "Attach to chat" });
    if (!uris?.length) return;

    const uploadedIds: string[] = [];
    for (const uri of uris) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const name = basename(uri.fsPath);
        const document = await uploadDocument({ name, bytes });
        uploadedIds.push(document.id);
        this.attachmentBytes.set(document.id, { data: bytes, mimeType: document.mimeType, name: document.name });
        if (!this.catalog.documents.some((entry) => entry.id === document.id)) {
          this.catalog = { ...this.catalog, documents: [document, ...this.catalog.documents] };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`[chat.attach] ${msg}`);
        this.broadcast({ type: "log", message: `Failed to attach ${basename(uri.fsPath)}: ${msg}` });
      }
    }
    if (!uploadedIds.length) return;

    const session = sessionId.startsWith("draft:") && this.draftSession?.id === sessionId
      ? this.draftSession
      : this.conversations.has(sessionId)
        ? this.sessionFromConversation(this.conversations.get(sessionId)!)
        : null;
    if (!session) return;

    const current = session.overrides.documentIds ?? [];
    await this.updateOverrides(sessionId, { documentIds: [...new Set([...current, ...uploadedIds])] });
    this.broadcast({ type: "catalog", catalog: this.catalog, backendStatus: this.backendStatus });
  }

  private async removeAttachment(sessionId: string, documentId: string): Promise<void> {
    const session = sessionId.startsWith("draft:") && this.draftSession?.id === sessionId
      ? this.draftSession
      : this.conversations.has(sessionId)
        ? this.sessionFromConversation(this.conversations.get(sessionId)!)
        : null;
    if (!session) return;
    const next = (session.overrides.documentIds ?? []).filter((id) => id !== documentId);
    await this.updateOverrides(sessionId, { documentIds: next });
    // Free the buffered file bytes so repeated attach/remove cycles don't leak memory.
    this.attachmentBytes.delete(documentId);
  }

  private async updateOverrides(id: string, overrides: ChatOverrides): Promise<void> {
    const normalizedOverrides: ChatOverrides = { ...overrides };
    delete normalizedOverrides.chatMode;
    delete normalizedOverrides.toolsEnabled;
    if (normalizedOverrides.approvalMode !== undefined) {
      // Lives on the conversation, not in the local overrides cache.
      const mode = normalizedOverrides.approvalMode;
      delete normalizedOverrides.approvalMode;
      await this.updateApprovalMode(id, mode);
      if (Object.keys(normalizedOverrides).length === 0) return;
    }
    if (id.startsWith("draft:") && this.draftSession?.id === id) {
      this.draftSession.overrides = { ...this.draftSession.overrides, ...normalizedOverrides };
      this.draftSession.updatedAt = Date.now();
      this.broadcastSessions();
      this.broadcastActiveSession();
      return;
    }
    if (!this.conversations.has(id)) return;
    const merged = { ...(this.overrides[id] ?? {}), ...normalizedOverrides };
    delete merged.chatMode;
    delete merged.toolsEnabled;
    this.overrides[id] = merged;
    await this.persistOverrides();

    const patch: Record<string, unknown> = {};
    if (normalizedOverrides.provider) patch.provider = toWireProvider(normalizedOverrides.provider);
    if (normalizedOverrides.model) patch.model = normalizedOverrides.model;
    if (normalizedOverrides.modelSelection) patch.modelSelection = normalizedOverrides.modelSelection;
    if (normalizedOverrides.agentId !== undefined) patch.agentId = normalizedOverrides.agentId;
    if (normalizedOverrides.allowedAgentIds) patch.allowedAgentIds = normalizedOverrides.allowedAgentIds;
    if (Object.keys(patch).length > 0) {
      try {
        const updated = await patchConversation(id, patch);
        this.conversations.set(id, updated);
      } catch (err) {
        this.output.appendLine(`[chat.override] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.broadcastSessions();
    this.broadcastActiveSession();
  }

  // ---------------------------------------------------------------------------
  // Sending chat
  // ---------------------------------------------------------------------------

  /**
   * Provider/model/selection for a turn: the chat's own model selection
   * (drafts without one use the global default); auto sends model `auto`.
   */
  private resolveProviderModel(
    overrides: ChatOverrides,
    forced?: { provider: Provider; model: string },
  ): { provider: Provider; model: string; modelSelection: "auto" | "manual" } | null {
    return resolveTurnModel({
      models: this.catalog.models,
      selection: effectiveModelSelection(overrides.modelSelection, overrides.model, readSettings().modelSelection),
      provider: overrides.provider,
      model: overrides.model,
      forced,
    });
  }

  private buildIdeContext(conversationId: string): IdeToolContextPayload | undefined {
    return buildIdeContextPayload(conversationId);
  }

  /** Sessions with a send in progress (before its stream is registered). */
  private readonly sendingSessions = new Set<string>();

  private async sendChat(
    sessionId: string,
    content: string,
    forced?: { provider: Provider; model: string },
  ): Promise<void> {
    // A draft creates its conversation before the stream exists, so the
    // stream map alone lets a double send start two conversations.
    if (this.sendingSessions.has(sessionId)) {
      this.broadcast({ type: "restoreDraft", sessionId, content });
      this.broadcast({ type: "log", message: BUSY_MESSAGE, severity: "warning" });
      return;
    }
    this.sendingSessions.add(sessionId);
    try {
      await this.sendChatInSession(sessionId, content, forced);
    } finally {
      this.sendingSessions.delete(sessionId);
    }
  }

  private async sendChatInSession(
    sessionId: string,
    content: string,
    forced?: { provider: Provider; model: string },
  ): Promise<void> {
    let session = this.findSession(sessionId);
    if (!session) return;
    if (this.streams.has(sessionId)) {
      this.broadcast({ type: "restoreDraft", sessionId, content });
      this.broadcast({ type: "log", message: BUSY_MESSAGE, severity: "warning" });
      return;
    }
    if (this.backendStatus !== "ok") {
      const hint =
        this.backendStatus === "unauthorized"
          ? "Not signed in to LiberIDE. Close VS Code and reopen the project from the LiberIDE desktop app while logged in."
          : "LiberIDE backend is unreachable. Check the LIBERIDE_API_ORIGIN setting.";
      this.broadcast({ type: "log", message: hint });
      return;
    }
    const resolved = this.resolveProviderModel(session.overrides, forced);
    if (!resolved) {
      this.broadcast({ type: "log", message: "No configured model. Add one in the LiberIDE app first." });
      return;
    }

    let conversation = session.remote && session.conversationId
      ? this.conversations.get(session.conversationId) ?? null
      : null;
    if (!conversation) {
      const draftId = session.id;
      const draftKind = session.kind;
      conversation = await this.createSessionConversation(content, session.overrides);
      if (!conversation) return;
      this.conversations.set(conversation.id, conversation);
      this.messagesCache.set(conversation.id, []);
      this.sessionKinds.delete(draftId);
      this.sessionKinds.set(conversation.id, draftKind);
      this.draftSession = null;
      this.activeSessionId = conversation.id;
      await this.persistSessionKinds();
      await this.persistActive();
      session = this.sessionFromConversation(conversation);
    }

    const conversationId = conversation.id;
    const settings = readSettings();
    const { command, rest } = detectIdeSpecSlashCommand(content);
    const messages = this.messagesCache.get(conversationId) ?? [];

    const userMessage: ConversationMessage = {
      id: `local:user:${randomId()}`,
      conversationId,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    messages.push(userMessage);

    const assistantMessage: ConversationMessage = {
      id: `local:asst:${randomId()}`,
      conversationId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
    };
    messages.push(assistantMessage);
    this.messagesCache.set(conversationId, messages);
    this.broadcastActiveSession();
    this.broadcastSessions();

    const overrides = session.overrides;
    const pipelineMode = !command && session.kind === "pipeline";
    const chatMode = "agent";
    const useRag = overrides.useRag ?? settings.useRag;
    const toolsEnabled = true;
    const systemPrompt = command
      ? SPEC_SYSTEM_PROMPTS[command]
      : pipelineMode
        ? PIPELINE_INTERVIEW_SYSTEM_PROMPT
        : (settings.systemPrompt || undefined);

    // Inline context chips are prepended to the backend content (the visible
    // user message stays clean); cleared once consumed.
    const baseContent = rest || content;
    const outgoingContent = !command && !pipelineMode
      ? enrichMessageWithContext(baseContent, this.pendingContextBlocks)
      : baseContent;
    if (!command && !pipelineMode && this.pendingContextBlocks.length > 0) {
      this.pendingContextBlocks = [];
      this.broadcastContextBlocks();
    }

    const body: ChatRequest = {
      conversationId,
      provider: resolved.provider,
      model: resolved.model,
      // The chat's own selection (an explicit retry with a chosen alternative is a pin).
      modelSelection: resolved.modelSelection,
      chatMode,
      content: outgoingContent,
      systemPrompt,
      // Spec/pipeline prompts steer this turn only; the chat keeps its own prompt.
      ...(command || pipelineMode ? { systemPromptScope: "turn" as const } : {}),
      // The model gets the command's argument (or the message plus attached
      // context chips); the chat shows what the user typed.
      ...(outgoingContent !== content ? { displayContent: content } : {}),
      skillIds: pipelineMode ? [] : (overrides.skillIds ?? []),
      documentIds: pipelineMode ? [] : (overrides.documentIds ?? []),
      useRag: pipelineMode ? false : useRag,
      toolsEnabled,
      mcpServerIds: pipelineMode ? [] : (overrides.mcpServerIds ?? []),
      agentId: pipelineMode ? undefined : overrides.agentId,
      allowedAgentIds: pipelineMode ? [] : (overrides.allowedAgentIds ?? []),
      maxAgentSpawns: this.catalog.maxAgentSpawns,
      ideContext: this.buildIdeContext(conversationId),
    };

    const { abort, streamState } = this.beginTurn(conversationId, assistantMessage, body.ideContext?.projectPath);
    const turn = this.createTurnHandlers(conversationId, assistantMessage, streamState, content);
    try {
      const handlers = turn.handlers;

      const useLocalCopilot =
        body.provider === "copilot" &&
        !this.backendHasCopilotModels &&
        readSettings().copilotModelsEnabled &&
        (await listCopilotLmModels().then((m) => m.some((x) => x.modelId === body.model)).catch(() => false));
      const copilotAttachments = useLocalCopilot
        ? body.documentIds
            .map((id) => this.attachmentBytes.get(id))
            .filter((entry): entry is { data: Uint8Array; mimeType: string; name: string } => !!entry)
        : [];
      const response: ChatResponse = useLocalCopilot
        ? await streamCopilotChat({
            modelId: body.model,
            history: (messages ?? [])
              .filter((m) => m.role === "user" || m.role === "assistant")
              .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
            prompt: body.content,
            toolsEnabled: body.toolsEnabled,
            attachments: copilotAttachments,
            onToken: handlers.onToken!,
            onToolEvent: handlers.onToolEvent!,
            signal: abort.signal,
          }).then((r) => {
            if (r.skippedAttachments.length) {
              const names = r.skippedAttachments.map((a) => a.name).join(", ");
              this.broadcast({ type: "log", message: `Copilot model ignored unsupported attachments: ${names}.` });
            }
            return { assistantMessage: { id: assistantMessage.id, content: r.content } };
          })
        : await streamChat(body, handlers, abort.signal);

      const localId = assistantMessage.id;
      this.applyTurnResponse(conversationId, assistantMessage, response);
      if (command === "tasks" && assistantMessage.content) {
        try {
          const written = await this.writeGeneratedTasks(assistantMessage.content);
          if (written > 0) {
            const note = `\n\n_Wrote **${written}** task contract${written === 1 ? "" : "s"} for the active feature._`;
            assistantMessage.content += note;
            this.broadcast({ type: "messageAppend", sessionId: conversationId, messageId: localId, chunk: note });
          }
        } catch (err) {
          this.output.appendLine(`[chat.tasks] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.completeTurn(conversationId, localId, assistantMessage.id);
    } catch (err) {
      this.failTurn(conversationId, assistantMessage, err, abort.signal.aborted, turn.buffer(), { userMessage, content });
    } finally {
      this.endTurn(conversationId, streamState);
    }
  }

  // ---------------------------------------------------------------------------
  // Turn lifecycle shared by chat, pipeline generation and approval resume
  // ---------------------------------------------------------------------------

  private beginTurn(
    conversationId: string,
    assistantMessage: ConversationMessage,
    root?: string,
    abort = new AbortController(),
  ): { abort: AbortController; streamState: ActiveStream } {
    // Undo snapshots cover the edits of the turn that is starting, in this
    // conversation only: another chat's turn keeps its own baseline.
    resetPreEditSnapshots(conversationId);
    const streamState: ActiveStream = {
      abort,
      messageId: assistantMessage.id,
      startedAt: Date.now(),
      tools: new Map(),
      edits: new Map(),
      root: root ?? activeWorkspaceFolder()?.uri.fsPath,
    };
    this.streams.set(conversationId, streamState);
    this.broadcast({
      type: "messageStart",
      sessionId: conversationId,
      messageId: assistantMessage.id,
      startedAt: streamState.startedAt,
    });
    return { abort, streamState };
  }

  private endTurn(conversationId: string, streamState: ActiveStream): void {
    if (this.streams.get(conversationId) === streamState) this.streams.delete(conversationId);
    if (this.pendingRefresh.delete(conversationId)) void this.refreshSingleConversation(conversationId);
  }

  /** Stream handlers that mirror every server event into the cached message and the webview. */
  private createTurnHandlers(
    conversationId: string,
    assistantMessage: ConversationMessage,
    streamState: ActiveStream,
    prompt: string,
  ): { handlers: ChatStreamHandlers; buffer: () => string } {
    let buffer = "";
    const handlers: ChatStreamHandlers = {
      onSnapshot: (snapshot) => {
        buffer = snapshot.content ?? "";
        assistantMessage.content = buffer;
        this.postPatch(conversationId, assistantMessage.id, { content: buffer });
        if (snapshot.thinking) {
          this.thinkingByMessage.set(assistantMessage.id, snapshot.thinking);
          this.postPatch(conversationId, assistantMessage.id, { thinking: snapshot.thinking });
        }
        if (Array.isArray(snapshot.todos)) this.postPatch(conversationId, assistantMessage.id, { todos: snapshot.todos as ChatMessage["todos"] });
        for (const event of snapshot.toolEvents ?? []) handlers.onToolEvent?.(event);
      },
      onConversation: (serverConversationId) => {
        streamState.serverConversationId = serverConversationId;
        if (streamState.stopRequested) void requestTurnCancel(serverConversationId);
      },
      onRoute: (route) => {
        // Auto turns: the chip shows the routed model while the turn runs.
        assistantMessage.provider = route.provider as Provider;
        assistantMessage.model = route.model;
        if (this.activeSessionId === conversationId) this.broadcastActiveSession();
      },
      onToken: (text: string) => {
        buffer += text;
        assistantMessage.content = buffer;
        this.broadcast({ type: "messageAppend", sessionId: conversationId, messageId: assistantMessage.id, chunk: text });
      },
      onMarkdown: (markdown: string) => {
        // The final markdown supersedes the streamed tokens.
        if (!markdown || markdown === buffer) return;
        buffer = markdown;
        assistantMessage.content = markdown;
        this.postPatch(conversationId, assistantMessage.id, { content: markdown });
      },
      onTodo: (payload: Record<string, unknown>) => {
        if (!Array.isArray(payload.todos)) return;
        this.postPatch(conversationId, assistantMessage.id, { todos: payload.todos as ChatMessage["todos"] }, true);
      },
      onThinking: (delta: string) => {
        const next = `${this.thinkingByMessage.get(assistantMessage.id) ?? ""}${delta}`;
        this.thinkingByMessage.set(assistantMessage.id, next);
        this.postPatch(conversationId, assistantMessage.id, { thinking: next }, true);
      },
      onToolEvent: (event: ToolCallEvent) => {
        const update = applyToolEvent(streamState, event);
        if (!update) return;
        this.broadcast({
          type: "toolUpdate",
          sessionId: conversationId,
          messageId: assistantMessage.id,
          entry: update.entry,
          editedFiles: update.editedFiles,
        });
      },
      onFallbackRequired: (resolution: FallbackRequiredResolution) => {
        const proposal: FallbackProposalView = { prompt, reason: resolution.reason, alternatives: resolution.alternatives ?? [] };
        this.fallbacks.set(assistantMessage.id, proposal);
        this.postPatch(conversationId, assistantMessage.id, { fallback: proposal });
      },
    };
    return { handlers, buffer: () => buffer };
  }

  /** Fold the `done` payload into the cached message: id, status, approvals, graph, warnings. */
  private applyTurnResponse(conversationId: string, assistantMessage: ConversationMessage, response: ChatResponse): void {
    const finalConversation = response.conversation as Conversation | undefined;
    if (finalConversation?.id) this.conversations.set(finalConversation.id, finalConversation);
    const localId = assistantMessage.id;
    const server = response.assistantMessage;
    if (server) {
      if (server.content) assistantMessage.content = server.content;
      for (const key of ["status", "approvalId", "pausedAgentRunId", "executionGraphId", "graphStatus", "error", "warnings", "resolution", "provider", "model"] as const) {
        if (server[key] !== undefined) (assistantMessage as unknown as Record<string, unknown>)[key] = server[key];
      }
      if (server.id && server.id !== localId) {
        assistantMessage.id = server.id;
        this.renameMessageState(localId, server.id);
      }
    }
    const messageId = assistantMessage.id;

    const warnings = response.context?.warnings?.filter(Boolean) ?? [];
    if (warnings.length) this.turnWarnings.set(messageId, warnings);

    const pending = (response.approvals ?? []).filter((a) => a.status === "pending");
    const approval = (assistantMessage.approvalId && response.approvals?.find((a) => a.id === assistantMessage.approvalId)) || pending[0];
    if (approval) {
      this.approvalCards.set(messageId, approvalCardFrom(approval));
      if (!assistantMessage.approvalId) assistantMessage.approvalId = approval.id;
      if (!assistantMessage.status && approval.status === "pending") assistantMessage.status = "awaiting_approval";
    }

    const graphId = response.executionGraphId ?? assistantMessage.executionGraphId;
    if (graphId) {
      assistantMessage.executionGraphId = graphId;
      if (!isTerminalGraphStatus(assistantMessage.graphStatus)) this.watchGraph(conversationId, messageId, graphId);
    }
  }

  private completeTurn(conversationId: string, localId: string, serverId: string): void {
    this.broadcast({
      type: "messageComplete",
      sessionId: conversationId,
      messageId: localId,
      serverMessageId: serverId !== localId ? serverId : undefined,
      conversationId,
      completedAt: Date.now(),
    });
    // Re-render with approval / graph / warnings merged in, then reconcile with the server.
    if (this.activeSessionId === conversationId) this.broadcastActiveSession();
    this.pendingRefresh.add(conversationId);
  }

  private failTurn(
    conversationId: string,
    assistantMessage: ConversationMessage,
    err: unknown,
    aborted: boolean,
    buffer: string,
    optimistic: OptimisticTurn = {},
  ): void {
    const streamError = err instanceof ChatStreamError ? err : undefined;
    const msg = err instanceof Error ? err.message : String(err);
    this.output.appendLine(`[chat] ${streamError ? `${streamError.kind}: ` : ""}${msg}`);

    if (streamError?.kind === "busy") {
      // Nothing was accepted: drop the optimistic turn and hand the text back.
      const messages = this.messagesCache.get(conversationId);
      if (messages) {
        this.messagesCache.set(conversationId, messages.filter((m) => m !== assistantMessage && m !== optimistic.userMessage));
      }
      if (this.activeSessionId === conversationId) this.broadcastActiveSession();
      if (optimistic.content) this.broadcast({ type: "restoreDraft", sessionId: conversationId, content: optimistic.content });
      this.broadcast({ type: "log", message: BUSY_MESSAGE, severity: "warning" });
      return;
    }

    if (aborted || streamError?.kind === "cancelled") {
      const note = `${buffer ? "\n\n" : ""}_Cancelled._`;
      assistantMessage.content = `${buffer}${note}`;
      this.localTurnStatus.set(assistantMessage.id, "cancelled");
      this.broadcast({ type: "messageAppend", sessionId: conversationId, messageId: assistantMessage.id, chunk: note });
      this.broadcast({
        type: "messageComplete",
        sessionId: conversationId,
        messageId: assistantMessage.id,
        conversationId,
        completedAt: Date.now(),
      });
      this.postPatch(conversationId, assistantMessage.id, { turnStatus: "cancelled" });
      return;
    }

    if (streamError?.kind === "fallback_required" && streamError.details.fallback && !this.fallbacks.has(assistantMessage.id)) {
      const resolution = streamError.details.fallback;
      this.fallbacks.set(assistantMessage.id, {
        prompt: optimistic.content ?? "",
        reason: resolution.reason,
        alternatives: resolution.alternatives ?? [],
      });
    }
    assistantMessage.status = "failed";
    assistantMessage.error = msg;
    this.broadcast({
      type: "messageError",
      sessionId: conversationId,
      messageId: assistantMessage.id,
      error: msg,
      completedAt: Date.now(),
    });
    const fallback = this.fallbacks.get(assistantMessage.id);
    this.postPatch(conversationId, assistantMessage.id, { turnStatus: "failed", ...(fallback ? { fallback } : {}) });
    if (streamError?.kind === "unauthorized") void this.refreshCatalog();
  }

  /** Move per-message UI state when the optimistic id is replaced by the server id. */
  private renameMessageState(from: string, to: string): void {
    const maps: Array<Map<string, unknown>> = [
      this.approvalCards,
      this.graphViews,
      this.thinkingByMessage,
      this.fallbacks,
      this.turnWarnings,
      this.localTurnStatus,
    ];
    for (const map of maps) {
      if (!map.has(from)) continue;
      map.set(to, map.get(from));
      map.delete(from);
    }
    for (const watcher of this.graphWatchers.values()) {
      if (watcher.messageId === from) watcher.messageId = to;
    }
  }

  /** Send a partial message update; `coalesce` batches rapid updates (thinking deltas, graph steps). */
  private postPatch(sessionId: string, messageId: string, patch: Partial<ChatMessage>, coalesce = false): void {
    if (!coalesce) {
      this.broadcast({ type: "messagePatch", sessionId, messageId, patch });
      return;
    }
    const key = `${sessionId}:${messageId}:${Object.keys(patch).join(",")}`;
    const existing = this.patchTimers.get(key);
    if (existing) clearTimeout(existing);
    this.patchTimers.set(key, setTimeout(() => {
      this.patchTimers.delete(key);
      this.broadcast({ type: "messagePatch", sessionId, messageId, patch });
    }, 80));
  }

  // ---------------------------------------------------------------------------
  // Cancel, approvals, graphs, model fallback
  // ---------------------------------------------------------------------------

  /**
   * Stop button: ask the server to cancel the turn (closing the stream no
   * longer stops it; the stream then ends as cancelled), and cancel any graph
   * still running for this conversation.
   */
  private async cancelTurn(conversationId: string): Promise<void> {
    const stream = this.streams.get(conversationId);
    if (stream) {
      if (stream.serverConversationId) void requestTurnCancel(stream.serverConversationId);
      else stream.stopRequested = true;
      // Safety net: stop listening if the cancel never ends the stream.
      setTimeout(() => {
        if (this.streams.get(conversationId) === stream) stream.abort.abort();
      }, 5_000);
    }
    const running = [...this.graphWatchers.entries()].filter(([, w]) => w.conversationId === conversationId);
    await Promise.all(running.map(([graphId, watcher]) => this.cancelGraph(graphId, watcher.messageId)));
  }

  private async cancelGraph(graphId: string, messageId: string): Promise<void> {
    const conversationId = this.graphWatchers.get(graphId)?.conversationId ?? this.conversationIdForMessage(messageId);
    const view = this.graphViews.get(messageId);
    if (view) {
      view.cancelling = true;
      if (conversationId) this.postPatch(conversationId, messageId, { graph: { ...view } });
    }
    try {
      await cancelExecutionGraph(graphId);
    } catch (err) {
      if (this.disposed) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (view) {
        view.cancelling = false;
        view.error = `Cancel failed: ${msg}`;
        if (conversationId) this.postPatch(conversationId, messageId, { graph: { ...view } });
      }
      this.broadcast({ type: "log", message: `Could not cancel the graph: ${msg}`, severity: "error" });
    }
  }

  private conversationIdForMessage(messageId: string): string | undefined {
    for (const [conversationId, messages] of this.messagesCache) {
      if (messages.some((m) => m.id === messageId)) return conversationId;
    }
    return undefined;
  }

  /** Follow a graph and render its steps on the message; reload the message once it finishes. */
  private watchGraph(conversationId: string, messageId: string, graphId: string): void {
    if (this.graphWatchers.has(graphId) || this.finishedGraphs.has(graphId)) return;
    const view: GraphProgressView = this.graphViews.get(messageId) ?? { graphId, status: "running", steps: [] };
    this.graphViews.set(messageId, view);
    const watcher: GraphWatcher = { conversationId, messageId, dispose: () => undefined };
    const publish = (coalesce = true) => this.postPatch(conversationId, watcher.messageId, { graph: { ...view, steps: view.steps.map((step) => ({ ...step })) } }, coalesce);

    watcher.dispose = subscribeExecutionGraphEvents(graphId, (event) => {
      if (event.type === "init" || event.type === "graph_status") {
        if (event.status) view.status = event.status;
      } else if (event.type === "node_status" && event.nodeId) {
        let step = view.steps.find((s) => s.nodeId === event.nodeId);
        if (!step) {
          step = { nodeId: event.nodeId, status: event.status ?? "queued" };
          view.steps.push(step);
        }
        if (event.status) step.status = event.status;
        if (event.title) step.title = event.title;
        if (typeof event.taskId === "string" && event.taskId) step.taskId = event.taskId;
        const error = nodeEventError(event);
        if (error) step.error = error;
        else if (event.status && event.status !== "failed") step.error = undefined;
        const output = [event.output, event.summary, event.outputSummary, event.result].find((v): v is string => typeof v === "string" && v.trim() !== "");
        if (output) step.output = output;
      } else if (event.type === "done") {
        view.status = event.status ?? view.status;
        view.cancelling = false;
        view.reconnecting = false;
        this.finishedGraphs.add(graphId);
        this.graphWatchers.delete(graphId);
        publish(false);
        // The server writes the delivered result into the message; fetch it.
        void this.refreshSingleConversation(conversationId);
        return;
      } else {
        return;
      }
      view.error = undefined;
      view.reconnecting = false;
      publish();
    }, {
      onConnected: () => {
        if (!view.error && !view.reconnecting) return;
        view.error = undefined;
        view.reconnecting = false;
        publish(false);
      },
      onError: (message, willRetry) => {
        view.error = willRetry ? `Reconnecting to graph events\u2026 (${message})` : message;
        view.reconnecting = willRetry;
        if (!willRetry) this.graphWatchers.delete(graphId);
        this.output.appendLine(`[chat.graph] ${graphId}: ${message}${willRetry ? " (retrying)" : ""}`);
        publish(false);
      },
    });
    this.graphWatchers.set(graphId, watcher);
  }

  private async resolveApprovalFromPanel(
    conversationId: string,
    messageId: string,
    approvalId: string,
    decision: "approved" | "rejected",
    responseText?: string,
  ): Promise<void> {
    const card: ApprovalCardView = this.approvalCards.get(messageId) ?? { id: approvalId, action: "Approval required", status: "pending" };
    this.approvalCards.set(messageId, card);
    const publish = () => this.postPatch(conversationId, messageId, { approval: { ...card } });
    if (this.streams.has(conversationId)) {
      this.broadcast({ type: "log", message: BUSY_MESSAGE, severity: "warning" });
      return;
    }
    card.busy = true;
    card.error = undefined;
    publish();
    try {
      await resolveApproval(approvalId, decision, responseText);
    } catch (err) {
      card.busy = false;
      card.error = err instanceof Error ? err.message : String(err);
      publish();
      if (err instanceof ChatStreamError && err.details.status === 404) void this.refreshSingleConversation(conversationId);
      return;
    }
    card.status = decision;
    publish();
    try {
      await this.runApprovalResume(conversationId, messageId, approvalId);
    } finally {
      card.busy = false;
      publish();
    }
  }

  /**
   * Follow the conversation's running turn, wherever it started (the web
   * app, another window, a background approval resume): what streamed so far
   * arrives as a snapshot, then the live events. No-op when none is running.
   */
  private async attachRunningTurn(conversationId: string): Promise<void> {
    if (conversationId.startsWith("draft:") || this.backendStatus !== "ok") return;
    if (this.streams.has(conversationId) || this.attaching.has(conversationId)) return;
    this.attaching.add(conversationId);
    const abort = new AbortController();
    let read: Awaited<ReturnType<typeof openTurnStream>>;
    try {
      read = await openTurnStream(conversationId, abort.signal);
    } catch (err) {
      this.output.appendLine(`[chat.attach-turn] ${err instanceof Error ? err.message : String(err)}`);
      return;
    } finally {
      this.attaching.delete(conversationId);
    }
    if (!read) return;
    if (this.streams.has(conversationId)) {
      abort.abort();
      return;
    }
    const assistantMessage: ConversationMessage = {
      id: `local:asst:${randomId()}`,
      conversationId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
    };
    this.messagesCache.set(conversationId, [...(this.messagesCache.get(conversationId) ?? []), assistantMessage]);
    if (this.activeSessionId === conversationId) this.broadcastActiveSession();
    const { streamState } = this.beginTurn(conversationId, assistantMessage, undefined, abort);
    streamState.serverConversationId = conversationId;
    const turn = this.createTurnHandlers(conversationId, assistantMessage, streamState, "");
    try {
      const response = await read(turn.handlers);
      const localId = assistantMessage.id;
      this.applyTurnResponse(conversationId, assistantMessage, response);
      this.completeTurn(conversationId, localId, assistantMessage.id);
    } catch (err) {
      this.failTurn(conversationId, assistantMessage, err, abort.signal.aborted, turn.buffer());
    } finally {
      this.endTurn(conversationId, streamState);
    }
  }

  /** Stream the continuation of a paused turn into a new assistant bubble. */
  private async runApprovalResume(conversationId: string, pausedMessageId: string, approvalId: string): Promise<void> {
    const messages = this.messagesCache.get(conversationId) ?? [];
    const assistantMessage: ConversationMessage = {
      id: `local:asst:${randomId()}`,
      conversationId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
    };
    const pausedIndex = messages.findIndex((m) => m.id === pausedMessageId);
    if (pausedIndex >= 0) messages.splice(pausedIndex + 1, 0, assistantMessage);
    else messages.push(assistantMessage);
    this.messagesCache.set(conversationId, messages);
    if (this.activeSessionId === conversationId) this.broadcastActiveSession();

    const { abort, streamState } = this.beginTurn(conversationId, assistantMessage);
    const turn = this.createTurnHandlers(conversationId, assistantMessage, streamState, "");
    try {
      const response = await streamApprovalResume(approvalId, turn.handlers, abort.signal);
      const localId = assistantMessage.id;
      if (isAgentRunResumed(response)) {
        // A paused sub-agent continues server-side; its result arrives later via message_updated.
        const note = "_Agent resumed \u2014 its result will appear here._";
        assistantMessage.content = `${turn.buffer()}${turn.buffer() ? "\n\n" : ""}${note}`;
        this.agentResumeNotes.set(conversationId, assistantMessage);
        this.postPatch(conversationId, localId, { content: assistantMessage.content });
        this.broadcast({ type: "messageComplete", sessionId: conversationId, messageId: localId, conversationId, completedAt: Date.now() });
        return;
      }
      // If the server continued the paused message in place, drop our placeholder.
      if (response.assistantMessage?.id === pausedMessageId) {
        this.messagesCache.set(conversationId, (this.messagesCache.get(conversationId) ?? []).filter((m) => m !== assistantMessage));
        const paused = (this.messagesCache.get(conversationId) ?? []).find((m) => m.id === pausedMessageId);
        if (paused) {
          this.applyTurnResponse(conversationId, paused, response);
          this.localTurnStatus.delete(pausedMessageId);
        }
        this.completeTurn(conversationId, localId, localId);
        return;
      }
      this.applyTurnResponse(conversationId, assistantMessage, response);
      this.completeTurn(conversationId, localId, assistantMessage.id);
    } catch (err) {
      this.failTurn(conversationId, assistantMessage, err, abort.signal.aborted, turn.buffer());
    } finally {
      this.endTurn(conversationId, streamState);
    }
  }

  /** The user picked a compatible model after a fallback_required: pin it and resend. */
  private async retryWithModel(
    sessionId: string,
    messageId: string,
    provider: Provider,
    model: string,
    content: string,
  ): Promise<void> {
    if (!content.trim()) return;
    this.fallbacks.delete(messageId);
    this.postPatch(sessionId, messageId, { fallback: undefined });
    await this.updateOverrides(sessionId, { modelSelection: "manual", provider: provider as ConfiguredProvider, model });
    await this.sendChat(sessionId, content, { provider, model });
  }

  private findSession(id: string): ChatSession | null {
    if (id.startsWith("draft:") && this.draftSession?.id === id) return this.draftSession;
    const conv = this.conversations.get(id);
    return conv ? this.sessionFromConversation(conv) : null;
  }

  private async assignConversationToProject(conv: Conversation | string): Promise<Conversation | null> {
    const conversationId = typeof conv === "string" ? conv : conv.id;
    const existing = typeof conv === "string" ? this.conversations.get(conv) : conv;
    if (this.project.source === "none") return existing ?? null;

    await this.ensureProjectFolder();
    if (!this.projectFolderId) return existing ?? null;

    const folderName = this.projectFolder?.name ?? projectFolderName(this.project);
    const projectTag = projectConversationTag(this.project);
    const tags = [...new Set([...(existing?.tags ?? []), projectTag])];

    try {
      if (this.projectFolderId) {
        await addConversationToFolder(this.projectFolderId, conversationId);
      }
    } catch (err) {
      this.output.appendLine(`[chat.attachFolder] ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      return await patchConversation(conversationId, { folder: folderName, tags });
    } catch (err) {
      this.output.appendLine(`[chat.tagFolder] ${err instanceof Error ? err.message : String(err)}`);
      return existing ?? null;
    }
  }

  private async createSessionConversation(firstMessage: string, overrides: ChatOverrides = {}): Promise<Conversation | null> {
    try {
      const title = deriveTitle(firstMessage);
      let conv = await createConversation(title);
      const settings = readSettings();
      const allowedAgentIds = overrides.allowedAgentIds?.length
        ? overrides.allowedAgentIds
        : resolveAllowedAgentIds(this.catalog.agents, settings.defaultAllowedAgentIds);
      const patch: Record<string, unknown> = {};
      // The draft's model choice (else the local default) becomes the conversation's.
      patch.modelSelection = effectiveModelSelection(overrides.modelSelection, overrides.model, settings.modelSelection);
      if (overrides.provider) patch.provider = toWireProvider(overrides.provider);
      if (overrides.model) patch.model = overrides.model;
      if (overrides.agentId) patch.agentId = overrides.agentId;
      if (allowedAgentIds.length) patch.allowedAgentIds = allowedAgentIds;
      // The mode picked on the draft becomes the new conversation's.
      if (overrides.approvalMode && overrides.approvalMode !== conversationApprovalMode(conv)) patch.approvalMode = overrides.approvalMode;
      if (Object.keys(patch).length) {
        conv = await patchConversation(conv.id, patch);
      }
      const assigned = await this.assignConversationToProject(conv);
      return assigned ?? conv;
    } catch (err) {
      this.output.appendLine(`[chat.createConversation] ${err instanceof Error ? err.message : String(err)}`);
      this.broadcast({ type: "log", message: `Failed to create conversation: ${err instanceof Error ? err.message : err}` });
      return null;
    }
  }

  private async refreshSingleConversation(id: string): Promise<void> {
    if (this.disposed) return;
    if (this.streams.has(id)) {
      // Replacing the cache now would drop the optimistic turn; do it when the stream ends.
      this.pendingRefresh.add(id);
      return;
    }
    try {
      const list = await listConversations();
      const updated = list.find((c) => c.id === id);
      if (updated) this.conversations.set(id, this.keepModelWhileStreaming(updated, this.conversations.get(id)));
      const fresh = await listConversationMessages(id);
      if (this.streams.has(id)) {
        this.pendingRefresh.add(id);
        return;
      }
      const note = this.agentResumeNotes.get(id);
      if (note && !fresh.some((m) => m.id === note.id)) fresh.push(note);
      // A dispatched graph's card stays until the server posts the graph's message.
      const anchors = (this.pendingGraphAnchors.get(id) ?? []).filter((a) => !fresh.some((m) => m.executionGraphId === a.executionGraphId));
      if (anchors.length) this.pendingGraphAnchors.set(id, anchors);
      else this.pendingGraphAnchors.delete(id);
      fresh.push(...anchors);
      this.messagesCache.set(id, fresh);
      this.hydratedApprovalConversations.delete(id);
      this.afterMessagesLoaded(id);
      this.broadcastSessions();
      if (this.activeSessionId === id) this.broadcastActiveSession();
    } catch (err) {
      this.output.appendLine(`[chat.refresh] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The workspace folder an edit card refers to: the root it recorded (only
   * if still open), else the only folder. With several folders and no
   * recorded root there is no safe guess.
   */
  private editRoot(root: string | undefined): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (root) return folders.find((folder) => nodePath.resolve(folder.uri.fsPath) === nodePath.resolve(root));
    return folders.length === 1 ? folders[0] : undefined;
  }

  private async revealFile(relativePath: string, root?: string): Promise<void> {
    const folder = this.editRoot(root);
    if (!folder) {
      this.broadcast({ type: "log", message: root ? `The folder ${root} is no longer open.` : "No workspace folder for this file." });
      return;
    }
    const clean = relativePath.replace(/^\/+/, "");
    let target: vscode.Uri;
    try {
      if (folder.uri.scheme === "file") {
        target = vscode.Uri.file(resolveInsideRootSync(folder.uri.fsPath, clean));
      } else {
        const normalized = nodePath.posix.normalize(clean.replace(/\\/g, "/"));
        if (normalized === ".." || normalized.startsWith("../") || nodePath.posix.isAbsolute(normalized)) throw new Error("Path escapes the workspace folder");
        target = vscode.Uri.joinPath(folder.uri, normalized);
      }
    } catch (err) {
      this.broadcast({ type: "log", message: `Could not open ${relativePath}: ${err instanceof Error ? err.message : err}` });
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      this.broadcast({ type: "log", message: `Could not open ${relativePath}: ${err instanceof Error ? err.message : err}` });
    }
  }

  /**
   * Undo the agent's edits to `files` from this conversation's latest turn:
   * exact pre-edit snapshots where they exist, otherwise (after a second
   * confirmation) git checkout in the edit's own folder only.
   */
  private async undoEdits(sessionId: string, files: Array<{ path: string; root?: string }>): Promise<void> {
    if (!files.length) return;
    const choice = await vscode.window.showWarningMessage(
      `Undo the agent's edits to ${files.length} file${files.length === 1 ? "" : "s"}?`,
      { modal: true },
      "Undo",
    );
    if (choice !== "Undo") return;
    const needGit: Array<{ clean: string; root: string }> = [];
    for (const file of files) {
      const folder = this.editRoot(file.root);
      const clean = file.path.replace(/^\/+/, "");
      if (!folder || folder.uri.scheme !== "file") {
        this.broadcast({ type: "log", message: `Undo failed for ${clean}: its workspace folder is not open.` });
        continue;
      }
      const root = folder.uri.fsPath;
      let full: string;
      try {
        full = resolveInsideRootSync(root, clean);
      } catch (err) {
        this.broadcast({ type: "log", message: `Undo failed for ${clean}: ${err instanceof Error ? err.message : err}` });
        continue;
      }
      // Exact undo: the content from before the agent's edits this turn.
      if (await restorePreEditSnapshot(full, sessionId)) {
        this.broadcast({ type: "log", message: `Restored ${clean} to its content before the agent's edits.`, severity: "info" });
        continue;
      }
      needGit.push({ clean, root });
    }
    if (!needGit.length) {
      if (files[0]) await this.revealFile(files[0].path, files[0].root).catch(() => undefined);
      return;
    }
    // No snapshot (the server wrote the file directly): git is the only
    // baseline, and it also discards the user's own uncommitted changes.
    const names = needGit.map((file) => file.clean).join(", ");
    const gitChoice = await vscode.window.showWarningMessage(
      `No exact snapshot for ${names}. Revert ${needGit.length === 1 ? "it" : "them"} to the last git commit? This also discards your own uncommitted changes.`,
      { modal: true },
      "Revert",
    );
    if (gitChoice !== "Revert") return;
    for (const { clean, root } of needGit) {
      if (!isPathInside(root, nodePath.resolve(root, clean))) continue;
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["checkout", "--", clean], { cwd: root, timeout: 15_000, windowsHide: true }, (err, _stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve();
        });
      }).then(() => {
        this.broadcast({ type: "log", message: `Reverted ${clean} to last git state.`, severity: "info" });
      }).catch((err) => {
        this.broadcast({ type: "log", message: `Undo failed for ${clean}: ${err instanceof Error ? err.message : err}` });
      });
    }
  }

  private async writeGeneratedTasks(text: string): Promise<number> {
    const feature = this.store.getActiveFeature();
    if (!feature?.tasksDirUri) return 0;
    const written = await this.writeTaskContractsForFeature(feature.id, feature.tasksDirUri, text);
    if (written > 0) {
      await this.store.refresh();
      const updated = this.store.getFeature(feature.id);
      if (updated?.tasksDirUri) {
        await writeTextFile(
          vscode.Uri.joinPath(updated.tasksDirUri, "index.md"),
          regenerateTasksIndex(updated.tasks),
        );
      }
    }
    return written;
  }

  private async writeTaskContractsForFeature(
    featureId: string,
    tasksDirUri: vscode.Uri,
    text: string,
  ): Promise<number> {
    let written = 0;
    for (const block of extractTaskBlocks(text)) {
      const probe = vscode.Uri.joinPath(tasksDirUri, "_probe.md");
      const task = parseTaskContract(
        featureId,
        probe,
        block.startsWith("---") ? block : `---\n${block}\n---\n`,
      );
      if (!task) continue;
      task.filePath = vscode.Uri.joinPath(
        tasksDirUri,
        `${task.id}-${task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.md`,
      );
      await writeTaskContract(task);
      written++;
    }
    return written;
  }

  private async generatePipeline(sessionId: string, featureName: string): Promise<void> {
    const session = this.findSession(sessionId);
    if (!session) {
      this.broadcast({ type: "log", message: "Pipeline generation: session not found." });
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.broadcast({ type: "log", message: "Open a workspace folder to scaffold a feature." });
      return;
    }
    if (!session.remote || !session.conversationId) {
      this.broadcast({
        type: "log",
        message: "Send at least one interview message before generating the pipeline.",
      });
      return;
    }
    if (this.streams.has(session.conversationId)) {
      this.broadcast({ type: "log", message: BUSY_MESSAGE, severity: "warning" });
      return;
    }
    const resolved = this.resolveProviderModel(session.overrides);
    if (!resolved) {
      this.broadcast({ type: "log", message: "No configured model. Add one in the LiberIDE app first." });
      return;
    }

    let root: vscode.Uri;
    try {
      root = await scaffoldFeature(folder, featureName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[chat.pipeline.scaffold] ${msg}`);
      this.broadcast({ type: "log", message: `Failed to scaffold feature: ${msg}` });
      return;
    }
    const slug = root.path.split("/").pop() ?? featureName;
    // Dispatches of this feature report back to this chat.
    await linkFeatureConversation(this.context.workspaceState, slug, session.conversationId);
    const tasksDirUri = vscode.Uri.joinPath(root, "tasks");
    const requirementsUri = vscode.Uri.joinPath(root, "requirements.md");
    const designUri = vscode.Uri.joinPath(root, "design.md");

    const conversationId = session.conversationId;
    const messages = this.messagesCache.get(conversationId) ?? [];
    const userPrompt = `Generate the requirements, design, and task contracts for the feature "${featureName}". Emit the marker [[FEATURE_NAME: ${slug}]] on the first line.`;
    // The prompt above is app-built; the chat shows (and stores) this label instead.
    const userLabel = `Generate pipeline: ${slug}`;

    for (let i = messages.length - 1; i >= 0; i--) {
      const candidate = messages[i];
      if (candidate.role === "assistant" && candidate.content.includes("[[PIPELINE_READY:")) {
        this.markPipelineCardConsumed(conversationId, candidate.id);
        break;
      }
    }

    const userMessage: ConversationMessage = {
      id: `local:user:${randomId()}`,
      conversationId,
      role: "user",
      content: userPrompt,
      displayContent: userLabel,
      createdAt: new Date().toISOString(),
    };
    messages.push(userMessage);
    const assistantMessage: ConversationMessage = {
      id: `local:asst:${randomId()}`,
      conversationId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
    };
    messages.push(assistantMessage);
    this.messagesCache.set(conversationId, messages);
    this.broadcastActiveSession();
    this.broadcastSessions();

    const body: ChatRequest = {
      conversationId,
      provider: resolved.provider,
      model: resolved.model,
      modelSelection: resolved.modelSelection,
      chatMode: "agent",
      content: userPrompt,
      displayContent: userLabel,
      systemPrompt: PIPELINE_GENERATE_SYSTEM_PROMPT,
      systemPromptScope: "turn",
      skillIds: [],
      documentIds: [],
      useRag: false,
      toolsEnabled: true,
      mcpServerIds: [],
      allowedAgentIds: [],
      maxAgentSpawns: this.catalog.maxAgentSpawns,
    };

    const { abort, streamState } = this.beginTurn(conversationId, assistantMessage);
    const turn = this.createTurnHandlers(conversationId, assistantMessage, streamState, userPrompt);
    let buffer = "";
    try {
      const handlers = turn.handlers;

      const useLocalCopilot =
        body.provider === "copilot" &&
        !this.backendHasCopilotModels &&
        readSettings().copilotModelsEnabled &&
        (await listCopilotLmModels().then((m) => m.some((x) => x.modelId === body.model)).catch(() => false));
      const response = useLocalCopilot
        ? await streamCopilotChat({
            modelId: body.model,
            history: (messages ?? [])
              .filter((m) => m.role === "user" || m.role === "assistant")
              .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
            prompt: body.content,
            toolsEnabled: body.toolsEnabled,
            onToken: handlers.onToken!,
            onToolEvent: handlers.onToolEvent!,
            signal: abort.signal,
          }).then((r): ChatResponse => ({ assistantMessage: { id: assistantMessage.id, content: r.content } }))
        : await streamChat(body, handlers, abort.signal);

      const localId = assistantMessage.id;
      this.applyTurnResponse(conversationId, assistantMessage, response);
      buffer = assistantMessage.content || turn.buffer();

      let taskCount = 0;
      try {
        const sections = parsePipelineSections(buffer);
        await writeTextFile(requirementsUri, `# Requirements\n\n${sections.requirements}\n`);
        await writeTextFile(designUri, `# Design\n\n${sections.design}\n`);
        if (sections.documentation) {
          await writeTextFile(vscode.Uri.joinPath(root, "documentation.md"), `# Documentation\n\n${sections.documentation}\n`);
        }
        if (sections.blockers) {
          await writeTextFile(vscode.Uri.joinPath(root, "blockers.md"), `# Blockers\n\n${sections.blockers}\n`);
        }
        taskCount = await this.writeTaskContractsForFeature(slug, tasksDirUri, buffer);
        this.store.setActiveFeature(slug);
        await this.context.workspaceState.update("liberide.activeFeatureId", slug);
        await this.store.refresh();
        const updated = this.store.getFeature(slug);
        if (updated?.tasksDirUri) {
          await writeTextFile(
            vscode.Uri.joinPath(updated.tasksDirUri, "index.md"),
            regenerateTasksIndex(updated.tasks),
          );
        }
        const note = `\n\n_Scaffolded feature **${featureName}** with **${taskCount}** task${taskCount === 1 ? "" : "s"}. [[OPEN_PIPELINE]]_`;
        assistantMessage.content += note;
        this.broadcast({
          type: "messageAppend",
          sessionId: conversationId,
          messageId: localId,
          chunk: note,
        });
        this.completeTurn(conversationId, localId, assistantMessage.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`[chat.pipeline.write] ${msg}`);
        const note = `\n\n_Failed to scaffold pipeline files: ${msg}_`;
        assistantMessage.content += note;
        this.broadcast({
          type: "messageAppend",
          sessionId: conversationId,
          messageId: localId,
          chunk: note,
        });
        this.completeTurn(conversationId, localId, assistantMessage.id);
      }
    } catch (err) {
      this.failTurn(conversationId, assistantMessage, err, abort.signal.aborted, turn.buffer(), { userMessage });
    } finally {
      this.endTurn(conversationId, streamState);
    }
  }

  private async copilotGithubLogin(): Promise<void> {
    try {
      const session = await vscode.authentication.getSession("github", ["read:user"], { createIfNone: true });
      if (!session?.accessToken) throw new Error("GitHub authentication did not return an access token.");
      await apiFetch("/api/copilot/link/ide", {
        method: "POST",
        body: JSON.stringify({ accessToken: session.accessToken }),
      });
      this.broadcast({ type: "log", message: "GitHub linked for Copilot.", severity: "info" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.broadcast({ type: "log", message: `GitHub sign-in failed: ${msg}` });
    }
  }

  // ---------------------------------------------------------------------------
  // HTML
  // ---------------------------------------------------------------------------

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "chat.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.css"));
    const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "mermaid.js"));
    const nonce = randomNonce();
    const csp = [
      `default-src 'none'`,
      // No remote images: model output could embed a URL that exfiltrates context.
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `connect-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>LiberIDE</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body class="liberide-chat-body">
  <div id="root" data-mermaid-src="${mermaidUri}"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function emptyCatalog(): BackendCatalog {
  return { models: [], agents: [], skills: [], mcpServers: [], documents: [], maxAgentSpawns: 3 };
}

function catalogFromConfig(config: AppConfig, documents: BackendCatalog["documents"]): BackendCatalog {
  return {
    models: (config.configuredModels ?? []).filter((m) => m.enabled !== false && supportsTextGeneration(m)),
    agents: config.agents ?? [],
    skills: config.skills ?? [],
    mcpServers: config.mcpServers ?? [],
    documents,
    maxAgentSpawns: config.maxAgentSpawns ?? 3,
    maxApprovalMode: maxApprovalModeFromConfig(config),
  };
}

function parsePipelineSections(buffer: string): { requirements: string; design: string; documentation: string; blockers: string } {
  const lines = buffer.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && !/^\s*#\s+/.test(lines[i])) i++;
  const sections = new Map<string, string[]>();
  const KNOWN = new Set(["requirements", "design", "documentation", "blockers"]);
  let currentKey: string | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^\s*#\s+(.+?)\s*$/);
    if (match) {
      const heading = match[1].toLowerCase();
      if (KNOWN.has(heading)) {
        currentKey = heading;
        sections.set(currentKey, []);
        continue;
      }
      currentKey = null;
      continue;
    }
    if (!currentKey) continue;
    if (/^```task\b/.test(line)) {
      while (i < lines.length && !/^```\s*$/.test(lines[i])) i++;
      continue;
    }
    sections.get(currentKey)!.push(line);
  }
  const trim = (lines: string[] | undefined): string => (lines ?? []).join("\n").replace(/^\s+|\s+$/g, "");
  const requirements = trim(sections.get("requirements"));
  const design = trim(sections.get("design"));
  if (!requirements && !design) {
    throw new Error("Generated output did not contain # Requirements or # Design sections.");
  }
  return {
    requirements,
    design,
    documentation: trim(sections.get("documentation")),
    blockers: trim(sections.get("blockers")),
  };
}

function deriveTitle(text: string): string {
  const firstLine = text.replace(/\s+/g, " ").trim();
  if (!firstLine) return "New chat";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}\u2026` : firstLine;
}

function applyToolEvent(
  stream: ActiveStream,
  event: ToolCallEvent,
): { entry: ToolTimelineEntry; editedFiles: EditedFileSummary[] } | null {
  const now = Date.now();
  const existing = stream.tools.get(event.id);
  if (!existing) {
    const entry: ToolTimelineEntry = {
      id: event.id,
      name: event.name,
      arguments: event.arguments ?? {},
      activityKind: toolActivityKind(event.name),
      summary: summarizeTool(event.name, event.arguments ?? {}),
      startedAt: event.createdAt ? Date.parse(event.createdAt) || now : now,
      status: "running",
    };
    stream.tools.set(event.id, entry);
    recordFileEdit(stream.edits, event.name, event.arguments ?? {}, event.result, stream.root);
    return { entry, editedFiles: [...stream.edits.values()] };
  }

  existing.completedAt = now;
  existing.activityKind = existing.activityKind ?? toolActivityKind(existing.name);
  if (event.result !== undefined) {
    existing.result = event.result;
    existing.status = looksLikeToolError(event.result) ? "error" : "complete";
    if (existing.status === "error") existing.error = event.result.slice(0, 300);
    recordFileEdit(stream.edits, event.name, event.arguments ?? {}, event.result, stream.root);
  }
  return { entry: existing, editedFiles: [...stream.edits.values()] };
}

function summarizeTool(name: string, args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : undefined;
  switch (name) {
    case "ide_write_file":
      return path ? `Wrote \`${path}\`` : "Wrote file";
    case "ide_edit_file":
      return path ? `Edited \`${path}\`` : "Edited file";
    case "ide_read_file":
      return path ? `Read \`${path}\`` : "Read file";
    case "ide_list_directory":
      return path ? `Listed \`${path}\`` : "Listed directory";
    case "ide_search_code":
      return typeof args.query === "string" ? `Searched for "${truncate(args.query, 40)}"` : "Searched code";
    case "ide_run_command":
    case "terminal_run":
      return typeof args.command === "string" ? `Ran \`${truncate(args.command, 48)}\`` : "Ran command";
    default:
      return humanizeToolName(name);
  }
}

function humanizeToolName(name: string): string {
  return name.replace(/^ide_/, "").replace(/_/g, " ");
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}\u2026` : value;
}

function looksLikeToolError(result: string): boolean {
  const trimmed = result.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; success?: boolean };
      if (parsed.error === true || parsed.success === false) return true;
    } catch {
      // not json
    }
  }
  return /^(error|failed|denied)/i.test(trimmed);
}

function recordFileEdit(
  edits: Map<string, EditedFileSummary>,
  name: string,
  args: Record<string, unknown>,
  result?: string,
  root?: string,
): void {
  if (name !== "ide_write_file" && name !== "ide_edit_file") return;
  const path = typeof args.path === "string" ? args.path : undefined;
  if (!path) return;

  const current = edits.get(path) ?? { path, root, writes: 0, edits: 0, additions: 0, deletions: 0 };
  if (name === "ide_write_file") {
    current.writes += 1;
    const content = typeof args.content === "string" ? args.content : "";
    const lines = content ? content.split("\n").length : 0;
    current.additions += lines;
  } else {
    const editList = Array.isArray(args.edits) ? args.edits : [];
    current.edits += editList.length;
    for (const edit of editList) {
      if (!edit || typeof edit !== "object") continue;
      const oldText = typeof (edit as { oldText?: unknown }).oldText === "string" ? (edit as { oldText: string }).oldText : "";
      const newText = typeof (edit as { newText?: unknown }).newText === "string" ? (edit as { newText: string }).newText : "";
      current.additions += newText ? newText.split("\n").length : 0;
      current.deletions += oldText ? oldText.split("\n").length : 0;
    }
  }

  if (result && !looksLikeToolError(result)) {
    const parsedStats = parseEditStatsFromResult(result);
    if (parsedStats) {
      current.additions = Math.max(current.additions, parsedStats.additions);
      current.deletions = Math.max(current.deletions, parsedStats.deletions);
    }
  }

  edits.set(path, current);
}

function parseEditStatsFromResult(result: string): { additions: number; deletions: number } | null {
  const match = result.match(/(\+|\u002B)(\d+).*?(-|\u2212)(\d+)/);
  if (!match) return null;
  return { additions: Number(match[2]) || 0, deletions: Number(match[4]) || 0 };
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function randomNonce(): string {
  return randomBytes(16).toString("hex");
}
