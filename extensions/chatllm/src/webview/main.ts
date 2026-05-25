import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import dagre from "cytoscape-dagre";
import type { ChatllmSettings } from "../settings";
import type {
  FeatureSummary,
  GraphDoneEvent,
  GraphNodeUpdate,
  GraphStartEvent,
  HostToWebview,
  Tab,
  TaskSummary,
  WebviewToHost,
} from "../panel/protocol";

cytoscape.use(dagre);

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  setState(state: unknown): void;
  getState<T = unknown>(): T | undefined;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

interface AppState {
  settings: ChatllmSettings | null;
  features: FeatureSummary[];
  activeFeatureId: string | null;
  activeTasks: TaskSummary[];
  tab: Tab;
  runs: Map<string, RunState>;
  streaming: boolean;
  partial: string;
}

interface RunState {
  graphId: string;
  label: string;
  featureId: string;
  status: string;
  nodes: Map<string, { label: string; status: string; dependsOn: string[] }>;
}

const state: AppState = {
  settings: null,
  features: [],
  activeFeatureId: null,
  activeTasks: [],
  tab: "chat",
  runs: new Map(),
  streaming: false,
  partial: "",
};

const root = document.getElementById("root") as HTMLDivElement;

let cy: Core | null = null;
let activeRunId: string | null = null;
let transcriptEl: HTMLDivElement | null = null;
let currentAssistantBubble: HTMLDivElement | null = null;
let graphContainerEl: HTMLDivElement | null = null;

function send(message: WebviewToHost): void {
  vscode.postMessage(message);
}

function render(): void {
  if (!root.firstChild) {
    root.innerHTML = `
      <header class="chatllm-header">
        <div class="brand"><span class="dot"></span><span>Chatllm</span></div>
        <span class="spacer"></span>
        <span class="status" id="chatllm-status">Initializing\u2026</span>
      </header>
      <nav class="chatllm-tabs">
        <button data-tab="chat">Chat</button>
        <button data-tab="pipeline">Pipeline</button>
        <button data-tab="settings">Settings</button>
      </nav>
      <main class="chatllm-main">
        <section class="chatllm-tab" data-tab="chat">${chatTabHtml()}</section>
        <section class="chatllm-tab" data-tab="pipeline">${pipelineTabHtml()}</section>
        <section class="chatllm-tab" data-tab="settings"><div class="settings-grid" id="settings-form"></div></section>
      </main>
    `;
    bindGlobal();
    bindChat();
    bindPipeline();
    bindSettings();
  }
  applyTab();
  renderFeatures();
  renderRuns();
  renderSettings();
  renderStatus();
}

function chatTabHtml(): string {
  return `
    <div class="chat-transcript" id="chat-transcript"></div>
    <div class="chat-composer">
      <textarea id="chat-input" placeholder="Ask Chatllm anything\u2026 (Shift+Enter for newline)"></textarea>
      <div class="composer-aside">
        <select id="chat-command" title="Workflow command">
          <option value="">Default chat</option>
          <option value="spec">/spec  draft requirements</option>
          <option value="design">/design  draft design.md</option>
          <option value="tasks">/tasks  generate task contracts</option>
        </select>
        <button class="send" id="chat-send">Send</button>
      </div>
    </div>
  `;
}

function pipelineTabHtml(): string {
  return `
    <div class="pipeline-shell">
      <aside class="pipeline-side">
        <h3>Features</h3>
        <div id="feature-list"></div>
        <h3>Create</h3>
        <div style="display:flex; gap:6px; padding: 4px;">
          <input id="scaffold-name" type="text" placeholder="new-feature" style="flex:1; padding:4px 6px; border:1px solid var(--chatllm-border); border-radius:6px; background:var(--vscode-input-background); color:var(--vscode-input-foreground);" />
          <button id="scaffold-btn">+</button>
        </div>
      </aside>
      <div class="pipeline-main">
        <div class="pipeline-actions">
          <button data-cmd="spec">/spec</button>
          <button data-cmd="design">/design</button>
          <button data-cmd="tasks">/tasks</button>
          <button class="primary" id="dispatch-btn">Dispatch tasks</button>
        </div>
        <div class="graph-area" id="graph-area"><div class="graph-empty">Run /tasks then dispatch to see the live execution graph.</div></div>
        <div class="runs-list" id="runs-list"></div>
      </div>
    </div>
  `;
}

function bindGlobal(): void {
  for (const btn of root.querySelectorAll<HTMLButtonElement>("nav.chatllm-tabs button")) {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab as Tab;
      state.tab = tab;
      send({ type: "switchTab", tab });
      applyTab();
    });
  }
}

function applyTab(): void {
  for (const btn of root.querySelectorAll<HTMLButtonElement>("nav.chatllm-tabs button")) {
    btn.classList.toggle("active", btn.dataset.tab === state.tab);
  }
  for (const tab of root.querySelectorAll<HTMLElement>("section.chatllm-tab")) {
    tab.classList.toggle("active", tab.dataset.tab === state.tab);
  }
  if (state.tab === "pipeline") setTimeout(() => cy?.resize(), 0);
}

function bindChat(): void {
  transcriptEl = root.querySelector<HTMLDivElement>("#chat-transcript");
  const input = root.querySelector<HTMLTextAreaElement>("#chat-input")!;
  const sendBtn = root.querySelector<HTMLButtonElement>("#chat-send")!;
  const cmd = root.querySelector<HTMLSelectElement>("#chat-command")!;
  const submit = () => {
    const content = input.value.trim();
    if (!content) return;
    appendMessage("user", content);
    send({ type: "sendChat", content, command: (cmd.value || undefined) as "spec" | "design" | "tasks" | undefined });
    input.value = "";
    state.streaming = true;
    currentAssistantBubble = appendMessage("assistant", "", true);
    sendBtn.disabled = true;
    renderStatus();
  };
  sendBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });
}

function bindPipeline(): void {
  graphContainerEl = root.querySelector<HTMLDivElement>("#graph-area");
  const scaffoldBtn = root.querySelector<HTMLButtonElement>("#scaffold-btn")!;
  const scaffoldInput = root.querySelector<HTMLInputElement>("#scaffold-name")!;
  scaffoldBtn.addEventListener("click", () => {
    const name = scaffoldInput.value.trim();
    if (!name) return;
    send({ type: "scaffoldFeature", name });
    scaffoldInput.value = "";
  });
  for (const button of root.querySelectorAll<HTMLButtonElement>(".pipeline-actions button[data-cmd]")) {
    button.addEventListener("click", () => {
      const command = button.dataset.cmd as "spec" | "design" | "tasks";
      state.tab = "chat";
      applyTab();
      const cmdSelect = root.querySelector<HTMLSelectElement>("#chat-command");
      const input = root.querySelector<HTMLTextAreaElement>("#chat-input");
      if (cmdSelect) cmdSelect.value = command;
      if (input) input.focus();
    });
  }
  root.querySelector<HTMLButtonElement>("#dispatch-btn")!.addEventListener("click", () => {
    if (!state.activeFeatureId) return;
    send({ type: "dispatchFeature", featureId: state.activeFeatureId });
  });
}

function bindSettings(): void {
  renderSettings();
}

function renderFeatures(): void {
  const list = root.querySelector<HTMLDivElement>("#feature-list");
  if (!list) return;
  list.innerHTML = "";
  if (state.features.length === 0) {
    list.innerHTML = `<div class="meta" style="padding:8px;">No features yet. Scaffold one below.</div>`;
    return;
  }
  for (const feature of state.features) {
    const row = document.createElement("div");
    row.className = "feature-row" + (feature.active ? " active" : "");
    row.innerHTML = `<div><strong>${escapeHtml(feature.name)}</strong></div>
      <div class="meta">${feature.status} \u00b7 ${feature.requirementCount} req \u00b7 ${feature.designCount} design \u00b7 ${feature.taskCount} tasks</div>`;
    row.addEventListener("click", () => send({ type: "setActiveFeature", featureId: feature.id }));
    list.appendChild(row);
  }
}

function renderRuns(): void {
  const container = root.querySelector<HTMLDivElement>("#runs-list");
  if (!container) return;
  container.innerHTML = "";
  if (state.runs.size === 0) {
    container.innerHTML = `<div class="meta" style="padding:8px;">No runs yet.</div>`;
    return;
  }
  for (const run of state.runs.values()) {
    const wrapper = document.createElement("div");
    wrapper.className = "run-item";
    wrapper.innerHTML = `
      <header>
        <div><strong>${escapeHtml(run.label)}</strong><div class="meta">graph ${escapeHtml(run.graphId)}</div></div>
        <span class="pill">${escapeHtml(run.status)}</span>
      </header>
      <div class="nodes"></div>
    `;
    const nodesEl = wrapper.querySelector<HTMLDivElement>(".nodes")!;
    for (const [id, node] of run.nodes) {
      const chip = document.createElement("span");
      chip.className = "node-chip";
      chip.dataset.status = node.status;
      chip.textContent = `${id} \u00b7 ${node.status}`;
      nodesEl.appendChild(chip);
    }
    wrapper.addEventListener("click", () => focusGraph(run.graphId));
    container.appendChild(wrapper);
  }
}

function renderSettings(): void {
  const grid = root.querySelector<HTMLDivElement>("#settings-form");
  if (!grid || !state.settings) return;
  const s = state.settings;
  grid.innerHTML = `
    <h2>Model</h2>
    <label for="set-provider">Provider</label>
    <select id="set-provider" data-key="provider">
      ${["openai","openrouter","google","ollama","llamacpp","lmstudio","custom"].map((p) => `<option value="${p}" ${p===s.provider?"selected":""}>${p}</option>`).join("")}
    </select>
    <label for="set-model">Model</label>
    <input id="set-model" data-key="model" type="text" value="${escapeAttr(s.model)}" />
    <label for="set-mode">Model selection</label>
    <select id="set-mode" data-key="modelSelection">
      <option value="manual" ${s.modelSelection==="manual"?"selected":""}>manual</option>
      <option value="auto" ${s.modelSelection==="auto"?"selected":""}>auto</option>
    </select>
    <label for="set-chatmode">Chat mode</label>
    <select id="set-chatmode" data-key="chatMode">
      <option value="normal" ${s.chatMode==="normal"?"selected":""}>normal</option>
      <option value="agent" ${s.chatMode==="agent"?"selected":""}>agent</option>
    </select>

    <h2>Behavior</h2>
    <label for="set-rag">RAG</label>
    <div><input id="set-rag" data-key="useRag" type="checkbox" ${s.useRag?"checked":""} /></div>
    <label for="set-tools">Tools enabled</label>
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
    <div class="hint">Settings persist in your VS Code user configuration (chatllm.*) and are scoped to this extension.</div>
  `;
  for (const input of grid.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-key]")) {
    const event = input instanceof HTMLInputElement && input.type === "checkbox" ? "change" : "change";
    input.addEventListener(event, () => emitSettingChange(input));
  }
}

function emitSettingChange(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): void {
  const key = input.dataset.key as keyof ChatllmSettings;
  let value: unknown;
  if (input instanceof HTMLInputElement && input.type === "checkbox") value = input.checked;
  else if (input instanceof HTMLInputElement && input.type === "number") value = Number(input.value);
  else if (input.dataset.list) value = input.value.split(",").map((v) => v.trim()).filter(Boolean);
  else value = input.value;
  send({ type: "updateSetting", key, value });
}

function renderStatus(): void {
  const status = root.querySelector<HTMLSpanElement>("#chatllm-status");
  if (!status) return;
  if (!state.settings) status.textContent = "Initializing\u2026";
  else if (state.streaming) status.textContent = `Streaming via ${state.settings.provider}/${state.settings.model}\u2026`;
  else status.textContent = `${state.settings.provider}/${state.settings.model} \u00b7 ${state.settings.chatMode} mode`;
}

function appendMessage(role: "user" | "assistant" | "tool" | "error", content: string, streaming = false): HTMLDivElement {
  if (!transcriptEl) return document.createElement("div");
  const bubble = document.createElement("div");
  bubble.className = `chat-message ${role}`;
  if (role === "assistant") {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "Chatllm";
    bubble.appendChild(badge);
    const body = document.createElement("span");
    body.className = "body";
    body.textContent = content;
    bubble.appendChild(body);
    if (streaming) bubble.dataset.streaming = "1";
  } else {
    bubble.textContent = content;
  }
  transcriptEl.appendChild(bubble);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return bubble;
}

function appendAssistantToken(token: string): void {
  if (!currentAssistantBubble) currentAssistantBubble = appendMessage("assistant", "", true);
  const body = currentAssistantBubble.querySelector<HTMLSpanElement>(".body");
  if (body) body.textContent = (body.textContent ?? "") + token;
  if (transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function finalizeAssistantBubble(): void {
  state.streaming = false;
  currentAssistantBubble = null;
  const sendBtn = root.querySelector<HTMLButtonElement>("#chat-send");
  if (sendBtn) sendBtn.disabled = false;
  renderStatus();
}

function ensureCytoscape(): Core | null {
  if (!graphContainerEl) return null;
  if (cy) return cy;
  graphContainerEl.innerHTML = "";
  cy = cytoscape({
    container: graphContainerEl,
    style: [
      {
        selector: "node",
        style: {
          "background-color": "#5b5b5b",
          label: "data(label)",
          color: "#fff",
          "font-size": 10,
          "text-valign": "center",
          "text-halign": "center",
          "text-wrap": "wrap",
          "text-max-width": "120px",
          width: "label",
          height: "label",
          padding: "8px",
          shape: "round-rectangle",
        },
      },
      { selector: 'node[status = "queued"]', style: { "background-color": "#6c6c6c" } },
      { selector: 'node[status = "running"]', style: { "background-color": "#0a84ff" } },
      { selector: 'node[status = "completed"]', style: { "background-color": "#28a86b" } },
      { selector: 'node[status = "failed"]', style: { "background-color": "#d9534f" } },
      { selector: 'node[status = "blocked"]', style: { "background-color": "#c9a000" } },
      {
        selector: "edge",
        style: {
          width: 1.5,
          "line-color": "rgba(150,150,150,0.6)",
          "target-arrow-color": "rgba(150,150,150,0.6)",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
        },
      },
    ],
    elements: [],
    wheelSensitivity: 0.3,
  });
  return cy;
}

function renderGraph(run: RunState): void {
  const c = ensureCytoscape();
  if (!c) return;
  const elements: ElementDefinition[] = [];
  for (const [id, node] of run.nodes) {
    elements.push({ data: { id, label: node.label, status: node.status } });
    for (const dep of node.dependsOn) {
      elements.push({ data: { id: `${dep}->${id}`, source: dep, target: id } });
    }
  }
  c.elements().remove();
  c.add(elements);
  c.layout({ name: "dagre", rankDir: "TB", nodeSep: 30, rankSep: 50 } as cytoscape.LayoutOptions).run();
  c.resize();
  c.fit(undefined, 24);
}

function updateGraphNode(graphId: string, nodeId: string, status: string): void {
  if (activeRunId !== graphId) return;
  cy?.$(`#${cssEscape(nodeId)}`).data("status", status);
}

function focusGraph(graphId: string): void {
  const run = state.runs.get(graphId);
  if (!run) return;
  activeRunId = graphId;
  renderGraph(run);
}

function cssEscape(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}
function escapeAttr(value: string): string { return escapeHtml(value); }

function handleMessage(msg: HostToWebview): void {
  switch (msg.type) {
    case "init":
      state.settings = msg.settings;
      state.features = msg.features;
      state.tab = msg.activeTab;
      render();
      break;
    case "settings":
      state.settings = msg.settings;
      renderSettings();
      renderStatus();
      break;
    case "tab":
      state.tab = msg.tab;
      applyTab();
      break;
    case "features":
      state.features = msg.features;
      state.activeFeatureId = msg.activeFeature?.id ?? null;
      state.activeTasks = msg.activeFeature?.tasks ?? [];
      renderFeatures();
      break;
    case "chatToken":
      appendAssistantToken(msg.token);
      break;
    case "chatToolEvent":
      appendMessage("tool", `\u25CB ${msg.name}(${JSON.stringify(msg.arguments)})`);
      break;
    case "chatDone":
      finalizeAssistantBubble();
      break;
    case "chatError":
      appendMessage("error", msg.error);
      finalizeAssistantBubble();
      break;
    case "graphStart": {
      const ev = msg.payload as GraphStartEvent;
      const run: RunState = {
        graphId: ev.graphId,
        featureId: ev.featureId,
        label: ev.label,
        status: "running",
        nodes: new Map(ev.nodes.map((n) => [n.id, { label: n.label, status: "queued", dependsOn: n.dependsOn }])),
      };
      state.runs.set(ev.graphId, run);
      activeRunId = ev.graphId;
      renderRuns();
      renderGraph(run);
      break;
    }
    case "graphNode": {
      const ev = msg.payload as GraphNodeUpdate;
      const run = state.runs.get(ev.graphId);
      if (run) {
        const node = run.nodes.get(ev.nodeId);
        if (node) node.status = ev.status;
      }
      updateGraphNode(ev.graphId, ev.nodeId, ev.status);
      renderRuns();
      break;
    }
    case "graphDone": {
      const ev = msg.payload as GraphDoneEvent;
      const run = state.runs.get(ev.graphId);
      if (run) run.status = ev.status;
      renderRuns();
      break;
    }
    case "log":
      appendMessage("error", msg.message);
      break;
  }
}

window.addEventListener("message", (event) => handleMessage(event.data as HostToWebview));
send({ type: "ready" });
