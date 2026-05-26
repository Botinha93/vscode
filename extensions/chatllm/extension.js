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
var vscode11 = __toESM(require("vscode"));

// src/api.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var integrationPath;
var cachedIntegration;
function initApiFromContext(context) {
  integrationPath = (0, import_node_path.join)(context.globalStorageUri.fsPath, "../../../chatllm-integration.json");
  cachedIntegration = void 0;
}
function loadIntegrationFile() {
  if (cachedIntegration !== void 0) return cachedIntegration;
  const candidates = [
    process.env.CHATLLM_INTEGRATION_FILE,
    integrationPath
  ].filter((p) => Boolean(p));
  for (const path of candidates) {
    try {
      if ((0, import_node_fs.existsSync)(path)) {
        cachedIntegration = JSON.parse((0, import_node_fs.readFileSync)(path, "utf8"));
        return cachedIntegration;
      }
    } catch {
    }
  }
  cachedIntegration = null;
  return null;
}
function getApiOrigin() {
  const fromEnv = process.env.CHATLLM_API_ORIGIN;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return (loadIntegrationFile()?.apiOrigin || "").replace(/\/$/, "");
}
function getAuthToken() {
  const fromEnv = process.env.CHATLLM_AUTH_TOKEN;
  if (fromEnv) return fromEnv;
  return loadIntegrationFile()?.authToken || "";
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
async function probeBackend() {
  if (!getApiOrigin()) return "unconfigured";
  try {
    const res = await apiFetch("/api/config");
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 403) return "unauthorized";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}
async function readJson(res) {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? ` \u2014 ${body.slice(0, 300)}` : ""}`);
  }
  return await res.json();
}
async function readNothing(res) {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? ` \u2014 ${body.slice(0, 300)}` : ""}`);
  }
}
async function fetchConfig() {
  return readJson(await apiFetch("/api/config"));
}
async function listConversations() {
  return readJson(await apiFetch("/api/conversations"));
}
async function createConversation(title) {
  return readJson(
    await apiFetch("/api/conversations", { method: "POST", body: JSON.stringify({ title }) })
  );
}
async function patchConversation(id, partial) {
  return readJson(
    await apiFetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(partial)
    })
  );
}
async function deleteConversation(id) {
  await readNothing(
    await apiFetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" })
  );
}
async function listConversationMessages(id) {
  return readJson(
    await apiFetch(`/api/conversations/${encodeURIComponent(id)}/messages`)
  );
}
async function listFolders(filter = "mine") {
  return readJson(
    await apiFetch(`/api/folders?filter=${encodeURIComponent(filter)}`)
  );
}
async function createFolder(input) {
  return readJson(
    await apiFetch("/api/folders", { method: "POST", body: JSON.stringify(input) })
  );
}
async function addConversationToFolder(folderId, conversationId) {
  await readNothing(
    await apiFetch(
      `/api/folders/${encodeURIComponent(folderId)}/conversations/${encodeURIComponent(conversationId)}`,
      { method: "POST" }
    )
  );
}
async function listDocuments() {
  return readJson(await apiFetch("/api/documents"));
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
    modelSelection: cfg.get("modelSelection") ?? "manual",
    chatMode: cfg.get("chatMode") ?? "normal",
    useRag: cfg.get("useRag") ?? false,
    toolsEnabled: cfg.get("toolsEnabled") ?? true,
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
var vscode5 = __toESM(require("vscode"));

// src/project/identity.ts
var vscode4 = __toESM(require("vscode"));
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
function gitExec(args, cwd) {
  return new Promise((resolve) => {
    (0, import_node_child_process.execFile)("git", args, { cwd, timeout: 5e3, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.toString().trim());
    });
  });
}
function normaliseRemote(remote) {
  let out = remote.trim();
  if (out.endsWith(".git")) out = out.slice(0, -4);
  const sshMatch = out.match(/^[a-zA-Z0-9_-]+@([^:]+):(.+)$/);
  if (sshMatch) out = `${sshMatch[1]}/${sshMatch[2]}`;
  return out.replace(/^https?:\/\//, "").toLowerCase();
}
function shortHash(input) {
  return (0, import_node_crypto.createHash)("sha1").update(input).digest("hex").slice(0, 24);
}
async function detectProjectIdentity() {
  const folder = vscode4.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") {
    return { id: "none", source: "none", name: "No workspace" };
  }
  const cwd = folder.uri.fsPath;
  const [remoteRaw, firstCommit, branch] = await Promise.all([
    gitExec(["config", "--get", "remote.origin.url"], cwd),
    gitExec(["rev-list", "--max-parents=0", "HEAD"], cwd),
    gitExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
  ]);
  if (remoteRaw || firstCommit) {
    const remote = remoteRaw ? normaliseRemote(remoteRaw) : void 0;
    const composite = `${remote ?? ""}|${firstCommit ?? ""}`;
    return {
      id: `git:${shortHash(composite)}`,
      source: "git",
      name: folder.name,
      remoteUrl: remote,
      firstCommit: firstCommit ?? void 0,
      branch: branch ?? void 0,
      rootPath: cwd
    };
  }
  return {
    id: `folder:${shortHash(cwd)}`,
    source: "folder",
    name: folder.name,
    rootPath: cwd
  };
}
function projectFolderName(identity) {
  if (identity.source === "git" && identity.remoteUrl) {
    return `repo:${identity.remoteUrl}`;
  }
  if (identity.source === "git") {
    return `repo:${identity.id}`;
  }
  if (identity.source === "folder") {
    return `local:${identity.name}`;
  }
  return "workspace";
}

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

// src/chat/models.ts
function toWireProvider(provider) {
  return provider === "ollama-internal" ? "ollama" : provider;
}
function findConfiguredModel(models, provider, modelId) {
  if (!provider || !modelId) return void 0;
  return models.find((m) => m.provider === provider && m.modelId === modelId);
}
function defaultEnabledModel(models) {
  return models.find((m) => m.enabled && m.apiKeyConfigured) ?? models.find((m) => m.enabled) ?? models[0];
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
var OVERRIDES_STORAGE_KEY = "chatllm.chat.overrides";
var ACTIVE_SESSION_STORAGE_KEY = "chatllm.chat.activeSession";
var ChatllmChatPanelController = class _ChatllmChatPanelController {
  constructor(context, store2, output) {
    this.context = context;
    this.store = store2;
    this.output = output;
    this.overrides = this.context.workspaceState.get(OVERRIDES_STORAGE_KEY, {});
    this.activeSessionId = this.context.workspaceState.get(ACTIVE_SESSION_STORAGE_KEY, null);
    this.disposables.push(
      onSettingsChange((settings) => this.broadcast({ type: "settings", settings }))
    );
  }
  static viewType = "chatllm.chat";
  view;
  disposables = [];
  streams = /* @__PURE__ */ new Map();
  project = { id: "none", source: "none", name: "" };
  projectFolderId = null;
  projectFolder;
  catalog = emptyCatalog();
  backendStatus = "unconfigured";
  conversations = /* @__PURE__ */ new Map();
  messagesCache = /* @__PURE__ */ new Map();
  overrides = {};
  /** Locally-staged session for "new chat" before the first message creates it on the backend. */
  draftSession = null;
  activeSessionId = null;
  resolveWebviewView(view) {
    this.view = view;
    this.bindWebview(view.webview);
    view.onDidDispose(() => {
      if (this.view === view) this.view = void 0;
    });
  }
  show() {
    void vscode5.commands.executeCommand(`${_ChatllmChatPanelController.viewType}.focus`);
  }
  async newSession() {
    this.draftSession = this.makeDraft();
    this.activeSessionId = this.draftSession.id;
    await this.persistActive();
    this.broadcastSessions();
    this.broadcastActiveSession();
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
  // ---------------------------------------------------------------------------
  // Webview plumbing
  // ---------------------------------------------------------------------------
  webviewOptions() {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode5.Uri.joinPath(this.context.extensionUri, "media"),
        vscode5.Uri.joinPath(this.context.extensionUri, "resources")
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
    const session = this.activeSession();
    if (session) this.broadcast({ type: "session", session });
  }
  async handleMessage(message) {
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
        case "refreshCatalog":
          await this.refreshCatalog();
          break;
        case "refreshSessions":
          await this.refreshConversations();
          break;
        case "updateSetting":
          await writeSetting(message.key, message.value);
          break;
        case "openSettings":
          this.broadcast({ type: "openSettings" });
          break;
        case "openPipeline":
          await vscode5.commands.executeCommand("chatllm.openPipeline");
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
  async sendInit() {
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
      apiOrigin: getApiOrigin()
    });
  }
  async refreshCatalog() {
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
      this.backendStatus = "ok";
    } catch (err) {
      this.output.appendLine(`[chat.catalog] ${err instanceof Error ? err.message : String(err)}`);
      this.catalog = emptyCatalog();
      this.backendStatus = "unreachable";
    }
    this.broadcast({ type: "catalog", catalog: this.catalog, backendStatus: this.backendStatus });
  }
  async ensureProjectFolder() {
    if (this.backendStatus !== "ok") return;
    if (this.project.source === "none") {
      this.projectFolder = void 0;
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
  async refreshConversations() {
    if (this.backendStatus !== "ok") {
      this.broadcastSessions();
      return;
    }
    try {
      const all = await listConversations();
      const folderName = projectFolderName(this.project);
      const folderId = this.projectFolderId;
      const owned = all.filter((c) => {
        if (this.project.source === "none") return true;
        if (c.folder === folderName) return true;
        if (folderId && c.folderIds?.includes(folderId)) return true;
        return false;
      });
      this.conversations.clear();
      for (const c of owned) this.conversations.set(c.id, c);
      if (this.activeSessionId && this.activeSessionId.startsWith("draft:")) {
      } else if (!this.activeSessionId || !this.conversations.has(this.activeSessionId)) {
        const next = [...this.conversations.values()].sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
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
  async ensureMessagesLoaded(conversationId) {
    if (this.messagesCache.has(conversationId)) return;
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
  makeDraft() {
    const now = Date.now();
    return {
      id: `draft:${randomId()}`,
      title: "New chat",
      messages: [],
      overrides: {},
      remote: false,
      createdAt: now,
      updatedAt: now
    };
  }
  sessionSummaries() {
    const summaries = [];
    if (this.draftSession) {
      summaries.push({
        id: this.draftSession.id,
        title: this.draftSession.title,
        updatedAt: this.draftSession.updatedAt,
        messageCount: this.draftSession.messages.length,
        overrides: this.draftSession.overrides,
        remote: false
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
        remote: true
      });
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
  }
  activeSession() {
    if (!this.activeSessionId) return null;
    if (this.activeSessionId.startsWith("draft:")) return this.draftSession;
    const conv = this.conversations.get(this.activeSessionId);
    if (!conv) return null;
    return this.sessionFromConversation(conv);
  }
  sessionFromConversation(conv) {
    const cached = this.messagesCache.get(conv.id) ?? [];
    const messages = cached.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: new Date(m.createdAt).getTime() || Date.now(),
      status: "complete"
    }));
    return {
      id: conv.id,
      conversationId: conv.id,
      title: conv.title || "Untitled",
      messages,
      overrides: this.conversationOverrides(conv),
      remote: true,
      createdAt: new Date(conv.createdAt).getTime() || Date.now(),
      updatedAt: new Date(conv.updatedAt).getTime() || Date.now()
    };
  }
  conversationOverrides(conv) {
    const stored = this.overrides[conv.id] ?? {};
    return {
      provider: conv.provider ?? stored.provider,
      model: conv.model ?? stored.model,
      chatMode: conv.chatMode ?? stored.chatMode,
      useRag: stored.useRag,
      toolsEnabled: stored.toolsEnabled,
      agentIds: conv.agentIds ?? stored.agentIds,
      skillIds: stored.skillIds,
      mcpServerIds: stored.mcpServerIds
    };
  }
  projectInfo() {
    return {
      id: this.project.id,
      source: this.project.source,
      name: this.project.name,
      remoteUrl: this.project.remoteUrl,
      branch: this.project.branch,
      rootPath: this.project.rootPath,
      folderName: projectFolderName(this.project)
    };
  }
  async persistActive() {
    await this.context.workspaceState.update(ACTIVE_SESSION_STORAGE_KEY, this.activeSessionId);
  }
  async persistOverrides() {
    await this.context.workspaceState.update(OVERRIDES_STORAGE_KEY, this.overrides);
  }
  // ---------------------------------------------------------------------------
  // Session operations
  // ---------------------------------------------------------------------------
  async openSession(id) {
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
  async removeSession(id) {
    if (id.startsWith("draft:")) {
      if (this.draftSession?.id === id) {
        this.draftSession = null;
        if (this.activeSessionId === id) this.activeSessionId = null;
      }
    } else if (this.conversations.has(id)) {
      try {
        await deleteConversation(id);
      } catch (err) {
        this.output.appendLine(`[chat.delete] ${err instanceof Error ? err.message : String(err)}`);
      }
      this.conversations.delete(id);
      this.messagesCache.delete(id);
      delete this.overrides[id];
      await this.persistOverrides();
      if (this.activeSessionId === id) this.activeSessionId = null;
    }
    if (!this.activeSessionId) {
      const next = [...this.conversations.values()].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
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
  async renameSession(id, title) {
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
  async updateOverrides(id, overrides) {
    if (id.startsWith("draft:") && this.draftSession?.id === id) {
      this.draftSession.overrides = { ...this.draftSession.overrides, ...overrides };
      this.draftSession.updatedAt = Date.now();
      this.broadcastSessions();
      this.broadcastActiveSession();
      return;
    }
    if (!this.conversations.has(id)) return;
    const merged = { ...this.overrides[id] ?? {}, ...overrides };
    this.overrides[id] = merged;
    await this.persistOverrides();
    const patch = {};
    if (overrides.provider) patch.provider = toWireProvider(overrides.provider);
    if (overrides.model) patch.model = overrides.model;
    if (overrides.chatMode) patch.chatMode = overrides.chatMode;
    if (overrides.agentIds) patch.agentIds = overrides.agentIds;
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
  detectCommand(content) {
    const trimmed = content.trimStart();
    const match = trimmed.match(/^\/(spec|design|tasks)(\s|$)/);
    if (!match) return { rest: content };
    return {
      command: match[1],
      rest: trimmed.slice(match[0].length).trimStart()
    };
  }
  resolveProviderModel(overrides) {
    const fromOverride = overrides.provider && overrides.model ? findConfiguredModel(this.catalog.models, overrides.provider, overrides.model) : void 0;
    const chosen = fromOverride ?? defaultEnabledModel(this.catalog.models);
    if (!chosen) return null;
    return { provider: toWireProvider(chosen.provider), model: chosen.modelId };
  }
  async sendChat(sessionId, content) {
    let session = this.findSession(sessionId);
    if (!session) return;
    if (this.streams.has(sessionId)) {
      this.broadcast({ type: "log", message: "A response is already streaming for this chat." });
      return;
    }
    if (this.backendStatus !== "ok") {
      const hint = this.backendStatus === "unauthorized" ? "Not signed in to Chatllm. Close VS Code and reopen the project from the Chatllm desktop app while logged in." : "Chatllm backend is unreachable. Check the CHATLLM_API_ORIGIN setting.";
      this.broadcast({ type: "log", message: hint });
      return;
    }
    const resolved = this.resolveProviderModel(session.overrides);
    if (!resolved) {
      this.broadcast({ type: "log", message: "No configured model. Add one in the Chatllm app first." });
      return;
    }
    let conversation = session.remote && session.conversationId ? this.conversations.get(session.conversationId) ?? null : null;
    if (!conversation) {
      conversation = await this.createSessionConversation(content);
      if (!conversation) return;
      this.conversations.set(conversation.id, conversation);
      this.messagesCache.set(conversation.id, []);
      this.draftSession = null;
      this.activeSessionId = conversation.id;
      await this.persistActive();
      session = this.sessionFromConversation(conversation);
    }
    const conversationId = conversation.id;
    const settings = readSettings();
    const { command, rest } = this.detectCommand(content);
    const messages = this.messagesCache.get(conversationId) ?? [];
    const userMessage = {
      id: `local:user:${randomId()}`,
      conversationId,
      role: "user",
      content,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    messages.push(userMessage);
    const assistantMessage = {
      id: `local:asst:${randomId()}`,
      conversationId,
      role: "assistant",
      content: "",
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    messages.push(assistantMessage);
    this.messagesCache.set(conversationId, messages);
    this.broadcastActiveSession();
    this.broadcastSessions();
    const overrides = session.overrides;
    const chatMode = command ? command === "spec" ? "normal" : "agent" : overrides.chatMode ?? settings.chatMode;
    const useRag = overrides.useRag ?? settings.useRag;
    const toolsEnabled = command ? command === "spec" ? overrides.toolsEnabled ?? settings.toolsEnabled : true : overrides.toolsEnabled ?? settings.toolsEnabled;
    const body = {
      conversationId,
      provider: resolved.provider,
      model: resolved.model,
      modelSelection: settings.modelSelection,
      chatMode,
      content: rest || content,
      systemPrompt: command ? SPEC_SYSTEM_PROMPTS[command] : settings.systemPrompt || void 0,
      skillIds: overrides.skillIds ?? [],
      documentIds: [],
      useRag,
      toolsEnabled,
      mcpServerIds: overrides.mcpServerIds ?? [],
      agentIds: overrides.agentIds ?? [],
      maxAgentSpawns: this.catalog.maxAgentSpawns
    };
    const abort = new AbortController();
    this.streams.set(conversationId, { abort, messageId: assistantMessage.id });
    let buffer = "";
    try {
      const response = await streamChat(
        body,
        {
          onToken: (text) => {
            buffer += text;
            assistantMessage.content = buffer;
            this.broadcast({ type: "messageAppend", sessionId: conversationId, messageId: assistantMessage.id, chunk: text });
          },
          onToolEvent: (event) => {
            this.broadcast({
              type: "toolEvent",
              sessionId: conversationId,
              name: event.name,
              arguments: event.arguments ?? {}
            });
          }
        },
        abort.signal
      );
      const finalConversation = response.conversation;
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
            const note = `

_Wrote **${written}** task contract${written === 1 ? "" : "s"} for the active feature._`;
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
        conversationId
      });
      void this.refreshSingleConversation(conversationId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[chat] ${msg}`);
      if (abort.signal.aborted) {
        const note = `${buffer ? "\n\n" : ""}_Cancelled._`;
        assistantMessage.content = `${buffer}${note}`;
        this.broadcast({ type: "messageAppend", sessionId: conversationId, messageId: assistantMessage.id, chunk: note });
        this.broadcast({ type: "messageComplete", sessionId: conversationId, messageId: assistantMessage.id, conversationId });
      } else {
        this.broadcast({ type: "messageError", sessionId: conversationId, messageId: assistantMessage.id, error: msg });
      }
    } finally {
      this.streams.delete(conversationId);
    }
  }
  findSession(id) {
    if (id.startsWith("draft:") && this.draftSession?.id === id) return this.draftSession;
    const conv = this.conversations.get(id);
    return conv ? this.sessionFromConversation(conv) : null;
  }
  async createSessionConversation(firstMessage) {
    try {
      const title = deriveTitle(firstMessage);
      const conv = await createConversation(title);
      if (this.projectFolderId) {
        try {
          await addConversationToFolder(this.projectFolderId, conv.id);
        } catch (err) {
          this.output.appendLine(`[chat.attachFolder] ${err instanceof Error ? err.message : String(err)}`);
        }
        const folderName = this.projectFolder?.name ?? projectFolderName(this.project);
        try {
          const patched = await patchConversation(conv.id, { folder: folderName });
          return patched;
        } catch (err) {
          this.output.appendLine(`[chat.tagFolder] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return conv;
    } catch (err) {
      this.output.appendLine(`[chat.createConversation] ${err instanceof Error ? err.message : String(err)}`);
      this.broadcast({ type: "log", message: `Failed to create conversation: ${err instanceof Error ? err.message : err}` });
      return null;
    }
  }
  async refreshSingleConversation(id) {
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
  async writeGeneratedTasks(text) {
    const feature = this.store.getActiveFeature();
    if (!feature?.tasksDirUri) return 0;
    let written = 0;
    for (const block of extractTaskBlocks(text)) {
      const probe = vscode5.Uri.joinPath(feature.tasksDirUri, "_probe.md");
      const task = parseTaskContract(feature.id, probe, block.startsWith("---") ? block : `---
${block}
---
`);
      if (!task) continue;
      task.filePath = vscode5.Uri.joinPath(
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
          vscode5.Uri.joinPath(updated.tasksDirUri, "index.md"),
          regenerateTasksIndex(updated.tasks)
        );
      }
    }
    return written;
  }
  // ---------------------------------------------------------------------------
  // HTML
  // ---------------------------------------------------------------------------
  renderHtml(webview) {
    const scriptUri = webview.asWebviewUri(vscode5.Uri.joinPath(this.context.extensionUri, "media", "chat.js"));
    const styleUri = webview.asWebviewUri(vscode5.Uri.joinPath(this.context.extensionUri, "media", "webview.css"));
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
function emptyCatalog() {
  return { models: [], agents: [], skills: [], mcpServers: [], documents: [], maxAgentSpawns: 3 };
}
function catalogFromConfig(config, documents) {
  return {
    models: (config.configuredModels ?? []).filter((m) => m.enabled !== false),
    agents: config.agents ?? [],
    skills: config.skills ?? [],
    mcpServers: config.mcpServers ?? [],
    documents,
    maxAgentSpawns: config.maxAgentSpawns ?? 3
  };
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
var vscode6 = __toESM(require("vscode"));
var SpecStore = class {
  constructor(output) {
    this.output = output;
  }
  changeEmitter = new vscode6.EventEmitter();
  onDidChange = this.changeEmitter.event;
  features = /* @__PURE__ */ new Map();
  watcher;
  activeFeatureId;
  async initialize(context) {
    this.activeFeatureId = context.workspaceState.get("chatllm.activeFeatureId");
    this.watcher = vscode6.workspace.createFileSystemWatcher("**/.chatllm/specs/**/*.md");
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
    for (const folder of vscode6.workspace.workspaceFolders ?? []) {
      const root = vscode6.Uri.joinPath(folder.uri, ".chatllm", "specs");
      try {
        for (const [name, type] of await vscode6.workspace.fs.readDirectory(root)) {
          if (type === vscode6.FileType.Directory) {
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
    const rootUri = vscode6.Uri.joinPath(specsRoot, id);
    const featureMdUri = vscode6.Uri.joinPath(rootUri, "feature.md");
    const requirementsUri = vscode6.Uri.joinPath(rootUri, "requirements.md");
    const designUri = vscode6.Uri.joinPath(rootUri, "design.md");
    const tasksDirUri = vscode6.Uri.joinPath(rootUri, "tasks");
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
      for (const [fileName, fileType] of await vscode6.workspace.fs.readDirectory(tasksDirUri)) {
        if (fileType !== vscode6.FileType.File || !/^T-\d+.*\.md$/i.test(fileName)) continue;
        const filePath = vscode6.Uri.joinPath(tasksDirUri, fileName);
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
var vscode7 = __toESM(require("vscode"));
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
    await vscode7.workspace.getConfiguration("workbench").update("colorTheme", themeId, vscode7.ConfigurationTarget.Global);
  }
  async function applyColorOverrides(overrides) {
    if (!overrides || Object.keys(overrides).length === 0) return;
    const fingerprint = JSON.stringify(overrides);
    if (fingerprint === lastOverridesKey) return;
    lastOverridesKey = fingerprint;
    const config = vscode7.workspace.getConfiguration("workbench");
    const existing = config.get("colorCustomizations") ?? {};
    const next = { ...overrides };
    for (const [key, value] of Object.entries(existing)) {
      if (key.startsWith("[") && key.endsWith("]")) next[key] = value;
    }
    await config.update("colorCustomizations", next, vscode7.ConfigurationTarget.Global);
  }
  async function publishTheme() {
    const themeId = vscode7.workspace.getConfiguration("workbench").get("colorTheme");
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
  const listener = vscode7.workspace.onDidChangeConfiguration((event) => {
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
var vscode8 = __toESM(require("vscode"));
var RunsTreeProvider = class {
  constructor(writeback) {
    this.writeback = writeback;
  }
  emitter = new vscode8.EventEmitter();
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
      const tree2 = new vscode8.TreeItem(item.run.label, vscode8.TreeItemCollapsibleState.Expanded);
      tree2.description = item.run.status;
      return tree2;
    }
    const tree = new vscode8.TreeItem(item.nodeId);
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
var vscode9 = __toESM(require("vscode"));
var SpecsTreeProvider = class {
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
    if (item.kind === "feature") {
      const tree2 = new vscode9.TreeItem(item.feature.name, vscode9.TreeItemCollapsibleState.Expanded);
      tree2.description = item.feature.status;
      tree2.contextValue = "feature";
      tree2.iconPath = new vscode9.ThemeIcon("folder");
      tree2.command = { command: "chatllm.setActiveFeature", title: "Set Active", arguments: [item.feature.id] };
      return tree2;
    }
    const tree = new vscode9.TreeItem(item.label);
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
      f.tasksDirUri && { kind: "file", label: `tasks/index.md (${f.tasks.length})`, uri: vscode9.Uri.joinPath(f.tasksDirUri, "index.md") }
    ].filter(Boolean);
  }
};

// src/views/tasksTree.ts
var vscode10 = __toESM(require("vscode"));
var TasksTreeProvider = class {
  constructor(store2) {
    this.store = store2;
    store2.onDidChange(() => this.refresh());
  }
  emitter = new vscode10.EventEmitter();
  onDidChangeTreeData = this.emitter.event;
  refresh() {
    this.emitter.fire(void 0);
  }
  getTreeItem(item) {
    if (item.kind === "group") return new vscode10.TreeItem(item.label, vscode10.TreeItemCollapsibleState.Expanded);
    const tree = new vscode10.TreeItem(`${item.task.id}: ${item.task.title}`);
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
  initApiFromContext(context);
  const output = vscode11.window.createOutputChannel("Chatllm");
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
    vscode11.window.registerWebviewViewProvider(ChatllmPipelineController.viewType, pipeline, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode11.window.registerWebviewViewProvider(ChatllmChatPanelController.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode11.window.registerTreeDataProvider("chatllm.specs", specsTree),
    vscode11.window.registerTreeDataProvider("chatllm.tasks", tasksTree),
    vscode11.window.registerTreeDataProvider("chatllm.runs", runsTree),
    createThemeBridge(output),
    statusBar(),
    ...commands4(context, specsTree, tasksTree, runsTree)
  );
}
function commands4(context, specsTree, tasksTree, runsTree) {
  return [
    vscode11.commands.registerCommand("chatllm.openChat", () => chat.show()),
    vscode11.commands.registerCommand("chatllm.newChat", async () => {
      chat.show();
      await chat.newSession();
    }),
    vscode11.commands.registerCommand("chatllm.openSettings", () => chat.openSettings()),
    vscode11.commands.registerCommand("chatllm.openPipeline", () => pipeline.show()),
    vscode11.commands.registerCommand("chatllm.refreshSpecs", async () => {
      await store.refresh();
      specsTree.refresh();
    }),
    vscode11.commands.registerCommand("chatllm.refreshTasks", async () => {
      await store.refresh();
      tasksTree.refresh();
    }),
    vscode11.commands.registerCommand("chatllm.refreshRuns", () => runsTree.refresh()),
    vscode11.commands.registerCommand("chatllm.scaffoldFeature", async () => {
      const folder = vscode11.workspace.workspaceFolders?.[0];
      const name = await vscode11.window.showInputBox({ prompt: "Feature name" });
      if (!folder || !name) return;
      const root = await scaffoldFeature(folder, name);
      const id = root.path.split("/").pop() ?? name;
      store.setActiveFeature(id);
      await context.workspaceState.update("chatllm.activeFeatureId", id);
      await store.refresh();
      specsTree.refresh();
    }),
    vscode11.commands.registerCommand("chatllm.setActiveFeature", async (id) => {
      store.setActiveFeature(id);
      await context.workspaceState.update("chatllm.activeFeatureId", id);
      tasksTree.refresh();
    }),
    vscode11.commands.registerCommand("chatllm.openTask", async (arg) => {
      const task = arg && store.getTask(arg.featureId, arg.task.id);
      if (task) await vscode11.window.showTextDocument(task.filePath);
    }),
    vscode11.commands.registerCommand("chatllm.runTask", async (arg) => {
      const feature = arg && store.getFeature(arg.featureId);
      if (!feature || !arg) return;
      await pipeline.dispatch(feature.id, [arg.task.id]);
    }),
    vscode11.commands.registerCommand("chatllm.markTaskReady", async (arg) => {
      const task = arg && store.getTask(arg.featureId, arg.task.id);
      if (task) await updateTaskStatus(task.filePath, "ready");
      await store.refresh();
    }),
    vscode11.commands.registerCommand("chatllm.dispatchFeature", async () => {
      const feature = store.getActiveFeature();
      if (!feature) return;
      await pipeline.dispatch(feature.id);
    }),
    vscode11.commands.registerCommand("chatllm.regenerateTasksIndex", async () => {
      const feature = store.getActiveFeature();
      if (feature?.tasksDirUri) await writeTextFile(vscode11.Uri.joinPath(feature.tasksDirUri, "index.md"), regenerateTasksIndex(feature.tasks));
    }),
    vscode11.commands.registerCommand("chatllm.cancelRun", async () => {
      const graphId = await vscode11.window.showInputBox({ prompt: "Graph id to cancel" });
      if (graphId) await cancelExecutionGraph(graphId);
    })
  ];
}
function statusBar() {
  const item = vscode11.window.createStatusBarItem(vscode11.StatusBarAlignment.Left, 100);
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
