"use strict";
(() => {
  // src/webview/chat-main.ts
  var vscode = acquireVsCodeApi();
  var state = {
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
    streaming: false
  };
  var PROVIDER_LABELS = {
    openai: "OpenAI",
    openrouter: "OpenRouter",
    google: "Google",
    ollama: "Ollama",
    "ollama-internal": "Ollama (internal)",
    llamacpp: "llama.cpp",
    lmstudio: "LM Studio",
    custom: "Custom"
  };
  var root = document.getElementById("root");
  function send(msg) {
    vscode.postMessage(msg);
  }
  function effective() {
    const s = state.settings;
    const o = state.activeSession?.overrides ?? {};
    const fallbackModel = state.catalog.models.find((m) => m.enabled);
    return {
      provider: o.provider ?? fallbackModel?.provider,
      model: o.model ?? fallbackModel?.modelId,
      chatMode: o.chatMode ?? s?.chatMode ?? "normal",
      useRag: o.useRag ?? s?.useRag ?? false,
      toolsEnabled: o.toolsEnabled ?? s?.toolsEnabled ?? true,
      agentIds: o.agentIds ?? [],
      skillIds: o.skillIds ?? [],
      mcpServerIds: o.mcpServerIds ?? []
    };
  }
  function setOverrides(partial) {
    if (!state.activeSession) return;
    send({ type: "setOverrides", sessionId: state.activeSession.id, overrides: partial });
  }
  function render() {
    if (!root.firstChild) {
      root.innerHTML = shellHtml();
      bindShell();
    }
    renderProjectBar();
    renderSidebar();
    renderHeader();
    renderTranscript();
    renderComposer();
    applySettings();
    applyModelPicker();
    applyAgentPicker();
    renderBackendBanner();
  }
  function shellHtml() {
    return `
    <div class="chat-shell">
      <aside class="chat-sidebar" id="chat-sidebar" hidden>
        <header class="chat-sidebar-header">
          <span>Chats</span>
          <button class="icon-btn" id="sidebar-close" title="Close" aria-label="Close">\u2715</button>
        </header>
        <div class="chat-sidebar-actions">
          <button class="ghost-btn" id="sidebar-new">+  New chat</button>
        </div>
        <div class="chat-sidebar-list" id="session-list"></div>
        <footer class="chat-sidebar-footer">
          <button class="ghost-btn small" id="sidebar-refresh" title="Refresh chats from Chatllm">\u21BB  Refresh</button>
        </footer>
      </aside>
      <div class="chat-main">
        <div class="project-bar" id="project-bar"></div>
        <header class="chat-header">
          <button class="icon-btn" id="sidebar-toggle" title="Show chats" aria-label="Show chats">\u2630</button>
          <div class="chat-title" id="chat-title">New chat</div>
          <button class="icon-btn" id="new-chat" title="New chat" aria-label="New chat">+</button>
        </header>
        <div class="backend-banner" id="backend-banner" hidden></div>
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
      <div class="popover" id="model-picker" hidden></div>
      <div class="popover" id="agent-picker" hidden></div>
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
  function bindShell() {
    root.querySelector("#sidebar-toggle")?.addEventListener("click", () => {
      state.sidebarOpen = !state.sidebarOpen;
      applySidebar();
    });
    root.querySelector("#sidebar-close")?.addEventListener("click", () => {
      state.sidebarOpen = false;
      applySidebar();
    });
    root.querySelector("#sidebar-new")?.addEventListener("click", () => send({ type: "newSession" }));
    root.querySelector("#sidebar-refresh")?.addEventListener("click", () => send({ type: "refreshSessions" }));
    root.querySelector("#new-chat")?.addEventListener("click", () => send({ type: "newSession" }));
    root.querySelector("#settings-close")?.addEventListener("click", () => {
      state.settingsOpen = false;
      applySettings();
    });
    root.querySelector("#modal-backdrop")?.addEventListener("click", () => {
      if (state.modelPickerOpen) {
        state.modelPickerOpen = false;
        applyModelPicker();
      }
      if (state.agentPickerOpen) {
        state.agentPickerOpen = false;
        applyAgentPicker();
      }
      if (state.settingsOpen) {
        state.settingsOpen = false;
        applySettings();
      }
    });
    const composer = root.querySelector("#composer");
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
    root.querySelector("#send-btn")?.addEventListener("click", () => submit());
  }
  function submit() {
    if (!state.activeSession) return;
    if (state.streaming) {
      send({ type: "cancelMessage", sessionId: state.activeSession.id });
      return;
    }
    const composer = root.querySelector("#composer");
    const text = composer.value.trim();
    if (!text) return;
    send({ type: "sendMessage", sessionId: state.activeSession.id, content: text });
    composer.value = "";
    state.draft = "";
    autosize(composer);
    renderComposerHints();
  }
  function autosize(el) {
    el.style.height = "auto";
    const max = 200;
    el.style.height = Math.min(el.scrollHeight, max) + "px";
  }
  function applySidebar() {
    const el = root.querySelector("#chat-sidebar");
    if (el) el.toggleAttribute("hidden", !state.sidebarOpen);
  }
  function applySettings() {
    const el = root.querySelector("#settings-overlay");
    const backdrop = root.querySelector("#modal-backdrop");
    if (el) el.toggleAttribute("hidden", !state.settingsOpen);
    if (backdrop) backdrop.toggleAttribute("hidden", !(state.settingsOpen || state.modelPickerOpen || state.agentPickerOpen));
    if (state.settingsOpen) renderSettings();
  }
  function applyModelPicker() {
    const el = root.querySelector("#model-picker");
    const backdrop = root.querySelector("#modal-backdrop");
    if (el) el.toggleAttribute("hidden", !state.modelPickerOpen);
    if (backdrop) backdrop.toggleAttribute("hidden", !(state.settingsOpen || state.modelPickerOpen || state.agentPickerOpen));
    if (state.modelPickerOpen) renderModelPicker();
  }
  function applyAgentPicker() {
    const el = root.querySelector("#agent-picker");
    const backdrop = root.querySelector("#modal-backdrop");
    if (el) el.toggleAttribute("hidden", !state.agentPickerOpen);
    if (backdrop) backdrop.toggleAttribute("hidden", !(state.settingsOpen || state.modelPickerOpen || state.agentPickerOpen));
    if (state.agentPickerOpen) renderAgentPicker();
  }
  function renderProjectBar() {
    const bar = root.querySelector("#project-bar");
    if (!bar) return;
    if (!state.project || state.project.source === "none") {
      bar.innerHTML = `<span class="project-name">No workspace folder</span>`;
      return;
    }
    const icon = state.project.source === "git" ? "\u2387" : "\u25A2";
    const subtitle = state.project.source === "git" ? state.project.remoteUrl ?? state.project.id : state.project.rootPath ?? "";
    const branch = state.project.branch ? ` <span class="project-branch">\u2387 ${escapeHtml(state.project.branch)}</span>` : "";
    bar.innerHTML = `
    <span class="project-icon">${icon}</span>
    <div class="project-text">
      <div class="project-name">${escapeHtml(state.project.name)}${branch}</div>
      <div class="project-subtitle" title="${escapeAttr(subtitle)}">${escapeHtml(subtitle)}</div>
    </div>
  `;
  }
  function renderSidebar() {
    const list = root.querySelector("#session-list");
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
      row.innerHTML = `
      <div class="session-row-main">
        <div class="session-row-title">${escapeHtml(s.title)} ${tag}</div>
        <div class="session-row-meta">${s.messageCount} \xB7 ${time}</div>
      </div>
      <button class="icon-btn session-delete" title="Delete" aria-label="Delete">\u2715</button>
    `;
      row.addEventListener("click", (event) => {
        if (event.target.closest(".session-delete")) return;
        send({ type: "openSession", sessionId: s.id });
        state.sidebarOpen = false;
        applySidebar();
      });
      row.querySelector(".session-delete")?.addEventListener("click", (event) => {
        event.stopPropagation();
        send({ type: "deleteSession", sessionId: s.id });
      });
      list.appendChild(row);
    }
  }
  function renderHeader() {
    const title = root.querySelector("#chat-title");
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
  function renderBackendBanner() {
    const banner = root.querySelector("#backend-banner");
    if (!banner) return;
    if (state.backendStatus === "ok") {
      banner.toggleAttribute("hidden", true);
      return;
    }
    banner.toggleAttribute("hidden", false);
    if (state.backendStatus === "unconfigured") {
      banner.className = "backend-banner unconfigured";
      banner.innerHTML = `Chatllm API origin is not configured. Set <code>CHATLLM_API_ORIGIN</code> in your environment to start chatting.`;
    } else if (state.backendStatus === "unauthorized") {
      banner.className = "backend-banner unauthorized";
      banner.innerHTML = `VS Code is not signed in to Chatllm. Close this window and reopen the project from the Chatllm desktop app while you are logged in.`;
    } else {
      banner.className = "backend-banner unreachable";
      banner.innerHTML = `Can't reach Chatllm at <code>${escapeHtml(state.apiOrigin)}</code>. <button id="retry-backend" class="link-btn">Retry</button>`;
      banner.querySelector("#retry-backend")?.addEventListener("click", () => send({ type: "refreshCatalog" }));
    }
  }
  function renderTranscript() {
    const transcript = root.querySelector("#transcript");
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
  function renderEmptyState() {
    const el = document.createElement("div");
    el.className = "empty-state";
    const projectLine = state.project && state.project.source !== "none" ? `<div class="empty-project">Chats here live with <strong>${escapeHtml(state.project.name)}</strong>${state.project.source === "git" ? " (git project)" : ""}.</div>` : "";
    el.innerHTML = `
    <h2>What can I build for you?</h2>
    ${projectLine}
    <div class="empty-commands">
      <button data-prompt="/spec ">/spec   draft EARS requirements</button>
      <button data-prompt="/design ">/design   draft design.md</button>
      <button data-prompt="/tasks ">/tasks   generate task contracts</button>
    </div>
  `;
    for (const b of el.querySelectorAll(".empty-commands button")) {
      b.addEventListener("click", () => {
        const composer = root.querySelector("#composer");
        composer.value = b.dataset.prompt ?? "";
        composer.focus();
        autosize(composer);
      });
    }
    return el;
  }
  function renderMessage(message) {
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
    const content = turn.querySelector(".turn-content");
    content.innerHTML = renderMarkdownish(message.content);
    return turn;
  }
  function renderComposer() {
    const chipRow = root.querySelector("#chip-row");
    if (!chipRow) return;
    const eff = effective();
    const modelLabel = describeModel(eff.provider, eff.model);
    const agentCount = eff.agentIds.length;
    chipRow.innerHTML = `
    <button class="chip chip-model" id="chip-model" title="Pick model for this chat" ${state.catalog.models.length === 0 ? "disabled" : ""}>
      <span class="chip-icon">\u25CF</span>
      <span>${escapeHtml(modelLabel)}</span>
      <span class="chip-caret">\u25BE</span>
    </button>
    <button class="chip${eff.chatMode === "agent" ? " chip-on" : ""}" id="chip-mode" title="Toggle agent mode">
      ${eff.chatMode === "agent" ? "Agent" : "Normal"}
    </button>
    <button class="chip${eff.toolsEnabled ? " chip-on" : ""}" id="chip-tools" title="Toggle tools">
      \u2692 Tools
    </button>
    <button class="chip${eff.useRag ? " chip-on" : ""}" id="chip-rag" title="Toggle RAG (uses indexed documents)">
      \u2630 RAG
    </button>
    <button class="chip${agentCount > 0 ? " chip-on" : ""}" id="chip-agents" title="Attach agents from Chatllm" ${state.catalog.agents.length === 0 ? "disabled" : ""}>
      \u269B Agents${agentCount ? ` (${agentCount})` : ""}
    </button>
    <span class="composer-spacer"></span>
    <button class="chip chip-ghost" id="chip-settings" title="Open settings">\u2699</button>
    <button class="chip chip-ghost" id="chip-pipeline" title="Open pipeline">\u29C9</button>
  `;
    chipRow.querySelector("#chip-model")?.addEventListener("click", () => {
      state.modelPickerOpen = !state.modelPickerOpen;
      applyModelPicker();
    });
    chipRow.querySelector("#chip-mode")?.addEventListener("click", () => {
      setOverrides({ chatMode: eff.chatMode === "agent" ? "normal" : "agent" });
    });
    chipRow.querySelector("#chip-tools")?.addEventListener("click", () => {
      setOverrides({ toolsEnabled: !eff.toolsEnabled });
    });
    chipRow.querySelector("#chip-rag")?.addEventListener("click", () => {
      setOverrides({ useRag: !eff.useRag });
    });
    chipRow.querySelector("#chip-agents")?.addEventListener("click", () => {
      state.agentPickerOpen = !state.agentPickerOpen;
      applyAgentPicker();
    });
    chipRow.querySelector("#chip-settings")?.addEventListener("click", () => {
      state.settingsOpen = true;
      applySettings();
    });
    chipRow.querySelector("#chip-pipeline")?.addEventListener("click", () => {
      send({ type: "openPipeline" });
    });
    const sendBtn = root.querySelector("#send-btn");
    if (sendBtn) {
      sendBtn.classList.toggle("streaming", state.streaming);
      sendBtn.innerHTML = state.streaming ? `<span class="stop-dot"></span>` : `\u27A4`;
      sendBtn.title = state.streaming ? "Stop" : "Send";
    }
    renderComposerHints();
  }
  function renderComposerHints() {
    const hints = root.querySelector("#composer-hints");
    if (!hints) return;
    const draft = state.draft.trimStart();
    if (draft.startsWith("/")) {
      const matches = ["/spec", "/design", "/tasks"].filter((c) => c.startsWith(draft.split(/\s/)[0]));
      if (matches.length) {
        hints.innerHTML = matches.map((c) => `<button class="hint" data-cmd="${c}">${c}</button>`).join("");
        for (const b of hints.querySelectorAll(".hint")) {
          b.addEventListener("click", () => {
            const composer = root.querySelector("#composer");
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
  function renderModelPicker() {
    const el = root.querySelector("#model-picker");
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
        No models configured in Chatllm. Open the Chatllm app and add a model under Settings \u2192 Models.
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
    el.querySelector("#picker-close")?.addEventListener("click", () => {
      state.modelPickerOpen = false;
      applyModelPicker();
    });
    for (const li of el.querySelectorAll(".popover-row")) {
      li.addEventListener("click", () => {
        setOverrides({
          provider: li.dataset.provider,
          model: li.dataset.model
        });
        state.modelPickerOpen = false;
        applyModelPicker();
      });
    }
  }
  function renderAgentPicker() {
    const el = root.querySelector("#agent-picker");
    if (!el || !state.agentPickerOpen) return;
    const eff = effective();
    if (state.catalog.agents.length === 0) {
      el.innerHTML = `
      <header class="popover-header">
        <span>Agents</span>
        <button class="icon-btn" id="agent-close">\u2715</button>
      </header>
      <div class="popover-empty">No agents configured in Chatllm.</div>
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
    el.querySelector("#agent-close")?.addEventListener("click", () => {
      state.agentPickerOpen = false;
      applyAgentPicker();
    });
    for (const li of el.querySelectorAll(".popover-row")) {
      li.addEventListener("click", () => {
        const id = li.dataset.id;
        const current = new Set(eff.agentIds);
        if (current.has(id)) current.delete(id);
        else current.add(id);
        setOverrides({ agentIds: [...current] });
      });
    }
  }
  function renderSettings() {
    const grid = root.querySelector("#settings-form");
    if (!grid || !state.settings) return;
    const s = state.settings;
    const projectLine = state.project && state.project.source !== "none" ? `<div class="hint">Active project: <strong>${escapeHtml(state.project.name)}</strong> &mdash; ${escapeHtml(state.project.source === "git" ? state.project.remoteUrl ?? state.project.id : state.project.rootPath ?? "")}</div>` : "";
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
      <option value="manual" ${s.modelSelection === "manual" ? "selected" : ""}>manual</option>
      <option value="auto" ${s.modelSelection === "auto" ? "selected" : ""}>auto</option>
    </select>
    <label for="set-chatmode">Default chat mode</label>
    <select id="set-chatmode" data-key="chatMode">
      <option value="normal" ${s.chatMode === "normal" ? "selected" : ""}>normal</option>
      <option value="agent" ${s.chatMode === "agent" ? "selected" : ""}>agent</option>
    </select>
    <label for="set-rag">RAG by default</label>
    <div><input id="set-rag" data-key="useRag" type="checkbox" ${s.useRag ? "checked" : ""} /></div>
    <label for="set-tools">Tools by default</label>
    <div><input id="set-tools" data-key="toolsEnabled" type="checkbox" ${s.toolsEnabled ? "checked" : ""} /></div>
    <label for="set-system">Local system prompt</label>
    <textarea id="set-system" data-key="systemPrompt" placeholder="(empty)">${escapeHtml(s.systemPrompt)}</textarea>

    <h2>Integrations</h2>
    <label for="set-copilot">GitHub Copilot</label>
    <div>
      <input id="set-copilot" data-key="copilot.enabled" type="checkbox" ${s.copilotEnabled ? "checked" : ""} />
      <span class="hint inline">Re-enable the bundled Copilot extension and the native Chat view. Toggling prompts a window reload.</span>
    </div>

    <div class="hint">Models, agents, MCP servers, and skills are managed in the Chatllm app. Per-chat picks are stored on the conversation.</div>
  `;
    for (const input of grid.querySelectorAll("[data-key]")) {
      input.addEventListener("change", () => emitSettingChange(input));
    }
  }
  function emitSettingChange(input) {
    const key = input.dataset.key;
    let value;
    if (input instanceof HTMLInputElement && input.type === "checkbox") value = input.checked;
    else value = input.value;
    send({ type: "updateSetting", key, value });
  }
  function groupModels(models) {
    const map = /* @__PURE__ */ new Map();
    for (const m of models) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    return Array.from(map.entries()).map(([provider, group]) => ({
      provider,
      label: PROVIDER_LABELS[provider] ?? provider,
      models: [...group].sort((a, b) => a.displayName.localeCompare(b.displayName))
    })).sort((a, b) => a.label.localeCompare(b.label));
  }
  function describeModel(provider, modelId) {
    if (!provider || !modelId) return state.catalog.models.length === 0 ? "No models configured" : "Pick a model";
    for (const m of state.catalog.models) {
      if (m.provider === provider && m.modelId === modelId) return m.displayName;
    }
    return `${PROVIDER_LABELS[provider] ?? provider} \xB7 ${modelId}`;
  }
  function relativeTime(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 6e4);
    if (m < 1) return "now";
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    return `${d}d`;
  }
  function escapeHtml(value) {
    if (value == null) return "";
    return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
  }
  function escapeAttr(value) {
    return escapeHtml(value);
  }
  function renderMarkdownish(text) {
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
    const paragraphs = italic.split(/\n{2,}/).map((p) => {
      if (p.startsWith("<pre")) return p;
      const lines = p.split("\n").map((line) => line);
      return `<p>${lines.join("<br />")}</p>`;
    }).join("");
    return paragraphs;
  }
  function appendChunkInDom(messageId, chunk) {
    const turn = root.querySelector(`.turn[data-message-id="${cssAttr(messageId)}"] .turn-content`);
    if (!turn) return;
    if (turn.querySelector(".placeholder")) turn.innerHTML = "";
    turn.appendChild(document.createTextNode(chunk));
    const transcript = root.querySelector("#transcript");
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }
  function rerenderMessageInDom(messageId) {
    const session = state.activeSession;
    if (!session) return;
    const message = session.messages.find((m) => m.id === messageId);
    if (!message) return;
    const turn = root.querySelector(`.turn[data-message-id="${cssAttr(messageId)}"]`);
    if (!turn) return;
    turn.replaceWith(renderMessage(message));
  }
  function cssAttr(id) {
    return id.replace(/"/g, '\\"');
  }
  function handleMessage(msg) {
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
        renderBackendBanner();
        if (state.modelPickerOpen) renderModelPicker();
        if (state.agentPickerOpen) renderAgentPicker();
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
          if (m) m.status = "complete";
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
  window.addEventListener("message", (event) => handleMessage(event.data));
  send({ type: "ready" });
})();
//# sourceMappingURL=chat.js.map
