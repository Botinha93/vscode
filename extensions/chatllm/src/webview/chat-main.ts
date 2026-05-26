import type { ChatllmSettings } from "../settings";
import type {
  ChatHostToWebview,
  ChatMessage,
  ChatOverrides,
  ChatSession,
  ChatWebviewToHost,
  ProviderModelGroup,
  SessionSummary,
} from "../chat/chat-protocol";
import type { Provider } from "../chat/types";

interface VsCodeApi {
  postMessage(message: ChatWebviewToHost): void;
  setState(state: unknown): void;
  getState<T = unknown>(): T | undefined;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

interface AppState {
  settings: ChatllmSettings | null;
  sessions: SessionSummary[];
  activeSession: ChatSession | null;
  activeSessionId: string | null;
  modelCatalog: ProviderModelGroup[];
  sidebarOpen: boolean;
  settingsOpen: boolean;
  modelPickerOpen: boolean;
  draft: string;
  streaming: boolean;
}

const state: AppState = {
  settings: null,
  sessions: [],
  activeSession: null,
  activeSessionId: null,
  modelCatalog: [],
  sidebarOpen: false,
  settingsOpen: false,
  modelPickerOpen: false,
  draft: "",
  streaming: false,
};

const root = document.getElementById("root") as HTMLDivElement;

function send(msg: ChatWebviewToHost): void {
  vscode.postMessage(msg);
}

function effectiveOverrides(): Required<ChatOverrides> {
  const s = state.settings;
  const o = state.activeSession?.overrides ?? {};
  return {
    provider: (o.provider ?? s?.provider ?? "openai") as Provider,
    model: o.model ?? s?.model ?? "gpt-4o-mini",
    chatMode: o.chatMode ?? s?.chatMode ?? "normal",
    useRag: o.useRag ?? s?.useRag ?? false,
    toolsEnabled: o.toolsEnabled ?? s?.toolsEnabled ?? true,
  };
}

function setOverrides(partial: ChatOverrides): void {
  if (!state.activeSession) return;
  send({ type: "setOverrides", sessionId: state.activeSession.id, overrides: partial });
}

function render(): void {
  if (!root.firstChild) {
    root.innerHTML = shellHtml();
    bindShell();
  }
  renderSidebar();
  renderHeader();
  renderTranscript();
  renderComposer();
  renderSettingsOverlay();
  renderModelPicker();
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
        </div>
        <div class="chat-sidebar-list" id="session-list"></div>
      </aside>
      <div class="chat-main">
        <header class="chat-header">
          <button class="icon-btn" id="sidebar-toggle" title="Show chats" aria-label="Show chats">\u2630</button>
          <div class="chat-title" id="chat-title">New chat</div>
          <button class="icon-btn" id="new-chat" title="New chat" aria-label="New chat">+</button>
        </header>
        <section class="chat-transcript" id="transcript"></section>
        <footer class="chat-composer">
          <div class="composer-chips" id="chip-row"></div>
          <div class="composer-input">
            <textarea id="composer" placeholder="Ask Chatllm\u2026  (Enter to send, Shift+Enter for newline, / for commands)" rows="1"></textarea>
            <button class="send-btn" id="send-btn" title="Send" aria-label="Send"></button>
          </div>
          <div class="composer-hints" id="composer-hints"></div>
        </footer>
      </div>
      <div class="modal-backdrop" id="modal-backdrop" hidden></div>
      <div class="model-picker" id="model-picker" hidden></div>
      <aside class="settings-overlay" id="settings-overlay" hidden>
        <header class="settings-overlay-header">
          <span>Chatllm Settings</span>
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
  root.querySelector<HTMLButtonElement>("#sidebar-new")?.addEventListener("click", () => {
    send({ type: "newSession" });
  });
  root.querySelector<HTMLButtonElement>("#new-chat")?.addEventListener("click", () => {
    send({ type: "newSession" });
  });
  root.querySelector<HTMLButtonElement>("#settings-close")?.addEventListener("click", () => {
    state.settingsOpen = false;
    applySettings();
  });
  root.querySelector<HTMLButtonElement>("#modal-backdrop")?.addEventListener("click", () => {
    if (state.modelPickerOpen) {
      state.modelPickerOpen = false;
      applyModelPicker();
    }
    if (state.settingsOpen) {
      state.settingsOpen = false;
      applySettings();
    }
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
  root.querySelector<HTMLButtonElement>("#send-btn")?.addEventListener("click", () => submit());
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
  const max = 180;
  el.style.height = Math.min(el.scrollHeight, max) + "px";
}

function applySidebar(): void {
  const el = root.querySelector<HTMLElement>("#chat-sidebar");
  if (!el) return;
  el.toggleAttribute("hidden", !state.sidebarOpen);
}

function applySettings(): void {
  const el = root.querySelector<HTMLElement>("#settings-overlay");
  const backdrop = root.querySelector<HTMLElement>("#modal-backdrop");
  if (el) el.toggleAttribute("hidden", !state.settingsOpen);
  if (backdrop) backdrop.toggleAttribute("hidden", !(state.settingsOpen || state.modelPickerOpen));
  if (state.settingsOpen) renderSettings();
}

function applyModelPicker(): void {
  const el = root.querySelector<HTMLElement>("#model-picker");
  const backdrop = root.querySelector<HTMLElement>("#modal-backdrop");
  if (el) el.toggleAttribute("hidden", !state.modelPickerOpen);
  if (backdrop) backdrop.toggleAttribute("hidden", !(state.settingsOpen || state.modelPickerOpen));
  if (state.modelPickerOpen) renderModelPicker();
}

function renderSidebar(): void {
  const list = root.querySelector<HTMLDivElement>("#session-list");
  if (!list) return;
  list.innerHTML = "";
  if (state.sessions.length === 0) {
    list.innerHTML = `<div class="sidebar-empty">No chats yet.</div>`;
    return;
  }
  for (const s of state.sessions) {
    const row = document.createElement("div");
    row.className = "session-row" + (s.id === state.activeSessionId ? " active" : "");
    const time = relativeTime(s.updatedAt);
    row.innerHTML = `
      <div class="session-row-main">
        <div class="session-row-title">${escapeHtml(s.title)}</div>
        <div class="session-row-meta">${s.messageCount} \u00B7 ${time}</div>
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

function renderHeader(): void {
  const title = root.querySelector<HTMLDivElement>("#chat-title");
  if (!title) return;
  const t = state.activeSession?.title || "New chat";
  title.textContent = t;
  title.title = "Click to rename";
  title.onclick = () => {
    if (!state.activeSession) return;
    const next = window.prompt("Rename chat", state.activeSession.title);
    if (next != null) send({ type: "renameSession", sessionId: state.activeSession.id, title: next });
  };
}

function renderTranscript(): void {
  const transcript = root.querySelector<HTMLDivElement>("#transcript");
  if (!transcript) return;
  transcript.innerHTML = "";
  const messages = state.activeSession?.messages ?? [];
  if (messages.length === 0) {
    transcript.innerHTML = `
      <div class="empty-state">
        <h2>What can I build for you?</h2>
        <p>Type a question, or use a slash command:</p>
        <div class="empty-commands">
          <button data-prompt="/spec ">/spec   draft EARS requirements</button>
          <button data-prompt="/design ">/design   draft design.md</button>
          <button data-prompt="/tasks ">/tasks   generate task contracts</button>
        </div>
      </div>`;
    for (const b of transcript.querySelectorAll<HTMLButtonElement>(".empty-commands button")) {
      b.addEventListener("click", () => {
        const composer = root.querySelector<HTMLTextAreaElement>("#composer")!;
        composer.value = b.dataset.prompt ?? "";
        composer.focus();
        autosize(composer);
      });
    }
    return;
  }
  for (const m of messages) {
    transcript.appendChild(renderMessage(m));
  }
  transcript.scrollTop = transcript.scrollHeight;
}

function renderMessage(message: ChatMessage): HTMLElement {
  const turn = document.createElement("article");
  turn.className = `turn turn-${message.role}` + (message.status === "streaming" ? " streaming" : "") + (message.status === "error" ? " error" : "");
  turn.dataset.messageId = message.id;
  const role = message.role === "user" ? "You" : "Chatllm";
  const initial = message.role === "user" ? "U" : "C";
  turn.innerHTML = `
    <div class="turn-avatar">${initial}</div>
    <div class="turn-body">
      <header class="turn-header">
        <span class="turn-role">${role}</span>
        ${message.status === "streaming" ? `<span class="turn-indicator"></span>` : ""}
        ${message.status === "error" ? `<span class="turn-error-label">error</span>` : ""}
      </header>
      <div class="turn-content"></div>
      ${message.status === "error" && message.error ? `<div class="turn-error">${escapeHtml(message.error)}</div>` : ""}
    </div>
  `;
  const content = turn.querySelector<HTMLDivElement>(".turn-content")!;
  content.innerHTML = renderMarkdownish(message.content);
  return turn;
}

function renderComposer(): void {
  const chipRow = root.querySelector<HTMLDivElement>("#chip-row");
  if (!chipRow) return;
  const eff = effectiveOverrides();
  const desc = lookupModelLabel(eff.provider, eff.model);
  chipRow.innerHTML = `
    <button class="chip chip-model" id="chip-model" title="Pick model">
      <span class="chip-icon">\u25CF</span>
      <span>${escapeHtml(desc)}</span>
      <span class="chip-caret">\u25BE</span>
    </button>
    <button class="chip${eff.chatMode === "agent" ? " chip-on" : ""}" id="chip-mode" title="Toggle agent mode">
      ${eff.chatMode === "agent" ? "Agent" : "Normal"}
    </button>
    <button class="chip${eff.toolsEnabled ? " chip-on" : ""}" id="chip-tools" title="Toggle tools">
      \u2692 Tools
    </button>
    <button class="chip${eff.useRag ? " chip-on" : ""}" id="chip-rag" title="Toggle RAG">
      \u2630 RAG
    </button>
    <span class="composer-spacer"></span>
    <button class="chip chip-ghost" id="chip-settings" title="Open settings">\u2699</button>
    <button class="chip chip-ghost" id="chip-pipeline" title="Open pipeline">\u29C9</button>
  `;
  chipRow.querySelector<HTMLButtonElement>("#chip-model")?.addEventListener("click", () => {
    state.modelPickerOpen = !state.modelPickerOpen;
    applyModelPicker();
  });
  chipRow.querySelector<HTMLButtonElement>("#chip-mode")?.addEventListener("click", () => {
    setOverrides({ chatMode: eff.chatMode === "agent" ? "normal" : "agent" });
  });
  chipRow.querySelector<HTMLButtonElement>("#chip-tools")?.addEventListener("click", () => {
    setOverrides({ toolsEnabled: !eff.toolsEnabled });
  });
  chipRow.querySelector<HTMLButtonElement>("#chip-rag")?.addEventListener("click", () => {
    setOverrides({ useRag: !eff.useRag });
  });
  chipRow.querySelector<HTMLButtonElement>("#chip-settings")?.addEventListener("click", () => {
    state.settingsOpen = true;
    applySettings();
  });
  chipRow.querySelector<HTMLButtonElement>("#chip-pipeline")?.addEventListener("click", () => {
    send({ type: "openPipeline" });
  });

  const sendBtn = root.querySelector<HTMLButtonElement>("#send-btn");
  if (sendBtn) {
    sendBtn.classList.toggle("streaming", state.streaming);
    sendBtn.innerHTML = state.streaming
      ? `<span class="stop-dot"></span>`
      : `\u27A4`;
    sendBtn.title = state.streaming ? "Stop" : "Send";
  }

  renderComposerHints();
}

function renderComposerHints(): void {
  const hints = root.querySelector<HTMLDivElement>("#composer-hints");
  if (!hints) return;
  const draft = state.draft.trimStart();
  if (draft.startsWith("/")) {
    const matches = ["/spec", "/design", "/tasks"].filter((c) => c.startsWith(draft.split(/\s/)[0]));
    if (matches.length) {
      hints.innerHTML = matches
        .map((c) => `<button class="hint" data-cmd="${c}">${c}</button>`)
        .join("");
      for (const b of hints.querySelectorAll<HTMLButtonElement>(".hint")) {
        b.addEventListener("click", () => {
          const composer = root.querySelector<HTMLTextAreaElement>("#composer")!;
          composer.value = (b.dataset.cmd ?? "") + " ";
          composer.focus();
          state.draft = composer.value;
          autosize(composer);
          renderComposerHints();
        });
      }
      return;
    }
  }
  hints.innerHTML = "";
}

function renderModelPicker(): void {
  const el = root.querySelector<HTMLElement>("#model-picker");
  if (!el || !state.modelPickerOpen) return;
  const eff = effectiveOverrides();
  const groups = state.modelCatalog.filter((g) => g.models.length > 0);
  el.innerHTML = `
    <header class="model-picker-header">
      <span>Choose model for this chat</span>
      <button class="icon-btn" id="picker-close" title="Close" aria-label="Close">\u2715</button>
    </header>
    <div class="model-picker-body">
      ${groups.map((g) => `
        <section class="provider-group">
          <h4>${escapeHtml(g.label)}</h4>
          <ul>
            ${g.models.map((m) => {
              const selected = m.provider === eff.provider && m.modelId === eff.model;
              return `<li class="model-row${selected ? " selected" : ""}" data-provider="${m.provider}" data-model="${escapeAttr(m.modelId)}">
                <div class="model-row-title">${escapeHtml(m.name)}</div>
                <div class="model-row-detail">${escapeHtml(m.detail ?? "")}</div>
              </li>`;
            }).join("")}
          </ul>
        </section>
      `).join("")}
      <section class="provider-group">
        <h4>Use default</h4>
        <ul>
          <li class="model-row" data-clear="1">
            <div class="model-row-title">Reset to workspace default</div>
            <div class="model-row-detail">${escapeHtml(state.settings?.provider ?? "")} \u00B7 ${escapeHtml(state.settings?.model ?? "")}</div>
          </li>
        </ul>
      </section>
    </div>
  `;
  el.querySelector<HTMLButtonElement>("#picker-close")?.addEventListener("click", () => {
    state.modelPickerOpen = false;
    applyModelPicker();
  });
  for (const li of el.querySelectorAll<HTMLLIElement>(".model-row")) {
    li.addEventListener("click", () => {
      if (li.dataset.clear) {
        setOverrides({ provider: undefined, model: undefined });
      } else {
        setOverrides({
          provider: li.dataset.provider as Provider,
          model: li.dataset.model,
        });
      }
      state.modelPickerOpen = false;
      applyModelPicker();
    });
  }
}

function renderSettingsOverlay(): void {
  applySettings();
}

function renderSettings(): void {
  const grid = root.querySelector<HTMLDivElement>("#settings-form");
  if (!grid || !state.settings) return;
  const s = state.settings;
  grid.innerHTML = `
    <h2>Defaults</h2>
    <label for="set-provider">Provider</label>
    <select id="set-provider" data-key="provider">
      ${["openai","openrouter","google","ollama","llamacpp","lmstudio","custom"].map((p) => `<option value="${p}" ${p===s.provider?"selected":""}>${p}</option>`).join("")}
    </select>
    <label for="set-model">Default model</label>
    <input id="set-model" data-key="model" type="text" value="${escapeAttr(s.model)}" />
    <label for="set-mode">Model selection</label>
    <select id="set-mode" data-key="modelSelection">
      <option value="manual" ${s.modelSelection==="manual"?"selected":""}>manual</option>
      <option value="auto" ${s.modelSelection==="auto"?"selected":""}>auto</option>
    </select>
    <label for="set-chatmode">Default chat mode</label>
    <select id="set-chatmode" data-key="chatMode">
      <option value="normal" ${s.chatMode==="normal"?"selected":""}>normal</option>
      <option value="agent" ${s.chatMode==="agent"?"selected":""}>agent</option>
    </select>

    <h2>Default behavior</h2>
    <label for="set-rag">RAG by default</label>
    <div><input id="set-rag" data-key="useRag" type="checkbox" ${s.useRag?"checked":""} /></div>
    <label for="set-tools">Tools by default</label>
    <div><input id="set-tools" data-key="toolsEnabled" type="checkbox" ${s.toolsEnabled?"checked":""} /></div>
    <label for="set-spawns">Max agent spawns</label>
    <input id="set-spawns" data-key="maxAgentSpawns" type="number" min="0" max="32" value="${s.maxAgentSpawns}" />

    <h2>Wiring</h2>
    <label for="set-agents">Agents</label>
    <input id="set-agents" data-key="agentIds" data-list="1" type="text" value="${escapeAttr(s.agentIds.join(", "))}" placeholder="agent-1, agent-2" />
    <label for="set-mcps">MCP servers</label>
    <input id="set-mcps" data-key="mcpServerIds" data-list="1" type="text" value="${escapeAttr(s.mcpServerIds.join(", "))}" placeholder="server-1, server-2" />
    <label for="set-skills">Skills</label>
    <input id="set-skills" data-key="skillIds" data-list="1" type="text" value="${escapeAttr(s.skillIds.join(", "))}" placeholder="skill-1, skill-2" />
    <label for="set-docs">Documents</label>
    <input id="set-docs" data-key="documentIds" data-list="1" type="text" value="${escapeAttr(s.documentIds.join(", "))}" placeholder="doc-1, doc-2" />

    <h2>Prompts</h2>
    <label for="set-system">System prompt</label>
    <textarea id="set-system" data-key="systemPrompt">${escapeHtml(s.systemPrompt)}</textarea>

    <h2>Integrations</h2>
    <label for="set-copilot">GitHub Copilot</label>
    <div>
      <input id="set-copilot" data-key="copilot.enabled" type="checkbox" ${s.copilotEnabled?"checked":""} />
      <span class="hint inline">Re-enable the bundled Copilot extension and the native Chat view. Toggling prompts a window reload.</span>
    </div>

    <div class="hint">Defaults persist as <code>chatllm.*</code> user settings. Per-chat picks (model, mode, tools, RAG) only affect the current conversation.</div>
  `;
  for (const input of grid.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-key]")) {
    input.addEventListener("change", () => emitSettingChange(input));
  }
}

function emitSettingChange(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): void {
  const key = input.dataset.key!;
  let value: unknown;
  if (input instanceof HTMLInputElement && input.type === "checkbox") value = input.checked;
  else if (input instanceof HTMLInputElement && input.type === "number") value = Number(input.value);
  else if (input.dataset.list) value = input.value.split(",").map((v) => v.trim()).filter(Boolean);
  else value = input.value;
  send({ type: "updateSetting", key, value });
}

function lookupModelLabel(provider: Provider, modelId: string): string {
  for (const g of state.modelCatalog) {
    if (g.provider !== provider) continue;
    const m = g.models.find((x) => x.modelId === modelId);
    if (m) return m.name;
  }
  return `${provider} \u00B7 ${modelId}`;
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}
function escapeAttr(value: string): string { return escapeHtml(value); }

function renderMarkdownish(text: string): string {
  if (!text) return `<span class="placeholder">\u2026</span>`;
  const escaped = escapeHtml(text);
  const codeFenced = escaped.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, body) => {
    const cls = lang ? `language-${escapeAttr(lang)}` : "";
    return `<pre class="code-block"><code class="${cls}">${body}</code></pre>`;
  });
  const inlineCode = codeFenced.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
  const withLinks = inlineCode.replace(/(https?:\/\/[^\s)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  const bold = withLinks.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const italic = bold.replace(/(^|\W)_([^_\n]+)_/g, "$1<em>$2</em>");
  const paragraphs = italic
    .split(/\n{2,}/)
    .map((p) => {
      if (p.startsWith("<pre")) return p;
      const lines = p.split("\n").map((line) => line);
      return `<p>${lines.join("<br />")}</p>`;
    })
    .join("");
  return paragraphs;
}

function appendChunkInDom(messageId: string, chunk: string): void {
  const turn = root.querySelector<HTMLElement>(`.turn[data-message-id="${cssAttr(messageId)}"] .turn-content`);
  if (!turn) return;
  if (turn.querySelector(".placeholder")) turn.innerHTML = "";
  turn.appendChild(document.createTextNode(chunk));
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

function cssAttr(id: string): string {
  return id.replace(/"/g, '\\"');
}

function handleMessage(msg: ChatHostToWebview): void {
  switch (msg.type) {
    case "init":
      state.settings = msg.settings;
      state.sessions = msg.sessions;
      state.activeSession = msg.activeSession;
      state.activeSessionId = msg.activeSessionId;
      state.modelCatalog = msg.modelCatalog;
      state.streaming = false;
      render();
      break;
    case "settings":
      state.settings = msg.settings;
      renderComposer();
      if (state.settingsOpen) renderSettings();
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
      break;
    case "messageAppend":
      if (state.activeSession && state.activeSession.id === msg.sessionId) {
        const m = state.activeSession.messages.find((x) => x.id === msg.messageId);
        if (m) {
          m.content += msg.chunk;
          m.status = "streaming";
          state.streaming = true;
          appendChunkInDom(msg.messageId, msg.chunk);
          renderComposer();
        }
      }
      break;
    case "messageComplete":
      if (state.activeSession && state.activeSession.id === msg.sessionId) {
        const m = state.activeSession.messages.find((x) => x.id === msg.messageId);
        if (m) {
          m.status = "complete";
          if (msg.conversationId) state.activeSession.conversationId = msg.conversationId;
          rerenderMessageInDom(msg.messageId);
        }
        state.streaming = state.activeSession.messages.some((x) => x.status === "streaming");
        renderComposer();
      }
      break;
    case "messageError":
      if (state.activeSession && state.activeSession.id === msg.sessionId) {
        const m = state.activeSession.messages.find((x) => x.id === msg.messageId);
        if (m) {
          m.status = "error";
          m.error = msg.error;
          rerenderMessageInDom(msg.messageId);
        }
        state.streaming = false;
        renderComposer();
      }
      break;
    case "toolEvent":
      break;
    case "log":
      console.warn("[chatllm]", msg.message);
      break;
  }
}

window.addEventListener("message", (event) => handleMessage(event.data as ChatHostToWebview));
send({ type: "ready" });
