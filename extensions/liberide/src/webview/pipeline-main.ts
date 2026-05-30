import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import dagre from "cytoscape-dagre";
import type { LiberideSettings } from "../settings";
import type {
  FeatureSummary,
  GraphDoneEvent,
  GraphNodeUpdate,
  GraphStartEvent,
  PipelineHostToWebview,
  PipelineWebviewToHost,
  TaskSummary,
} from "../panel/protocol";

cytoscape.use(dagre);

interface VsCodeApi {
  postMessage(message: PipelineWebviewToHost): void;
  setState(state: unknown): void;
  getState<T = unknown>(): T | undefined;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

interface RunState {
  graphId: string;
  label: string;
  featureId: string;
  status: string;
  nodes: Map<string, { label: string; status: string; dependsOn: string[] }>;
}

interface AppState {
  settings: LiberideSettings | null;
  features: FeatureSummary[];
  activeFeatureId: string | null;
  activeTasks: TaskSummary[];
  runs: Map<string, RunState>;
  busyAction: "scaffold" | "dispatch" | "cancel" | null;
}

const state: AppState = {
  settings: null,
  features: [],
  activeFeatureId: null,
  activeTasks: [],
  runs: new Map(),
  busyAction: null,
};

const root = document.getElementById("root") as HTMLDivElement;

let cy: Core | null = null;
let activeRunId: string | null = null;
let graphContainerEl: HTMLDivElement | null = null;

function send(message: PipelineWebviewToHost): void {
  vscode.postMessage(message);
}

function render(): void {
  if (!root.firstChild) {
    root.innerHTML = `
      <main class="liberide-main">
        <section class="liberide-tab active">${pipelineHtml()}</section>
      </main>
    `;
    bindPipeline();
  }
  renderFeatures();
  renderTasks();
  renderRuns();
}

function pipelineHtml(): string {
  return `
    <div class="pipeline-shell">
      <header class="pipeline-header">
        <div>
          <div class="pipeline-title">Pipeline</div>
          <div class="pipeline-subtitle">Features, tasks, and live runs</div>
        </div>
        <button class="icon-btn" id="chat-open" title="Open LiberIDE chat" aria-label="Open LiberIDE chat">\u270E</button>
      </header>
      <div class="notice-stack" id="pipeline-notices"></div>
      <div class="pipeline-stack">
        <section class="pipeline-section">
          <h3>Features</h3>
          <div id="feature-list"></div>
        </section>
        <section class="pipeline-section">
          <h3>Create</h3>
          <div class="scaffold-row">
            <input id="scaffold-name" type="text" placeholder="new-feature" />
            <button id="scaffold-btn" title="Scaffold feature" aria-label="Scaffold feature">+</button>
          </div>
        </section>
        <section class="pipeline-section">
          <div class="pipeline-section-header">
            <h3>Tasks</h3>
            <button class="primary" id="dispatch-btn">Dispatch</button>
          </div>
          <div id="task-list"></div>
        </section>
        <section class="pipeline-section pipeline-graph-section">
          <h3>Graph</h3>
          <div class="graph-area" id="graph-area"><div class="graph-empty">Generate task contracts via the LiberIDE chat (use <strong>/tasks</strong>), then dispatch to see the live execution graph.</div></div>
        </section>
        <section class="pipeline-section">
          <h3>Runs</h3>
          <div class="runs-list" id="runs-list"></div>
        </section>
      </div>
    </div>
  `;
}

function bindPipeline(): void {
  graphContainerEl = root.querySelector<HTMLDivElement>("#graph-area");
  root.querySelector<HTMLButtonElement>("#chat-open")?.addEventListener("click", () => {
    send({ type: "openChat" });
  });
  const scaffoldBtn = root.querySelector<HTMLButtonElement>("#scaffold-btn")!;
  const scaffoldInput = root.querySelector<HTMLInputElement>("#scaffold-name")!;
  scaffoldBtn.addEventListener("click", () => {
    const name = scaffoldInput.value.trim();
    if (!name) return;
    send({ type: "scaffoldFeature", name });
  });
  scaffoldInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") scaffoldBtn.click();
  });
  root.querySelector<HTMLButtonElement>("#dispatch-btn")!.addEventListener("click", () => {
    if (!state.activeFeatureId) return;
    send({ type: "dispatchFeature", featureId: state.activeFeatureId });
  });
}

function renderFeatures(): void {
  const list = root.querySelector<HTMLDivElement>("#feature-list");
  if (!list) return;
  list.innerHTML = "";
  if (state.features.length === 0) {
    list.innerHTML = `<div class="meta empty-row">No features yet. Scaffold one below.</div>`;
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

function renderTasks(): void {
  const list = root.querySelector<HTMLDivElement>("#task-list");
  if (!list) return;
  list.innerHTML = "";
  const dispatch = root.querySelector<HTMLButtonElement>("#dispatch-btn");
  if (dispatch) {
    dispatch.disabled = state.busyAction !== null || !state.activeFeatureId;
    dispatch.textContent = state.busyAction === "dispatch" ? "Dispatching..." : "Dispatch";
  }
  if (!state.activeFeatureId) {
    list.innerHTML = `<div class="meta empty-row">Select a feature to see tasks.</div>`;
    return;
  }
  if (state.activeTasks.length === 0) {
    list.innerHTML = `<div class="meta empty-row">No tasks for the active feature.</div>`;
    return;
  }
  for (const task of state.activeTasks) {
    const row = document.createElement("div");
    row.className = "task-row";
    row.innerHTML = `
      <button class="task-main" title="Open task contract">
        <span class="task-title">${escapeHtml(task.id)} \u00B7 ${escapeHtml(task.title)}</span>
        <span class="meta">${escapeHtml(task.agent)} \u00B7 ${escapeHtml(task.status)}</span>
      </button>
      <button class="icon-btn task-dispatch" title="Dispatch task" aria-label="Dispatch task">\u25B6</button>
    `;
    row.querySelector<HTMLButtonElement>(".task-main")?.addEventListener("click", () => {
      if (!state.activeFeatureId) return;
      send({ type: "openTask", featureId: state.activeFeatureId, taskId: task.id });
    });
    row.querySelector<HTMLButtonElement>(".task-dispatch")?.addEventListener("click", () => {
      if (!state.activeFeatureId) return;
      send({ type: "dispatchFeature", featureId: state.activeFeatureId, taskIds: [task.id] });
    });
    list.appendChild(row);
  }
}

function renderRuns(): void {
  const container = root.querySelector<HTMLDivElement>("#runs-list");
  if (!container) return;
  container.innerHTML = "";
  if (state.runs.size === 0) {
    container.innerHTML = `<div class="meta empty-row">No runs yet.</div>`;
    return;
  }
  for (const run of state.runs.values()) {
    const wrapper = document.createElement("div");
    wrapper.className = "run-item";
    wrapper.innerHTML = `
      <header>
        <div><strong>${escapeHtml(run.label)}</strong><div class="meta">graph ${escapeHtml(run.graphId)}</div></div>
        <div class="run-actions"><span class="pill">${escapeHtml(run.status)}</span>
        ${run.status === "running" ? `<button class="icon-btn run-cancel" title="Cancel run" aria-label="Cancel run">&times;</button>` : ""}</div>
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
    wrapper.querySelector<HTMLButtonElement>(".run-cancel")?.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!window.confirm(`Cancel ${run.label}?`)) return;
      send({ type: "cancelGraph", graphId: run.graphId });
    });
    container.appendChild(wrapper);
  }
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

function showNotice(message: string, severity: "info" | "warning" | "error" = "warning"): void {
  const stack = root.querySelector<HTMLDivElement>("#pipeline-notices");
  if (!stack) return;
  const notice = document.createElement("div");
  notice.className = `inline-notice ${severity}`;
  notice.innerHTML = `<span>${escapeHtml(message)}</span><button class="icon-btn" title="Dismiss" aria-label="Dismiss">&times;</button>`;
  notice.querySelector("button")?.addEventListener("click", () => notice.remove());
  stack.appendChild(notice);
}

function renderBusyState(): void {
  const scaffold = root.querySelector<HTMLButtonElement>("#scaffold-btn");
  const scaffoldInput = root.querySelector<HTMLInputElement>("#scaffold-name");
  if (scaffold) scaffold.disabled = state.busyAction !== null;
  if (scaffoldInput) scaffoldInput.disabled = state.busyAction !== null;
  renderTasks();
}

function handleMessage(msg: PipelineHostToWebview): void {
  switch (msg.type) {
    case "init":
      state.settings = msg.settings;
      state.features = msg.features;
      state.activeFeatureId = msg.features.find((feature) => feature.active)?.id ?? null;
      render();
      break;
    case "settings":
      state.settings = msg.settings;
      break;
    case "features":
      state.features = msg.features;
      state.activeFeatureId = msg.activeFeature?.id ?? null;
      state.activeTasks = msg.activeFeature?.tasks ?? [];
      renderFeatures();
      renderTasks();
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
    case "operation":
      state.busyAction = msg.status === "running" ? msg.action : null;
      if (msg.status === "success" && msg.action === "scaffold") {
        const input = root.querySelector<HTMLInputElement>("#scaffold-name");
        if (input) input.value = "";
      }
      if (msg.message) showNotice(msg.message, msg.status === "error" ? "error" : "info");
      renderBusyState();
      break;
    case "log":
      console.warn("[liberide.pipeline]", msg.message);
      showNotice(msg.message, msg.severity);
      break;
  }
}

window.addEventListener("message", (event) => handleMessage(event.data as PipelineHostToWebview));
send({ type: "ready" });
