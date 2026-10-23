import type { LiberideSettings } from "../settings";
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
  ToolTimelineEntry,
} from "../chat/chat-protocol";
import type { ConfiguredProvider, DocumentRecord } from "../chat/types";
import { effectiveModelSelection, modelCapabilityBadges, modelChipLabel, providerLabel, type ModelSelectionMode } from "../chat/models";
import { isActiveAgentRunStatus, layoutAgentRuns, type AgentRunLayout, type AgentRunView } from "../chat/agent-runs";
import type { ContextBlockChip } from "../chat/context-blocks";
import type { WorkspaceIntelligence } from "../workspace/intelligence";
import { buildChatSlashCommands, parseSlashQuery, parseTaskContractBlock, type TaskContractView } from "@nexus/shared";
import { highlightCode } from "./highlight";
import { captureBoxState, isAtBottom, pickAnchor, restoredScrollTop, restoredTranscriptTop, type AnchorCandidate, type BoxState, type TranscriptState } from "./view-state";
import { APPROVAL_MODE_OPTIONS, approvalModeAllowed, approvalModeLabel, DEFAULT_APPROVAL_MODE, type ApprovalMode } from "../chat/approval-mode";

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
  approvalPickerOpen: boolean;
  /** Pending approvals the newly chosen approval mode would auto-approve. */
  approvalModeOffer: ApprovalModeOfferView | null;
  draft: string;
  streaming: boolean;
  /** messageId -> whether the "Worked for" timeline is expanded */
  expandedTimelines: Set<string>;
  /** messageId -> whether the edit card file list is expanded */
  expandedEditCards: Set<string>;
  /** message ids whose pipeline-ready card was acted on locally; must never re-render. */
  consumedPipelineCards: Set<string>;
  /** Inline context chips applied to the next message. */
  contextBlocks: ContextBlockChip[];
  /** Agent runs of the active chat, by run id. */
  agentRuns: Map<string, AgentRunView>;
  /** Pending approvals raised by the active chat's agent runs. */
  runApprovals: RunApprovalView[];
  /** False while the live agent-run stream reconnects. */
  agentsConnected: boolean;
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
  approvalPickerOpen: false,
  approvalModeOffer: null,
  draft: "",
  streaming: false,
  expandedTimelines: new Set(),
  expandedEditCards: new Set(),
  consumedPipelineCards: new Set(),
  contextBlocks: [],
  agentRuns: new Map(),
  runApprovals: [],
  agentsConnected: true,
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
  modelSelection: ModelSelectionMode;
  chatMode: "normal" | "agent";
  useRag: boolean;
  toolsEnabled: boolean;
  agentId?: string;
  allowedAgentIds: string[];
  skillIds: string[];
  mcpServerIds: string[];
  documentIds: string[];
  approvalMode: ApprovalMode;
}

function invokableAgents(agents: BackendCatalog["agents"]) {
  return agents.filter((agent) => !agent.disableModelInvocation);
}

function effective(): ResolvedSelections {
  const s = state.settings;
  const o = state.activeSession?.overrides ?? {};
  const fallbackModel = state.catalog.models.find((m) => m.enabled);
  const defaultAllowed = s?.defaultAllowedAgentIds?.length
    ? s.defaultAllowedAgentIds.filter((id) => invokableAgents(state.catalog.agents).some((agent) => agent.id === id))
    : invokableAgents(state.catalog.agents).map((agent) => agent.id);
  const modelSelection = effectiveModelSelection(o.modelSelection, o.model, s?.modelSelection ?? "auto");
  return {
    provider: o.provider ?? fallbackModel?.provider,
    model: o.model && (o.model !== "auto" || modelSelection === "auto") ? o.model : fallbackModel?.modelId,
    modelSelection,
    chatMode: "agent",
    useRag: o.useRag ?? s?.useRag ?? false,
    toolsEnabled: true,
    agentId: o.agentId,
    allowedAgentIds: o.allowedAgentIds?.length ? o.allowedAgentIds : defaultAllowed,
    skillIds: o.skillIds ?? [],
    mcpServerIds: o.mcpServerIds ?? [],
    documentIds: o.documentIds ?? [],
    approvalMode: o.approvalMode ?? DEFAULT_APPROVAL_MODE,
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
  renderTranscript();
  renderComposer();
  renderComposerAttachments();
  applySettings();
  applyModelPicker();
  applyAgentPicker();
  applyApprovalPicker();
  renderApprovalModeOffer();
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
        <div class="activity-topbar" id="activity-topbar" data-active="false"></div>
        <div class="project-bar" id="project-bar"></div>
        <div class="backend-banner" id="backend-banner" hidden></div>
        <div class="notice-stack" id="notice-stack"></div>
        <div class="approval-mode-offer" id="approval-mode-offer" hidden></div>
        <section class="chat-transcript" id="transcript"></section>
        <footer class="chat-composer">
          <div class="composer-card">
            <div class="composer-hints" id="composer-hints" role="listbox" aria-label="Commands" hidden></div>
            <div class="composer-attachments" id="composer-context" hidden></div>
            <div class="composer-attachments" id="composer-attachments" hidden></div>
            <textarea id="composer" placeholder="Ask for follow-up changes\u2026" rows="1"></textarea>
            <div class="composer-toolbar" id="chip-row"></div>
          </div>
          <div class="composer-foot">
            <div class="activity-composer-line" id="activity-composer-line" hidden></div>
            <button class="chip chip-foot" id="chip-rag" title="Use indexed documents (RAG)">
              <span class="chip-dot"></span>
              <span id="chip-rag-label">Work locally</span>
            </button>
          </div>
        </footer>
      </div>
      <div class="modal-backdrop" id="modal-backdrop" hidden></div>
      <div class="popover" id="model-picker" hidden></div>
      <div class="popover" id="agent-picker" hidden></div>
      <div class="popover" id="approval-picker" hidden></div>
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
  root.querySelector<HTMLButtonElement>("#settings-close")?.addEventListener("click", () => {
    state.settingsOpen = false;
    applySettings();
  });
  root.querySelector<HTMLButtonElement>("#modal-backdrop")?.addEventListener("click", () => {
    if (state.modelPickerOpen) { state.modelPickerOpen = false; applyModelPicker(); }
    if (state.agentPickerOpen) { state.agentPickerOpen = false; applyAgentPicker(); }
    if (state.approvalPickerOpen) { state.approvalPickerOpen = false; applyApprovalPicker(); }
    if (state.settingsOpen)   { state.settingsOpen = false;   applySettings(); }
  });

  const composer = root.querySelector<HTMLTextAreaElement>("#composer")!;
  composer.addEventListener("input", () => {
    state.draft = composer.value;
    autosize(composer);
    renderComposerHints();
  });
  composer.addEventListener("keydown", (event) => {
    if (handleHintKey(event)) return;
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
  if (backdrop) backdrop.toggleAttribute("hidden", !anyPopoverOpen());
  if (state.settingsOpen) renderSettings();
}

function applyModelPicker(): void {
  const el = root.querySelector<HTMLElement>("#model-picker");
  const backdrop = root.querySelector<HTMLElement>("#modal-backdrop");
  if (el) el.toggleAttribute("hidden", !state.modelPickerOpen);
  if (backdrop) backdrop.toggleAttribute("hidden", !anyPopoverOpen());
  if (state.modelPickerOpen) renderModelPicker();
}

function anyPopoverOpen(): boolean {
  return state.settingsOpen || state.modelPickerOpen || state.agentPickerOpen || state.approvalPickerOpen;
}

function applyApprovalPicker(): void {
  const el = root.querySelector<HTMLElement>("#approval-picker");
  const backdrop = root.querySelector<HTMLElement>("#modal-backdrop");
  if (el) el.toggleAttribute("hidden", !state.approvalPickerOpen);
  if (backdrop) backdrop.toggleAttribute("hidden", !anyPopoverOpen());
  if (state.approvalPickerOpen) renderApprovalPicker();
}

function renderApprovalPicker(): void {
  const el = root.querySelector<HTMLElement>("#approval-picker");
  if (!el || !state.approvalPickerOpen) return;
  const current = effective().approvalMode;
  const max = state.catalog.maxApprovalMode;
  el.innerHTML = `
    <header class="popover-header">
      <span>Approval mode</span>
      <button class="icon-btn" id="approval-close">\u2715</button>
    </header>
    <div class="popover-body">
      <ul>
        ${APPROVAL_MODE_OPTIONS.map((option) => {
          const allowed = approvalModeAllowed(option.id, max);
          const classes = ["popover-row", `approval-mode-${option.id}`];
          if (option.id === current) classes.push("selected");
          if (!allowed) classes.push("disabled");
          return `<li class="${classes.join(" ")}" data-mode="${escapeAttr(option.id)}" aria-disabled="${!allowed}">
            <div class="popover-row-title">${escapeHtml(option.label)}</div>
            <div class="popover-row-detail">${escapeHtml(allowed ? option.description : `${option.description} Not allowed by your administrator.`)}</div>
          </li>`;
        }).join("")}
      </ul>
    </div>
  `;
  el.querySelector<HTMLButtonElement>("#approval-close")?.addEventListener("click", () => {
    state.approvalPickerOpen = false;
    applyApprovalPicker();
  });
  for (const li of el.querySelectorAll<HTMLLIElement>(".popover-row")) {
    li.addEventListener("click", () => {
      const mode = li.dataset.mode as ApprovalMode | undefined;
      if (!mode || li.classList.contains("disabled")) return;
      state.approvalPickerOpen = false;
      applyApprovalPicker();
      if (mode !== current) setOverrides({ approvalMode: mode });
    });
  }
}

function renderApprovalModeOffer(): void {
  const el = root.querySelector<HTMLElement>("#approval-mode-offer");
  if (!el) return;
  const offer = state.approvalModeOffer;
  if (!offer || offer.sessionId !== state.activeSession?.id || offer.approvals.length === 0) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const count = offer.approvals.length;
  el.hidden = false;
  el.innerHTML = `
    <div class="approval-mode-offer-text">
      ${escapeHtml(`${count} pending approval${count === 1 ? "" : "s"} would be auto-approved in ${approvalModeLabel(offer.mode)} mode.`)}
      <ul>${offer.approvals.slice(0, 5).map((a) => `<li>${escapeHtml(a.action)}</li>`).join("")}${count > 5 ? `<li>\u2026</li>` : ""}</ul>
    </div>
    <div class="approval-mode-offer-actions">
      <button class="btn-primary" id="approval-offer-approve" ${offer.busy ? "disabled" : ""}>${offer.busy ? "Approving\u2026" : `Approve ${count}`}</button>
      <button class="btn-secondary small" id="approval-offer-dismiss" ${offer.busy ? "disabled" : ""}>Keep pending</button>
    </div>
  `;
  el.querySelector<HTMLButtonElement>("#approval-offer-approve")?.addEventListener("click", () => {
    send({ type: "autoResolveApprovals", sessionId: offer.sessionId, ids: offer.approvals.map((a) => a.id) });
  });
  el.querySelector<HTMLButtonElement>("#approval-offer-dismiss")?.addEventListener("click", () => {
    send({ type: "dismissApprovalModeOffer", sessionId: offer.sessionId });
  });
}

function applyAgentPicker(): void {
  const el = root.querySelector<HTMLElement>("#agent-picker");
  const backdrop = root.querySelector<HTMLElement>("#modal-backdrop");
  if (el) el.toggleAttribute("hidden", !state.agentPickerOpen);
  if (backdrop) backdrop.toggleAttribute("hidden", !anyPopoverOpen());
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
  const profile = workspaceProfileLabel(state.project.workspaceIntelligence);
  bar.innerHTML = `
    <span class="project-icon">${icon}</span>
    <div class="project-text">
      <div class="project-name">${escapeHtml(state.project.name)}${branch}</div>
      <div class="project-subtitle" title="${escapeAttr(subtitle)}">${escapeHtml(subtitle)}${profile ? ` · ${escapeHtml(profile)}` : ""}</div>
    </div>
  `;
}

function workspaceProfileLabel(value: WorkspaceIntelligence | undefined): string {
  if (!value) return "";
  const manager = typeof value.packageManager === "string" ? value.packageManager : "";
  const languages = Array.isArray(value.languages) ? value.languages.slice(0, 3).join(", ") : "";
  const commands = value.commands && typeof value.commands === "object"
    ? Object.keys(value.commands as Record<string, unknown>).filter((key) => Boolean((value.commands as Record<string, unknown>)[key])).join("/")
    : "";
  return [manager, languages, commands].filter(Boolean).join(" · ");
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
      // The host asks for confirmation (webviews cannot show modal dialogs).
      send({ type: "deleteSession", sessionId: s.id });
    });
    list.appendChild(row);
  }
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

/** Where each agent run of the active chat is drawn (recomputed per render). */
let runLayout: AgentRunLayout = layoutAgentRuns([], []);

function computeRunLayout(): AgentRunLayout {
  const messages = state.activeSession?.messages ?? [];
  runLayout = layoutAgentRuns(
    messages.map((m) => ({ id: m.id, agentRunId: m.agentRunId, graphId: m.graph?.graphId })),
    [...state.agentRuns.values()],
  );
  return runLayout;
}

// ---------------------------------------------------------------------------
// Scroll preservation across live re-renders (see view-state.ts)
// ---------------------------------------------------------------------------

/** Elements that can hold the transcript's place: turns, run cards, graph steps. */
const ANCHOR_SELECTOR = ".turn[data-message-id], .agent-run-card[data-run-id], .graph-step-block[data-step-key]";

function anchorKeyOf(el: HTMLElement): string {
  if (el.classList.contains("graph-step-block")) return `step:${el.dataset.stepKey ?? ""}`;
  if (el.classList.contains("agent-run-card")) return `run:${el.dataset.runId ?? ""}`;
  return `turn:${el.dataset.messageId ?? ""}`;
}

/** Visible anchor elements, in content coordinates of the transcript. */
function anchorCandidates(transcript: HTMLElement): AnchorCandidate[] {
  const origin = transcript.getBoundingClientRect().top - transcript.scrollTop;
  const candidates: AnchorCandidate[] = [];
  transcript.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR).forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) return;
    candidates.push({ key: anchorKeyOf(el), top: rect.top - origin, bottom: rect.bottom - origin });
  });
  return candidates;
}

function anchorTopAfter(transcript: HTMLElement, key: string): number | undefined {
  const origin = transcript.getBoundingClientRect().top - transcript.scrollTop;
  for (const el of transcript.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR)) {
    if (anchorKeyOf(el) === key) return el.getBoundingClientRect().top - origin;
  }
  return undefined;
}

interface ViewSnapshot {
  transcript: TranscriptState;
  /** Inner scroll boxes by `data-scroll-key`. */
  boxes: Map<string, BoxState>;
}

function captureView(transcript: HTMLElement): ViewSnapshot {
  const boxes = new Map<string, BoxState>();
  transcript.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((el) => {
    boxes.set(el.dataset.scrollKey!, captureBoxState(el));
  });
  const position = captureBoxState(transcript);
  return {
    transcript: { ...position, anchor: position.atBottom ? undefined : pickAnchor(anchorCandidates(transcript), transcript) },
    boxes,
  };
}

function restoreView(transcript: HTMLElement, snapshot: ViewSnapshot): void {
  transcript.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((el) => {
    const top = restoredScrollTop(snapshot.boxes.get(el.dataset.scrollKey!), el, el.hasAttribute("data-follow"));
    if (top !== undefined && el.scrollTop !== top) el.scrollTop = top;
  });
  const anchor = snapshot.transcript.anchor;
  const top = restoredTranscriptTop(snapshot.transcript, transcript, anchor ? anchorTopAfter(transcript, anchor.key) : undefined);
  if (transcript.scrollTop !== top) transcript.scrollTop = top;
}

let preservingView = false;

/**
 * Run a DOM update without moving the user: the transcript follows new
 * content only if it was at the bottom, inner scroll boxes keep their offset
 * (or follow their tail if they were at it). Nested calls run inside the
 * outermost one.
 */
function preserveView(update: () => void): void {
  const transcript = root.querySelector<HTMLDivElement>("#transcript");
  if (!transcript || preservingView) {
    update();
    return;
  }
  const snapshot = captureView(transcript);
  preservingView = true;
  try {
    update();
  } finally {
    preservingView = false;
  }
  restoreView(transcript, snapshot);
}

/** `keepScroll`: live updates stay where the user scrolled unless they were at the bottom. */
function renderTranscript(options: { keepScroll?: boolean } = {}): void {
  const transcript = root.querySelector<HTMLDivElement>("#transcript");
  if (!transcript) return;
  if (options.keepScroll) {
    preserveView(() => fillTranscript(transcript));
  } else {
    fillTranscript(transcript);
    transcript.scrollTop = transcript.scrollHeight;
  }
  renderActivity();
}

function fillTranscript(transcript: HTMLElement): void {
  transcript.innerHTML = "";
  const messages = state.activeSession?.messages ?? [];
  const layout = computeRunLayout();
  if (messages.length === 0 && layout.orphans.length === 0 && state.runApprovals.length === 0) {
    transcript.appendChild(renderEmptyState());
    return;
  }
  for (const m of messages) {
    if (layout.hiddenMessageIds.has(m.id)) continue;
    transcript.appendChild(renderMessage(m));
  }
  const tail = renderRunsTail();
  if (tail) transcript.appendChild(tail);
}

/** Runs (and run approvals) with no message to sit in: after the transcript. */
function renderRunsTail(): HTMLElement | null {
  const placed = new Set(runIdsInLayout());
  const approvals = state.runApprovals.filter((a) => !a.agentRunId || !placed.has(a.agentRunId));
  if (runLayout.orphans.length === 0 && approvals.length === 0) return null;
  const el = document.createElement("article");
  el.className = "turn turn-assistant agent-runs-tail";
  el.dataset.messageId = RUNS_TAIL_ID;
  el.innerHTML = `${runLayout.orphans.map((id) => renderAgentRunCard(id, 0)).join("")}${approvals.map(renderRunApprovalCard).join("")}`;
  bindRunCards(el);
  return el;
}

const RUNS_TAIL_ID = "__agent-runs-tail__";

function runIdsInLayout(): string[] {
  const ids: string[] = [...runLayout.orphans];
  for (const list of runLayout.rootsByMessage.values()) ids.push(...list);
  for (const nodes of runLayout.nodeRuns.values()) for (const list of nodes.values()) ids.push(...list);
  for (const list of runLayout.childrenByRun.values()) ids.push(...list);
  return ids;
}

/** The message a run is drawn in (its root's host), or the tail. */
function ownerOfRun(runId: string): string {
  const seen = new Set<string>();
  let current = state.agentRuns.get(runId);
  while (current?.parentRunId && state.agentRuns.has(current.parentRunId) && !seen.has(current.parentRunId)) {
    seen.add(current.runId);
    current = state.agentRuns.get(current.parentRunId);
  }
  const rootId = current?.runId ?? runId;
  for (const [messageId, list] of runLayout.rootsByMessage) if (list.includes(rootId)) return messageId;
  if (current?.graphId && current.nodeId && runLayout.nodeRuns.get(current.graphId)?.get(current.nodeId)?.includes(rootId)) {
    const host = state.activeSession?.messages.find((m) => m.graph?.graphId === current!.graphId);
    if (host) return host.id;
  }
  return RUNS_TAIL_ID;
}

/** Re-render the messages hosting `runIds`; the whole transcript when their placement changed. */
function rerenderRuns(runIds: string[], placementChanged: boolean): void {
  if (placementChanged) {
    renderTranscript({ keepScroll: true });
    return;
  }
  const transcript = root.querySelector<HTMLDivElement>("#transcript");
  const owners = new Set(runIds.map(ownerOfRun));
  preserveView(() => {
    for (const owner of owners) {
      if (owner === RUNS_TAIL_ID) {
        const current = root.querySelector<HTMLElement>(`.turn[data-message-id="${cssAttr(RUNS_TAIL_ID)}"]`);
        const next = renderRunsTail();
        if (current && next) current.replaceWith(next);
        else if (!current && next) transcript?.appendChild(next);
        else current?.remove();
      } else {
        rerenderMessageInDom(owner);
      }
    }
  });
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

  if (message.note) {
    turn.className = `turn turn-note note-${message.note}`;
    turn.innerHTML = `<div class="chat-note"><span class="chat-note-icon">${message.note === "error" ? "\u2717" : message.note === "warning" ? "\u26A0" : "\u2139"}</span><div class="turn-content"></div></div>`;
    const content = turn.querySelector<HTMLDivElement>(".turn-content")!;
    content.innerHTML = renderMarkdownish(message.content);
    bindMarkdownExtras(content);
    return turn;
  }

  // The server's card for an agent run: the run itself, live.
  if (message.role === "assistant" && message.agentRunId && state.agentRuns.has(message.agentRunId)) {
    turn.classList.add("turn-agent-run");
    turn.innerHTML = renderMessageRuns(message.id);
    bindRunCards(turn);
    return turn;
  }

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
    ${renderStatusBadges(message)}
    ${renderThinking(message)}
    ${renderPlan(message)}
    <div class="assistant-meta">
      ${timelineHtml}
      ${editCardHtml}
      ${showWorking ? `<div class="assistant-status"><span class="turn-indicator"></span><span>Working\u2026</span></div>` : ""}
    </div>
    <div class="turn-content"></div>
    ${message.status === "error" && message.error ? `<div class="turn-error">${escapeHtml(message.error)}</div>` : ""}
    ${renderTurnExtras(message)}
    ${renderMessageRuns(message.id)}
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
  bindTurnExtras(turn, message);
  bindRunCards(turn);
  turn.querySelector<HTMLButtonElement>('[data-act="copy"]')?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(message.content); } catch { /* clipboard blocked */ }
  });
  return turn;
}

// ---------------------------------------------------------------------------
// Turn status, warnings, thinking, approval / graph / fallback cards
// ---------------------------------------------------------------------------

/** messageId -> the user's open/closed choice for the reasoning block (unset = default). */
const thinkingToggles = new Map<string, boolean>();

const TURN_STATUS_LABEL: Record<NonNullable<ChatMessage["turnStatus"]>, string> = {
  failed: "Failed",
  cancelled: "Cancelled",
  awaiting_approval: "Awaiting approval",
  resolved: "Approval resolved",
};

function renderStatusBadges(message: ChatMessage): string {
  const badges: string[] = [];
  if (message.turnStatus) {
    badges.push(`<span class="turn-badge badge-${message.turnStatus}">${escapeHtml(TURN_STATUS_LABEL[message.turnStatus])}</span>`);
  }
  const graph = message.graph;
  if (graph && isTerminalGraph(graph.status) && !message.turnStatus) {
    badges.push(`<span class="turn-badge badge-graph-${escapeAttr(graph.status)}">Graph ${escapeHtml(graph.status)}</span>`);
  }
  return badges.length ? `<div class="turn-badges">${badges.join("")}</div>` : "";
}

function renderThinking(message: ChatMessage): string {
  if (!message.thinking) return "";
  const live = message.status === "streaming" && !message.content;
  const open = thinkingToggles.get(message.id) ?? live;
  return `<details class="thinking-block"${open ? " open" : ""}>
    <summary>${live ? "Thinking\u2026" : "Reasoning"}</summary>
    <div class="thinking-body" data-scroll-key="thinking:${escapeAttr(message.id)}"${message.status === "streaming" ? " data-follow" : ""}>${escapeHtml(message.thinking)}</div>
  </details>`;
}

/** The run's plan (update_plan) as a checklist. */
function renderPlan(message: ChatMessage): string {
  if (!message.todos?.length) return "";
  const items = message.todos.map((todo) => {
    const status = todo.status ?? (todo.done ? "completed" : "pending");
    const mark = status === "completed" ? "\u2713" : status === "in_progress" ? "\u25B8" : status === "cancelled" ? "\u2715" : "\u25CB";
    return `<li class="plan-item plan-${escapeAttr(status)}"><span class="plan-mark" aria-hidden="true">${mark}</span>${escapeHtml(todo.label)}</li>`;
  }).join("");
  return `<div class="plan-block"><div class="plan-title">Plan</div><ul>${items}</ul></div>`;
}

function isTerminalGraph(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function renderTurnExtras(message: ChatMessage): string {
  const parts: string[] = [];
  if (message.warnings?.length) {
    parts.push(`<div class="turn-warnings">${message.warnings.map((w) => `<div class="turn-warning">\u26A0 ${escapeHtml(w)}</div>`).join("")}</div>`);
  }
  if (message.approval) parts.push(renderApprovalCard(message.approval));
  if (message.graph) parts.push(renderGraphCard(message.graph));
  if (message.fallback) parts.push(renderFallbackCard(message.fallback));
  return parts.join("");
}

function renderApprovalCard(card: ApprovalCardView): string {
  const pending = card.status === "pending";
  const statusText = card.busy
    ? (pending ? "Submitting\u2026" : "Continuing\u2026")
    : pending ? "Waiting for your decision" : card.status === "approved" ? "Approved" : card.status === "auto_approved" ? "Auto-approved by the chat's approval mode" : "Rejected";
  return `<div class="approval-card status-${escapeAttr(card.status)}" data-approval-id="${escapeAttr(card.id)}">
    <div class="approval-head">
      <span class="approval-title">${escapeHtml(card.action)}</span>
      ${card.risk ? `<span class="approval-risk risk-${escapeAttr(card.risk)}">${escapeHtml(card.risk)} risk</span>` : ""}
    </div>
    ${card.reason ? `<div class="approval-reason">${escapeHtml(card.reason)}</div>` : ""}
    ${card.details ? `<pre class="approval-details" data-scroll-key="approval:${escapeAttr(card.id)}">${escapeHtml(card.details)}</pre>` : ""}
    ${card.error ? `<div class="turn-error">${escapeHtml(card.error)}</div>` : ""}
    <div class="approval-actions">
      <span class="approval-status">${card.busy ? `<span class="turn-indicator"></span>` : ""}${escapeHtml(statusText)}</span>
      ${pending ? `
        <button class="btn-secondary" type="button" data-approval="rejected"${card.busy ? " disabled" : ""}>Reject</button>
        <button class="btn-primary" type="button" data-approval="approved"${card.busy ? " disabled" : ""}>Approve</button>` : ""}
    </div>
  </div>`;
}

function stepIcon(status: string): string {
  switch (status) {
    case "running": return `<span class="turn-indicator"></span>`;
    case "completed": return "\u2713";
    case "failed": return "\u2717";
    case "cancelled": return "\u2298";
    case "skipped": return "\u21B7";
    case "waiting_approval": return "\u23F8";
    case "blocked": return "\u29D7";
    default: return "\u25CB";
  }
}

/** User-toggled open state of graph steps (`graphId|nodeId`) and run cards; unset = default. */
const stepToggles = new Map<string, boolean>();
const runToggles = new Map<string, boolean>();
/** Finished runs whose tool calls were already requested. */
const requestedToolCalls = new Set<string>();

function stepKey(graphId: string, nodeId: string): string {
  return `${graphId}|${nodeId}`;
}

function stepOpen(graphId: string, step: GraphProgressView["steps"][number], runIds: string[]): boolean {
  const key = stepKey(graphId, step.nodeId);
  const toggled = stepToggles.get(key);
  if (toggled !== undefined) return toggled;
  // Live, failed and blocked-on-you steps show their output without a click.
  const open = step.status === "running" || step.status === "failed" || step.status === "waiting_approval"
    || runIds.some((id) => isActiveAgentRunStatus(state.agentRuns.get(id)?.status));
  // Once shown open it stays open (until the user closes it): a step finishing
  // must not fold away the output the user is reading.
  if (open) stepToggles.set(key, true);
  return open;
}

function renderGraphStep(graph: GraphProgressView, step: GraphProgressView["steps"][number]): string {
  const runIds = runLayout.nodeRuns.get(graph.graphId)?.get(step.nodeId) ?? [];
  const hasDetail = Boolean(step.error || step.output || runIds.length || step.status === "waiting_approval" || step.status === "failed");
  const open = hasDetail && stepOpen(graph.graphId, step, runIds);
  const key = stepKey(graph.graphId, step.nodeId);
  const detail = open ? `<div class="graph-step-detail">
      ${step.error ? `<pre class="graph-step-error" data-scroll-key="step-error:${escapeAttr(key)}">${escapeHtml(step.error)}</pre>` : ""}
      ${step.output ? `<div class="graph-step-output" data-scroll-key="step-output:${escapeAttr(key)}"${step.status === "running" ? " data-follow" : ""}>${renderMarkdownish(step.output)}</div>` : ""}
      ${runIds.map((id) => renderAgentRunCard(id, 1)).join("")}
      ${step.status === "waiting_approval" ? `<div class="approval-actions">
        <span class="approval-status">Waiting for your decision</span>
        <button class="btn-secondary small" type="button" data-step-approval="rejected" data-graph-id="${escapeAttr(graph.graphId)}" data-node-id="${escapeAttr(step.nodeId)}">Reject</button>
        <button class="btn-primary small" type="button" data-step-approval="approved" data-graph-id="${escapeAttr(graph.graphId)}" data-node-id="${escapeAttr(step.nodeId)}">Approve</button>
      </div>` : ""}
      ${step.status === "failed" ? `<div class="approval-actions"><span class="approval-status"></span><button class="btn-secondary small" type="button" data-step-replay data-graph-id="${escapeAttr(graph.graphId)}" data-node-id="${escapeAttr(step.nodeId)}">Replay from here</button></div>` : ""}
    </div>` : "";
  return `<div class="graph-step-block${open ? " open" : ""}" data-step-key="${escapeAttr(key)}">
    <button class="graph-step status-${escapeAttr(step.status)}" type="button"${hasDetail ? ` data-step-toggle="${escapeAttr(key)}"` : " disabled"}>
      <span class="timeline-icon">${stepIcon(step.status)}</span>
      <span class="graph-step-title">${escapeHtml(step.title || step.nodeId)}</span>
      ${runIds.length ? `<span class="graph-step-runs">${runIds.length} agent${runIds.length === 1 ? "" : "s"}</span>` : ""}
      <span class="graph-step-status">${escapeHtml(step.status.replace(/_/g, " "))}</span>
      ${hasDetail ? `<span class="graph-step-chevron">${open ? "\u25BE" : "\u25B8"}</span>` : ""}
    </button>
    ${detail}
  </div>`;
}

function renderGraphCard(graph: GraphProgressView): string {
  const terminal = isTerminalGraph(graph.status);
  const nodeRuns = runLayout.nodeRuns.get(graph.graphId);
  // A finished graph from history with no live steps or runs needs no card: the badge covers it.
  if (terminal && graph.steps.length === 0 && !graph.error && !nodeRuns?.size) return "";
  const done = graph.steps.filter((s) => s.status === "completed" || s.status === "skipped").length;
  // Swarm tasks run as parallel branches: draw each task's steps side by side.
  const branched = graph.steps.some((step) => step.taskId);
  let body = "";
  if (branched) {
    const branches = new Map<string, GraphProgressView["steps"]>();
    for (const step of graph.steps) {
      const key = step.taskId ?? "";
      branches.set(key, [...(branches.get(key) ?? []), step]);
    }
    body = `<div class="graph-branches">${[...branches].map(([taskId, steps]) => `<div class="graph-branch">
      ${taskId ? `<div class="graph-branch-title">${escapeHtml(taskId)}</div>` : ""}
      ${steps.map((step) => renderGraphStep(graph, step)).join("")}
    </div>`).join("")}</div>`;
  } else if (graph.steps.length) {
    body = `<div class="graph-steps">${graph.steps.map((step) => renderGraphStep(graph, step)).join("")}</div>`;
  }
  // Runs of nodes the step list has not seen yet (e.g. a card hydrated from history).
  const known = new Set(graph.steps.map((step) => step.nodeId));
  const unplaced = [...(nodeRuns ?? [])].filter(([nodeId]) => !known.has(nodeId)).flatMap(([, ids]) => ids);
  const reconnecting = graph.reconnecting || (!state.agentsConnected && [...(nodeRuns?.values() ?? [])].flat().some((id) => isActiveAgentRunStatus(state.agentRuns.get(id)?.status)));
  return `<div class="graph-card status-${escapeAttr(graph.status)}" data-graph-id="${escapeAttr(graph.graphId)}">
    <div class="graph-head">
      ${terminal ? "" : `<span class="turn-indicator"></span>`}
      <span class="graph-title">${terminal ? `Graph ${escapeHtml(graph.status)}` : `Running graph \u2014 ${escapeHtml(graph.status.replace(/_/g, " "))}`}</span>
      ${reconnecting ? `<span class="graph-reconnecting" title="${escapeAttr(graph.error ?? "Reconnecting to live output")}">Reconnecting\u2026</span>` : ""}
      ${graph.steps.length ? `<span class="graph-count">${done}/${graph.steps.length}</span>` : ""}
      ${terminal ? "" : `<button class="btn-secondary small" type="button" data-graph-cancel${graph.cancelling ? " disabled" : ""}>${graph.cancelling ? "Cancelling\u2026" : "Cancel"}</button>`}
    </div>
    ${body}
    ${unplaced.map((id) => renderAgentRunCard(id, 1)).join("")}
    ${graph.error && !graph.reconnecting ? `<div class="turn-error">${escapeHtml(graph.error)}</div>` : ""}
  </div>`;
}

/** Top-level run cards of a message (its anchor run, or runs its turn started). */
function renderMessageRuns(messageId: string): string {
  const ids = runLayout.rootsByMessage.get(messageId) ?? [];
  return ids.length ? `<div class="agent-run-list">${ids.map((id) => renderAgentRunCard(id, 0)).join("")}</div>` : "";
}

const RUN_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  waiting_approval: "Waiting for approval",
  needs_followup: "Needs follow-up",
  waiting_for_machine: "Waiting for machine",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function runOpen(run: AgentRunView): boolean {
  const toggled = runToggles.get(run.runId);
  return toggled ?? true;
}

/** One agent run: status, live text, tool calls, result or full error, and its sub-agents. */
function renderAgentRunCard(runId: string, depth: number): string {
  const run = state.agentRuns.get(runId);
  if (!run) return "";
  const active = isActiveAgentRunStatus(run.status);
  const open = runOpen(run);
  const children = runLayout.childrenByRun.get(runId) ?? [];
  const approvals = state.runApprovals.filter((a) => a.agentRunId === runId);
  const title = run.agentName || (run.nodeId ? `Node ${run.nodeId}` : "Agent");
  const tools = run.toolCalls.map((call) => {
    const icon = call.status === "running" ? `<span class="turn-indicator"></span>` : call.status === "error" ? "\u2717" : "\u2713";
    return `<div class="timeline-row status-${escapeAttr(call.status === "complete" ? "complete" : call.status)}" title="${escapeAttr(call.result?.slice(0, 500) ?? "")}">
      <span class="timeline-icon">${icon}</span><span>${escapeHtml(call.name.replace(/^ide_/, "").replace(/_/g, " "))}${call.summary ? ` <code>${escapeHtml(call.summary)}</code>` : ""}</span>
    </div>`;
  }).join("");
  const excerpt = !open && run.text ? `<span class="agent-run-excerpt">${escapeHtml(run.text.replace(/\s+/g, " ").slice(0, 120))}</span>` : "";
  const reconnecting = active && !state.agentsConnected;
  const body = open ? `<div class="agent-run-body">
      ${tools ? `<div class="agent-run-tools">${tools}</div>` : ""}
      ${run.text ? `<div class="agent-run-text${active ? " streaming" : ""}" data-run-text="${escapeAttr(runId)}" data-scroll-key="run-text:${escapeAttr(runId)}"${active ? " data-follow" : ""}>${renderMarkdownish(run.text)}</div>`
        : active ? `<div class="assistant-status"><span class="turn-indicator"></span><span>${reconnecting ? "Reconnecting to live output\u2026" : "Working\u2026"}</span></div>` : ""}
      ${run.error ? `<pre class="agent-run-error" data-scroll-key="run-error:${escapeAttr(runId)}">${escapeHtml(run.error)}</pre>` : ""}
      ${approvals.map(renderRunApprovalCard).join("")}
      ${children.length ? `<div class="agent-run-children">${children.map((id) => renderAgentRunCard(id, depth + 1)).join("")}</div>` : ""}
    </div>` : approvals.map(renderRunApprovalCard).join("");
  return `<div class="agent-run-card status-${escapeAttr(run.status)}${depth ? " nested" : ""}" data-run-id="${escapeAttr(runId)}">
    <button class="agent-run-head" type="button" data-run-toggle="${escapeAttr(runId)}">
      <span class="timeline-icon">${active ? `<span class="turn-indicator"></span>` : stepIcon(run.status)}</span>
      <span class="agent-run-title">${escapeHtml(title)}</span>
      ${excerpt}
      ${children.length ? `<span class="graph-step-runs">${children.length} sub-agent${children.length === 1 ? "" : "s"}</span>` : ""}
      ${reconnecting ? `<span class="graph-reconnecting">Reconnecting\u2026</span>` : ""}
      <span class="agent-run-status">${escapeHtml(RUN_STATUS_LABEL[run.status] ?? run.status.replace(/_/g, " "))}</span>
      <span class="graph-step-chevron">${open ? "\u25BE" : "\u25B8"}</span>
    </button>
    ${body}
  </div>`;
}

function renderRunApprovalCard(card: RunApprovalView): string {
  return renderApprovalCard(card).replace(/data-approval="/g, `data-run-approval-id="${escapeAttr(card.id)}" data-run-approval="`);
}

/** Wire run cards, graph steps and run approvals inside `scope`. */
function bindRunCards(scope: HTMLElement): void {
  const sessionId = state.activeSession?.id;
  scope.querySelectorAll<HTMLButtonElement>("[data-run-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const runId = btn.dataset.runToggle!;
      const run = state.agentRuns.get(runId);
      if (!run) return;
      runToggles.set(runId, !runOpen(run));
      rerenderRuns([runId], false);
    });
  });
  scope.querySelectorAll<HTMLButtonElement>("[data-step-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.stepToggle!;
      const block = btn.closest<HTMLElement>(".graph-step-block");
      stepToggles.set(key, !block?.classList.contains("open"));
      const owner = btn.closest<HTMLElement>(".turn")?.dataset.messageId;
      if (owner) rerenderMessageInDom(owner);
    });
  });
  if (!sessionId) return;
  scope.querySelectorAll<HTMLButtonElement>("[data-step-approval]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const messageId = btn.closest<HTMLElement>(".turn")?.dataset.messageId ?? "";
      btn.closest(".approval-actions")?.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      send({
        type: "resolveNodeApproval",
        sessionId,
        messageId,
        graphId: btn.dataset.graphId!,
        nodeId: btn.dataset.nodeId!,
        decision: btn.dataset.stepApproval === "approved" ? "approved" : "rejected",
      });
    });
  });
  scope.querySelectorAll<HTMLButtonElement>("[data-step-replay]").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.disabled = true;
      send({ type: "replayNode", sessionId, graphId: btn.dataset.graphId!, nodeId: btn.dataset.nodeId! });
    });
  });
  scope.querySelectorAll<HTMLButtonElement>("[data-run-approval]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const approvalId = btn.dataset.runApprovalId!;
      const card = state.runApprovals.find((a) => a.id === approvalId);
      if (card?.busy) return;
      if (card) card.busy = true;
      btn.closest(".approval-actions")?.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      send({ type: "resolveRunApproval", sessionId, approvalId, decision: btn.dataset.runApproval === "approved" ? "approved" : "rejected" });
    });
  });
  // Live output follows its tail via preserveView (`data-follow`), only while
  // the user is at its bottom. Fetch the tool calls of finished runs once.
  scope.querySelectorAll<HTMLElement>(".agent-run-card").forEach((card) => {
    const runId = card.dataset.runId!;
    const run = state.agentRuns.get(runId);
    if (!run || !runOpen(run) || isActiveAgentRunStatus(run.status) || run.toolCalls.length || requestedToolCalls.has(runId)) return;
    requestedToolCalls.add(runId);
    send({ type: "loadRunToolCalls", sessionId, runId });
  });
}

function renderFallbackCard(fallback: FallbackProposalView): string {
  const buttons = fallback.alternatives
    .map((alt, i) => `<button class="btn-secondary" type="button" data-fallback-index="${i}">${escapeHtml(describeModel(alt.provider as ConfiguredProvider, alt.model))}</button>`)
    .join("");
  return `<div class="fallback-card">
    <div class="approval-title">The selected model can't handle this request</div>
    ${fallback.reason ? `<div class="approval-reason">${escapeHtml(fallback.reason)}</div>` : ""}
    ${buttons
      ? `<div class="approval-reason">Retry with a compatible model:</div><div class="fallback-options">${buttons}</div>`
      : `<div class="approval-reason">No compatible model is configured. Add one under Settings \u2192 Providers.</div>`}
  </div>`;
}

function bindTurnExtras(turn: HTMLElement, message: ChatMessage): void {
  const sessionId = state.activeSession?.id;
  if (!sessionId) return;
  // Only a click is the user's choice (`toggle` also fires when a render opens it).
  const thinking = turn.querySelector<HTMLDetailsElement>(".thinking-block");
  thinking?.querySelector("summary")?.addEventListener("click", () => {
    thinkingToggles.set(message.id, !thinking.open);
  });
  turn.querySelectorAll<HTMLButtonElement>("[data-approval]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const approval = message.approval;
      if (!approval || approval.busy) return;
      const decision = btn.dataset.approval === "approved" ? "approved" : "rejected";
      approval.busy = true;
      rerenderMessageInDom(message.id);
      send({ type: "resolveApproval", sessionId, messageId: message.id, approvalId: approval.id, decision });
    });
  });
  turn.querySelector<HTMLButtonElement>("[data-graph-cancel]")?.addEventListener("click", () => {
    const graph = message.graph;
    if (!graph || graph.cancelling) return;
    graph.cancelling = true;
    rerenderMessageInDom(message.id);
    send({ type: "cancelGraph", sessionId, messageId: message.id, graphId: graph.graphId });
  });
  turn.querySelectorAll<HTMLButtonElement>("[data-fallback-index]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const fallback = message.fallback;
      const alt = fallback?.alternatives[Number(btn.dataset.fallbackIndex)];
      if (!fallback || !alt) return;
      send({ type: "retryWithModel", sessionId, messageId: message.id, provider: alt.provider, model: alt.model, content: fallback.prompt });
    });
  });
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

type LiveActivityKind = NonNullable<ToolTimelineEntry["activityKind"]> | "thinking";
type LiveActivity = { kind: LiveActivityKind; verb: string; detail?: string };

function activityVerb(kind: LiveActivityKind): string {
  switch (kind) {
    case "thinking":
      return "Thinking";
    case "reading":
      return "Reading";
    case "searching":
      return "Searching";
    case "writing":
      return "Editing";
    case "executing":
      return "Running";
    case "agent":
      return "Delegating";
    case "web":
      return "Fetching the web";
    case "mcp":
      return "Calling tool";
    case "approval":
      return "Awaiting approval";
  }
}

function activityIcon(kind: LiveActivityKind): string {
  switch (kind) {
    case "thinking":
      return `<span class="turn-indicator"></span>`;
    case "reading":
      return "📄";
    case "searching":
      return "🔎";
    case "writing":
      return "✎";
    case "executing":
      return "▶";
    case "agent":
      return "⚙";
    case "web":
      return "🌐";
    case "mcp":
      return "🔌";
    case "approval":
      return "🛡";
  }
}

function pickActivityDetail(name: string, args: Record<string, unknown>): string | undefined {
  const path = typeof args.path === "string" ? args.path : undefined;
  if (path) return path;
  if (name === "ide_search_code" && typeof args.query === "string") return truncateText(args.query, 80);
  if (typeof args.url === "string") return args.url;
  if (typeof args.command === "string") return truncateText(args.command, 80);
  return undefined;
}

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function activityFromTool(tool: ToolTimelineEntry): LiveActivity {
  const kind: LiveActivityKind = tool.activityKind ?? "executing";
  const verb = activityVerb(kind);
  const detail = pickActivityDetail(tool.name, tool.arguments ?? {});
  return { kind, verb, detail };
}

function activityFromMessage(message: ChatMessage): LiveActivity | null {
  if (message.role !== "assistant" || message.status !== "streaming") return null;
  const running = (message.tools ?? []).find((t) => t.status === "running");
  if (running) return activityFromTool(running);
  return { kind: "thinking", verb: activityVerb("thinking") };
}

function currentActivity(): LiveActivity | null {
  if (!state.streaming) return null;
  const session = state.activeSession;
  if (!session) return null;
  const streamingMessage = [...session.messages].reverse().find((m) => m.role === "assistant" && m.status === "streaming");
  if (!streamingMessage) return null;
  return activityFromMessage(streamingMessage);
}

function renderActivityPill(activity: LiveActivity): string {
  const detail = activity.detail ? `<code class="activity-detail">${escapeHtml(activity.detail)}</code>` : "";
  return `
    <div class="activity-pill" role="status" aria-live="polite">
      <span class="activity-icon">${activityIcon(activity.kind)}</span>
      <span class="activity-verb">${escapeHtml(activity.verb)}</span>
      ${detail}
      <span class="activity-progress" aria-hidden="true"></span>
    </div>
  `;
}

function renderActivity(): void {
  const activity = currentActivity();

  const topbar = root.querySelector<HTMLDivElement>("#activity-topbar");
  if (topbar) topbar.dataset.active = activity ? "true" : "false";

  const line = root.querySelector<HTMLDivElement>("#activity-composer-line");
  if (!line) return;
  if (!activity) {
    line.hidden = true;
    line.innerHTML = "";
    return;
  }
  line.hidden = false;
  const detail = activity.detail ? `<code class="activity-detail">${escapeHtml(activity.detail)}</code>` : "";
  line.innerHTML = `
    <span class="activity-icon">${activityIcon(activity.kind)}</span>
    <span class="activity-verb">${escapeHtml(activity.verb)}</span>
    ${detail}
    <span class="activity-progress" aria-hidden="true"></span>
  `;
}

function renderTimelineBlock(message: ChatMessage): string {
  const tools = message.tools ?? [];
  if (tools.length === 0 && message.status !== "streaming") return "";
  const duration = formatWorkDuration(message);
  const expanded = state.expandedTimelines.has(message.id) || message.status === "streaming";
  const chevron = expanded ? "\u25BE" : "\u25B8";
  const activity = message.status === "streaming" ? activityFromMessage(message) : null;
  const pill = activity ? renderActivityPill(activity) : "";
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
    ${pill}
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
      const file = message.editedFiles?.find((f) => f.path === path);
      if (path) send({ type: "revealFile", path, root: file?.root });
    });
  });
  turn.querySelector<HTMLButtonElement>('[data-act="undo-all"]')?.addEventListener("click", () => {
    const files = message.editedFiles ?? [];
    const sessionId = state.activeSession?.id;
    // The host confirms with a modal dialog and undoes from this chat's snapshots.
    if (files.length && sessionId) send({ type: "undoEdits", sessionId, files: files.map((f) => ({ path: f.path, root: f.root })) });
  });
  turn.querySelector<HTMLButtonElement>('[data-act="review-all"]')?.addEventListener("click", () => {
    const first = message.editedFiles?.[0];
    if (first) send({ type: "revealFile", path: first.path, root: first.root });
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
  const modelLabel = modelChipLabel({
    models: state.catalog.models,
    selection: eff.modelSelection,
    provider: eff.provider,
    model: eff.model,
    routed: state.activeSession?.routedModel,
  });
  const primaryAgent = state.catalog.agents.find((agent) => agent.id === eff.agentId);
  const agentLabel = primaryAgent ? primaryAgent.name : "Agent";

  toolbar.innerHTML = `
    <button class="composer-icon-btn" id="attach-btn" title="Attach files for chat and RAG" aria-label="Attach">+</button>
    <button class="chip${primaryAgent ? " chip-on" : ""}" id="chip-agents" title="Choose conversation agent" ${state.catalog.agents.length === 0 ? "disabled" : ""}>
      \u269B ${escapeHtml(agentLabel)}
    </button>
    <span class="composer-spacer"></span>
    <button class="chip chip-approval chip-approval-${escapeAttr(eff.approvalMode)}" id="chip-approval" title="${escapeAttr(`Approval mode: ${approvalModeLabel(eff.approvalMode)} \u2014 ${APPROVAL_MODE_OPTIONS.find((o) => o.id === eff.approvalMode)?.description ?? ""}`)}">
      <span>${eff.approvalMode === "full" ? "\u26A0 " : ""}${escapeHtml(approvalModeLabel(eff.approvalMode))}</span>
      <span class="chip-caret">\u25BE</span>
    </button>
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
  toolbar.querySelector<HTMLButtonElement>("#chip-approval")?.addEventListener("click", () => {
    state.approvalPickerOpen = !state.approvalPickerOpen;
    applyApprovalPicker();
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

/** Slash-command popover state: the highlighted row, and a draft the user dismissed it for. */
let hintIndex = 0;
let visibleHints: string[] = [];
let hintsDismissedFor: string | null = null;
function renderContextBlocks(): void {
  const container = root.querySelector<HTMLDivElement>("#composer-context");
  if (!container) return;
  if (state.contextBlocks.length === 0) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  container.hidden = false;
  container.innerHTML = state.contextBlocks.map((b) => `
    <span class="composer-attachment" data-id="${escapeAttr(b.id)}">
      <span class="composer-attachment-name" title="${escapeAttr(b.label)}">@${escapeHtml(b.kind)}: ${escapeHtml(b.label)}</span>
      <button type="button" class="composer-context-remove" data-id="${escapeAttr(b.id)}" title="Remove" aria-label="Remove">✕</button>
    </span>
  `).join("");
  for (const button of container.querySelectorAll<HTMLButtonElement>(".composer-context-remove")) {
    button.addEventListener("click", () => send({ type: "removeContextBlock", id: button.dataset.id ?? "" }));
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

  const commands = hintsDismissedFor === state.draft ? [] : buildChatSlashCommands({
    surface: "ide",
    agents: state.catalog.agents,
    slashQuery: parseSlashQuery(state.draft),
  });
  visibleHints = commands.slice(0, 50).map((command) => command.insert);
  if (!commands.length) {
    hints.innerHTML = "";
    hints.hidden = true;
    hintIndex = 0;
    return;
  }
  hintIndex = Math.min(hintIndex, visibleHints.length - 1);
  hints.hidden = false;
  hints.innerHTML = commands
    .slice(0, 50)
    .map(
      (command, index) => `
        <button class="hint${index === hintIndex ? " active" : ""}" role="option" aria-selected="${index === hintIndex}" data-index="${index}" data-insert="${escapeAttr(command.insert)}" title="${escapeAttr(command.description)}">
          <span class="hint-label">${escapeHtml(command.label)}</span>
          <span class="hint-description">${escapeHtml(command.description)}</span>
        </button>
      `,
    )
    .join("");
  hints.querySelector(".hint.active")?.scrollIntoView({ block: "nearest" });

  for (const button of hints.querySelectorAll<HTMLButtonElement>(".hint")) {
    // mousedown keeps focus in the composer.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => applyHint(button.dataset.insert ?? ""));
  }
}

function applyHint(insert: string): void {
  const composer = root.querySelector<HTMLTextAreaElement>("#composer")!;
  composer.value = insert;
  composer.focus();
  state.draft = composer.value;
  hintIndex = 0;
  autosize(composer);
  renderComposerHints();
}

/** Keyboard control of the open command popover; true when the key was handled. */
function handleHintKey(event: KeyboardEvent): boolean {
  if (visibleHints.length === 0) return false;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    hintIndex = (hintIndex + step + visibleHints.length) % visibleHints.length;
    renderComposerHints();
    return true;
  }
  if ((event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) && !event.isComposing) {
    const insert = visibleHints[hintIndex];
    // Enter on a command that is already fully typed sends it.
    if (event.key === "Enter" && insert?.trim() === state.draft.trim()) return false;
    event.preventDefault();
    if (insert !== undefined) applyHint(insert);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    hintsDismissedFor = state.draft;
    renderComposerHints();
    return true;
  }
  return false;
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
        No chat models configured. Open the VoxChat app and add a model under Settings \u2192 Providers.
      </div>
    `;
  } else {
    el.innerHTML = `
      <header class="popover-header">
        <span>Model for this chat</span>
        <button class="icon-btn" id="picker-close">\u2715</button>
      </header>
      <div class="popover-body">
        <section class="popover-group">
          <ul>
            <li class="popover-row popover-row-auto${eff.modelSelection === "auto" ? " selected" : ""}" data-auto="true">
              <div class="popover-row-title">Auto</div>
              <div class="popover-row-detail">Route each turn to a suitable model${state.activeSession?.routedModel?.model ? ` \u2014 last: ${escapeHtml(state.activeSession.routedModel.model)}` : ""}</div>
            </li>
          </ul>
        </section>
        ${grouped.map((g) => `
          <section class="popover-group">
            <h4>${escapeHtml(g.label)}</h4>
            <ul>
              ${g.models.map((m) => {
                const selected = eff.modelSelection === "manual" && m.provider === eff.provider && m.modelId === eff.model;
                const cap = modelCapabilityBadges(m).slice(0, 3).join(", ");
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
      setOverrides(li.dataset.auto
        ? { modelSelection: "auto", model: "auto" }
        : { modelSelection: "manual", provider: li.dataset.provider as ConfiguredProvider, model: li.dataset.model });
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
        <span>Conversation agent</span>
        <button class="icon-btn" id="agent-close">\u2715</button>
      </header>
      <div class="popover-empty">No agents configured in LiberIDE.</div>
    `;
  } else {
    el.innerHTML = `
      <header class="popover-header">
        <span>Conversation agent</span>
        <button class="icon-btn" id="agent-close">\u2715</button>
      </header>
      <div class="popover-body">
        <ul>
          <li class="popover-row${!eff.agentId ? " selected" : ""}" data-id="">
            <div class="popover-row-title">No primary agent</div>
            <div class="popover-row-detail">Use the default assistant persona for this chat.</div>
          </li>
          ${invokableAgents(state.catalog.agents).map((a) => {
            const selected = eff.agentId === a.id;
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
      const id = li.dataset.id || undefined;
      setOverrides({ agentId: id });
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
    <label for="set-mode">Model selection for new chats</label>
    <select id="set-mode" data-key="modelSelection">
      <option value="manual" ${s.modelSelection==="manual"?"selected":""}>manual</option>
      <option value="auto" ${s.modelSelection==="auto"?"selected":""}>auto</option>
    </select>
    <label for="set-rag">RAG by default</label>
    <div><input id="set-rag" data-key="useRag" type="checkbox" ${s.useRag?"checked":""} /></div>
    <label for="set-system">Local system prompt</label>
    <textarea id="set-system" data-key="systemPrompt" placeholder="(empty)">${escapeHtml(s.systemPrompt)}</textarea>

    <h2>Callable agents</h2>
    <p class="hint">Default allowed agents for new chats. Existing conversations keep their saved list and stay in sync with VoxChat.</p>
    <div class="settings-agent-list">
      ${invokableAgents(state.catalog.agents).map((agent) => {
        const selected = (s.defaultAllowedAgentIds ?? []).includes(agent.id);
        return `<label class="settings-agent-option">
          <input type="checkbox" data-default-agent="${escapeAttr(agent.id)}" ${selected ? "checked" : ""} />
          <span>
            <strong>${escapeHtml(agent.name)}</strong>
            <span>${escapeHtml(agent.description || "")}</span>
          </span>
        </label>`;
      }).join("") || "<p class=\"hint\">No callable agents configured in VoxChat.</p>"}
    </div>

    <div class="hint">Models, MCP servers, and skills are managed in VoxChat settings. The conversation agent is chosen per chat above the composer.</div>

    <h2>Integrations</h2>
    <label>GitHub Copilot</label>
    <div><button class="ghost-btn" id="copilot-github-login" type="button">Sign in to GitHub for Copilot</button></div>
  `;
  for (const input of grid.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-key]")) {
    input.addEventListener("change", () => emitSettingChange(input));
  }
  for (const input of grid.querySelectorAll<HTMLInputElement>("input[data-default-agent]")) {
    input.addEventListener("change", () => {
      const current = new Set(s.defaultAllowedAgentIds ?? []);
      const id = input.dataset.defaultAgent!;
      if (input.checked) current.add(id);
      else current.delete(id);
      send({ type: "updateSetting", key: "defaultAllowedAgentIds", value: [...current] });
    });
  }
  grid.querySelector<HTMLButtonElement>("#copilot-github-login")?.addEventListener("click", () => {
    send({ type: "copilotGithubLogin" });
  });
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
      label: providerLabel(provider as ConfiguredProvider),
      models: [...group].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function describeModel(provider: ConfiguredProvider | undefined, modelId: string | undefined): string {
  if (!provider || !modelId) return state.catalog.models.length === 0 ? "No models configured" : "Pick a model";
  for (const m of state.catalog.models) {
    if (m.provider === provider && m.modelId === modelId) return m.displayName;
  }
  return `${providerLabel(provider)} \u00B7 ${modelId}`;
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
  if (lang === "task") {
    const task = parseTaskContractBlock(code);
    if (task) return renderTaskCard(task, code);
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

/**
 * A ```task block (task contract) as a readable card, like VoxChat's. The raw
 * block stays right after the header so Copy copies it, and Source shows it.
 */
function renderTaskCard(task: TaskContractView, source: string): string {
  const chips = (label: string, items: string[]) => items.length
    ? `<div class="md-task-row"><span class="md-task-label">${escapeHtml(label)}</span>${items.map((item) => `<span class="md-task-chip">${escapeHtml(item)}</span>`).join("")}</div>`
    : "";
  const section = (label: string, body: string) => `<div class="md-task-section"><div class="md-task-heading">${escapeHtml(label)}</div>${body}</div>`;
  return `<div class="md-codeblock md-task">
    <div class="md-codeblock-head">
      <span class="md-task-meta"><span class="md-codeblock-lang">${escapeHtml(task.id)}</span><span class="md-task-pill">${escapeHtml(task.status)}</span><span class="md-task-pill">${escapeHtml(task.agent)}</span></span>
      <span><button class="md-codeblock-copy" data-task-toggle>Source</button><button class="md-codeblock-copy" data-copy>Copy</button></span>
    </div>
    <pre class="md-pre md-pre-wrap" data-task-source hidden><code class="language-yaml">${escapeHtml(source)}</code></pre>
    <div class="md-task-body" data-task-body>
      <div class="md-task-title">${escapeHtml(task.title)}</div>
      ${chips("Requirements", task.requirementRefs)}${chips("Design", task.designRefs)}${chips("Depends on", task.dependsOn)}
      ${task.expectedFiles.length ? section("Expected files", `<ul class="md-task-files">${task.expectedFiles.map((file) => `<li><code>${escapeHtml(file)}</code></li>`).join("")}</ul>`) : ""}
      ${task.architectureHints ? section("Architecture hints", `<div class="md-task-hints">${escapeHtml(task.architectureHints)}</div>`) : ""}
      ${task.acceptance.length ? section("Acceptance", `<ul class="md-task-acceptance">${task.acceptance.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`) : ""}
    </div>
  </div>`;
}

/** Links from model output: only web and mail links (no javascript:, command:, vscode:, file: ...). */
function isSafeLinkHref(href: string): boolean {
  const trimmed = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(trimmed);
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
          // Remote images would load without a click (and leak whatever the
          // URL encodes); show them as links instead. The CSP blocks them too.
          out += /^data:image\//i.test(src)
            ? `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" class="md-image" loading="lazy" />`
            : isSafeLinkHref(src)
              ? `<a href="${escapeAttr(src)}" class="md-image-link" title="${escapeAttr(src)}">${escapeHtml(alt || "image")}</a>`
              : escapeHtml(alt || "image");
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
          out += isSafeLinkHref(href)
            ? `<a class="md-link" href="${escapeAttr(href)}" target="_blank" rel="noopener">${renderInline(label)}</a>`
            : `<span class="md-link-blocked" title="${escapeAttr(href)}">${renderInline(label)}</span>`;
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
  for (const btn of scope.querySelectorAll<HTMLButtonElement>("[data-task-toggle]")) {
    if (btn.dataset.bound === "1") continue;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      const card = btn.closest(".md-task");
      const source = card?.querySelector<HTMLElement>("[data-task-source]");
      const body = card?.querySelector<HTMLElement>("[data-task-body]");
      if (!source || !body) return;
      const showSource = source.hidden;
      source.hidden = !showSource;
      body.hidden = showSource;
      btn.textContent = showSource ? "Card" : "Source";
    });
  }
  for (const btn of scope.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
    if (btn.dataset.bound === "1") continue;
    btn.dataset.bound = "1";
    btn.addEventListener("click", async () => {
      const head = btn.closest(".md-codeblock-head") ?? btn.parentElement;
      const code = head?.nextElementSibling?.textContent ?? "";
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
  const transcript = root.querySelector<HTMLDivElement>("#transcript");
  const follow = transcript ? isAtBottom(transcript) : false;
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
  // Follow the reply only while the user is at the bottom.
  if (transcript && follow) transcript.scrollTop = transcript.scrollHeight;
}

function rerenderMessageInDom(messageId: string): void {
  const session = state.activeSession;
  if (!session) return;
  const message = session.messages.find((m) => m.id === messageId);
  if (!message) return;
  const turn = root.querySelector<HTMLElement>(`.turn[data-message-id="${cssAttr(messageId)}"]`);
  if (!turn) return;
  preserveView(() => turn.replaceWith(renderMessage(message)));
}

function cssAttr(id: string): string { return id.replace(/"/g, '\\"'); }

/** Take the run state that comes with a (re)sent session; a different chat starts clean. */
function adoptSessionRuns(session: ChatSession | null): void {
  if (!session) {
    state.agentRuns = new Map();
    state.runApprovals = [];
    state.agentsConnected = true;
    return;
  }
  const sameChat = state.activeSession?.id === session.id;
  const next = new Map((session.agentRuns ?? []).map((run) => [run.runId, run] as const));
  // Live updates newer than the session snapshot (it is built from the same host state) are kept.
  if (sameChat) for (const [id, run] of state.agentRuns) if (!next.has(id)) next.set(id, run);
  state.agentRuns = next;
  state.runApprovals = session.runApprovals ?? [];
  state.agentsConnected = session.agentsConnected ?? true;
}

/** A fingerprint of where runs are drawn: a change needs a full transcript render. */
function runPlacement(): string {
  const parts: string[] = [];
  for (const [messageId, ids] of runLayout.rootsByMessage) parts.push(`m:${messageId}=${ids.join(",")}`);
  for (const [graphId, nodes] of runLayout.nodeRuns) for (const [nodeId, ids] of nodes) parts.push(`g:${graphId}/${nodeId}=${ids.join(",")}`);
  for (const [parent, ids] of runLayout.childrenByRun) parts.push(`p:${parent}=${ids.join(",")}`);
  parts.push(`o:${runLayout.orphans.join(",")}`, `h:${[...runLayout.hiddenMessageIds].join(",")}`);
  return parts.join(";");
}

/** Expand a graph node's step (and its runs) and scroll to it. */
function revealGraphNode(graphId: string, requestedNodeId: string): void {
  const host = state.activeSession?.messages.find((m) => m.graph?.graphId === graphId);
  // The Runs view may name the node by task id (`T-1`); steps use the server's id.
  const steps = host?.graph?.steps ?? [];
  const nodeId = steps.find((step) => step.nodeId === requestedNodeId)?.nodeId
    ?? steps.find((step) => step.nodeId === `${graphId}_${requestedNodeId}` || step.nodeId.startsWith(`${graphId}_${requestedNodeId}_`))?.nodeId
    ?? requestedNodeId;
  stepToggles.set(stepKey(graphId, nodeId), true);
  for (const id of runLayout.nodeRuns.get(graphId)?.get(nodeId) ?? []) runToggles.set(id, true);
  if (host) rerenderMessageInDom(host.id);
  const block = root.querySelector<HTMLElement>(`.graph-step-block[data-step-key="${cssAttr(stepKey(graphId, nodeId))}"]`)
    ?? root.querySelector<HTMLElement>(`.graph-card[data-graph-id="${cssAttr(graphId)}"]`);
  block?.scrollIntoView({ block: "center" });
  block?.classList.add("flash");
  setTimeout(() => block?.classList.remove("flash"), 1500);
}

function showNotice(message: string, severity: "info" | "warning" | "error" = "warning"): void {
  const stack = root.querySelector<HTMLDivElement>("#notice-stack");
  if (!stack) return;
  const notice = document.createElement("div");
  notice.className = `inline-notice ${severity}`;
  notice.innerHTML = `<span>${escapeHtml(message)}</span><button class="icon-btn" title="Dismiss" aria-label="Dismiss">&times;</button>`;
  notice.querySelector("button")?.addEventListener("click", () => notice.remove());
  stack.appendChild(notice);
}

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
      adoptSessionRuns(msg.activeSession);
      // A recreated view must keep Stop while the host is still streaming.
      state.streaming = Boolean(msg.activeSession?.messages.some((message) => message.status === "streaming"));
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
      if (state.approvalPickerOpen) renderApprovalPicker();
      break;
    case "project":
      state.project = msg.project;
      renderProjectBar();
      break;
    case "openSettings":
      state.settingsOpen = true;
      applySettings();
      break;
    case "openSidebar":
      state.sidebarOpen = true;
      applySidebar();
      break;
    case "contextBlocks":
      state.contextBlocks = msg.blocks;
      renderContextBlocks();
      break;
    case "approvalModeOffer":
      state.approvalModeOffer = msg.offer;
      renderApprovalModeOffer();
      break;
    case "sessions":
      state.sessions = msg.sessions;
      state.activeSessionId = msg.activeSessionId;
      renderSidebar();
      break;
    case "session": {
      // A re-sent session of the chat on screen is an update: keep the user's place.
      const sameChat = state.activeSession?.id === msg.session.id;
      adoptSessionRuns(msg.session);
      state.activeSession = msg.session;
      state.activeSessionId = msg.session.id;
      state.streaming = msg.session.messages.some((m) => m.status === "streaming");
      renderTranscript({ keepScroll: sameChat });
      renderComposer();
      renderComposerAttachments();
      if (state.approvalPickerOpen) renderApprovalPicker();
      renderApprovalModeOffer();
      break;
    }
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
          renderActivity();
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
          renderActivity();
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
        if (m && msg.serverMessageId && msg.serverMessageId !== msg.messageId) {
          // Adopt the persisted id so later patches (graph, approval) find this bubble.
          const turn = root.querySelector<HTMLElement>(`.turn[data-message-id="${cssAttr(msg.messageId)}"]`);
          m.id = msg.serverMessageId;
          if (turn) turn.dataset.messageId = m.id;
        }
        state.streaming = false;
        renderComposer();
        renderActivity();
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
        renderActivity();
      }
      break;
    case "messagePatch":
      if (state.activeSession && state.activeSession.id === msg.sessionId) {
        const m = state.activeSession.messages.find((x) => x.id === msg.messageId);
        if (m) {
          Object.assign(m, msg.patch);
          const before = runPlacement();
          computeRunLayout();
          // A graph card appearing can adopt runs drawn elsewhere until now.
          // Either way the transcript follows new content only from the bottom.
          if (msg.patch.graph && runPlacement() !== before) renderTranscript({ keepScroll: true });
          else rerenderMessageInDom(msg.messageId);
        }
      }
      break;
    case "restoreDraft":
      if (state.activeSession && state.activeSession.id === msg.sessionId) {
        const composer = root.querySelector<HTMLTextAreaElement>("#composer");
        if (composer && !composer.value.trim()) {
          composer.value = msg.content;
          state.draft = msg.content;
          autosize(composer);
          renderComposerHints();
          composer.focus();
        }
      }
      break;
    case "agentRuns":
      if (state.activeSession && state.activeSession.id === msg.sessionId) {
        if (msg.connected !== undefined && msg.connected !== state.agentsConnected) {
          state.agentsConnected = msg.connected;
          renderTranscript({ keepScroll: true });
        }
        if (!msg.runs.length) break;
        const before = runPlacement();
        for (const run of msg.runs) state.agentRuns.set(run.runId, run);
        computeRunLayout();
        rerenderRuns(msg.runs.map((run) => run.runId), runPlacement() !== before);
      }
      break;
    case "runApprovals":
      if (state.activeSession && state.activeSession.id === msg.sessionId) {
        state.runApprovals = msg.approvals;
        renderTranscript({ keepScroll: true });
      }
      break;
    case "revealGraphNode":
      if (state.activeSession && state.activeSession.id === msg.sessionId) revealGraphNode(msg.graphId, msg.nodeId);
      break;
    case "log":
      console.warn("[liberide]", msg.message);
      showNotice(msg.message, msg.severity);
      break;
  }
}

window.addEventListener("message", (event) => handleMessage(event.data as ChatHostToWebview));
send({ type: "ready" });
