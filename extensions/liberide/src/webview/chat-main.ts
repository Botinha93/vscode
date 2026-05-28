import type { LiberideSettings } from "../settings";
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
  ToolTimelineEntry,
} from "../chat/chat-protocol";
import type { ConfiguredProvider, DocumentRecord } from "../chat/types";
import { buildChatSlashCommands, parseSlashQuery } from "@nexus/shared";
import { highlightCode } from "./highlight";

interface VsCodeApi {
  postMessage(message: ChatWebviewToHost): void;
  setState(state: unknown): void;
  getState<T = unknown>(): T | undefined;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

interface AppState {
  settings: LiberideSettings | null;
  sessions: SessionSummary[];
  activeSession: ChatSession | null;
  activeSessionId: string | null;
  project: ProjectInfo | null;
  catalog: BackendCatalog;
  backendStatus: BackendStatus;
  apiOrigin: string;
  sidebarOpen: boolean;
  settingsOpen: boolean;
  modelPickerOpen: boolean;
  agentPickerOpen: boolean;
  draft: string;
  streaming: boolean;
  /** messageId -> whether the "Worked for" timeline is expanded */
  expandedTimelines: Set<string>;
  /** messageId -> whether the edit card file list is expanded */
  expandedEditCards: Set<string>;
  /** message ids whose pipeline-ready card was acted on locally; must never re-render. */
  consumedPipelineCards: Set<string>;
}

const state: AppState = {
  settings: null,
  sessions: [],
  activeSession: null,
  activeSessionId: null,
  project: null,
  catalog: { models: [], agents: [], skills: [], mcpServers: [], documents: [], maxAgentSpawns: 3 },
  backendStatus: "unconfigured",
  apiOrigin: "",
  sidebarOpen: false,
  settingsOpen: false,
  modelPickerOpen: false,
  agentPickerOpen: false,
  draft: "",
  streaming: false,
  expandedTimelines: new Set(),
  expandedEditCards: new Set(),
  consumedPipelineCards: new Set(),
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  google: "Google",
  ollama: "Ollama",
  "ollama-internal": "Ollama (internal)",
  llamacpp: "llama.cpp",
  lmstudio: "LM Studio",
  custom: "Custom",
};

const root = document.getElementById("root") as HTMLDivElement;

function send(msg: ChatWebviewToHost): void {
  vscode.postMessage(msg);
}

// ---------------------------------------------------------------------------
// Effective values from session overrides + settings + catalog
// ---------------------------------------------------------------------------

interface ResolvedSelections {
  provider?: ConfiguredProvider;
  model?: string;
  chatMode: "normal" | "agent";
  useRag: boolean;
  toolsEnabled: boolean;
  agentIds: string[];
  skillIds: string[];
  mcpServerIds: string[];
  documentIds: string[];
}

function effective(): ResolvedSelections {
  const s = state.settings;
  const o = state.activeSession?.overrides ?? {};
  const fallbackModel = state.catalog.models.find((m) => m.enabled);
  return {
    provider: o.provider ?? fallbackModel?.provider,
    model: o.model ?? fallbackModel?.modelId,
    chatMode: "agent",
    useRag: o.useRag ?? s?.useRag ?? false,
    toolsEnabled: true,
    agentIds: o.agentIds ?? [],
    skillIds: o.skillIds ?? [],
    mcpServerIds: o.mcpServerIds ?? [],
    documentIds: o.documentIds ?? [],
  };
}

function selectedAttachments(): DocumentRecord[] {
  const ids = state.activeSession?.overrides.documentIds ?? [];
  if (!ids.length) return [];
  return state.catalog.documents.filter((document) => ids.includes(document.id));
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setOverrides(partial: ChatOverrides): void {
  if (!state.activeSession) return;
  send({ type: "setOverrides", sessionId: state.activeSession.id, overrides: partial });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(): void {
  if (!root.firstChild) {
    root.innerHTML = shellHtml();
    bindShell();
  }
  renderProjectBar();
  renderSidebar();
  renderHeader();
  renderTranscript();
  renderComposer();
  renderComposerAttachments();
  applySettings();
  applyModelPicker();
  applyAgentPicker();
  renderBackendBanner();
}

function shellHtml(): string {
  return `
    <div class="chat-shell">
      <aside class="chat-sidebar" id="chat-sidebar" hidden>
        <header class="chat-sidebar-header">
          <span>Chats</span>
          <button class="icon-btn" id="sidebar-close" title="Close" aria-label="Close">\u2715</button>
        </header>
        <div class="chat-sidebar-actions">
          <button class="ghost-btn" id="sidebar-new">\u002B  New chat</button>
          <button class="ghost-btn" id="sidebar-history" title="Open chat history" aria-label="Open chat history">📜  History</button>
        </div>
        <div class="chat-sidebar-list" id="session-list"></div>
        <footer class="chat-sidebar-footer">
          <button class="ghost-btn small" id="sidebar-refresh" title="Refresh chats from LiberIDE">\u21BB  Refresh</button>
        </footer>
      </aside>
      <div class="chat-main">
        <div class="project-bar" id="project-bar"></div>
        <div class="backend-banner" id="backend-banner" hidden></div>
        <section class="chat-transcript" id="transcript"></section>
        <footer class="chat-composer">
          <div class="composer-card">
            <div class="composer-attachments" id="composer-attachments" hidden></div>
            <textarea id="composer" placeholder="Ask for follow-up changes\u2026" rows="1"></textarea>
            <div class="composer-toolbar" id="chip-row"></div>
          </div>
          <div class="composer-foot">
            <button class="chip chip-foot" id="chip-rag" title="Use indexed documents (RAG)">
              <span class="chip-dot"></span>
              <span id="chip-rag-label">Work locally</span>
            </button>
            <div class="composer-hints" id="composer-hints"></div>
          </div>
        </footer>
      </div>
      <div class="modal-backdrop" id="modal-backdrop" hidden></div>
      <div class="popover" id="model-picker" hidden></div>
      <div class="popover" id="agent-picker" hidden></div>
      <aside class="settings-overlay" id="settings-overlay" hidden>
        <header class="settings-overlay-header">
          <span>LiberIDE Settings</span>
          <button class="icon-btn" id="settings-close" title="Close settings" aria-label="Close settings">\u2715</button>
        </header>
        <div class="settings-grid" id="settings-form"></div>
      </aside>
    </div>
  `;
}

function bindShell(): void {
  root.querySelector<HTMLButtonElement>("#sidebar-toggle")?.addEventListener("click", () => {
    state.sidebarOpen = !state.sidebarOpen;
    applySidebar();
  });
  root.querySelector<HTMLButtonElement>("#sidebar-close")?.addEventListener("click", () => {
    state.sidebarOpen = false;
    applySidebar();
  });
  root.querySelector<HTMLButtonElement>("#sidebar-new")?.addEventListener("click", () => send({ type: "newSession" }));
  root.querySelector<HTMLButtonElement>("#sidebar-history")?.addEventListener("click", () => {
    state.sidebarOpen = true;
    applySidebar();
  });
  root.querySelector<HTMLButtonElement>("#sidebar-refresh")?.addEventListener("click", () => send({ type: "refreshSessions" }));
  root.querySelector<HTMLButtonElement>("#new-chat")?.addEventListener("click", () => send({ type: "newSession" }));
  root.querySelector<HTMLButtonElement>("#header-pipeline")?.addEventListener("click", () => send({ type: "openPipeline" }));
  root.querySelector<HTMLButtonElement>("#header-history")?.addEventListener("click", () => {
    state.sidebarOpen = true;
    applySidebar();
  });
  root.querySelector<HTMLButtonElement>("#header-settings")?.addEventListener("click", () => {
    state.settingsOpen = true;
    applySettings();
  });
  root.querySelector<HTMLButtonElement>("#settings-close")?.addEventListener("click", () => {
    state.settingsOpen = false;
    applySettings();
  });
  root.querySelector<HTMLButtonElement>("#modal-backdrop")?.addEventListener("click", () => {
    if (state.modelPickerOpen) { state.modelPickerOpen = false; applyModelPicker(); }
    if (state.agentPickerOpen) { state.agentPickerOpen = false; applyAgentPicker(); }
    if (state.settingsOpen)   { state.settingsOpen = false;   applySettings(); }
  });

  const composer = root.querySelector<HTMLTextAreaElement>("#composer")!;
  composer.addEventListener("input", () => {
    state.draft = composer.value;
    autosize(composer);
    renderComposerHints();
  });
  composer.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
}

function submit(): void {
  if (!state.activeSession) return;
  if (state.streaming) {
    send({ type: "cancelMessage", sessionId: state.activeSession.id });
    return;
  }
  const composer = root.querySelector<HTMLTextAreaElement>("#composer")!;
  const text = composer.value.trim();
  if (!text) return;
  send({ type: "sendMessage", sessionId: state.activeSession.id, content: text });
  composer.value = "";
  state.draft = "";
  autosize(composer);
  renderComposerHints();
}

function autosize(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  const max = 200;
  el.style.height = Math.min(el.scrollHeight, max) + "px";
}

function applySidebar(): void {
  const el = root.querySelector<HTMLElement>("#chat-sidebar");
  if (el) el.toggleAttribute("hidden", !state.sidebarOpen);
}

function applySettings(): void {
  const el = root.querySelector<HTMLElement>("#settings-overlay");
  const backdrop = root.querySelector<HTMLElement>("#modal-backdrop");
  if (el) el.toggleAttribute("hidden", !state.settingsOpen);
  if (backdrop) backdrop.toggleAttribute("hidden", !(state.settingsOpen || state.modelPickerOpen || state.agentPickerOpen));
  if (state.settingsOpen) renderSettings();
}

function applyModelPicker(): void {
  const el = root.querySelector<HTMLElement>("#model-picker");
  const backdrop = root.querySelector<HTMLElement>("#modal-backdrop");
  if (el) el.toggleAttribute("hidden", !state.modelPickerOpen);
  if (backdrop) backdrop.toggleAttribute("hidden", !(state.settingsOpen || state.modelPickerOpen || state.agentPickerOpen));
  if (state.modelPickerOpen) renderModelPicker();
}

function applyAgentPicker(): void {
  const el = root.querySelector<HTMLElement>("#agent-picker");
  const backdrop = root.querySelector<HTMLElement>("#modal-backdrop");
  if (el) el.toggleAttribute("hidden", !state.agentPickerOpen);
  if (backdrop) backdrop.toggleAttribute("hidden", !(state.settingsOpen || state.modelPickerOpen || state.agentPickerOpen));
  if (state.agentPickerOpen) renderAgentPicker();
}

// ---------------------------------------------------------------------------
// Project bar
// ---------------------------------------------------------------------------

function renderProjectBar(): void {
  const bar = root.querySelector<HTMLDivElement>("#project-bar");
  if (!bar) return;
  if (!state.project || state.project.source === "none") {
    bar.innerHTML = `<span class="project-name">No workspace folder</span>`;
    return;
  }
  const icon = state.project.source === "git" ? "\u2387" : "\u25A2";
  const subtitle = state.project.source === "git"
    ? state.project.remoteUrl ?? state.project.id
    : state.project.rootPath ?? "";
  const branch = state.project.branch ? ` <span class="project-branch">\u2387 ${escapeHtml(state.project.branch)}</span>` : "";
  bar.innerHTML = `
    <span class="project-icon">${icon}</span>
    <div class="project-text">
      <div class="project-name">${escapeHtml(state.project.name)}${branch}</div>
      <div class="project-subtitle" title="${escapeAttr(subtitle)}">${escapeHtml(subtitle)}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Sidebar (sessions list)
// ---------------------------------------------------------------------------

function renderSidebar(): void {
  const list = root.querySelector<HTMLDivElement>("#session-list");
  if (!list) return;
  list.innerHTML = "";
  if (state.sessions.length === 0) {
    list.innerHTML = `<div class="sidebar-empty">No chats yet for this project.</div>`;
    return;
  }
  for (const s of state.sessions) {
    const row = document.createElement("div");
    row.className = "session-row" + (s.id === state.activeSessionId ? " active" : "");
    const time = relativeTime(s.updatedAt);
    const tag = s.remote ? "" : `<span class="session-tag">draft</span>`;
    const pill = s.kind === "pipeline" ? `<span class="kind-pill kind-pipeline">Pipeline</span>` : "";
    row.innerHTML = `
      <div class="session-row-main">
        <div class="session-row-title">${escapeHtml(s.title)} ${tag}</div>
        <div class="session-row-meta">${s.messageCount} \u00B7 ${time}${pill ? " " : ""}${pill}</div>
      </div>
      <button class="icon-btn session-delete" title="Delete" aria-label="Delete">\u2715</button>
    `;
    row.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest(".session-delete")) return;
      send({ type: "openSession", sessionId: s.id });
      state.sidebarOpen = false;
      applySidebar();
    });
    row.querySelector<HTMLButtonElement>(".session-delete")?.addEventListener("click", (event) => {
      event.stopPropagation();
      send({ type: "deleteSession", sessionId: s.id });
    });
    list.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function renderHeader(): void {
  const title = root.querySelector<HTMLDivElement>("#chat-title");
  if (!title) return;
  const t = state.activeSession?.title || "New chat";
  const isPipeline = state.activeSession?.kind === "pipeline";
  title.innerHTML = `<span class="chat-title-text">${escapeHtml(t)}</span>${isPipeline ? `<span class="kind-pill kind-pipeline">Pipeline</span>` : ""}`;
  title.title = "Click to rename";
  title.onclick = (event) => {
    if (!state.activeSession) return;
    if ((event.target as HTMLElement).closest(".kind-pill")) return;
    const next = window.prompt("Rename chat", state.activeSession.title);
    if (next != null) send({ type: "renameSession", sessionId: state.activeSession.id, title: next });
  };
}

// ---------------------------------------------------------------------------
// Backend banner
// ---------------------------------------------------------------------------

function renderBackendBanner(): void {
  const banner = root.querySelector<HTMLDivElement>("#backend-banner");
  if (!banner) return;
  if (state.backendStatus === "ok") {
    banner.toggleAttribute("hidden", true);
    return;
  }
  banner.toggleAttribute("hidden", false);
  if (state.backendStatus === "unconfigured") {
    banner.className = "backend-banner unconfigured";
    banner.innerHTML = `LiberIDE API origin is not configured. Set <code>LIBERIDE_API_ORIGIN</code> in your environment to start chatting.`;
  } else if (state.backendStatus === "unauthorized") {
    banner.className = "backend-banner unauthorized";
    banner.innerHTML = `VS Code is not signed in to LiberIDE. Close this window and reopen the project from the LiberIDE desktop app while you are logged in.`;
  } else {
    banner.className = "backend-banner unreachable";
    banner.innerHTML = `Can't reach LiberIDE at <code>${escapeHtml(state.apiOrigin)}</code>. <button id="retry-backend" class="link-btn">Retry</button>`;
    banner.querySelector<HTMLButtonElement>("#retry-backend")?.addEventListener("click", () => send({ type: "refreshCatalog" }));
  }
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

function renderTranscript(): void {
  const transcript = root.querySelector<HTMLDivElement>("#transcript");
  if (!transcript) return;
  transcript.innerHTML = "";
  const messages = state.activeSession?.messages ?? [];
  if (messages.length === 0) {
    transcript.appendChild(renderEmptyState());
    return;
  }
  for (const m of messages) {
    transcript.appendChild(renderMessage(m));
  }
  transcript.scrollTop = transcript.scrollHeight;
}

function renderEmptyState(): HTMLElement {
  const el = document.createElement("div");
  el.className = "empty-state";
  const projectLine = state.project && state.project.source !== "none"
    ? `<div class="empty-project">Chats here live with <strong>${escapeHtml(state.project.name)}</strong>${state.project.source === "git" ? " (git project)" : ""}.</div>`
    : "";

  if (state.activeSession?.kind === "pipeline") {
    el.innerHTML = `
      <h2>Guided feature builder</h2>
      ${projectLine}
      <div class="empty-cards">
        <div class="empty-card-hint">
          <div class="empty-card-title">Describe the feature or system you want to build.</div>
          <div class="empty-card-sub">I'll ask follow-up questions before scaffolding the pipeline.</div>
          <button class="link-btn" id="switch-to-vibe" type="button">Switch to free chat</button>
        </div>
      </div>
    `;
    el.querySelector<HTMLButtonElement>("#switch-to-vibe")?.addEventListener("click", () => {
      if (!state.activeSession) return;
      send({ type: "setSessionKind", sessionId: state.activeSession.id, kind: "vibe" });
      const composer = root.querySelector<HTMLTextAreaElement>("#composer");
      composer?.focus();
    });
    return el;
  }

  el.innerHTML = `
    <h2>What can I build for you?</h2>
    ${projectLine}
    <div class="empty-cards">
      <button class="empty-card" type="button" data-card="vibe">
        <span class="empty-card-title">Free chat</span>
        <span class="empty-card-sub">Ask, brainstorm, or pair-program. The model can edit files and run tools.</span>
      </button>
      <button class="empty-card primary" type="button" data-card="pipeline">
        <span class="empty-card-title">Guided feature builder</span>
        <span class="empty-card-sub">I'll ask focused questions, then scaffold requirements, design, and tasks for you to dispatch.</span>
      </button>
    </div>
  `;
  el.querySelector<HTMLButtonElement>('[data-card="vibe"]')?.addEventListener("click", () => {
    const composer = root.querySelector<HTMLTextAreaElement>("#composer");
    composer?.focus();
  });
  el.querySelector<HTMLButtonElement>('[data-card="pipeline"]')?.addEventListener("click", () => {
    if (!state.activeSession) return;
    send({ type: "setSessionKind", sessionId: state.activeSession.id, kind: "pipeline" });
    const composer = root.querySelector<HTMLTextAreaElement>("#composer");
    composer?.focus();
  });
  return el;
}

function renderMessage(message: ChatMessage): HTMLElement {
  const turn = document.createElement("article");
  turn.className = `turn turn-${message.role}` + (message.status === "streaming" ? " streaming" : "") + (message.status === "error" ? " error" : "");
  turn.dataset.messageId = message.id;

  if (message.role === "user") {
    turn.innerHTML = `
      <div class="bubble bubble-user">
        <div class="turn-content"></div>
      </div>
      <div class="turn-avatar avatar-user">U</div>
    `;
    const content = turn.querySelector<HTMLDivElement>(".turn-content")!;
    content.innerHTML = renderMarkdownish(message.content);
    bindMarkdownExtras(content);
    return turn;
  }

  const timelineHtml = renderTimelineBlock(message);
  const editCardHtml = renderEditCard(message);
  const showWorking = message.status === "streaming" && !message.content && !(message.tools?.length);

  const { visibleContent, readyFeatureName, hasOpenPipeline } = extractPipelineMarkers(message);

  turn.innerHTML = `
    <div class="assistant-meta">
      ${timelineHtml}
      ${editCardHtml}
      ${showWorking ? `<div class="assistant-status"><span class="turn-indicator"></span><span>Working\u2026</span></div>` : ""}
    </div>
    <div class="turn-content"></div>
    ${message.status === "error" && message.error ? `<div class="turn-error">${escapeHtml(message.error)}</div>` : ""}
    ${message.status === "complete" ? `<div class="assistant-actions">
      <button class="icon-btn small" title="Copy" aria-label="Copy" data-act="copy">\u2398</button>
      <button class="icon-btn small" title="Helpful" aria-label="Helpful" data-act="up">\u{1F44D}</button>
      <button class="icon-btn small" title="Not helpful" aria-label="Not helpful" data-act="down">\u{1F44E}</button>
      <button class="icon-btn small" title="Share" aria-label="Share" data-act="share">\u21AA</button>
    </div>` : ""}
  `;
  const content = turn.querySelector<HTMLDivElement>(".turn-content")!;
  content.innerHTML = renderMarkdownish(visibleContent);
  bindMarkdownExtras(content);
  if (hasOpenPipeline) mountOpenPipelineButtons(content);
  const cardConsumed =
    message.pipelineCardConsumed === true || state.consumedPipelineCards.has(message.id);
  if (
    readyFeatureName !== null &&
    state.activeSession?.kind === "pipeline" &&
    message.status !== "streaming" &&
    !cardConsumed
  ) {
    mountPipelineReadyCard(turn, message, readyFeatureName);
  }
  bindAssistantMeta(turn, message);
  turn.querySelector<HTMLButtonElement>('[data-act="copy"]')?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(message.content); } catch { /* clipboard blocked */ }
  });
  return turn;
}

const OPEN_PIPELINE_PLACEHOLDER = "OPENPIPELINEBUTTONMOUNTx7n3v8q2t";

function extractPipelineMarkers(message: ChatMessage): {
  visibleContent: string;
  readyFeatureName: string | null;
  hasOpenPipeline: boolean;
} {
  let visible = message.content ?? "";
  let readyFeatureName: string | null = null;
  if (state.activeSession?.kind === "pipeline") {
    const readyMatch = visible.match(/\n?\s*\[\[PIPELINE_READY:\s*([^\]\n]+)\]\]\s*$/);
    if (readyMatch) {
      readyFeatureName = readyMatch[1].trim();
      visible = visible.slice(0, readyMatch.index).replace(/\s+$/, "");
    }
  }
  const hasOpenPipeline = /\[\[OPEN_PIPELINE\]\]/.test(visible);
  if (hasOpenPipeline) {
    visible = visible.replace(/\[\[OPEN_PIPELINE\]\]/g, OPEN_PIPELINE_PLACEHOLDER);
  }
  return { visibleContent: visible, readyFeatureName, hasOpenPipeline };
}

function mountOpenPipelineButtons(scope: HTMLElement): void {
  const buttonHtml = `<button class="btn-primary open-pipeline-btn" type="button">Open pipeline</button>`;
  if (!scope.innerHTML.includes(OPEN_PIPELINE_PLACEHOLDER)) return;
  scope.innerHTML = scope.innerHTML.replaceAll(OPEN_PIPELINE_PLACEHOLDER, buttonHtml);
  for (const btn of scope.querySelectorAll<HTMLButtonElement>(".open-pipeline-btn")) {
    btn.addEventListener("click", () => send({ type: "openPipeline" }));
  }
}

function mountPipelineReadyCard(turn: HTMLElement, message: ChatMessage, featureName: string): void {
  const sessionId = state.activeSession?.id;
  if (!sessionId) return;
  const card = document.createElement("div");
  card.className = "pipeline-ready-card";
  card.innerHTML = `
    <div class="pipeline-ready-label">Ready to scaffold the feature pipeline.</div>
    <input type="text" class="pipeline-ready-input" value="${escapeAttr(featureName)}" placeholder="feature-name" />
    <div class="pipeline-ready-actions">
      <button class="btn-secondary pipeline-ready-keep" type="button">Keep chatting</button>
      <button class="btn-primary pipeline-ready-generate" type="button">Generate pipeline</button>
    </div>
  `;
  const input = card.querySelector<HTMLInputElement>(".pipeline-ready-input")!;
  const generateBtn = card.querySelector<HTMLButtonElement>(".pipeline-ready-generate")!;
  const keepBtn = card.querySelector<HTMLButtonElement>(".pipeline-ready-keep")!;
  generateBtn.addEventListener("click", () => {
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    state.consumedPipelineCards.add(message.id);
    generateBtn.disabled = true;
    keepBtn.disabled = true;
    input.disabled = true;
    send({ type: "generatePipeline", sessionId, featureName: name });
    send({ type: "consumePipelineCard", sessionId, messageId: message.id });
  });
  keepBtn.addEventListener("click", () => {
    state.consumedPipelineCards.add(message.id);
    card.remove();
    send({ type: "consumePipelineCard", sessionId, messageId: message.id });
  });
  const contentEl = turn.querySelector<HTMLDivElement>(".turn-content");
  if (contentEl?.nextSibling) {
    turn.insertBefore(card, contentEl.nextSibling);
  } else {
    turn.appendChild(card);
  }
}

function renderTimelineBlock(message: ChatMessage): string {
  const tools = message.tools ?? [];
  if (tools.length === 0 && message.status !== "streaming") return "";
  const duration = formatWorkDuration(message);
  const expanded = state.expandedTimelines.has(message.id) || message.status === "streaming";
  const chevron = expanded ? "\u25BE" : "\u25B8";
  const rows = tools.map((t) => {
    const icon = t.status === "running" ? `<span class="turn-indicator"></span>` : t.status === "error" ? "\u2717" : "\u2713";
    const label = escapeHtml(t.summary ?? t.name);
    return `<div class="timeline-row status-${t.status}"><span class="timeline-icon">${icon}</span><span>${label}</span></div>`;
  }).join("");
  const body = expanded && rows
    ? `<div class="timeline-body">${rows}</div>`
    : expanded && message.status === "streaming"
      ? `<div class="timeline-body timeline-empty">Waiting for tool activity\u2026</div>`
      : "";
  return `
    <button class="worked-toggle" data-message-id="${escapeAttr(message.id)}" type="button">
      <span class="worked-chevron">${chevron}</span>
      <span class="worked-label">${escapeHtml(duration)}</span>
    </button>
    ${body}
  `;
}

function renderEditCard(message: ChatMessage): string {
  const files = message.editedFiles ?? [];
  if (files.length === 0) return "";
  const totalAdds = files.reduce((n, f) => n + f.additions, 0);
  const totalDels = files.reduce((n, f) => n + f.deletions, 0);
  const expanded = state.expandedEditCards.has(message.id);
  const chevron = expanded ? "\u25BE" : "\u25B8";
  const fileRows = files.map((f) => {
    const stats = formatFileStats(f);
    return `
      <button class="edit-file-row" type="button" data-path="${escapeAttr(f.path)}" title="Open ${escapeAttr(f.path)}">
        <span class="edit-file-icon">\u2637</span>
        <span class="edit-file-path">${escapeHtml(f.path)}</span>
        <span class="edit-file-stats">${stats}</span>
      </button>
    `;
  }).join("");
  return `
    <div class="edit-card">
      <div class="edit-card-header">
        <button class="edit-card-toggle" type="button" data-message-id="${escapeAttr(message.id)}">
          <span class="edit-card-icon">\u2637</span>
          <span>Edited ${files.length} file${files.length === 1 ? "" : "s"}</span>
          <span class="edit-card-stats">${formatDiffSummary(totalAdds, totalDels)}</span>
          <span class="edit-card-chevron">${chevron}</span>
        </button>
        <div class="edit-card-actions">
          <button class="edit-action" type="button" data-act="undo-all" data-message-id="${escapeAttr(message.id)}">Undo</button>
          <button class="edit-action primary" type="button" data-act="review-all" data-message-id="${escapeAttr(message.id)}">Review</button>
        </div>
      </div>
      ${expanded ? `<div class="edit-card-files">${fileRows}</div>` : ""}
    </div>
  `;
}

function bindAssistantMeta(turn: HTMLElement, message: ChatMessage): void {
  turn.querySelector<HTMLButtonElement>(".worked-toggle")?.addEventListener("click", () => {
    if (state.expandedTimelines.has(message.id)) state.expandedTimelines.delete(message.id);
    else state.expandedTimelines.add(message.id);
    updateAssistantMetaInDom(message.id);
  });
  turn.querySelector<HTMLButtonElement>(".edit-card-toggle")?.addEventListener("click", () => {
    if (state.expandedEditCards.has(message.id)) state.expandedEditCards.delete(message.id);
    else state.expandedEditCards.add(message.id);
    updateAssistantMetaInDom(message.id);
  });
  turn.querySelectorAll<HTMLButtonElement>(".edit-file-row").forEach((btn) => {
    btn.addEventListener("click", () => {
      const path = btn.dataset.path;
      if (path) send({ type: "revealFile", path });
    });
  });
  turn.querySelector<HTMLButtonElement>('[data-act="undo-all"]')?.addEventListener("click", () => {
    for (const f of message.editedFiles ?? []) send({ type: "undoEdit", path: f.path });
  });
  turn.querySelector<HTMLButtonElement>('[data-act="review-all"]')?.addEventListener("click", () => {
    const first = message.editedFiles?.[0];
    if (first) send({ type: "revealFile", path: first.path });
  });
}

function updateAssistantMetaInDom(messageId: string): void {
  const session = state.activeSession;
  if (!session) return;
  const message = session.messages.find((m) => m.id === messageId);
  if (!message || message.role !== "assistant") return;
  const turn = root.querySelector<HTMLElement>(`.turn[data-message-id="${cssAttr(messageId)}"]`);
  if (!turn) return;
  const meta = turn.querySelector<HTMLDivElement>(".assistant-meta");
  if (!meta) return;
  meta.innerHTML = `
    ${renderTimelineBlock(message)}
    ${renderEditCard(message)}
    ${message.status === "streaming" && !message.content && !(message.tools?.length)
      ? `<div class="assistant-status"><span class="turn-indicator"></span><span>Working\u2026</span></div>`
      : ""}
  `;
  bindAssistantMeta(turn, message);
}

function formatWorkDuration(message: ChatMessage): string {
  const start = message.startedAt ?? message.createdAt;
  const end = message.completedAt ?? (message.status === "streaming" ? Date.now() : start);
  const ms = Math.max(0, end - start);
  if (message.status === "streaming") {
    if (ms < 1500) return "Working\u2026";
    return `Working for ${formatDuration(ms)}\u2026`;
  }
  if (ms < 1500 && !(message.tools?.length)) return "Finished";
  return `Worked for ${formatDuration(ms)}`;
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${Math.max(1, sec)}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${min}m ${rem}s` : `${min}m`;
}

function formatFileStats(file: EditedFileSummary): string {
  return formatDiffSummary(file.additions, file.deletions);
}

function formatDiffSummary(additions: number, deletions: number): string {
  const parts: string[] = [];
  if (additions > 0) parts.push(`+${additions}`);
  if (deletions > 0) parts.push(`-${deletions}`);
  return parts.length ? parts.join(" ") : "+0";
}

function upsertTool(tools: ToolTimelineEntry[] | undefined, entry: ToolTimelineEntry): ToolTimelineEntry[] {
  const list = tools ? [...tools] : [];
  const idx = list.findIndex((t) => t.id === entry.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...entry };
  else list.push(entry);
  return list;
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function renderComposer(): void {
  const toolbar = root.querySelector<HTMLDivElement>("#chip-row");
  if (!toolbar) return;
  const eff = effective();
  const modelLabel = describeModel(eff.provider, eff.model);
  const agentCount = eff.agentIds.length;

  toolbar.innerHTML = `
    <button class="composer-icon-btn" id="attach-btn" title="Attach files for chat and RAG" aria-label="Attach">+</button>
    <button class="chip${agentCount > 0 ? " chip-on" : ""}" id="chip-agents" title="Attach agents from LiberIDE" ${state.catalog.agents.length === 0 ? "disabled" : ""}>
      \u269B Agents${agentCount ? ` (${agentCount})` : ""}
    </button>
    <span class="composer-spacer"></span>
    <button class="chip chip-model" id="chip-model" title="Pick model for this chat" ${state.catalog.models.length === 0 ? "disabled" : ""}>
      <span>${escapeHtml(modelLabel)}</span>
      <span class="chip-caret">\u25BE</span>
    </button>
    <button class="send-btn" id="send-btn" title="Send" aria-label="Send"></button>
  `;
  toolbar.querySelector<HTMLButtonElement>("#chip-model")?.addEventListener("click", () => {
    state.modelPickerOpen = !state.modelPickerOpen;
    applyModelPicker();
  });
  toolbar.querySelector<HTMLButtonElement>("#chip-agents")?.addEventListener("click", () => {
    state.agentPickerOpen = !state.agentPickerOpen;
    applyAgentPicker();
  });
  toolbar.querySelector<HTMLButtonElement>("#send-btn")?.addEventListener("click", () => submit());
  toolbar.querySelector<HTMLButtonElement>("#attach-btn")?.addEventListener("click", () => {
    if (!state.activeSession || state.streaming) return;
    send({ type: "attachFiles", sessionId: state.activeSession.id });
  });

  const ragBtn = root.querySelector<HTMLButtonElement>("#chip-rag");
  if (ragBtn) {
    ragBtn.classList.toggle("chip-on", eff.useRag);
    const label = ragBtn.querySelector<HTMLSpanElement>("#chip-rag-label");
    if (label) label.textContent = eff.useRag ? "Use project knowledge" : "Work locally";
    ragBtn.onclick = () => setOverrides({ useRag: !eff.useRag });
  }

  const sendBtn = toolbar.querySelector<HTMLButtonElement>("#send-btn");
  if (sendBtn) {
    sendBtn.classList.toggle("streaming", state.streaming);
    sendBtn.innerHTML = state.streaming ? `<span class="stop-dot"></span>` : `\u2191`;
    sendBtn.title = state.streaming ? "Stop" : "Send";
  }
  renderComposerHints();
}

function renderComposerAttachments(): void {
  const container = root.querySelector<HTMLDivElement>("#composer-attachments");
  if (!container) return;
  const attachments = selectedAttachments();
  if (!attachments.length) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  container.hidden = false;
  container.innerHTML = attachments.map((document) => `
    <span class="composer-attachment" data-id="${escapeAttr(document.id)}">
      <span class="composer-attachment-name" title="${escapeAttr(document.name)}">${escapeHtml(document.name)}</span>
      <span class="composer-attachment-meta">${escapeHtml(document.contentKind)} \u00b7 ${escapeHtml(formatFileSize(document.size))}</span>
      <button type="button" class="composer-attachment-remove" data-id="${escapeAttr(document.id)}" title="Remove" aria-label="Remove">\u2715</button>
    </span>
  `).join("");
  for (const button of container.querySelectorAll<HTMLButtonElement>(".composer-attachment-remove")) {
    button.addEventListener("click", () => {
      if (!state.activeSession) return;
      send({ type: "removeAttachment", sessionId: state.activeSession.id, documentId: button.dataset.id ?? "" });
    });
  }
}

function renderComposerHints(): void {
  const hints = root.querySelector<HTMLDivElement>("#composer-hints");
  if (!hints) return;
  const draft = state.draft.trimStart();
  if (!draft.startsWith("/")) {
    hints.innerHTML = "";
    return;
  }

  const commands = buildChatSlashCommands({
    surface: "ide",
    agents: state.catalog.agents,
    slashQuery: parseSlashQuery(state.draft),
  });
  if (!commands.length) {
    hints.innerHTML = "";
    return;
  }

  hints.innerHTML = commands
    .slice(0, 8)
    .map(
      (command) => `
        <button class="hint" data-insert="${escapeAttr(command.insert)}" title="${escapeAttr(command.description)}">
          <span class="hint-label">${escapeHtml(command.label)}</span>
          <span class="hint-description">${escapeHtml(command.description)}</span>
        </button>
      `,
    )
    .join("");

  for (const button of hints.querySelectorAll<HTMLButtonElement>(".hint")) {
    button.addEventListener("click", () => {
      const composer = root.querySelector<HTMLTextAreaElement>("#composer")!;
      composer.value = button.dataset.insert ?? "";
      composer.focus();
      state.draft = composer.value;
      autosize(composer);
      renderComposerHints();
    });
  }
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

function renderModelPicker(): void {
  const el = root.querySelector<HTMLElement>("#model-picker");
  if (!el || !state.modelPickerOpen) return;
  const eff = effective();
  const grouped = groupModels(state.catalog.models);
  if (grouped.length === 0) {
    el.innerHTML = `
      <header class="popover-header">
        <span>Choose model</span>
        <button class="icon-btn" id="picker-close">\u2715</button>
      </header>
      <div class="popover-empty">
        No models configured in LiberIDE. Open the LiberIDE app and add a model under Settings \u2192 Models.
      </div>
    `;
  } else {
    el.innerHTML = `
      <header class="popover-header">
        <span>Model for this chat</span>
        <button class="icon-btn" id="picker-close">\u2715</button>
      </header>
      <div class="popover-body">
        ${grouped.map((g) => `
          <section class="popover-group">
            <h4>${escapeHtml(g.label)}</h4>
            <ul>
              ${g.models.map((m) => {
                const selected = m.provider === eff.provider && m.modelId === eff.model;
                const cap = (m.capabilities ?? []).slice(0, 3).join(", ");
                return `<li class="popover-row${selected ? " selected" : ""}" data-provider="${escapeAttr(m.provider)}" data-model="${escapeAttr(m.modelId)}">
                  <div class="popover-row-title">${escapeHtml(m.displayName)}</div>
                  <div class="popover-row-detail">${escapeHtml(cap || m.modelId)}</div>
                </li>`;
              }).join("")}
            </ul>
          </section>
        `).join("")}
      </div>
    `;
  }
  el.querySelector<HTMLButtonElement>("#picker-close")?.addEventListener("click", () => {
    state.modelPickerOpen = false;
    applyModelPicker();
  });
  for (const li of el.querySelectorAll<HTMLLIElement>(".popover-row")) {
    li.addEventListener("click", () => {
      setOverrides({
        provider: li.dataset.provider as ConfiguredProvider,
        model: li.dataset.model,
      });
      state.modelPickerOpen = false;
      applyModelPicker();
    });
  }
}

function renderAgentPicker(): void {
  const el = root.querySelector<HTMLElement>("#agent-picker");
  if (!el || !state.agentPickerOpen) return;
  const eff = effective();
  if (state.catalog.agents.length === 0) {
    el.innerHTML = `
      <header class="popover-header">
        <span>Agents</span>
        <button class="icon-btn" id="agent-close">\u2715</button>
      </header>
      <div class="popover-empty">No agents configured in LiberIDE.</div>
    `;
  } else {
    el.innerHTML = `
      <header class="popover-header">
        <span>Agents for this chat</span>
        <button class="icon-btn" id="agent-close">\u2715</button>
      </header>
      <div class="popover-body">
        <ul>
          ${state.catalog.agents.map((a) => {
            const selected = eff.agentIds.includes(a.id);
            return `<li class="popover-row${selected ? " selected" : ""}" data-id="${escapeAttr(a.id)}">
              <div class="popover-row-title">${escapeHtml(a.name)}</div>
              <div class="popover-row-detail">${escapeHtml(a.description || "")}</div>
            </li>`;
          }).join("")}
        </ul>
      </div>
    `;
  }
  el.querySelector<HTMLButtonElement>("#agent-close")?.addEventListener("click", () => {
    state.agentPickerOpen = false;
    applyAgentPicker();
  });
  for (const li of el.querySelectorAll<HTMLLIElement>(".popover-row")) {
    li.addEventListener("click", () => {
      const id = li.dataset.id!;
      const current = new Set(eff.agentIds);
      if (current.has(id)) current.delete(id); else current.add(id);
      setOverrides({ agentIds: [...current] });
    });
  }
}

// ---------------------------------------------------------------------------
// Settings overlay
// ---------------------------------------------------------------------------

function renderSettings(): void {
  const grid = root.querySelector<HTMLDivElement>("#settings-form");
  if (!grid || !state.settings) return;
  const s = state.settings;
  const projectLine = state.project && state.project.source !== "none"
    ? `<div class="hint">Active project: <strong>${escapeHtml(state.project.name)}</strong> &mdash; ${escapeHtml(state.project.source === "git" ? state.project.remoteUrl ?? state.project.id : state.project.rootPath ?? "")}</div>`
    : "";
  grid.innerHTML = `
    <h2>Connection</h2>
    <label>API origin</label>
    <div class="value">${escapeHtml(state.apiOrigin || "(not configured)")}</div>
    <label>Status</label>
    <div class="value status-${state.backendStatus}">${escapeHtml(state.backendStatus)}</div>
    ${projectLine}

    <h2>Local defaults</h2>
    <label for="set-mode">Model selection mode</label>
    <select id="set-mode" data-key="modelSelection">
      <option value="manual" ${s.modelSelection==="manual"?"selected":""}>manual</option>
      <option value="auto" ${s.modelSelection==="auto"?"selected":""}>auto</option>
    </select>
    <label for="set-rag">RAG by default</label>
    <div><input id="set-rag" data-key="useRag" type="checkbox" ${s.useRag?"checked":""} /></div>
    <label for="set-system">Local system prompt</label>
    <textarea id="set-system" data-key="systemPrompt" placeholder="(empty)">${escapeHtml(s.systemPrompt)}</textarea>

    <div class="hint">Models, agents, MCP servers, and skills are managed in VoxChat settings. Per-chat picks are stored on the conversation.</div>
  `;
  for (const input of grid.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-key]")) {
    input.addEventListener("change", () => emitSettingChange(input));
  }
}

function emitSettingChange(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): void {
  const key = input.dataset.key!;
  let value: unknown;
  if (input instanceof HTMLInputElement && input.type === "checkbox") value = input.checked;
  else value = input.value;
  send({ type: "updateSetting", key, value });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ModelGroup { provider: string; label: string; models: BackendCatalog["models"] }

function groupModels(models: BackendCatalog["models"]): ModelGroup[] {
  const map = new Map<string, BackendCatalog["models"]>();
  for (const m of models) {
    const list = map.get(m.provider) ?? [];
    list.push(m);
    map.set(m.provider, list);
  }
  return Array.from(map.entries())
    .map(([provider, group]) => ({
      provider,
      label: PROVIDER_LABELS[provider] ?? provider,
      models: [...group].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function describeModel(provider: ConfiguredProvider | undefined, modelId: string | undefined): string {
  if (!provider || !modelId) return state.catalog.models.length === 0 ? "No models configured" : "Pick a model";
  for (const m of state.catalog.models) {
    if (m.provider === provider && m.modelId === modelId) return m.displayName;
  }
  return `${PROVIDER_LABELS[provider] ?? provider} \u00B7 ${modelId}`;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function escapeHtml(value: string | undefined | null): string {
  if (value == null) return "";
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}
function escapeAttr(value: string | undefined | null): string { return escapeHtml(value); }

function renderMarkdownish(text: string): string {
  if (!text) return `<span class="placeholder">\u2026</span>`;
  return renderBlocks(text);
}

// ---------------------------------------------------------------------------
// Tiny GFM-ish renderer for the VS Code chat webview.
// Handles fenced code (incl. Mermaid via lazy-loaded media/mermaid.js),
// headings, blockquotes, hr, ordered/unordered lists with task syntax,
// pipe tables, and inline emphasis/links/code.
// ---------------------------------------------------------------------------

function renderBlocks(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const fenceMatch = line.match(/^\s*```\s*([\w+-]*)\s*$/);
      const lang = fenceMatch?.[1] ?? "";
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(renderFenced(lang, code.join("\n")));
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      out.push(`<h${level} class="md-h md-h${level}">${renderInline(headingMatch[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*(?:-\s*){3,}$/.test(line) || /^\s*(?:\*\s*){3,}$/.test(line) || /^\s*(?:_\s*){3,}$/.test(line)) {
      out.push(`<hr class="md-hr" />`);
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote class="md-quote">${renderBlocks(quoteLines.join("\n"))}</blockquote>`);
      continue;
    }

    if (looksLikeTableRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== "" && looksLikeTableRow(lines[i])) {
        tableLines.push(lines[i]);
        i += 1;
      }
      out.push(renderTable(tableLines));
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (
        i < lines.length &&
        (ordered ? /^\s*\d+\.\s+/.test(lines[i]) : /^\s*[-*+]\s+/.test(lines[i]))
      ) {
        const rawItem = lines[i].replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/, "");
        items.push(renderListItem(rawItem));
        i += 1;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag} class="md-list">${items.join("")}</${tag}>`);
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const paraLines = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    out.push(`<p class="md-para">${renderInline(paraLines.join("\n").replace(/\n/g, " "))}</p>`);
  }
  return out.join("");
}

function renderListItem(raw: string): string {
  const taskMatch = raw.match(/^\[([ xX])\]\s+(.*)$/);
  if (taskMatch) {
    const checked = taskMatch[1].toLowerCase() === "x";
    return `<li class="md-task"><input type="checkbox" class="md-task-checkbox" disabled${checked ? " checked" : ""} /> <span>${renderInline(taskMatch[2])}</span></li>`;
  }
  return `<li class="md-list-item">${renderInline(raw)}</li>`;
}

function looksLikeTableRow(line: string): boolean {
  if (!line.includes("|")) return false;
  return /^\s*\|?[^|]+\|/.test(line.trim());
}

function renderTable(lines: string[]): string {
  if (lines.length < 2) return `<p class="md-para">${renderInline(lines.join(" "))}</p>`;
  const splitRow = (l: string) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  const headers = splitRow(lines[0]);
  const aligns = splitRow(lines[1]).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });
  const bodyRows = lines.slice(2).map((row) => splitRow(row));
  const thCells = headers.map((cell, idx) => {
    const align = aligns[idx];
    return `<th class="md-th" ${align ? `style="text-align:${align}"` : ""}>${renderInline(cell)}</th>`;
  }).join("");
  const trRows = bodyRows.map((row) => {
    const tds = row.map((cell, idx) => {
      const align = aligns[idx];
      return `<td class="md-td" ${align ? `style="text-align:${align}"` : ""}>${renderInline(cell)}</td>`;
    }).join("");
    return `<tr>${tds}</tr>`;
  }).join("");
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${thCells}</tr></thead><tbody>${trRows}</tbody></table></div>`;
}

function renderFenced(lang: string, code: string): string {
  if (lang === "mermaid") {
    const idx = mermaidCounter++;
    const escaped = escapeAttr(code);
    return `<div class="md-mermaid" data-mermaid-block="${idx}" data-source="${escaped}">
      <div class="md-mermaid-head"><span>Mermaid</span><button class="md-mermaid-toggle" data-toggle="${idx}">Source</button></div>
      <div class="md-mermaid-canvas" data-canvas="${idx}"><span class="placeholder">Loading diagram\u2026</span></div>
      <pre class="md-pre" data-source-block="${idx}" hidden><code class="language-mermaid">${escapeHtml(code)}</code></pre>
    </div>`;
  }
  const cls = lang ? ` language-${escapeAttr(lang)}` : "";
  const langLabel = lang || "text";
  // `highlightCode` outputs sanitised HTML composed of `<span class="tok-…">`
  // wrappers around HTML-escaped text. Token classes resolve to the
  // LiberIDE `--syntax-*` palette in webview.css so the same colors as the
  // web chat render here.
  const highlighted = highlightCode(code, lang);
  return `<div class="md-codeblock">
    <div class="md-codeblock-head"><span class="md-codeblock-lang">${escapeHtml(langLabel)}</span><button class="md-codeblock-copy" data-copy>${"Copy"}</button></div>
    <pre class="md-pre"><code class="${cls.trim()}">${highlighted}</code></pre>
  </div>`;
}

function renderInline(text: string): string {
  // Tokenise: code spans first, then images/links, then bold/italic, then autolinks.
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        out += `<code class="md-code">${escapeHtml(text.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }
    if (text.startsWith("![", i)) {
      const labelEnd = text.indexOf("]", i + 2);
      if (labelEnd > i && text[labelEnd + 1] === "(") {
        const hrefEnd = text.indexOf(")", labelEnd + 2);
        if (hrefEnd > labelEnd) {
          const alt = text.slice(i + 2, labelEnd);
          const src = text.slice(labelEnd + 2, hrefEnd);
          out += `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" class="md-image" loading="lazy" />`;
          i = hrefEnd + 1;
          continue;
        }
      }
    }
    if (text[i] === "[") {
      const labelEnd = text.indexOf("]", i + 1);
      if (labelEnd > i && text[labelEnd + 1] === "(") {
        const hrefEnd = text.indexOf(")", labelEnd + 2);
        if (hrefEnd > labelEnd) {
          const label = text.slice(i + 1, labelEnd);
          const href = text.slice(labelEnd + 2, hrefEnd);
          out += `<a class="md-link" href="${escapeAttr(href)}" target="_blank" rel="noopener">${renderInline(label)}</a>`;
          i = hrefEnd + 1;
          continue;
        }
      }
    }
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i) {
        out += `<strong>${renderInline(text.slice(i + 2, end))}</strong>`;
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "*" && text[i + 1] !== "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i) {
        out += `<em>${renderInline(text.slice(i + 1, end))}</em>`;
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "_" && /\W|^/.test(text[i - 1] ?? "")) {
      const end = text.indexOf("_", i + 1);
      if (end > i && /\W|$/.test(text[end + 1] ?? "")) {
        out += `<em>${renderInline(text.slice(i + 1, end))}</em>`;
        i = end + 1;
        continue;
      }
    }
    if (text.startsWith("~~", i)) {
      const end = text.indexOf("~~", i + 2);
      if (end > i) {
        out += `<del>${renderInline(text.slice(i + 2, end))}</del>`;
        i = end + 2;
        continue;
      }
    }
    if (text.startsWith("http", i)) {
      const urlMatch = text.slice(i).match(/^https?:\/\/[^\s)\]>"']+/);
      if (urlMatch) {
        const url = urlMatch[0];
        out += `<a class="md-link" href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`;
        i += url.length;
        continue;
      }
    }
    out += escapeHtmlChar(text[i]);
    i += 1;
  }
  return out;
}

function escapeHtmlChar(ch: string): string {
  switch (ch) {
    case "&": return "&amp;";
    case "<": return "&lt;";
    case ">": return "&gt;";
    case '"': return "&quot;";
    case "'": return "&#39;";
    case "\n": return "<br />";
    default: return ch;
  }
}

let mermaidCounter = 0;

let mermaidLoader: Promise<{ render: (source: string) => Promise<string> } | null> | null = null;
function loadMermaid(): Promise<{ render: (source: string) => Promise<string> } | null> {
  if (!mermaidLoader) {
    mermaidLoader = new Promise((resolve) => {
      const existing = (window as unknown as { LiberIDEMermaid?: { render: (source: string) => Promise<string> } }).LiberIDEMermaid;
      if (existing) return resolve(existing);
      const src = document.getElementById("root")?.dataset.mermaidSrc;
      if (!src) return resolve(null);
      const tag = document.createElement("script");
      tag.src = src;
      tag.onload = () => {
        const lib = (window as unknown as { LiberIDEMermaid?: { render: (source: string) => Promise<string> } }).LiberIDEMermaid;
        resolve(lib ?? null);
      };
      tag.onerror = () => resolve(null);
      document.head.appendChild(tag);
    });
  }
  return mermaidLoader;
}

function bindMarkdownExtras(scope: HTMLElement): void {
  for (const btn of scope.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
    if (btn.dataset.bound === "1") continue;
    btn.dataset.bound = "1";
    btn.addEventListener("click", async () => {
      const code = btn.parentElement?.nextElementSibling?.textContent ?? "";
      try {
        await navigator.clipboard.writeText(code);
        const prev = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = prev ?? "Copy"; }, 1200);
      } catch {
        /* clipboard blocked */
      }
    });
  }

  for (const wrap of scope.querySelectorAll<HTMLDivElement>(".md-mermaid[data-mermaid-block]")) {
    if (wrap.dataset.bound === "1") continue;
    wrap.dataset.bound = "1";
    const idx = wrap.dataset.mermaidBlock ?? "";
    const source = wrap.dataset.source ?? "";
    const canvas = wrap.querySelector<HTMLDivElement>(`[data-canvas="${cssAttr(idx)}"]`);
    const sourceBlock = wrap.querySelector<HTMLElement>(`[data-source-block="${cssAttr(idx)}"]`);
    const toggle = wrap.querySelector<HTMLButtonElement>(`[data-toggle="${cssAttr(idx)}"]`);
    toggle?.addEventListener("click", () => {
      const showSource = sourceBlock && sourceBlock.hasAttribute("hidden") ? true : false;
      if (showSource) {
        sourceBlock?.removeAttribute("hidden");
        if (canvas) canvas.hidden = true;
        if (toggle) toggle.textContent = "Diagram";
      } else {
        sourceBlock?.setAttribute("hidden", "");
        if (canvas) canvas.hidden = false;
        if (toggle) toggle.textContent = "Source";
      }
    });
    void loadMermaid().then(async (lib) => {
      if (!canvas) return;
      if (!lib) {
        canvas.innerHTML = `<span class="placeholder">Mermaid runtime unavailable.</span>`;
        return;
      }
      try {
        const decoded = decodeAttr(source);
        const svg = await lib.render(decoded);
        canvas.innerHTML = svg;
      } catch (err) {
        canvas.innerHTML = `<div class="md-mermaid-error">Failed to render diagram: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
      }
    });
  }
}

function decodeAttr(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function appendChunkInDom(messageId: string, chunk: string): void {
  const turn = root.querySelector<HTMLElement>(`.turn[data-message-id="${cssAttr(messageId)}"] .turn-content`);
  if (!turn) return;
  const session = state.activeSession;
  const fullMessage = session?.messages.find((m) => m.id === messageId);
  if (fullMessage) {
    const { visibleContent, hasOpenPipeline } = extractPipelineMarkers(fullMessage);
    turn.innerHTML = renderMarkdownish(visibleContent);
    bindMarkdownExtras(turn);
    if (hasOpenPipeline) mountOpenPipelineButtons(turn);
  } else {
    if (turn.querySelector(".placeholder")) turn.innerHTML = "";
    turn.appendChild(document.createTextNode(chunk));
  }
  const transcript = root.querySelector<HTMLDivElement>("#transcript");
  if (transcript) transcript.scrollTop = transcript.scrollHeight;
}

function rerenderMessageInDom(messageId: string): void {
  const session = state.activeSession;
  if (!session) return;
  const message = session.messages.find((m) => m.id === messageId);
  if (!message) return;
  const turn = root.querySelector<HTMLElement>(`.turn[data-message-id="${cssAttr(messageId)}"]`);
  if (!turn) return;
  turn.replaceWith(renderMessage(message));
}

function cssAttr(id: string): string { return id.replace(/"/g, '\\"'); }

// ---------------------------------------------------------------------------
// Inbound messages
// ---------------------------------------------------------------------------

function handleMessage(msg: ChatHostToWebview): void {
  switch (msg.type) {
    case "init":
      state.settings = msg.settings;
      state.sessions = msg.sessions;
      state.activeSession = msg.activeSession;
      state.activeSessionId = msg.activeSessionId;
      state.project = msg.project;
      state.catalog = msg.catalog;
      state.backendStatus = msg.backendStatus;
      state.apiOrigin = msg.apiOrigin;
      state.streaming = false;
      render();
      break;
    case "settings":
      state.settings = msg.settings;
      renderComposer();
      if (state.settingsOpen) renderSettings();
      break;
    case "catalog":
      state.catalog = msg.catalog;
      state.backendStatus = msg.backendStatus;
      renderComposer();
      renderComposerAttachments();
      renderBackendBanner();
      if (state.modelPickerOpen) renderModelPicker();
      if (state.agentPickerOpen) renderAgentPicker();
      break;
    case "project":
      state.project = msg.project;
      renderHeader();
      break;
    case "openSettings":
      state.settingsOpen = true;
      applySettings();
      break;
    case "sessions":
      state.sessions = msg.sessions;
      state.activeSessionId = msg.activeSessionId;
      renderSidebar();
      break;
    case "session":
      state.activeSession = msg.session;
      state.activeSessionId = msg.session.id;
      state.streaming = msg.session.messages.some((m) => m.status === "streaming");
      renderHeader();
      renderTranscript();
      renderComposer();
      renderComposerAttachments();
      break;
    case "messageStart":
      if (state.activeSession && state.activeSession.id === msg.sessionId) {
        const m = state.activeSession.messages.find((x) => x.id === msg.messageId);
        if (m) {
          m.startedAt = msg.startedAt;
          m.status = "streaming";
          state.streaming = true;
          state.expandedTimelines.add(msg.messageId);
          renderTranscript();
          renderComposer();
        }
      }
      break;
    case "messageAppend":
      if (state.activeSession && state.activeSession.id === msg.sessionId) {
        const m = state.activeSession.messages.find((x) => x.id === msg.messageId);
        if (m) {
          m.content += msg.chunk;
          m.status = "streaming";
          state.streaming = true;
          appendChunkInDom(msg.messageId, msg.chunk);
          updateAssistantMetaInDom(msg.messageId);
          renderComposer();
        }
      }
      break;
    case "toolUpdate":
      if (state.activeSession && state.activeSession.id === msg.sessionId) {
        const m = state.activeSession.messages.find((x) => x.id === msg.messageId);
        if (m) {
          m.tools = upsertTool(m.tools, msg.entry);
          m.editedFiles = msg.editedFiles;
          m.status = "streaming";
          state.streaming = true;
          state.expandedTimelines.add(msg.messageId);
          if (msg.editedFiles.length > 0) state.expandedEditCards.add(msg.messageId);
          updateAssistantMetaInDom(msg.messageId);
        }
      }
      break;
    case "messageComplete":
      if (state.activeSession && state.activeSession.id === msg.sessionId) {
        const m = state.activeSession.messages.find((x) => x.id === msg.messageId);
        if (m) {
          m.status = "complete";
          m.completedAt = msg.completedAt;
        }
        state.expandedTimelines.delete(msg.messageId);
        if (m) rerenderMessageInDom(msg.messageId);
        state.streaming = false;
        renderComposer();
      }
      break;
    case "messageError":
      if (state.activeSession && state.activeSession.id === msg.sessionId) {
        const m = state.activeSession.messages.find((x) => x.id === msg.messageId);
        if (m) {
          m.status = "error";
          m.error = msg.error;
          m.completedAt = msg.completedAt;
        }
        state.expandedTimelines.delete(msg.messageId);
        if (m) rerenderMessageInDom(msg.messageId);
        state.streaming = false;
        renderComposer();
      }
      break;
    case "log":
      console.warn("[liberide]", msg.message);
      break;
  }
}

window.addEventListener("message", (event) => handleMessage(event.data as ChatHostToWebview));
send({ type: "ready" });
