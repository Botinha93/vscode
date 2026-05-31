import * as vscode from "vscode";
import {
  addConversationToFolder,
  apiFetch,
  createConversation,
  createFolder,
  deleteConversation,
  fetchConfig,
  getApiOrigin,
  listConversationMessages,
  listConversations,
  listDocuments,
  listFolders,
  patchConversation,
  probeBackend,
  subscribeConversationListSync,
  uploadDocument,
} from "../api";
import { onSettingsChange, readSettings, writeSetting, type LiberideSettings } from "../settings";
import {
  conversationHasProjectTag,
  detectProjectIdentity,
  projectConversationTag,
  projectFolderName,
  type ProjectIdentity,
} from "../project/identity";
import { detectIdeSpecSlashCommand } from "@nexus/shared";
import {
  PIPELINE_GENERATE_SYSTEM_PROMPT,
  PIPELINE_INTERVIEW_SYSTEM_PROMPT,
  SPEC_SYSTEM_PROMPTS,
  extractTaskBlocks,
} from "./commands";
import { defaultEnabledModel, findConfiguredModel, toWireProvider } from "./models";
import { listCopilotLmModels, streamCopilotChat } from "./copilot-lm";
import { streamChat } from "./stream-client";
import { runLocalTerminal } from "../terminal/local-runner";
import type {
  AppConfig,
  ChatRequest,
  IdeToolContextPayload,
  TerminalDelegateEvent,
  ConfiguredProvider,
  Conversation,
  ConversationMessage,
  Provider,
  SharingFolder,
  AgentDefinition,
} from "./types";
import type {
  BackendCatalog,
  BackendStatus,
  ChatHostToWebview,
  ChatMessage,
  ChatOverrides,
  ChatSession,
  ChatWebviewToHost,
  EditedFileSummary,
  ProjectInfo,
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

interface ActiveStream {
  abort: AbortController;
  messageId: string;
  startedAt: number;
  tools: Map<string, ToolTimelineEntry>;
  edits: Map<string, EditedFileSummary>;
}

function toolActivityKind(name: string): ToolTimelineEntry["activityKind"] {
  if (name === "request_approval") return "approval";
  if (name === "agent" || name === "agent_group" || name === "agent_result") return "agent";
  if (name === "web") return "web";
  if (name === "mcp" || name.startsWith("mcp_")) return "mcp";

  if (
    name === "ide_read_file" ||
    name === "ide_list_directory" ||
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

  if (name === "ide_write_file" || name === "ide_edit_file" || name === "userspace" || name === "artifact") return "writing";

  return "executing";
}

export class LiberideChatPanelController implements vscode.WebviewViewProvider, vscode.Disposable {
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

  private conversations = new Map<string, Conversation>();
  private messagesCache = new Map<string, ConversationMessage[]>();
  private static readonly MAX_CACHED_CONVERSATIONS = 20;
  private attachmentBytes = new Map<string, { data: Uint8Array; mimeType: string; name: string }>();
  private overrides: OverridesCache = {};
  private sessionKinds = new Map<string, ChatSession["kind"]>();
  /** conversationId -> set of message ids whose pipeline-ready card has been consumed. */
  private consumedPipelineCards = new Map<string, Set<string>>();

  /** Locally-staged session for "new chat" before the first message creates it on the backend. */
  private draftSession: ChatSession | null = null;
  private activeSessionId: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SpecStore,
    private readonly output: vscode.OutputChannel,
  ) {
    this.overrides = this.context.workspaceState.get<OverridesCache>(OVERRIDES_STORAGE_KEY, {});
    this.activeSessionId = this.context.workspaceState.get<string | null>(ACTIVE_SESSION_STORAGE_KEY, null);
    const storedKinds = this.context.workspaceState.get<Record<string, ChatSessionKind>>("liberide.chat.sessionKinds") ?? {};
    for (const [id, kind] of Object.entries(storedKinds)) this.sessionKinds.set(id, kind);
    this.disposables.push(
      onSettingsChange((settings) => this.broadcast({ type: "settings", settings })),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.onWorkspaceFoldersChanged();
      }),
    );
    this.conversationSyncDispose = subscribeConversationListSync(() => {
      void this.refreshConversations();
    });
  }

  private async onWorkspaceFoldersChanged(): Promise<void> {
    this.project = await detectProjectIdentity();
    await this.ensureProjectFolder();
    await this.refreshConversations();
    this.broadcast({ type: "project", project: this.projectInfo() });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.bindWebview(view.webview);
    view.onDidDispose(() => {
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
    this.conversationSyncDispose?.();
    for (const d of this.disposables) d.dispose();
    for (const s of this.streams.values()) s.abort.abort();
    this.streams.clear();
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
    if (session) this.broadcast({ type: "session", session });
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
        case "deleteSession":
          await this.removeSession(message.sessionId);
          break;
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
        case "cancelMessage": {
          const stream = this.streams.get(message.sessionId);
          if (stream) {
            stream.abort.abort();
            this.streams.delete(message.sessionId);
          }
          break;
        }
        case "setOverrides":
          await this.updateOverrides(message.sessionId, message.overrides);
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
          await vscode.commands.executeCommand("liberide.openPipeline");
          break;
        case "copilotGithubLogin":
          await this.copilotGithubLogin();
          break;
        case "revealFile":
          await this.revealFile(message.path);
          break;
        case "undoEdit":
          await this.undoEdit(message.path);
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
  }

  private async refreshCatalog(): Promise<void> {
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
      // Merge locally-available Copilot LM models (VS Code vendor provider) into the catalog.
      // This lets the model picker show Copilot models even if the backend hasn't synced them yet.
      try {
        if (!readSettings().copilotModelsEnabled) throw new Error("Copilot LM disabled");
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
    if (this.backendStatus !== "ok") {
      this.broadcastSessions();
      return;
    }
    try {
      const all = await listConversations();
      await this.syncProjectConversations(all);
      const owned = all.filter((c) => this.conversationBelongsToProject(c));
      this.conversations.clear();
      for (const c of owned) this.conversations.set(c.id, c);
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
    } catch (err) {
      this.output.appendLine(`[chat.messages] ${err instanceof Error ? err.message : String(err)}`);
      this.messagesCache.set(conversationId, []);
    }
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
        const base: ChatMessage = {
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
          createdAt: new Date(m.createdAt).getTime() || Date.now(),
          status: "complete",
        };
        if (consumed?.has(m.id)) base.pipelineCardConsumed = true;
        return base;
      });
    const kind = this.sessionKinds.get(conv.id) ?? "vibe";
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
    };
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
    return {
      provider: (conv.provider as ConfiguredProvider) ?? stored.provider,
      model: conv.model ?? stored.model,
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
    };
  }

  private async persistActive(): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_SESSION_STORAGE_KEY, this.activeSessionId);
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

  private resolveProviderModel(overrides: ChatOverrides): { provider: Provider; model: string } | null {
    const fromOverride = overrides.provider && overrides.model
      ? findConfiguredModel(this.catalog.models, overrides.provider, overrides.model)
      : undefined;
    const chosen = fromOverride ?? defaultEnabledModel(this.catalog.models);
    if (!chosen) return null;
    return { provider: toWireProvider(chosen.provider), model: chosen.modelId };
  }

  private buildIdeContext(conversationId: string): IdeToolContextPayload | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    return {
      sessionId: `vscode-${folder.name}`,
      userId: "default",
      projectPath: folder.uri.fsPath,
      mode: "desktop",
      terminalExecutor: "client",
      conversationId,
    };
  }

  private async sendChat(sessionId: string, content: string): Promise<void> {
    let session = this.findSession(sessionId);
    if (!session) return;
    if (this.streams.has(sessionId)) {
      this.broadcast({ type: "log", message: "A response is already streaming for this chat." });
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
    const resolved = this.resolveProviderModel(session.overrides);
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

    const body: ChatRequest = {
      conversationId,
      provider: resolved.provider,
      model: resolved.model,
      modelSelection: settings.modelSelection,
      chatMode,
      content: rest || content,
      systemPrompt,
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

    const abort = new AbortController();
    const streamStartedAt = Date.now();
    const streamState: ActiveStream = {
      abort,
      messageId: assistantMessage.id,
      startedAt: streamStartedAt,
      tools: new Map(),
      edits: new Map(),
    };
    this.streams.set(conversationId, streamState);
    this.broadcast({
      type: "messageStart",
      sessionId: conversationId,
      messageId: assistantMessage.id,
      startedAt: streamStartedAt,
    });
    let buffer = "";
    try {
      const handlers = {
        onToken: (text: string) => {
          buffer += text;
          assistantMessage.content = buffer;
          this.broadcast({ type: "messageAppend", sessionId: conversationId, messageId: assistantMessage.id, chunk: text });
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
        onTerminalDelegate: async (delegate: TerminalDelegateEvent) => {
          this.broadcast({
            type: "log",
            message: `Running command locally: ${delegate.command.slice(0, 72)}${delegate.command.length > 72 ? "…" : ""}`,
          });
          const result = await runLocalTerminal(delegate);
          const complete = await apiFetch(`/api/ide/terminal/${encodeURIComponent(delegate.delegateId)}/complete`, {
            method: "POST",
            body: JSON.stringify(result),
          });
          if (!complete.ok) {
            const errText = await complete.text().catch(() => complete.statusText);
            throw new Error(errText || "Failed to report terminal output to API");
          }
        },
      };

      const useLocalCopilot =
        body.provider === "copilot" &&
        readSettings().copilotModelsEnabled &&
        (await listCopilotLmModels().then((m) => m.some((x) => x.modelId === body.model)).catch(() => false));
      const copilotAttachments = useLocalCopilot
        ? body.documentIds
            .map((id) => this.attachmentBytes.get(id))
            .filter((entry): entry is { data: Uint8Array; mimeType: string; name: string } => !!entry)
        : [];
      const response = useLocalCopilot
        ? await streamCopilotChat({
            modelId: body.model,
            history: (messages ?? [])
              .filter((m) => m.role === "user" || m.role === "assistant")
              .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
            prompt: body.content,
            toolsEnabled: body.toolsEnabled,
            attachments: copilotAttachments,
            onToken: handlers.onToken,
            onToolEvent: handlers.onToolEvent,
            signal: abort.signal,
          }).then((r) => {
            if (r.skippedAttachments.length) {
              const names = r.skippedAttachments.map((a) => a.name).join(", ");
              this.broadcast({ type: "log", message: `Copilot model ignored unsupported attachments: ${names}.` });
            }
            return { assistantMessage: { id: assistantMessage.id, content: r.content } };
          })
        : await streamChat(body, handlers, abort.signal);

      const finalConversation = "conversation" in response ? response.conversation as Conversation | undefined : undefined;
      if (finalConversation) this.conversations.set(finalConversation.id, finalConversation);
      if (response.assistantMessage?.id) assistantMessage.id = response.assistantMessage.id;
      if (response.assistantMessage?.content) {
        assistantMessage.content = response.assistantMessage.content;
        buffer = assistantMessage.content;
      }
      if (command === "tasks" && buffer) {
        try {
          const written = await this.writeGeneratedTasks(buffer);
          if (written > 0) {
            const note = `\n\n_Wrote **${written}** task contract${written === 1 ? "" : "s"} for the active feature._`;
            assistantMessage.content += note;
            this.broadcast({ type: "messageAppend", sessionId: conversationId, messageId: assistantMessage.id, chunk: note });
          }
        } catch (err) {
          this.output.appendLine(`[chat.tasks] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.broadcast({
        type: "messageComplete",
        sessionId: conversationId,
        messageId: assistantMessage.id,
        conversationId,
        completedAt: Date.now(),
      });
      void this.refreshSingleConversation(conversationId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[chat] ${msg}`);
      if (abort.signal.aborted) {
        const note = `${buffer ? "\n\n" : ""}_Cancelled._`;
        assistantMessage.content = `${buffer}${note}`;
        this.broadcast({ type: "messageAppend", sessionId: conversationId, messageId: assistantMessage.id, chunk: note });
        this.broadcast({
          type: "messageComplete",
          sessionId: conversationId,
          messageId: assistantMessage.id,
          conversationId,
          completedAt: Date.now(),
        });
      } else {
        this.broadcast({
          type: "messageError",
          sessionId: conversationId,
          messageId: assistantMessage.id,
          error: msg,
          completedAt: Date.now(),
        });
      }
    } finally {
      this.streams.delete(conversationId);
    }
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
      if (overrides.agentId) patch.agentId = overrides.agentId;
      if (allowedAgentIds.length) patch.allowedAgentIds = allowedAgentIds;
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
    try {
      const list = await listConversations();
      const updated = list.find((c) => c.id === id);
      if (updated) this.conversations.set(id, updated);
      const fresh = await listConversationMessages(id);
      this.messagesCache.set(id, fresh);
      this.broadcastSessions();
      if (this.activeSessionId === id) this.broadcastActiveSession();
    } catch (err) {
      this.output.appendLine(`[chat.refresh] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async revealFile(relativePath: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      this.broadcast({ type: "log", message: "No workspace folder open." });
      return;
    }
    const target = vscode.Uri.joinPath(root, relativePath.replace(/^\/+/, ""));
    try {
      const doc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      this.broadcast({ type: "log", message: `Could not open ${relativePath}: ${err instanceof Error ? err.message : err}` });
    }
  }

  private async undoEdit(relativePath: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.broadcast({ type: "log", message: "No workspace folder open." });
      return;
    }
    const clean = relativePath.replace(/^\/+/, "");
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["checkout", "--", clean], { cwd: root, timeout: 15_000, windowsHide: true }, (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
    }).then(async () => {
      await this.revealFile(clean);
      this.broadcast({ type: "log", message: `Reverted ${clean} to last git state.`, severity: "info" });
    }).catch((err) => {
      this.broadcast({ type: "log", message: `Undo failed for ${clean}: ${err instanceof Error ? err.message : err}` });
    });
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
      this.broadcast({ type: "log", message: "A response is already streaming for this chat." });
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
    const tasksDirUri = vscode.Uri.joinPath(root, "tasks");
    const requirementsUri = vscode.Uri.joinPath(root, "requirements.md");
    const designUri = vscode.Uri.joinPath(root, "design.md");

    const conversationId = session.conversationId;
    const messages = this.messagesCache.get(conversationId) ?? [];
    const userPrompt = `Generate the requirements, design, and task contracts for the feature "${featureName}". Emit the marker [[FEATURE_NAME: ${slug}]] on the first line.`;

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
      modelSelection: readSettings().modelSelection,
      chatMode: "agent",
      content: userPrompt,
      systemPrompt: PIPELINE_GENERATE_SYSTEM_PROMPT,
      skillIds: [],
      documentIds: [],
      useRag: false,
      toolsEnabled: true,
      mcpServerIds: [],
      allowedAgentIds: [],
      maxAgentSpawns: this.catalog.maxAgentSpawns,
    };

    const abort = new AbortController();
    const streamStartedAt = Date.now();
    const streamState: ActiveStream = {
      abort,
      messageId: assistantMessage.id,
      startedAt: streamStartedAt,
      tools: new Map(),
      edits: new Map(),
    };
    this.streams.set(conversationId, streamState);
    this.broadcast({
      type: "messageStart",
      sessionId: conversationId,
      messageId: assistantMessage.id,
      startedAt: streamStartedAt,
    });

    let buffer = "";
    try {
      const handlers = {
        onToken: (text: string) => {
          buffer += text;
          assistantMessage.content = buffer;
          this.broadcast({
            type: "messageAppend",
            sessionId: conversationId,
            messageId: assistantMessage.id,
            chunk: text,
          });
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
      };

      const useLocalCopilot =
        body.provider === "copilot" &&
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
            onToken: handlers.onToken,
            onToolEvent: handlers.onToolEvent,
            signal: abort.signal,
          }).then((r) => ({ assistantMessage: { id: assistantMessage.id, content: r.content } }))
        : await streamChat(body, handlers, abort.signal);

      const finalConversation = (response as { conversation?: Conversation }).conversation;
      if (finalConversation) this.conversations.set(finalConversation.id, finalConversation);
      if (response.assistantMessage?.id) assistantMessage.id = response.assistantMessage.id;
      if (response.assistantMessage?.content) {
        assistantMessage.content = response.assistantMessage.content;
        buffer = assistantMessage.content;
      }

      let taskCount = 0;
      try {
        const sections = parsePipelineSections(buffer);
        await writeTextFile(requirementsUri, `# Requirements\n\n${sections.requirements}\n`);
        await writeTextFile(designUri, `# Design\n\n${sections.design}\n`);
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
          messageId: assistantMessage.id,
          chunk: note,
        });
        this.broadcast({
          type: "messageComplete",
          sessionId: conversationId,
          messageId: assistantMessage.id,
          conversationId,
          completedAt: Date.now(),
        });
        void this.refreshSingleConversation(conversationId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`[chat.pipeline.write] ${msg}`);
        const note = `\n\n_Failed to scaffold pipeline files: ${msg}_`;
        assistantMessage.content += note;
        this.broadcast({
          type: "messageAppend",
          sessionId: conversationId,
          messageId: assistantMessage.id,
          chunk: note,
        });
        this.broadcast({
          type: "messageComplete",
          sessionId: conversationId,
          messageId: assistantMessage.id,
          conversationId,
          completedAt: Date.now(),
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[chat.pipeline] ${msg}`);
      if (abort.signal.aborted) {
        const note = `${buffer ? "\n\n" : ""}_Cancelled._`;
        assistantMessage.content = `${buffer}${note}`;
        this.broadcast({
          type: "messageAppend",
          sessionId: conversationId,
          messageId: assistantMessage.id,
          chunk: note,
        });
        this.broadcast({
          type: "messageComplete",
          sessionId: conversationId,
          messageId: assistantMessage.id,
          conversationId,
          completedAt: Date.now(),
        });
      } else {
        this.broadcast({
          type: "messageError",
          sessionId: conversationId,
          messageId: assistantMessage.id,
          error: msg,
          completedAt: Date.now(),
        });
      }
    } finally {
      this.streams.delete(conversationId);
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
      `img-src ${webview.cspSource} https: data:`,
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
    models: (config.configuredModels ?? []).filter((m) => m.enabled !== false),
    agents: config.agents ?? [],
    skills: config.skills ?? [],
    mcpServers: config.mcpServers ?? [],
    documents,
    maxAgentSpawns: config.maxAgentSpawns ?? 3,
  };
}

function parsePipelineSections(buffer: string): { requirements: string; design: string } {
  const lines = buffer.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && !/^\s*#\s+/.test(lines[i])) i++;
  const sections = new Map<string, string[]>();
  let currentKey: string | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^\s*#\s+(.+?)\s*$/);
    if (match) {
      const heading = match[1].toLowerCase();
      if (heading === "requirements" || heading === "design") {
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
  return { requirements, design };
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
    recordFileEdit(stream.edits, event.name, event.arguments ?? {}, event.result);
    return { entry, editedFiles: [...stream.edits.values()] };
  }

  existing.completedAt = now;
  existing.activityKind = existing.activityKind ?? toolActivityKind(existing.name);
  if (event.result !== undefined) {
    existing.result = event.result;
    existing.status = looksLikeToolError(event.result) ? "error" : "complete";
    if (existing.status === "error") existing.error = event.result.slice(0, 300);
    recordFileEdit(stream.edits, event.name, event.arguments ?? {}, event.result);
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
): void {
  if (name !== "ide_write_file" && name !== "ide_edit_file") return;
  const path = typeof args.path === "string" ? args.path : undefined;
  if (!path) return;

  const current = edits.get(path) ?? { path, writes: 0, edits: 0, additions: 0, deletions: 0 };
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
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
