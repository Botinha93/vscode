"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode10 = __toESM(require("vscode"));

// src/api.ts
function getApiOrigin() {
  return (process.env.CHATLLM_API_ORIGIN || "").replace(/\/$/, "");
}
function getAuthToken() {
  return process.env.CHATLLM_AUTH_TOKEN || "";
}
function authHeaders(extra) {
  const headers = { "Content-Type": "application/json", ...extra ?? {} };
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
async function apiFetch(path, init) {
  const origin = getApiOrigin();
  if (!origin) throw new Error("CHATLLM_API_ORIGIN is not set.");
  return fetch(path.startsWith("http") ? path : `${origin}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...init?.headers }
  });
}

// src/spec/dag.ts
function validateDag(tasks) {
  const ids = new Set(tasks.map((task) => task.id));
  const indegree = new Map(tasks.map((task) => [task.id, 0]));
  const adjacency = new Map(tasks.map((task) => [task.id, []]));
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) return { ok: false, order: [], error: `Task ${task.id} depends on unknown task ${dep}` };
      if (dep === task.id) return { ok: false, order: [], error: `Task ${task.id} cannot depend on itself` };
      adjacency.get(dep)?.push(task.id);
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
    }
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  return order.length === tasks.length ? { ok: true, order } : { ok: false, order: [], error: "Task dependencies contain a cycle" };
}
function computeTaskReadiness(tasks) {
  const status = new Map(tasks.map((task) => [task.id, task.status]));
  return new Map(tasks.map((task) => {
    const blockedBy = task.dependsOn.filter((dep) => status.get(dep) !== "completed");
    return [task.id, { ready: blockedBy.length === 0 && task.status !== "completed", blockedBy }];
  }));
}
function effectiveStatus(task, readiness) {
  if (["running", "completed", "failed"].includes(task.status)) return task.status;
  const info = readiness.get(task.id);
  if (info?.blockedBy.length) return "blocked";
  return info?.ready ? "ready" : task.status;
}
function groupTasksByStatus(tasks) {
  const readiness = computeTaskReadiness(tasks);
  const groups = { pending: [], ready: [], running: [], completed: [], blocked: [], failed: [] };
  for (const task of tasks) groups[effectiveStatus(task, readiness)].push(task);
  return groups;
}

// src/dispatch/client.ts
function taskInput(feature, task) {
  return [
    `# Task ${task.id}: ${task.title}`,
    `Feature: ${feature.name}`,
    `Requirements: ${task.requirementRefs.join(", ") || "(none)"}`,
    `Design: ${task.designRefs.join(", ") || "(none)"}`,
    "",
    "## Architecture hints",
    task.architectureHints || "(none)",
    "",
    "## Instructions",
    task.body
  ].join("\n").slice(0, 2e3);
}
async function dispatchFeature(feature, options = {}) {
  const tasks = options.taskIds?.length ? feature.tasks.filter((task) => options.taskIds.includes(task.id)) : feature.tasks;
  const validation = validateDag(tasks);
  if (!validation.ok) throw new Error(validation.error);
  const response = await apiFetch("/api/specs/dispatch", {
    method: "POST",
    body: JSON.stringify({
      feature: feature.id,
      goal: `Spec dispatch: ${feature.name}`,
      conversationId: options.conversationId,
      priority: "FOREGROUND",
      nodes: tasks.map((task) => ({
        id: task.id,
        type: "IMPLEMENT",
        title: task.title,
        inputSummary: taskInput(feature, task),
        dependsOn: task.dependsOn,
        metadata: { taskId: task.id, produces_context: task.producesContext, requirement_refs: task.requirementRefs, design_refs: task.designRefs },
        agent: task.agent,
        expectedFiles: task.expectedFiles,
        acceptance: task.acceptance,
        requirementRefs: task.requirementRefs,
        designRefs: task.designRefs,
        producesContext: task.producesContext
      }))
    })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error ?? response.statusText);
  }
  return response.json();
}
function subscribeExecutionGraphEvents(graphId, onEvent) {
  const origin = getApiOrigin();
  if (!origin) return () => {
  };
  const controller = new AbortController();
  void (async () => {
    const response = await fetch(`${origin}/api/execution-graphs/${graphId}/events/stream`, {
      headers: getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {},
      signal: controller.signal
    });
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const type = part.match(/^event: (.+)$/m)?.[1];
        const data = part.match(/^data: (.+)$/m)?.[1];
        if (type && data) onEvent({ type, ...JSON.parse(data) });
      }
      if (done) break;
    }
  })().catch(() => {
  });
  return () => controller.abort();
}
async function cancelExecutionGraph(graphId) {
  await apiFetch(`/api/execution-graphs/${graphId}/cancel`, { method: "POST" });
}

// src/panel/panel.ts
var vscode3 = __toESM(require("vscode"));

// src/settings.ts
var vscode = __toESM(require("vscode"));
var SECTION = "chatllm";
function readSettings() {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    provider: cfg.get("provider") ?? "openai",
    model: cfg.get("model") ?? "gpt-4o-mini",
    modelSelection: cfg.get("modelSelection") ?? "manual",
    chatMode: cfg.get("chatMode") ?? "normal",
    useRag: cfg.get("useRag") ?? false,
    toolsEnabled: cfg.get("toolsEnabled") ?? true,
    maxAgentSpawns: cfg.get("maxAgentSpawns") ?? 3,
    agentIds: cfg.get("agentIds") ?? [],
    mcpServerIds: cfg.get("mcpServerIds") ?? [],
    skillIds: cfg.get("skillIds") ?? [],
    documentIds: cfg.get("documentIds") ?? [],
    systemPrompt: cfg.get("systemPrompt") ?? "",
    copilotEnabled: cfg.get("copilot.enabled") ?? false
  };
}
var FLAT_TO_DOTTED = {
  copilotEnabled: "copilot.enabled"
};
async function writeSetting(key, value) {
  const dotted = FLAT_TO_DOTTED[key] ?? key;
  await vscode.workspace.getConfiguration(SECTION).update(dotted, value, vscode.ConfigurationTarget.Global);
}
function onSettingsChange(listener) {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(SECTION)) listener(readSettings());
  });
}

// src/spec/writer.ts
var vscode2 = __toESM(require("vscode"));

// src/spec/schema.ts
var TASK_STATUSES = /* @__PURE__ */ new Set(["pending", "ready", "running", "completed", "blocked", "failed"]);
var FEATURE_STATUSES = /* @__PURE__ */ new Set(["draft", "design", "tasks", "dispatching", "done"]);
function asStringArray(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}
function parseInlineArray(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  return trimmed.slice(1, -1).split(",").map((v) => v.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };
  const data = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(":");
    if (colon < 0 || line.startsWith(" ")) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    if (rawValue === "|") {
      const block = [];
      while (lines[i + 1]?.startsWith("  ")) block.push(lines[++i].slice(2));
      data[key] = block.join("\n");
    } else if (rawValue.startsWith("[")) {
      data[key] = parseInlineArray(rawValue);
    } else {
      data[key] = rawValue;
    }
  }
  return { data, body: match[2] };
}
function parseTaskContract(featureId, filePath, raw) {
  const { data, body } = parseFrontmatter(raw);
  const id = String(data.id ?? "").trim();
  const title = String(data.title ?? "").trim();
  if (!id || !title) return void 0;
  const statusRaw = String(data.status ?? "pending").trim();
  return {
    id,
    title,
    status: TASK_STATUSES.has(statusRaw) ? statusRaw : "pending",
    requirementRefs: asStringArray(data.requirement_refs),
    designRefs: asStringArray(data.design_refs),
    dependsOn: asStringArray(data.depends_on),
    producesContext: [],
    expectedFiles: asStringArray(data.expected_files),
    architectureHints: String(data.architecture_hints ?? ""),
    acceptance: asStringArray(data.acceptance),
    agent: String(data.agent ?? "coding"),
    body: body.trim(),
    filePath,
    featureId
  };
}
function parseFeatureStatus(raw) {
  const status = raw.match(/status:\s*(\w+)/i)?.[1] ?? "draft";
  return FEATURE_STATUSES.has(status) ? status : "draft";
}
function extractSectionIds(markdown, prefix) {
  const ids = [];
  const re = new RegExp(`^##\\s+(${prefix}-[\\w.-]+)`, "gim");
  let match;
  while ((match = re.exec(markdown)) !== null) ids.push(match[1]);
  return ids;
}

// src/spec/writer.ts
async function readTextFile(uri) {
  return Buffer.from(await vscode2.workspace.fs.readFile(uri)).toString("utf8");
}
async function writeTextFile(uri, content) {
  await vscode2.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
}
async function updateTaskStatus(uri, status) {
  const raw = await readTextFile(uri);
  const { data, body } = parseFrontmatter(raw);
  data.status = status;
  const frontmatter = Object.entries(data).map(
    ([key, value]) => Array.isArray(value) ? `${key}: [${value.join(", ")}]` : `${key}: ${value}`
  );
  await writeTextFile(uri, `---
${frontmatter.join("\n")}
---
${body}`);
}
async function writeTaskContract(task) {
  const content = `---
id: ${task.id}
title: ${task.title}
status: ${task.status}
requirement_refs: [${task.requirementRefs.join(", ")}]
design_refs: [${task.designRefs.join(", ")}]
depends_on: [${task.dependsOn.join(", ")}]
expected_files: [${task.expectedFiles.join(", ")}]
architecture_hints: |
${task.architectureHints.split("\n").map((line) => `  ${line}`).join("\n")}
acceptance: [${task.acceptance.join(", ")}]
agent: ${task.agent}
---
${task.body}
`;
  await writeTextFile(task.filePath, content);
}
async function scaffoldFeature(folder, featureName) {
  const slug = featureName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "new-feature";
  const root = vscode2.Uri.joinPath(folder.uri, ".chatllm", "specs", slug);
  const tasks = vscode2.Uri.joinPath(root, "tasks");
  await vscode2.workspace.fs.createDirectory(tasks);
  await vscode2.workspace.fs.createDirectory(vscode2.Uri.joinPath(root, "runs"));
  await writeTextFile(vscode2.Uri.joinPath(root, "runs", ".gitignore"), "*\n!.gitignore\n");
  await writeTextFile(vscode2.Uri.joinPath(root, "feature.md"), `# ${featureName}

status: draft
`);
  await writeTextFile(vscode2.Uri.joinPath(root, "requirements.md"), "# Requirements\n\n## R-1 Overview\n\n");
  await writeTextFile(vscode2.Uri.joinPath(root, "design.md"), "# Design\n\n## D-1 Architecture\n\n");
  await writeTextFile(vscode2.Uri.joinPath(tasks, "index.md"), regenerateTasksIndex([]));
  return root;
}
function regenerateTasksIndex(tasks) {
  const header = "# Tasks\n\n| ID | Title | Status | Depends on | Requirements | Design |\n|----|-------|--------|------------|--------------|--------|\n";
  return header + tasks.map(
    (t) => `| ${t.id} | ${t.title} | ${t.status} | ${t.dependsOn.join(", ") || "-"} | ${t.requirementRefs.join(", ") || "-"} | ${t.designRefs.join(", ") || "-"} |`
  ).join("\n") + "\n";
}

// src/panel/panel.ts
var ChatllmPipelineController = class _ChatllmPipelineController {
  constructor(context, store2, output) {
    this.context = context;
    this.store = store2;
    this.output = output;
    this.disposables.push(
      onSettingsChange((settings) => this.broadcast({ type: "settings", settings })),
      this.store.onDidChange(() => this.broadcastFeatures())
    );
  }
  static viewType = "chatllm.pipeline";
  view;
  disposables = [];
  graphs = /* @__PURE__ */ new Map();
  resolveWebviewView(view) {
    this.view = view;
    this.bindWebview(view.webview);
    view.onDidDispose(() => {
      if (this.view === view) this.view = void 0;
    });
  }
  show() {
    void vscode3.commands.executeCommand(`${_ChatllmPipelineController.viewType}.focus`);
  }
  dispose() {
    for (const d of this.disposables) d.dispose();
    for (const g of this.graphs.values()) g.dispose();
    this.graphs.clear();
  }
  webviewOptions() {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode3.Uri.joinPath(this.context.extensionUri, "media"),
        vscode3.Uri.joinPath(this.context.extensionUri, "resources")
      ]
    };
  }
  bindWebview(webview) {
    webview.options = this.webviewOptions();
    webview.html = this.renderHtml(webview);
    const sub = webview.onDidReceiveMessage((message) => {
      void this.handleMessage(webview, message);
    });
    this.disposables.push(sub);
  }
  broadcast(message) {
    this.view?.webview.postMessage(message);
  }
  broadcastFeatures() {
    const features = this.featureSummaries();
    const active = this.store.getActiveFeature();
    this.broadcast({
      type: "features",
      features,
      activeFeature: active ? { id: active.id, tasks: active.tasks.map((t) => this.taskSummary(t)) } : void 0
    });
  }
  featureSummaries() {
    const active = this.store.getActiveFeature();
    return this.store.getFeatures().map((feature) => ({
      id: feature.id,
      name: feature.name,
      status: feature.status,
      requirementCount: feature.requirementIds.length,
      designCount: feature.designIds.length,
      taskCount: feature.tasks.length,
      active: feature.id === active?.id
    }));
  }
  taskSummary(task) {
    return { id: task.id, title: task.title, status: task.status, dependsOn: task.dependsOn, agent: task.agent };
  }
  async handleMessage(webview, message) {
    try {
      switch (message.type) {
        case "ready":
          webview.postMessage({
            type: "init",
            settings: readSettings(),
            features: this.featureSummaries(),
            apiOrigin: getApiOrigin()
          });
          this.broadcastFeatures();
          break;
        case "setActiveFeature":
          this.store.setActiveFeature(message.featureId);
          await this.context.workspaceState.update("chatllm.activeFeatureId", message.featureId);
          this.broadcastFeatures();
          break;
        case "scaffoldFeature":
          await this.scaffold(message.name);
          break;
        case "dispatchFeature":
          await this.dispatch(message.featureId, message.taskIds);
          break;
        case "cancelGraph":
          await cancelExecutionGraph(message.graphId);
          this.graphs.get(message.graphId)?.dispose();
          this.graphs.delete(message.graphId);
          break;
        case "openTask": {
          const task = this.store.getTask(message.featureId, message.taskId);
          if (task) await vscode3.window.showTextDocument(task.filePath);
          break;
        }
        case "openChat":
          await vscode3.commands.executeCommand("chatllm.openChat");
          break;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[pipeline] ${msg}`);
      this.broadcast({ type: "log", message: msg });
    }
  }
  async scaffold(name) {
    const folder = vscode3.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.broadcast({ type: "log", message: "Open a workspace folder to scaffold a feature." });
      return;
    }
    const root = await scaffoldFeature(folder, name);
    const id = root.path.split("/").pop() ?? name;
    this.store.setActiveFeature(id);
    await this.context.workspaceState.update("chatllm.activeFeatureId", id);
    await this.store.refresh();
  }
  async dispatch(featureId, taskIds) {
    const feature = this.store.getFeature(featureId);
    if (!feature) {
      this.broadcast({ type: "log", message: `Unknown feature ${featureId}` });
      return;
    }
    const tasks = taskIds?.length ? feature.tasks.filter((t) => taskIds.includes(t.id)) : feature.tasks;
    const validation = validateDag(tasks);
    if (!validation.ok) {
      this.broadcast({ type: "log", message: `Cannot dispatch: ${validation.error}` });
      return;
    }
    const readiness = computeTaskReadiness(feature.tasks);
    const result = await dispatchFeature(feature, { taskIds });
    const startEvent = {
      graphId: result.graphId,
      featureId: feature.id,
      label: taskIds?.length ? `${feature.name} / ${taskIds.join(", ")}` : feature.name,
      nodes: tasks.map((task) => ({
        id: task.id,
        label: `${task.id} \xB7 ${task.title}`,
        dependsOn: task.dependsOn
      }))
    };
    this.broadcast({ type: "graphStart", payload: startEvent });
    for (const task of tasks) {
      const ready = readiness.get(task.id);
      this.broadcast({
        type: "graphNode",
        payload: { graphId: result.graphId, nodeId: task.id, status: ready?.blockedBy.length ? "blocked" : "queued" }
      });
    }
    const dispose = subscribeExecutionGraphEvents(result.graphId, (event) => {
      if (event.type === "node_status" && event.nodeId && event.status) {
        const mapped = mapStatus(event.status);
        if (mapped) {
          const task = this.store.getTask(feature.id, event.nodeId);
          if (task) void updateTaskStatus(task.filePath, mapped).then(() => this.store.refresh());
        }
        this.broadcast({ type: "graphNode", payload: { graphId: result.graphId, nodeId: event.nodeId, status: event.status } });
      }
      if (event.type === "done" && event.status) {
        this.broadcast({ type: "graphDone", payload: { graphId: result.graphId, status: event.status } });
        this.graphs.get(result.graphId)?.dispose();
        this.graphs.delete(result.graphId);
      }
    });
    this.graphs.set(result.graphId, { graphId: result.graphId, dispose });
  }
  renderHtml(webview) {
    const scriptUri = webview.asWebviewUri(vscode3.Uri.joinPath(this.context.extensionUri, "media", "pipeline.js"));
    const styleUri = webview.asWebviewUri(vscode3.Uri.joinPath(this.context.extensionUri, "media", "webview.css"));
    const nonce = randomNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `connect-src ${webview.cspSource}`
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Chatllm Pipeline</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
};
function mapStatus(status) {
  if (status === "running" || status === "completed" || status === "failed" || status === "blocked") return status;
  return void 0;
}
function randomNonce() {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// src/chat/chat-panel.ts
var vscode4 = __toESM(require("vscode"));

// src/chat/models.ts
var KNOWN_MODELS = {
  openai: [
    { id: "gpt-4o", name: "GPT-4o", family: "gpt-4o", detail: "OpenAI", maxInputTokens: 128e3, maxOutputTokens: 16384, toolCalling: true, imageInput: true },
    { id: "gpt-4o-mini", name: "GPT-4o mini", family: "gpt-4o-mini", detail: "OpenAI", maxInputTokens: 128e3, maxOutputTokens: 16384, toolCalling: true, imageInput: true },
    { id: "gpt-4-turbo", name: "GPT-4 Turbo", family: "gpt-4", detail: "OpenAI", maxInputTokens: 128e3, maxOutputTokens: 4096, toolCalling: true, imageInput: true },
    { id: "gpt-4.1", name: "GPT-4.1", family: "gpt-4.1", detail: "OpenAI", maxInputTokens: 1e6, maxOutputTokens: 32768, toolCalling: true, imageInput: true },
    { id: "gpt-4.1-mini", name: "GPT-4.1 mini", family: "gpt-4.1", detail: "OpenAI", maxInputTokens: 1e6, maxOutputTokens: 32768, toolCalling: true, imageInput: true },
    { id: "o1", name: "o1", family: "o1", detail: "OpenAI reasoning", maxInputTokens: 2e5, maxOutputTokens: 1e5, toolCalling: false },
    { id: "o1-mini", name: "o1 mini", family: "o1", detail: "OpenAI reasoning", maxInputTokens: 128e3, maxOutputTokens: 65536, toolCalling: false },
    { id: "o3", name: "o3", family: "o3", detail: "OpenAI reasoning", maxInputTokens: 2e5, maxOutputTokens: 1e5, toolCalling: true },
    { id: "o3-mini", name: "o3 mini", family: "o3", detail: "OpenAI reasoning", maxInputTokens: 2e5, maxOutputTokens: 1e5, toolCalling: true }
  ],
  openrouter: [
    { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", family: "claude-3.5", detail: "OpenRouter \xB7 Anthropic", maxInputTokens: 2e5, maxOutputTokens: 8192, toolCalling: true, imageInput: true },
    { id: "anthropic/claude-3.5-haiku", name: "Claude 3.5 Haiku", family: "claude-3.5", detail: "OpenRouter \xB7 Anthropic", maxInputTokens: 2e5, maxOutputTokens: 8192, toolCalling: true, imageInput: true },
    { id: "anthropic/claude-3-opus", name: "Claude 3 Opus", family: "claude-3", detail: "OpenRouter \xB7 Anthropic", maxInputTokens: 2e5, maxOutputTokens: 4096, toolCalling: true, imageInput: true },
    { id: "openai/gpt-4o", name: "GPT-4o", family: "gpt-4o", detail: "OpenRouter \xB7 OpenAI", maxInputTokens: 128e3, maxOutputTokens: 16384, toolCalling: true, imageInput: true },
    { id: "openai/gpt-4o-mini", name: "GPT-4o mini", family: "gpt-4o-mini", detail: "OpenRouter \xB7 OpenAI", maxInputTokens: 128e3, maxOutputTokens: 16384, toolCalling: true, imageInput: true },
    { id: "meta-llama/llama-3.1-405b-instruct", name: "Llama 3.1 405B", family: "llama-3.1", detail: "OpenRouter \xB7 Meta", maxInputTokens: 131072, maxOutputTokens: 4096, toolCalling: true },
    { id: "meta-llama/llama-3.1-70b-instruct", name: "Llama 3.1 70B", family: "llama-3.1", detail: "OpenRouter \xB7 Meta", maxInputTokens: 131072, maxOutputTokens: 4096, toolCalling: true },
    { id: "mistralai/mistral-large", name: "Mistral Large", family: "mistral", detail: "OpenRouter \xB7 Mistral", maxInputTokens: 128e3, maxOutputTokens: 4096, toolCalling: true },
    { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", family: "deepseek", detail: "OpenRouter \xB7 DeepSeek", maxInputTokens: 64e3, maxOutputTokens: 8192, toolCalling: true },
    { id: "qwen/qwen-2.5-72b-instruct", name: "Qwen 2.5 72B", family: "qwen", detail: "OpenRouter \xB7 Alibaba", maxInputTokens: 32e3, maxOutputTokens: 4096, toolCalling: true }
  ],
  google: [
    { id: "gemini-2.0-flash-exp", name: "Gemini 2.0 Flash (exp)", family: "gemini-2.0", detail: "Google", maxInputTokens: 1048576, maxOutputTokens: 8192, toolCalling: true, imageInput: true },
    { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", family: "gemini-1.5", detail: "Google", maxInputTokens: 2097152, maxOutputTokens: 8192, toolCalling: true, imageInput: true },
    { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", family: "gemini-1.5", detail: "Google", maxInputTokens: 1048576, maxOutputTokens: 8192, toolCalling: true, imageInput: true },
    { id: "gemini-1.5-flash-8b", name: "Gemini 1.5 Flash 8B", family: "gemini-1.5", detail: "Google", maxInputTokens: 1048576, maxOutputTokens: 8192, toolCalling: true, imageInput: true }
  ],
  ollama: [],
  llamacpp: [],
  lmstudio: [],
  custom: []
};
function listKnownModels(provider) {
  return KNOWN_MODELS[provider] ?? [];
}
var ALL_PROVIDERS = ["openai", "openrouter", "google", "ollama", "llamacpp", "lmstudio", "custom"];

// src/chat/commands.ts
var SPEC_SYSTEM_PROMPTS = {
  spec: "Draft EARS-style feature requirements in markdown using ## R-N section ids.",
  design: "Draft design.md from requirements. Use ## D-N section ids and reference R-* ids.",
  tasks: `Generate task contracts. Each task must be in a fenced \`\`\`task block with YAML frontmatter containing id, title, status, requirement_refs, design_refs, depends_on, expected_files, architecture_hints, acceptance, and agent.`
};
function extractTaskBlocks(content) {
  const blocks = [];
  const re = /```task\s*([\s\S]*?)```/gi;
  let match;
  while ((match = re.exec(content)) !== null) blocks.push(match[1].trim());
  return blocks;
}

// src/chat/stream-client.ts
async function streamChat(body, handlers, signal) {
  const response = await apiFetch("/api/chat/stream", {
    method: "POST",
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok || !response.body) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error ?? response.statusText);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResponse;
  const consume = (rawEvent) => {
    const event = rawEvent.match(/^event: (.+)$/m)?.[1];
    const dataLine = rawEvent.match(/^data: (.+)$/m)?.[1];
    if (!event || !dataLine) return;
    const data = JSON.parse(dataLine);
    if (event === "token") handlers.onToken?.(data.token);
    if (event === "tool") handlers.onToolEvent?.(data);
    if (event === "error") throw new Error(data.error);
    if (event === "done") finalResponse = data;
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) consume(part);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (!finalResponse) throw new Error("Stream ended before the chat response completed.");
  return finalResponse;
}

// src/chat/chat-panel.ts
var STORAGE_KEY = "chatllm.chat.sessions";
var ACTIVE_KEY = "chatllm.chat.activeSession";
var ChatllmChatPanelController = class _ChatllmChatPanelController {
  constructor(context, store2, output) {
    this.context = context;
    this.store = store2;
    this.output = output;
    this.loadSessions();
    this.disposables.push(
      onSettingsChange((settings) => this.broadcast({ type: "settings", settings }))
    );
  }
  static viewType = "chatllm.chat";
  view;
  disposables = [];
  sessions = /* @__PURE__ */ new Map();
  activeSessionId = null;
  streams = /* @__PURE__ */ new Map();
  resolveWebviewView(view) {
    this.view = view;
    this.bindWebview(view.webview);
    view.onDidDispose(() => {
      if (this.view === view) this.view = void 0;
    });
  }
  show() {
    void vscode4.commands.executeCommand(`${_ChatllmChatPanelController.viewType}.focus`);
  }
  async newSession() {
    const session = this.createSession();
    this.activeSessionId = session.id;
    await this.persist();
    this.broadcastSessions();
    this.broadcastActiveSession();
    return session;
  }
  openSettings() {
    this.show();
    this.broadcast({ type: "openSettings" });
  }
  dispose() {
    for (const d of this.disposables) d.dispose();
    for (const s of this.streams.values()) s.abort.abort();
    this.streams.clear();
  }
  webviewOptions() {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode4.Uri.joinPath(this.context.extensionUri, "media"),
        vscode4.Uri.joinPath(this.context.extensionUri, "resources")
      ]
    };
  }
  bindWebview(webview) {
    webview.options = this.webviewOptions();
    webview.html = this.renderHtml(webview);
    const sub = webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    });
    this.disposables.push(sub);
  }
  loadSessions() {
    const raw = this.context.workspaceState.get(STORAGE_KEY, []);
    this.sessions.clear();
    for (const s of raw) {
      this.sessions.set(s.id, this.normalizeSession(s));
    }
    this.activeSessionId = this.context.workspaceState.get(ACTIVE_KEY, null);
    if (this.activeSessionId && !this.sessions.has(this.activeSessionId)) {
      this.activeSessionId = null;
    }
  }
  normalizeSession(session) {
    return {
      ...session,
      messages: session.messages.map((m) => ({
        ...m,
        status: m.status === "streaming" || m.status === "pending" ? "complete" : m.status ?? "complete"
      })),
      overrides: session.overrides ?? {}
    };
  }
  async persist() {
    const list = Array.from(this.sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    await this.context.workspaceState.update(STORAGE_KEY, list);
    await this.context.workspaceState.update(ACTIVE_KEY, this.activeSessionId);
  }
  createSession() {
    const now = Date.now();
    const session = {
      id: randomId(),
      title: "New chat",
      messages: [],
      overrides: {},
      createdAt: now,
      updatedAt: now
    };
    this.sessions.set(session.id, session);
    return session;
  }
  getOrCreateActive() {
    if (this.activeSessionId) {
      const s = this.sessions.get(this.activeSessionId);
      if (s) return s;
    }
    const created = this.createSession();
    this.activeSessionId = created.id;
    return created;
  }
  sessionSummaries() {
    return Array.from(this.sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt).map((s) => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      messageCount: s.messages.length,
      overrides: s.overrides
    }));
  }
  modelCatalog() {
    return ALL_PROVIDERS.map((provider) => ({
      provider,
      label: providerLabel(provider),
      models: listKnownModels(provider).map((m) => ({
        provider,
        modelId: m.id,
        name: m.name,
        detail: m.detail
      }))
    }));
  }
  broadcast(message) {
    this.view?.webview.postMessage(message);
  }
  broadcastSessions() {
    this.broadcast({
      type: "sessions",
      sessions: this.sessionSummaries(),
      activeSessionId: this.activeSessionId
    });
  }
  broadcastActiveSession() {
    const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : null;
    if (session) this.broadcast({ type: "session", session });
  }
  async handleMessage(message) {
    try {
      switch (message.type) {
        case "ready":
          await this.sendInit();
          break;
        case "newSession": {
          const s = this.createSession();
          this.activeSessionId = s.id;
          await this.persist();
          this.broadcastSessions();
          this.broadcastActiveSession();
          break;
        }
        case "openSession": {
          if (this.sessions.has(message.sessionId)) {
            this.activeSessionId = message.sessionId;
            await this.persist();
            this.broadcastSessions();
            this.broadcastActiveSession();
          }
          break;
        }
        case "deleteSession": {
          const stream = this.streams.get(message.sessionId);
          if (stream) {
            stream.abort.abort();
            this.streams.delete(message.sessionId);
          }
          this.sessions.delete(message.sessionId);
          if (this.activeSessionId === message.sessionId) {
            const next = this.sessionSummaries()[0];
            this.activeSessionId = next?.id ?? null;
          }
          await this.persist();
          this.broadcastSessions();
          this.broadcastActiveSession();
          break;
        }
        case "renameSession": {
          const s = this.sessions.get(message.sessionId);
          if (s) {
            s.title = message.title.trim() || "Untitled";
            s.updatedAt = Date.now();
            await this.persist();
            this.broadcastSessions();
          }
          break;
        }
        case "sendMessage":
          await this.sendChat(message.sessionId, message.content);
          break;
        case "cancelMessage": {
          const stream = this.streams.get(message.sessionId);
          if (stream) {
            stream.abort.abort();
            this.streams.delete(message.sessionId);
          }
          break;
        }
        case "setOverrides": {
          const s = this.sessions.get(message.sessionId);
          if (s) {
            s.overrides = { ...s.overrides, ...message.overrides };
            s.updatedAt = Date.now();
            await this.persist();
            this.broadcastSessions();
            this.broadcastActiveSession();
          }
          break;
        }
        case "updateSetting":
          await writeSetting(message.key, message.value);
          break;
        case "openSettings":
          this.broadcast({ type: "openSettings" });
          break;
        case "openPipeline":
          await vscode4.commands.executeCommand("chatllm.openPipeline");
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[chat] ${msg}`);
      this.broadcast({ type: "log", message: msg });
    }
  }
  async sendInit() {
    if (!this.activeSessionId || !this.sessions.has(this.activeSessionId)) {
      this.getOrCreateActive();
      await this.persist();
    }
    const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) ?? null : null;
    this.broadcast({
      type: "init",
      settings: readSettings(),
      sessions: this.sessionSummaries(),
      activeSessionId: this.activeSessionId,
      activeSession: active,
      modelCatalog: this.modelCatalog()
    });
  }
  detectCommand(content) {
    const trimmed = content.trimStart();
    const match = trimmed.match(/^\/(spec|design|tasks)(\s|$)/);
    if (!match) return { rest: content };
    return {
      command: match[1],
      rest: trimmed.slice(match[0].length).trimStart()
    };
  }
  async sendChat(sessionId, content) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (this.streams.has(sessionId)) {
      this.broadcast({ type: "log", message: "A response is already streaming for this chat." });
      return;
    }
    const settings = readSettings();
    const { command, rest } = this.detectCommand(content);
    const userMessage = {
      id: randomId(),
      role: "user",
      content,
      createdAt: Date.now(),
      status: "complete"
    };
    session.messages.push(userMessage);
    if (session.messages.length === 1) {
      session.title = deriveTitle(content);
    }
    session.updatedAt = Date.now();
    this.broadcastActiveSession();
    this.broadcastSessions();
    const assistant = {
      id: randomId(),
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      status: "streaming"
    };
    session.messages.push(assistant);
    this.broadcastActiveSession();
    const provider = session.overrides.provider ?? settings.provider;
    const model = session.overrides.model ?? settings.model;
    const chatMode = session.overrides.chatMode ?? settings.chatMode;
    const useRag = session.overrides.useRag ?? settings.useRag;
    const toolsEnabled = session.overrides.toolsEnabled ?? settings.toolsEnabled;
    const body = {
      conversationId: session.conversationId,
      provider,
      model,
      modelSelection: settings.modelSelection,
      chatMode: command ? command === "spec" ? "normal" : "agent" : chatMode,
      content: rest || content,
      systemPrompt: command ? SPEC_SYSTEM_PROMPTS[command] : settings.systemPrompt || void 0,
      skillIds: settings.skillIds,
      documentIds: settings.documentIds,
      useRag,
      toolsEnabled: command ? command === "spec" ? toolsEnabled : true : toolsEnabled,
      mcpServerIds: settings.mcpServerIds,
      agentIds: settings.agentIds,
      maxAgentSpawns: settings.maxAgentSpawns
    };
    const abort = new AbortController();
    this.streams.set(sessionId, { abort, messageId: assistant.id });
    let buffer = "";
    try {
      const response = await streamChat(
        body,
        {
          onToken: (text) => {
            buffer += text;
            assistant.content = buffer;
            this.broadcast({ type: "messageAppend", sessionId, messageId: assistant.id, chunk: text });
          },
          onToolEvent: (event) => {
            this.broadcast({
              type: "toolEvent",
              sessionId,
              name: event.name,
              arguments: event.arguments ?? {}
            });
          }
        },
        abort.signal
      );
      if (response.conversation?.id) session.conversationId = response.conversation.id;
      assistant.status = "complete";
      assistant.content = buffer;
      session.updatedAt = Date.now();
      if (command === "tasks" && buffer) {
        try {
          const written = await this.writeGeneratedTasks(buffer);
          if (written > 0) {
            const note = `

_Wrote **${written}** task contract${written === 1 ? "" : "s"} for the active feature. Run **Chatllm: Dispatch Feature Tasks** to execute them._`;
            assistant.content = `${buffer}${note}`;
            this.broadcast({ type: "messageAppend", sessionId, messageId: assistant.id, chunk: note });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.output.appendLine(`[chat.tasks] ${msg}`);
        }
      }
      this.broadcast({
        type: "messageComplete",
        sessionId,
        messageId: assistant.id,
        conversationId: session.conversationId
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[chat] ${msg}`);
      const aborted = abort.signal.aborted;
      if (aborted) {
        assistant.status = "complete";
        assistant.content = `${buffer}${buffer ? "\n\n" : ""}_Cancelled._`;
        this.broadcast({ type: "messageAppend", sessionId, messageId: assistant.id, chunk: `${buffer ? "\n\n" : ""}_Cancelled._` });
        this.broadcast({ type: "messageComplete", sessionId, messageId: assistant.id, conversationId: session.conversationId });
      } else {
        assistant.status = "error";
        assistant.error = msg;
        this.broadcast({ type: "messageError", sessionId, messageId: assistant.id, error: msg });
      }
    } finally {
      this.streams.delete(sessionId);
      await this.persist();
      this.broadcastSessions();
    }
  }
  async writeGeneratedTasks(text) {
    const feature = this.store.getActiveFeature();
    if (!feature?.tasksDirUri) return 0;
    let written = 0;
    for (const block of extractTaskBlocks(text)) {
      const probe = vscode4.Uri.joinPath(feature.tasksDirUri, "_probe.md");
      const task = parseTaskContract(feature.id, probe, block.startsWith("---") ? block : `---
${block}
---
`);
      if (!task) continue;
      task.filePath = vscode4.Uri.joinPath(
        feature.tasksDirUri,
        `${task.id}-${task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.md`
      );
      await writeTaskContract(task);
      written++;
    }
    if (written > 0) {
      await this.store.refresh();
      const updated = this.store.getFeature(feature.id);
      if (updated?.tasksDirUri) {
        await writeTextFile(
          vscode4.Uri.joinPath(updated.tasksDirUri, "index.md"),
          regenerateTasksIndex(updated.tasks)
        );
      }
    }
    return written;
  }
  renderHtml(webview) {
    const scriptUri = webview.asWebviewUri(vscode4.Uri.joinPath(this.context.extensionUri, "media", "chat.js"));
    const styleUri = webview.asWebviewUri(vscode4.Uri.joinPath(this.context.extensionUri, "media", "webview.css"));
    const nonce = randomNonce2();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `connect-src ${webview.cspSource}`
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Chatllm</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body class="chatllm-chat-body">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
};
function providerLabel(provider) {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "openrouter":
      return "OpenRouter";
    case "google":
      return "Google";
    case "ollama":
      return "Ollama";
    case "llamacpp":
      return "llama.cpp";
    case "lmstudio":
      return "LM Studio";
    case "custom":
      return "Custom";
  }
}
function deriveTitle(text) {
  const firstLine = text.replace(/\s+/g, " ").trim();
  if (!firstLine) return "New chat";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}\u2026` : firstLine;
}
function randomId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function randomNonce2() {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// src/spec/store.ts
var vscode5 = __toESM(require("vscode"));
var SpecStore = class {
  constructor(output) {
    this.output = output;
  }
  changeEmitter = new vscode5.EventEmitter();
  onDidChange = this.changeEmitter.event;
  features = /* @__PURE__ */ new Map();
  watcher;
  activeFeatureId;
  async initialize(context) {
    this.activeFeatureId = context.workspaceState.get("chatllm.activeFeatureId");
    this.watcher = vscode5.workspace.createFileSystemWatcher("**/.chatllm/specs/**/*.md");
    this.watcher.onDidCreate(() => void this.refresh());
    this.watcher.onDidChange(() => void this.refresh());
    this.watcher.onDidDelete(() => void this.refresh());
    context.subscriptions.push(this.watcher);
    await this.refresh();
  }
  getFeatures() {
    return [...this.features.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  getFeature(id) {
    return this.features.get(id);
  }
  getActiveFeature() {
    return this.activeFeatureId ? this.features.get(this.activeFeatureId) : this.getFeatures()[0];
  }
  setActiveFeature(id) {
    this.activeFeatureId = id;
  }
  getTask(featureId, taskId) {
    return this.features.get(featureId)?.tasks.find((task) => task.id === taskId);
  }
  async refresh() {
    this.features.clear();
    for (const folder of vscode5.workspace.workspaceFolders ?? []) {
      const root = vscode5.Uri.joinPath(folder.uri, ".chatllm", "specs");
      try {
        for (const [name, type] of await vscode5.workspace.fs.readDirectory(root)) {
          if (type === vscode5.FileType.Directory) {
            const feature = await this.loadFeature(root, name);
            if (feature) this.features.set(feature.id, feature);
          }
        }
      } catch {
      }
    }
    this.changeEmitter.fire();
  }
  async loadFeature(specsRoot, id) {
    const rootUri = vscode5.Uri.joinPath(specsRoot, id);
    const featureMdUri = vscode5.Uri.joinPath(rootUri, "feature.md");
    const requirementsUri = vscode5.Uri.joinPath(rootUri, "requirements.md");
    const designUri = vscode5.Uri.joinPath(rootUri, "design.md");
    const tasksDirUri = vscode5.Uri.joinPath(rootUri, "tasks");
    let name = id;
    let status = "draft";
    try {
      const featureMd = await readTextFile(featureMdUri);
      name = featureMd.match(/^#\s+(.+)$/m)?.[1]?.trim() || id;
      status = parseFeatureStatus(featureMd);
    } catch {
      this.output.appendLine(`Feature ${id} has no feature.md`);
    }
    const requirementIds = await this.readIds(requirementsUri, "R");
    const designIds = await this.readIds(designUri, "D");
    const tasks = [];
    try {
      for (const [fileName, fileType] of await vscode5.workspace.fs.readDirectory(tasksDirUri)) {
        if (fileType !== vscode5.FileType.File || !/^T-\d+.*\.md$/i.test(fileName)) continue;
        const filePath = vscode5.Uri.joinPath(tasksDirUri, fileName);
        const task = parseTaskContract(id, filePath, await readTextFile(filePath));
        if (task) tasks.push(task);
      }
    } catch {
    }
    return { id, name, status, rootUri, featureMdUri, requirementsUri, designUri, tasksDirUri, requirementIds, designIds, tasks };
  }
  async readIds(uri, prefix) {
    try {
      return extractSectionIds(await readTextFile(uri), prefix);
    } catch {
      return [];
    }
  }
  dispose() {
    this.watcher?.dispose();
    this.changeEmitter.dispose();
  }
};

// src/theme-bridge.ts
var vscode6 = __toESM(require("vscode"));
var CHATLLM_TO_VSCODE = {
  "default:light": "Light Modern",
  "default:dark": "Dark Modern",
  "cursor:light": "Light 2026",
  "cursor:dark": "Dark 2026",
  "github:light": "Light+",
  "github:dark": "Dark+"
};
var VSCODE_TO_CHATLLM = {
  "Light Modern": { family: "default", mode: "light" },
  "Dark Modern": { family: "default", mode: "dark" },
  "Light+": { family: "github", mode: "light" },
  "Dark+": { family: "github", mode: "dark" },
  "Light 2026": { family: "cursor", mode: "light" },
  "Dark 2026": { family: "cursor", mode: "dark" }
};
function createThemeBridge(output) {
  const apiOrigin = getApiOrigin();
  if (!apiOrigin) return { dispose() {
  } };
  let ws;
  let disposed = false;
  let lastApplied;
  let lastOverridesKey;
  async function applyTheme(themeId) {
    if (!themeId) return;
    lastApplied = themeId;
    await vscode6.workspace.getConfiguration("workbench").update("colorTheme", themeId, vscode6.ConfigurationTarget.Global);
  }
  async function applyColorOverrides(overrides) {
    if (!overrides || Object.keys(overrides).length === 0) return;
    const fingerprint = JSON.stringify(overrides);
    if (fingerprint === lastOverridesKey) return;
    lastOverridesKey = fingerprint;
    const config = vscode6.workspace.getConfiguration("workbench");
    const existing = config.get("colorCustomizations") ?? {};
    const next = { ...overrides };
    for (const [key, value] of Object.entries(existing)) {
      if (key.startsWith("[") && key.endsWith("]")) next[key] = value;
    }
    await config.update("colorCustomizations", next, vscode6.ConfigurationTarget.Global);
  }
  async function publishTheme() {
    const themeId = vscode6.workspace.getConfiguration("workbench").get("colorTheme");
    if (!themeId || themeId === lastApplied) {
      lastApplied = void 0;
      return;
    }
    const mapped = VSCODE_TO_CHATLLM[themeId];
    if (!mapped) return;
    await apiFetch("/api/theme", {
      method: "PUT",
      body: JSON.stringify({ kind: "name", family: mapped.family, mode: mapped.mode, vsCodeThemeId: themeId, source: "vscode" })
    }).catch((error) => output.appendLine(`Theme publish error: ${error instanceof Error ? error.message : String(error)}`));
  }
  function connect() {
    if (disposed) return;
    ws = new WebSocket(`${apiOrigin.replace(/^http/, "ws")}/api/theme/stream`);
    ws.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data));
      if (payload.type !== "theme" || payload.snapshot?.source === "vscode") return;
      const snapshot = payload.snapshot;
      const themeId = snapshot?.vsCodeThemeId ?? CHATLLM_TO_VSCODE[`${snapshot?.family}:${snapshot?.mode}`];
      void applyTheme(themeId).then(() => applyColorOverrides(snapshot?.colorOverrides));
    });
    ws.addEventListener("close", () => setTimeout(connect, 1e3));
  }
  const envTheme = CHATLLM_TO_VSCODE[`${process.env.CHATLLM_THEME_FAMILY}:${process.env.CHATLLM_THEME_MODE === "system" ? "dark" : process.env.CHATLLM_THEME_MODE}`];
  void applyTheme(envTheme);
  const listener = vscode6.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("workbench.colorTheme")) void publishTheme();
  });
  connect();
  void publishTheme();
  return { dispose() {
    disposed = true;
    listener.dispose();
    ws?.close();
  } };
}

// src/views/runsTree.ts
var vscode7 = __toESM(require("vscode"));
var RunsTreeProvider = class {
  constructor(writeback) {
    this.writeback = writeback;
  }
  emitter = new vscode7.EventEmitter();
  onDidChangeTreeData = this.emitter.event;
  runs = /* @__PURE__ */ new Map();
  refresh() {
    this.emitter.fire(void 0);
  }
  trackRun(graphId, featureId, label, nodeIds) {
    const run = { graphId, featureId, label, status: "running", nodes: new Map(nodeIds.map((id) => [id, "queued"])) };
    run.dispose = subscribeExecutionGraphEvents(graphId, (event) => {
      if (event.type === "node_status" && event.nodeId && event.status) {
        run.nodes.set(event.nodeId, event.status);
        const mapped = mapStatus2(event.status);
        if (mapped) void this.writeback?.(featureId, event.nodeId, mapped);
      }
      if (event.type === "done" && event.status) run.status = event.status;
      this.refresh();
    });
    this.runs.set(graphId, run);
    this.refresh();
  }
  cancelRun(graphId) {
    this.runs.get(graphId)?.dispose?.();
    this.runs.delete(graphId);
    this.refresh();
  }
  getTreeItem(item) {
    if (item.kind === "run") {
      const tree2 = new vscode7.TreeItem(item.run.label, vscode7.TreeItemCollapsibleState.Expanded);
      tree2.description = item.run.status;
      return tree2;
    }
    const tree = new vscode7.TreeItem(item.nodeId);
    tree.description = item.status;
    return tree;
  }
  getChildren(item) {
    if (!item) return [...this.runs.values()].map((run) => ({ kind: "run", run }));
    if (item.kind === "run") return [...item.run.nodes.entries()].map(([nodeId, status]) => ({ kind: "node", nodeId, status }));
    return [];
  }
};
function mapStatus2(status) {
  if (status === "running" || status === "completed" || status === "failed" || status === "blocked") return status;
  return void 0;
}

// src/views/specsTree.ts
var vscode8 = __toESM(require("vscode"));
var SpecsTreeProvider = class {
  constructor(store2) {
    this.store = store2;
    store2.onDidChange(() => this.refresh());
  }
  emitter = new vscode8.EventEmitter();
  onDidChangeTreeData = this.emitter.event;
  refresh() {
    this.emitter.fire(void 0);
  }
  getTreeItem(item) {
    if (item.kind === "feature") {
      const tree2 = new vscode8.TreeItem(item.feature.name, vscode8.TreeItemCollapsibleState.Expanded);
      tree2.description = item.feature.status;
      tree2.contextValue = "feature";
      tree2.iconPath = new vscode8.ThemeIcon("folder");
      tree2.command = { command: "chatllm.setActiveFeature", title: "Set Active", arguments: [item.feature.id] };
      return tree2;
    }
    const tree = new vscode8.TreeItem(item.label);
    tree.resourceUri = item.uri;
    tree.command = { command: "vscode.open", title: "Open", arguments: [item.uri] };
    return tree;
  }
  getChildren(item) {
    if (!item) return this.store.getFeatures().map((feature) => ({ kind: "feature", feature }));
    if (item.kind !== "feature") return [];
    const f = item.feature;
    return [
      f.requirementsUri && { kind: "file", label: `requirements.md (${f.requirementIds.length})`, uri: f.requirementsUri },
      f.designUri && { kind: "file", label: `design.md (${f.designIds.length})`, uri: f.designUri },
      f.tasksDirUri && { kind: "file", label: `tasks/index.md (${f.tasks.length})`, uri: vscode8.Uri.joinPath(f.tasksDirUri, "index.md") }
    ].filter(Boolean);
  }
};

// src/views/tasksTree.ts
var vscode9 = __toESM(require("vscode"));
var TasksTreeProvider = class {
  constructor(store2) {
    this.store = store2;
    store2.onDidChange(() => this.refresh());
  }
  emitter = new vscode9.EventEmitter();
  onDidChangeTreeData = this.emitter.event;
  refresh() {
    this.emitter.fire(void 0);
  }
  getTreeItem(item) {
    if (item.kind === "group") return new vscode9.TreeItem(item.label, vscode9.TreeItemCollapsibleState.Expanded);
    const tree = new vscode9.TreeItem(`${item.task.id}: ${item.task.title}`);
    tree.description = item.task.status;
    tree.contextValue = "task";
    tree.command = { command: "chatllm.openTask", title: "Open Task", arguments: [{ kind: "task", featureId: item.featureId, task: { id: item.task.id } }] };
    return tree;
  }
  getChildren(item) {
    const feature = this.store.getActiveFeature();
    if (!feature) return [];
    if (!item) {
      const groups = groupTasksByStatus(feature.tasks);
      return ["running", "ready", "blocked", "pending", "failed", "completed"].filter((status) => groups[status].length).map((status) => ({ kind: "group", status, label: `${status} (${groups[status].length})` }));
    }
    if (item.kind !== "group") return [];
    return (groupTasksByStatus(feature.tasks)[item.status] ?? []).map((task) => ({ kind: "task", featureId: feature.id, task }));
  }
};

// src/extension.ts
var store;
var pipeline;
var chat;
async function activate(context) {
  const output = vscode10.window.createOutputChannel("Chatllm");
  store = new SpecStore(output);
  await store.initialize(context);
  const specsTree = new SpecsTreeProvider(store);
  const tasksTree = new TasksTreeProvider(store);
  const runsTree = new RunsTreeProvider(async (featureId, taskId, status) => {
    const task = store.getTask(featureId, taskId);
    if (task) {
      await updateTaskStatus(task.filePath, status);
      await store.refresh();
    }
  });
  pipeline = new ChatllmPipelineController(context, store, output);
  chat = new ChatllmChatPanelController(context, store, output);
  context.subscriptions.push(
    output,
    store,
    pipeline,
    chat,
    vscode10.window.registerWebviewViewProvider(ChatllmPipelineController.viewType, pipeline, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode10.window.registerWebviewViewProvider(ChatllmChatPanelController.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode10.window.registerTreeDataProvider("chatllm.specs", specsTree),
    vscode10.window.registerTreeDataProvider("chatllm.tasks", tasksTree),
    vscode10.window.registerTreeDataProvider("chatllm.runs", runsTree),
    createThemeBridge(output),
    statusBar(),
    ...commands4(context, specsTree, tasksTree, runsTree)
  );
}
function commands4(context, specsTree, tasksTree, runsTree) {
  return [
    vscode10.commands.registerCommand("chatllm.openChat", () => chat.show()),
    vscode10.commands.registerCommand("chatllm.newChat", async () => {
      chat.show();
      await chat.newSession();
    }),
    vscode10.commands.registerCommand("chatllm.openSettings", () => chat.openSettings()),
    vscode10.commands.registerCommand("chatllm.openPipeline", () => pipeline.show()),
    vscode10.commands.registerCommand("chatllm.refreshSpecs", async () => {
      await store.refresh();
      specsTree.refresh();
    }),
    vscode10.commands.registerCommand("chatllm.refreshTasks", async () => {
      await store.refresh();
      tasksTree.refresh();
    }),
    vscode10.commands.registerCommand("chatllm.refreshRuns", () => runsTree.refresh()),
    vscode10.commands.registerCommand("chatllm.scaffoldFeature", async () => {
      const folder = vscode10.workspace.workspaceFolders?.[0];
      const name = await vscode10.window.showInputBox({ prompt: "Feature name" });
      if (!folder || !name) return;
      const root = await scaffoldFeature(folder, name);
      const id = root.path.split("/").pop() ?? name;
      store.setActiveFeature(id);
      await context.workspaceState.update("chatllm.activeFeatureId", id);
      await store.refresh();
      specsTree.refresh();
    }),
    vscode10.commands.registerCommand("chatllm.setActiveFeature", async (id) => {
      store.setActiveFeature(id);
      await context.workspaceState.update("chatllm.activeFeatureId", id);
      tasksTree.refresh();
    }),
    vscode10.commands.registerCommand("chatllm.openTask", async (arg) => {
      const task = arg && store.getTask(arg.featureId, arg.task.id);
      if (task) await vscode10.window.showTextDocument(task.filePath);
    }),
    vscode10.commands.registerCommand("chatllm.runTask", async (arg) => {
      const feature = arg && store.getFeature(arg.featureId);
      if (!feature || !arg) return;
      await pipeline.dispatch(feature.id, [arg.task.id]);
    }),
    vscode10.commands.registerCommand("chatllm.markTaskReady", async (arg) => {
      const task = arg && store.getTask(arg.featureId, arg.task.id);
      if (task) await updateTaskStatus(task.filePath, "ready");
      await store.refresh();
    }),
    vscode10.commands.registerCommand("chatllm.dispatchFeature", async () => {
      const feature = store.getActiveFeature();
      if (!feature) return;
      await pipeline.dispatch(feature.id);
    }),
    vscode10.commands.registerCommand("chatllm.regenerateTasksIndex", async () => {
      const feature = store.getActiveFeature();
      if (feature?.tasksDirUri) await writeTextFile(vscode10.Uri.joinPath(feature.tasksDirUri, "index.md"), regenerateTasksIndex(feature.tasks));
    }),
    vscode10.commands.registerCommand("chatllm.cancelRun", async () => {
      const graphId = await vscode10.window.showInputBox({ prompt: "Graph id to cancel" });
      if (graphId) await cancelExecutionGraph(graphId);
    })
  ];
}
function statusBar() {
  const item = vscode10.window.createStatusBarItem(vscode10.StatusBarAlignment.Left, 100);
  item.text = "$(comment-discussion) Chatllm";
  item.tooltip = "Open Chatllm chat";
  item.command = "chatllm.openChat";
  item.show();
  return item;
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
