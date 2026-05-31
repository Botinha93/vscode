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
var vscode12 = __toESM(require("vscode"));

// src/api.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var integrationPath;
var cachedIntegration;
function initApiFromContext(context) {
  integrationPath = (0, import_node_path.join)(context.globalStorageUri.fsPath, "../../../libervox-integration.json");
  cachedIntegration = void 0;
}
function loadIntegrationFile() {
  if (cachedIntegration !== void 0) return cachedIntegration;
  const candidates = [
    process.env.LIBERVOX_INTEGRATION_FILE,
    process.env.CHATLLM_INTEGRATION_FILE,
    integrationPath
  ].filter((p) => Boolean(p));
  for (const path2 of candidates) {
    try {
      if ((0, import_node_fs.existsSync)(path2)) {
        cachedIntegration = JSON.parse((0, import_node_fs.readFileSync)(path2, "utf8"));
        return cachedIntegration;
      }
    } catch {
    }
  }
  cachedIntegration = null;
  return null;
}
function getApiOrigin() {
  const fromEnv = process.env.LIBERIDE_API_ORIGIN ?? process.env.CHATLLM_API_ORIGIN;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return (loadIntegrationFile()?.apiOrigin || "").replace(/\/$/, "");
}
function getAuthToken() {
  const fromEnv = process.env.LIBERIDE_AUTH_TOKEN ?? process.env.CHATLLM_AUTH_TOKEN;
  if (fromEnv) return fromEnv;
  return loadIntegrationFile()?.authToken || "";
}
function authHeaders(extra) {
  const headers = { "Content-Type": "application/json", ...extra ?? {} };
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
async function apiFetch(path2, init) {
  const origin = getApiOrigin();
  if (!origin) throw new Error("LIBERIDE_API_ORIGIN is not set.");
  return fetch(path2.startsWith("http") ? path2 : `${origin}${path2}`, {
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
async function uploadDocument(file) {
  const form = new FormData();
  const bytes = file.bytes.slice();
  const blob = new Blob([bytes], { type: file.mimeType ?? "application/octet-stream" });
  form.append("file", blob, file.name);
  const token = getAuthToken();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await apiFetch("/api/documents", { method: "POST", body: form, headers });
  const payload = await readJson(response);
  return payload.document;
}
function subscribeConversationListSync(onChange) {
  const origin = getApiOrigin();
  if (!origin) {
    const poll = setInterval(onChange, 3e4);
    return () => clearInterval(poll);
  }
  let closed = false;
  let pollTimer = null;
  const abort = new AbortController();
  const startPoll = () => {
    if (pollTimer || closed) return;
    pollTimer = setInterval(onChange, 3e4);
  };
  void (async () => {
    try {
      const response = await fetch(`${origin}/api/conversations/stream`, {
        headers: authHeaders({ Accept: "text/event-stream" }),
        signal: abort.signal
      });
      if (!response.ok || !response.body) {
        startPoll();
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const MAX_SSE_BUFFER_BYTES = 1e6;
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_SSE_BUFFER_BYTES) {
          console.warn("[liberide] SSE buffer exceeded limit \u2014 resetting stream");
          reader.cancel().catch(() => void 0);
          if (!closed) startPoll();
          return;
        }
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === "conversations_changed" || data.type === "folders_changed") {
              onChange();
            }
          } catch {
          }
        }
      }
    } catch {
      if (!closed) startPoll();
    }
  })();
  return () => {
    closed = true;
    abort.abort();
    if (pollTimer) clearInterval(pollTimer);
  };
}

// src/panel/panel.ts
var vscode3 = __toESM(require("vscode"));

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

// src/settings.ts
var vscode = __toESM(require("vscode"));
var SECTION = "liberide";
function readSettings() {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    modelSelection: cfg.get("modelSelection") ?? "manual",
    chatMode: "agent",
    useRag: cfg.get("useRag") ?? false,
    toolsEnabled: true,
    systemPrompt: cfg.get("systemPrompt") ?? "",
    copilotUiEnabled: cfg.get("copilot.enabled") ?? false,
    copilotModelsEnabled: cfg.get("copilot.modelsEnabled") ?? true,
    defaultAllowedAgentIds: cfg.get("defaultAllowedAgentIds") ?? []
  };
}
var FLAT_TO_DOTTED = {
  copilotUiEnabled: "copilot.enabled",
  copilotModelsEnabled: "copilot.modelsEnabled"
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
function unquoteScalar(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (first === '"' && last === '"' || first === "'" && last === "'") {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}
function parseInlineArray(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((v) => unquoteScalar(v)).filter((v) => v.length > 0);
}
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };
  const data = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^\s/.test(line)) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    if (rawValue === "|") {
      const block = [];
      while (lines[i + 1]?.startsWith("  ")) block.push(lines[++i].slice(2));
      data[key] = block.join("\n");
    } else if (rawValue.startsWith("[")) {
      data[key] = parseInlineArray(rawValue);
    } else if (rawValue === "") {
      const items = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const dashMatch = next.match(/^\s+-\s+(.*)$/);
        if (!dashMatch) break;
        items.push(unquoteScalar(dashMatch[1]));
        i += 1;
      }
      data[key] = items.length > 0 ? items : "";
    } else {
      data[key] = unquoteScalar(rawValue);
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
  const root = vscode2.Uri.joinPath(folder.uri, ".liberide", "specs", slug);
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
var LiberidePipelineController = class _LiberidePipelineController {
  constructor(context, store2, output, runsTree) {
    this.context = context;
    this.store = store2;
    this.output = output;
    this.runsTree = runsTree;
    this.disposables.push(
      onSettingsChange((settings) => this.broadcast({ type: "settings", settings })),
      this.store.onDidChange(() => this.broadcastFeatures())
    );
  }
  static viewType = "liberide.pipeline";
  view;
  disposables = [];
  graphs = /* @__PURE__ */ new Map();
  resolveWebviewView(view) {
    this.view = view;
    this.bindWebview(view.webview);
    view.onDidDispose(() => {
      if (this.view === view) this.view = void 0;
      for (const g of this.graphs.values()) g.dispose();
      this.graphs.clear();
    });
  }
  show() {
    void vscode3.commands.executeCommand(`${_LiberidePipelineController.viewType}.focus`);
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
          await this.context.workspaceState.update("liberide.activeFeatureId", message.featureId);
          this.broadcastFeatures();
          break;
        case "scaffoldFeature":
          await this.scaffold(message.name);
          break;
        case "dispatchFeature":
          await this.dispatch(message.featureId, message.taskIds);
          break;
        case "cancelGraph":
          await this.cancel(message.graphId);
          break;
        case "openTask": {
          const task = this.store.getTask(message.featureId, message.taskId);
          if (task) await vscode3.window.showTextDocument(task.filePath);
          break;
        }
        case "openChat":
          await vscode3.commands.executeCommand("liberide.openChat");
          break;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[pipeline] ${msg}`);
      this.broadcast({ type: "operation", action: message.type === "scaffoldFeature" ? "scaffold" : message.type === "cancelGraph" ? "cancel" : "dispatch", status: "error", message: msg });
      this.broadcast({ type: "log", message: msg, severity: "error" });
    }
  }
  async scaffold(name) {
    this.broadcast({ type: "operation", action: "scaffold", status: "running" });
    const folder = vscode3.workspace.workspaceFolders?.[0];
    if (!folder) {
      const message = "Open a workspace folder to scaffold a feature.";
      this.broadcast({ type: "operation", action: "scaffold", status: "error", message });
      this.broadcast({ type: "log", message, severity: "warning" });
      return;
    }
    const root = await scaffoldFeature(folder, name);
    const id = root.path.split("/").pop() ?? name;
    this.store.setActiveFeature(id);
    await this.context.workspaceState.update("liberide.activeFeatureId", id);
    await this.store.refresh();
    this.broadcast({ type: "operation", action: "scaffold", status: "success", message: `Created ${name}.` });
  }
  async dispatch(featureId, taskIds) {
    this.broadcast({ type: "operation", action: "dispatch", status: "running" });
    const feature = this.store.getFeature(featureId);
    if (!feature) {
      const message = `Unknown feature ${featureId}`;
      this.broadcast({ type: "operation", action: "dispatch", status: "error", message });
      this.broadcast({ type: "log", message, severity: "error" });
      return;
    }
    const tasks = taskIds?.length ? feature.tasks.filter((t) => taskIds.includes(t.id)) : feature.tasks;
    const validation = validateDag(tasks);
    if (!validation.ok) {
      const message = `Cannot dispatch: ${validation.error}`;
      this.broadcast({ type: "operation", action: "dispatch", status: "error", message });
      this.broadcast({ type: "log", message, severity: "warning" });
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
    this.runsTree.trackRun(result.graphId, feature.id, startEvent.label, tasks.map((task) => task.id));
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
    this.broadcast({ type: "operation", action: "dispatch", status: "success", message: `Dispatched ${startEvent.label}.` });
  }
  async cancel(graphId) {
    this.broadcast({ type: "operation", action: "cancel", status: "running" });
    await cancelExecutionGraph(graphId);
    this.graphs.get(graphId)?.dispose();
    this.graphs.delete(graphId);
    this.runsTree.cancelRun(graphId);
    this.broadcast({ type: "graphDone", payload: { graphId, status: "cancelled" } });
    this.broadcast({ type: "operation", action: "cancel", status: "success", message: `Cancelled ${graphId}.` });
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
  <title>LiberIDE Pipeline</title>
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
var vscode6 = __toESM(require("vscode"));

// src/project/identity.ts
var vscode4 = __toESM(require("vscode"));
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
function gitExec(args, cwd) {
  return new Promise((resolve2) => {
    (0, import_node_child_process.execFile)("git", args, { cwd, timeout: 5e3, windowsHide: true }, (err, stdout) => {
      if (err) return resolve2(null);
      resolve2(stdout.toString().trim());
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
function projectConversationTag(identity) {
  return `ide-project:${identity.id}`;
}
function conversationHasProjectTag(identity, tags) {
  if (!tags?.length || identity.source === "none") return false;
  return tags.includes(projectConversationTag(identity));
}

// ../../../packages/shared/src/chat-commands.ts
function detectIdeSpecSlashCommand(content) {
  const trimmed = content.trimStart();
  const match = trimmed.match(/^\/(spec|design|tasks)(\s|$)/);
  if (!match) return { rest: content };
  return {
    command: match[1],
    rest: trimmed.slice(match[0].length).trimStart()
  };
}

// src/chat/commands.ts
var SPEC_SYSTEM_PROMPTS = {
  spec: "Draft EARS-style feature requirements in markdown using ## R-N section ids.",
  design: "Draft design.md from requirements. Use ## D-N section ids and reference R-* ids.",
  tasks: `Generate task contracts. Each task must be in a fenced \`\`\`task block with YAML frontmatter containing id, title, status, requirement_refs, design_refs, depends_on, expected_files, architecture_hints, acceptance, and agent.`
};
var PIPELINE_INTERVIEW_SYSTEM_PROMPT = `You are a feature-pipeline interviewer for a software team. Your job is to gather just enough information to draft a feature pipeline (requirements, design, and task contracts) for the user's idea.

Conduct a focused interview:
- Ask SHORT clarifying questions, grouped one batch per turn (2-5 questions max), covering:
  - scope (what's in vs out),
  - target users / use cases,
  - inputs and outputs (data, files, APIs),
  - constraints (performance, security, compatibility, deadlines),
  - integrations and existing systems to touch.
- Respond in plain markdown only. Do NOT edit files, run tools, or emit code blocks. This is a planning conversation.
- Acknowledge what the user already told you before asking more. Avoid repeating questions.
- Do not fabricate facts. If the user is vague, ask follow-ups instead of guessing.

When you have enough information to draft requirements, design, and tasks (and ONLY then), end your message with a single line of exactly this form, nothing after it:

[[PIPELINE_READY: <kebab-case-feature-name>]]

The marker must appear on its own line as the very last line of the message. Never emit the marker before you have sufficient information to draft the pipeline.`;
var PIPELINE_GENERATE_SYSTEM_PROMPT = `You are generating a complete feature pipeline on this single turn. Emit plain markdown structured EXACTLY as follows, with no prose outside this structure:

[[FEATURE_NAME: <kebab-case-feature-name>]]

# Requirements

## R-1 <short title>
<EARS-style requirement statement, e.g. "When <trigger>, the <system> shall <response>.">

## R-2 <short title>
<...>

# Design

## D-1 <short title>
<design note referencing R-* ids where applicable>

## D-2 <short title>
<...>

\`\`\`task
id: T-1
title: <imperative title>
status: ready
requirement_refs: [R-1, R-2]
design_refs: [D-1]
depends_on: []
expected_files: [path/to/file.ts]
architecture_hints: |
  Multi-line hints describing the approach,
  data flow, and components to touch.
acceptance: [First acceptance bullet, Second acceptance bullet]
agent: coder
\`\`\`

\`\`\`task
id: T-2
title: <...>
status: ready
requirement_refs: [R-2]
design_refs: [D-2]
depends_on: [T-1]
expected_files: [path/to/other.ts]
architecture_hints: |
  ...
acceptance: [<bullet 1>, <bullet 2>]
agent: coder
\`\`\`

Rules:
- The first line MUST be the [[FEATURE_NAME: ...]] marker. No leading whitespace, no other text on that line.
- Use EARS-style requirement statements ("When X, the system shall Y" / "While X, ..." / "Where X, ...").
- Every \`## R-N\` and \`## D-N\` heading must use a unique id.
- Emit one or more fenced \`\`\`task blocks. Each block must contain valid YAML frontmatter with: id, title, status, requirement_refs, design_refs, depends_on, expected_files, architecture_hints, acceptance, agent.
- For list fields (\`requirement_refs\`, \`design_refs\`, \`depends_on\`, \`expected_files\`, \`acceptance\`), use either inline \`[a, b]\` arrays or block-style YAML lists (\`key:\` then indented \`- item\` lines) for list fields. Prefer block-style when items contain commas or are long sentences. Use \`[]\` for empty lists.
- \`architecture_hints\` MUST be a YAML block string introduced by \`|\` and its continuation lines indented by two spaces.
- Tasks must form a valid DAG: every id in \`depends_on\` must reference an earlier task's \`id\`.
- Use status \`ready\`.
- Do NOT emit a [[PIPELINE_READY]] marker. Do NOT add prose before or after the structure above.`;
function extractTaskBlocks(content) {
  const blocks = [];
  const re = /```task\s*([\s\S]*?)```/gi;
  let match;
  while ((match = re.exec(content)) !== null) blocks.push(match[1].trim());
  return blocks;
}

// src/chat/models.ts
var PROVIDER_LABELS = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  google: "Google",
  copilot: "GitHub Copilot",
  ollama: "Ollama",
  "ollama-internal": "Ollama (internal)",
  llamacpp: "llama.cpp",
  lmstudio: "LM Studio",
  custom: "Custom"
};
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

// src/chat/copilot-lm.ts
var vscode5 = __toESM(require("vscode"));
async function listCopilotLmModels() {
  const models = await vscode5.lm.selectChatModels({ vendor: "copilot" });
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return models.map((m) => ({
    id: `lm:copilot:${m.id}`,
    provider: "copilot",
    modelId: m.id,
    displayName: m.name || `${PROVIDER_LABELS.copilot} \xB7 ${m.id}`,
    description: m.family ? `${m.family}${m.version ? ` \xB7 ${m.version}` : ""}` : void 0,
    capabilities: capabilitiesFromLm(m),
    apiKeyConfigured: true,
    contextWindow: m.maxInputTokens,
    enabled: true,
    createdAt: now,
    updatedAt: now
  }));
}
function capabilitiesFromLm(model) {
  const caps = /* @__PURE__ */ new Set(["chat", "tools"]);
  const id = `${model.vendor}/${model.family}/${model.id}`.toLowerCase();
  if (id.includes("vision") || id.includes("vl") || id.includes("4o")) caps.add("vision");
  if (id.includes("code") || id.includes("coder")) caps.add("code");
  if (model.maxInputTokens && model.maxInputTokens >= 128e3) caps.add("long-context");
  return [...caps];
}
function isImage(mime) {
  return mime.toLowerCase().startsWith("image/");
}
function toLmMessages(history) {
  return history.map(
    (m) => m.role === "user" ? vscode5.LanguageModelChatMessage.User(m.content) : vscode5.LanguageModelChatMessage.Assistant(m.content)
  );
}
function buildUserMessage(prompt, attachments) {
  if (!attachments.length) return vscode5.LanguageModelChatMessage.User(prompt);
  const parts = [
    new vscode5.LanguageModelTextPart(prompt)
  ];
  for (const attachment of attachments) {
    if (isImage(attachment.mimeType)) {
      parts.push(vscode5.LanguageModelDataPart.image(attachment.data, attachment.mimeType));
    } else {
      parts.push(new vscode5.LanguageModelDataPart(attachment.data, attachment.mimeType));
    }
  }
  return vscode5.LanguageModelChatMessage.User(parts);
}
async function streamCopilotChat(input) {
  const [model] = await vscode5.lm.selectChatModels({ vendor: "copilot", id: input.modelId });
  if (!model) throw new Error(`Copilot model not available: ${input.modelId}`);
  const toolEvents = [];
  let content = "";
  const cancellation = new vscode5.CancellationTokenSource();
  if (input.signal) {
    if (input.signal.aborted) cancellation.cancel();
    else input.signal.addEventListener("abort", () => cancellation.cancel(), { once: true });
  }
  const modelCaps = capabilitiesFromLm(model);
  const usable = [];
  const skippedAttachments = [];
  for (const attachment of input.attachments ?? []) {
    if (isImage(attachment.mimeType) && modelCaps.includes("vision")) {
      usable.push(attachment);
    } else {
      skippedAttachments.push(attachment);
    }
  }
  const tools = input.toolsEnabled ? await buildToolStubs() : [];
  const messages = [
    ...toLmMessages(input.history),
    buildUserMessage(input.prompt, usable)
  ];
  const runOnce = async () => {
    return model.sendRequest(messages, { tools, toolMode: vscode5.LanguageModelChatToolMode.Auto }, cancellation.token);
  };
  let response = await runOnce();
  for await (const part of response.stream) {
    if (typeof part === "string") continue;
    if (part.type === "text") {
      const text = part.value;
      content += text;
      input.onToken(text);
      continue;
    }
    if (part.type === "tool_call") {
      const call = part;
      const event = {
        id: call.callId,
        name: call.name,
        arguments: call.input,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      toolEvents.push(event);
      input.onToolEvent(event);
      const result = await invokeBackendTool({
        name: call.name,
        arguments: call.input
      });
      const done = { ...event, result: result.result ?? JSON.stringify(result), createdAt: event.createdAt };
      toolEvents.push(done);
      input.onToolEvent(done);
      messages.push(vscode5.LanguageModelChatMessage.Assistant([call]));
      messages.push(vscode5.LanguageModelChatMessage.User([new vscode5.LanguageModelToolResultPart(call.callId, [result.result ?? ""])]));
      response = await runOnce();
    }
  }
  if (!content) {
    for await (const token of response.text) {
      content += token;
      input.onToken(token);
    }
  }
  return { content, toolEvents, skippedAttachments };
}
async function buildToolStubs() {
  const names = [
    "ide_read_file",
    "ide_edit_file",
    "ide_write_file",
    "ide_list_directory",
    "ide_search_code",
    "terminal_run",
    "ide_run_command"
  ];
  return names.map((name) => ({
    name,
    description: `Invoke ${name} via ChatLLM backend`,
    inputSchema: { type: "object" }
  }));
}
function buildIdeContextForInvoke() {
  const folder = vscode5.workspace.workspaceFolders?.[0];
  if (!folder) return void 0;
  return {
    sessionId: `vscode-${folder.name}`,
    userId: "default",
    projectPath: folder.uri.fsPath,
    mode: "desktop",
    terminalExecutor: "client"
  };
}
async function invokeBackendTool(body) {
  const ideContext = buildIdeContextForInvoke();
  const response = await apiFetch("/api/tools/invoke", {
    method: "POST",
    headers: ideContext ? { "X-Terminal-Executor": "client" } : void 0,
    body: JSON.stringify({ ...body, ideContext })
  });
  if (!response.ok) {
    const err = await response.text().catch(() => response.statusText);
    throw new Error(err || response.statusText);
  }
  const event = await response.json();
  return { result: event.result };
}

// src/chat/stream-client.ts
async function streamChat(body, handlers, signal) {
  const response = await apiFetch("/api/chat/stream", {
    method: "POST",
    headers: {
      "X-Terminal-Executor": body.ideContext?.terminalExecutor === "client" ? "client" : "server"
    },
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
    let data;
    try {
      data = JSON.parse(dataLine);
    } catch {
      console.warn("[stream-client] could not parse SSE chunk:", dataLine.slice(0, 200));
      return;
    }
    if (event === "token") handlers.onToken?.(data.token);
    if (event === "tool") handlers.onToolEvent?.(data);
    if (event === "terminal_delegate") {
      void handlers.onTerminalDelegate?.(data);
    }
    if (event === "markdown") handlers.onMarkdown?.(data.content);
    if (event === "diff") handlers.onDiff?.(data);
    if (event === "plan") handlers.onPlan?.(data);
    if (event === "todo") handlers.onTodo?.(data);
    if (event === "follow_up") handlers.onFollowUp?.(data);
    if (event === "error") throw new Error(data.error);
    if (event === "done") finalResponse = data;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) consume(part);
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
  } finally {
    reader.cancel().catch(() => void 0);
  }
  if (!finalResponse) throw new Error("Stream ended before the chat response completed.");
  return finalResponse;
}

// src/terminal/local-runner.ts
var import_child_process = require("child_process");
var path = __toESM(require("path"));
var MAX_OUTPUT = 1e5;
function truncate(text) {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}
... [output truncated]`;
}
function shellArgv(command) {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec ?? "cmd.exe";
    return { argv: [comspec, "/d", "/s", "/c", command], cwd: "" };
  }
  const shell = process.env.SHELL ?? "/bin/sh";
  return { argv: [shell, "-c", command], cwd: "" };
}
function runLocalTerminal(delegate) {
  const cwd = path.resolve(delegate.cwd || delegate.projectPath);
  const { argv } = shellArgv(delegate.command);
  const timeoutMs = delegate.timeoutMs > 0 ? delegate.timeoutMs : 12e4;
  return new Promise((resolve2) => {
    const proc = (0, import_child_process.spawn)(argv[0], argv.slice(1), {
      cwd,
      env: {
        ...process.env,
        HOME: delegate.projectPath
      },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve2({
        exitCode: code,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        timedOut
      });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve2({
        exitCode: 1,
        stdout: "",
        stderr: err.message,
        timedOut: false
      });
    });
  });
}

// src/chat/chat-panel.ts
var import_node_child_process2 = require("node:child_process");
var import_node_path2 = require("node:path");
var OVERRIDES_STORAGE_KEY = "liberide.chat.overrides";
var ACTIVE_SESSION_STORAGE_KEY = "liberide.chat.activeSession";
function resolveAllowedAgentIds(agents, configured) {
  const invokable = agents.filter((agent) => !agent.disableModelInvocation).map((agent) => agent.id);
  if (!configured?.length) return invokable;
  return configured.filter((id) => invokable.includes(id));
}
function toolActivityKind(name) {
  if (name === "request_approval") return "approval";
  if (name === "agent" || name === "agent_group" || name === "agent_result") return "agent";
  if (name === "web") return "web";
  if (name === "mcp" || name.startsWith("mcp_")) return "mcp";
  if (name === "ide_read_file" || name === "ide_list_directory" || name === "read" || name === "find_symbol" || name === "find_references" || name === "find_implementations" || name === "find_callers" || name === "find_dependencies" || name === "find_test_for_file" || name === "find_related_code") {
    return "reading";
  }
  if (name === "ide_search_code" || name === "search" || name === "recall") return "searching";
  if (name === "ide_write_file" || name === "ide_edit_file" || name === "userspace" || name === "artifact") return "writing";
  return "executing";
}
var LiberideChatPanelController = class _LiberideChatPanelController {
  constructor(context, store2, output) {
    this.context = context;
    this.store = store2;
    this.output = output;
    this.overrides = this.context.workspaceState.get(OVERRIDES_STORAGE_KEY, {});
    this.activeSessionId = this.context.workspaceState.get(ACTIVE_SESSION_STORAGE_KEY, null);
    const storedKinds = this.context.workspaceState.get("liberide.chat.sessionKinds") ?? {};
    for (const [id, kind] of Object.entries(storedKinds)) this.sessionKinds.set(id, kind);
    this.disposables.push(
      onSettingsChange((settings) => this.broadcast({ type: "settings", settings })),
      vscode6.workspace.onDidChangeWorkspaceFolders(() => {
        void this.onWorkspaceFoldersChanged();
      })
    );
    this.conversationSyncDispose = subscribeConversationListSync(() => {
      void this.refreshConversations();
    });
  }
  static viewType = "liberide.chat";
  view;
  disposables = [];
  streams = /* @__PURE__ */ new Map();
  conversationSyncDispose;
  project = { id: "none", source: "none", name: "" };
  projectFolderId = null;
  projectFolder;
  catalog = emptyCatalog();
  backendStatus = "unconfigured";
  conversations = /* @__PURE__ */ new Map();
  messagesCache = /* @__PURE__ */ new Map();
  static MAX_CACHED_CONVERSATIONS = 20;
  attachmentBytes = /* @__PURE__ */ new Map();
  overrides = {};
  sessionKinds = /* @__PURE__ */ new Map();
  /** conversationId -> set of message ids whose pipeline-ready card has been consumed. */
  consumedPipelineCards = /* @__PURE__ */ new Map();
  /** Locally-staged session for "new chat" before the first message creates it on the backend. */
  draftSession = null;
  activeSessionId = null;
  async onWorkspaceFoldersChanged() {
    this.project = await detectProjectIdentity();
    await this.ensureProjectFolder();
    await this.refreshConversations();
    this.broadcast({ type: "project", project: this.projectInfo() });
  }
  resolveWebviewView(view) {
    this.view = view;
    this.bindWebview(view.webview);
    view.onDidDispose(() => {
      if (this.view === view) this.view = void 0;
    });
  }
  show() {
    void vscode6.commands.executeCommand(`${_LiberideChatPanelController.viewType}.focus`);
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
  openChatHistory() {
    this.show();
    this.broadcast({ type: "openSidebar" });
  }
  async renameActiveChat() {
    this.show();
    const session = this.activeSession();
    if (!session) {
      void vscode6.window.showInformationMessage("No active chat to rename.");
      return;
    }
    const next = await vscode6.window.showInputBox({
      prompt: "Rename chat",
      value: session.title
    });
    if (next == null) return;
    await this.renameSession(session.id, next);
  }
  dispose() {
    this.conversationSyncDispose?.();
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
        vscode6.Uri.joinPath(this.context.extensionUri, "media"),
        vscode6.Uri.joinPath(this.context.extensionUri, "resources")
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
          await writeSetting(message.key, message.value);
          break;
        case "openSettings":
          this.broadcast({ type: "openSettings" });
          break;
        case "openPipeline":
          await vscode6.commands.executeCommand("liberide.openPipeline");
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
      try {
        if (!readSettings().copilotModelsEnabled) throw new Error("Copilot LM disabled");
        const localCopilot = await listCopilotLmModels();
        const merged = /* @__PURE__ */ new Map();
        for (const m of this.catalog.models) merged.set(`${m.provider}:${m.modelId}`, m);
        for (const m of localCopilot) merged.set(`${m.provider}:${m.modelId}`, m);
        this.catalog.models = [...merged.values()];
      } catch {
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
  conversationBelongsToProject(conv) {
    if (this.project.source === "none") return true;
    const folderName = projectFolderName(this.project);
    if (conv.folder === folderName) return true;
    if (this.projectFolderId && conv.folderIds?.includes(this.projectFolderId)) return true;
    if (conversationHasProjectTag(this.project, conv.tags)) return true;
    return false;
  }
  conversationFullyAssignedToProject(conv) {
    if (!this.projectFolderId) return false;
    const folderName = projectFolderName(this.project);
    return conv.folder === folderName && Boolean(conv.folderIds?.includes(this.projectFolderId));
  }
  async syncProjectConversations(all) {
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
  async refreshConversations() {
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
    if (this.messagesCache.has(conversationId)) {
      const cached = this.messagesCache.get(conversationId);
      this.messagesCache.delete(conversationId);
      this.messagesCache.set(conversationId, cached);
      return;
    }
    if (this.messagesCache.size >= _LiberideChatPanelController.MAX_CACHED_CONVERSATIONS) {
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
  makeDraft() {
    const now = Date.now();
    const id = `draft:${randomId()}`;
    const kind = "vibe";
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
      kind
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
        remote: false,
        kind: this.draftSession.kind
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
        kind: this.sessionKinds.get(c.id) ?? "vibe"
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
    const consumed = this.consumedPipelineCards.get(conv.id);
    const messages = cached.filter((m) => m.role === "user" || m.role === "assistant").map((m) => {
      const base = {
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: new Date(m.createdAt).getTime() || Date.now(),
        status: "complete"
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
      kind
    };
  }
  markPipelineCardConsumed(conversationId, messageId) {
    let set = this.consumedPipelineCards.get(conversationId);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.consumedPipelineCards.set(conversationId, set);
    }
    if (set.has(messageId)) return;
    set.add(messageId);
    this.broadcastSessions();
    if (this.activeSessionId === conversationId) this.broadcastActiveSession();
  }
  conversationOverrides(conv) {
    const stored = this.overrides[conv.id] ?? {};
    const settings = readSettings();
    const defaultAllowed = resolveAllowedAgentIds(this.catalog.agents, settings.defaultAllowedAgentIds);
    return {
      provider: conv.provider ?? stored.provider,
      model: conv.model ?? stored.model,
      chatMode: "agent",
      useRag: stored.useRag,
      toolsEnabled: true,
      agentId: conv.agentId ?? stored.agentId,
      allowedAgentIds: conv.allowedAgentIds?.length ? conv.allowedAgentIds : stored.allowedAgentIds?.length ? stored.allowedAgentIds : defaultAllowed,
      skillIds: stored.skillIds,
      mcpServerIds: stored.mcpServerIds,
      documentIds: stored.documentIds ?? []
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
  async persistSessionKinds() {
    await this.context.workspaceState.update("liberide.chat.sessionKinds", Object.fromEntries(this.sessionKinds));
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
  async updateSessionKind(id, kind) {
    this.sessionKinds.set(id, kind);
    if (id.startsWith("draft:") && this.draftSession?.id === id) {
      this.draftSession.kind = kind;
      this.draftSession.updatedAt = Date.now();
    }
    await this.persistSessionKinds();
    this.broadcastSessions();
    this.broadcastActiveSession();
  }
  async attachFiles(sessionId) {
    if (this.backendStatus !== "ok") {
      this.broadcast({ type: "log", message: "Connect to the LiberIDE backend before attaching files." });
      return;
    }
    const uris = await vscode6.window.showOpenDialog({ canSelectMany: true, openLabel: "Attach to chat" });
    if (!uris?.length) return;
    const uploadedIds = [];
    for (const uri of uris) {
      try {
        const bytes = await vscode6.workspace.fs.readFile(uri);
        const name = (0, import_node_path2.basename)(uri.fsPath);
        const document = await uploadDocument({ name, bytes });
        uploadedIds.push(document.id);
        this.attachmentBytes.set(document.id, { data: bytes, mimeType: document.mimeType, name: document.name });
        if (!this.catalog.documents.some((entry) => entry.id === document.id)) {
          this.catalog = { ...this.catalog, documents: [document, ...this.catalog.documents] };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`[chat.attach] ${msg}`);
        this.broadcast({ type: "log", message: `Failed to attach ${(0, import_node_path2.basename)(uri.fsPath)}: ${msg}` });
      }
    }
    if (!uploadedIds.length) return;
    const session = sessionId.startsWith("draft:") && this.draftSession?.id === sessionId ? this.draftSession : this.conversations.has(sessionId) ? this.sessionFromConversation(this.conversations.get(sessionId)) : null;
    if (!session) return;
    const current = session.overrides.documentIds ?? [];
    await this.updateOverrides(sessionId, { documentIds: [.../* @__PURE__ */ new Set([...current, ...uploadedIds])] });
    this.broadcast({ type: "catalog", catalog: this.catalog, backendStatus: this.backendStatus });
  }
  async removeAttachment(sessionId, documentId) {
    const session = sessionId.startsWith("draft:") && this.draftSession?.id === sessionId ? this.draftSession : this.conversations.has(sessionId) ? this.sessionFromConversation(this.conversations.get(sessionId)) : null;
    if (!session) return;
    const next = (session.overrides.documentIds ?? []).filter((id) => id !== documentId);
    await this.updateOverrides(sessionId, { documentIds: next });
    this.attachmentBytes.delete(documentId);
  }
  async updateOverrides(id, overrides) {
    const normalizedOverrides = { ...overrides };
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
    const merged = { ...this.overrides[id] ?? {}, ...normalizedOverrides };
    delete merged.chatMode;
    delete merged.toolsEnabled;
    this.overrides[id] = merged;
    await this.persistOverrides();
    const patch = {};
    if (normalizedOverrides.provider) patch.provider = toWireProvider(normalizedOverrides.provider);
    if (normalizedOverrides.model) patch.model = normalizedOverrides.model;
    if (normalizedOverrides.agentId !== void 0) patch.agentId = normalizedOverrides.agentId;
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
  resolveProviderModel(overrides) {
    const fromOverride = overrides.provider && overrides.model ? findConfiguredModel(this.catalog.models, overrides.provider, overrides.model) : void 0;
    const chosen = fromOverride ?? defaultEnabledModel(this.catalog.models);
    if (!chosen) return null;
    return { provider: toWireProvider(chosen.provider), model: chosen.modelId };
  }
  buildIdeContext(conversationId) {
    const folder = vscode6.workspace.workspaceFolders?.[0];
    if (!folder) return void 0;
    return {
      sessionId: `vscode-${folder.name}`,
      userId: "default",
      projectPath: folder.uri.fsPath,
      mode: "desktop",
      terminalExecutor: "client",
      conversationId
    };
  }
  async sendChat(sessionId, content) {
    let session = this.findSession(sessionId);
    if (!session) return;
    if (this.streams.has(sessionId)) {
      this.broadcast({ type: "log", message: "A response is already streaming for this chat." });
      return;
    }
    if (this.backendStatus !== "ok") {
      const hint = this.backendStatus === "unauthorized" ? "Not signed in to LiberIDE. Close VS Code and reopen the project from the LiberIDE desktop app while logged in." : "LiberIDE backend is unreachable. Check the LIBERIDE_API_ORIGIN setting.";
      this.broadcast({ type: "log", message: hint });
      return;
    }
    const resolved = this.resolveProviderModel(session.overrides);
    if (!resolved) {
      this.broadcast({ type: "log", message: "No configured model. Add one in the LiberIDE app first." });
      return;
    }
    let conversation = session.remote && session.conversationId ? this.conversations.get(session.conversationId) ?? null : null;
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
    const pipelineMode = !command && session.kind === "pipeline";
    const chatMode = "agent";
    const useRag = overrides.useRag ?? settings.useRag;
    const toolsEnabled = true;
    const systemPrompt = command ? SPEC_SYSTEM_PROMPTS[command] : pipelineMode ? PIPELINE_INTERVIEW_SYSTEM_PROMPT : settings.systemPrompt || void 0;
    const body = {
      conversationId,
      provider: resolved.provider,
      model: resolved.model,
      modelSelection: settings.modelSelection,
      chatMode,
      content: rest || content,
      systemPrompt,
      skillIds: pipelineMode ? [] : overrides.skillIds ?? [],
      documentIds: pipelineMode ? [] : overrides.documentIds ?? [],
      useRag: pipelineMode ? false : useRag,
      toolsEnabled,
      mcpServerIds: pipelineMode ? [] : overrides.mcpServerIds ?? [],
      agentId: pipelineMode ? void 0 : overrides.agentId,
      allowedAgentIds: pipelineMode ? [] : overrides.allowedAgentIds ?? [],
      maxAgentSpawns: this.catalog.maxAgentSpawns,
      ideContext: this.buildIdeContext(conversationId)
    };
    const abort = new AbortController();
    const streamStartedAt = Date.now();
    const streamState = {
      abort,
      messageId: assistantMessage.id,
      startedAt: streamStartedAt,
      tools: /* @__PURE__ */ new Map(),
      edits: /* @__PURE__ */ new Map()
    };
    this.streams.set(conversationId, streamState);
    this.broadcast({
      type: "messageStart",
      sessionId: conversationId,
      messageId: assistantMessage.id,
      startedAt: streamStartedAt
    });
    let buffer = "";
    try {
      const handlers = {
        onToken: (text) => {
          buffer += text;
          assistantMessage.content = buffer;
          this.broadcast({ type: "messageAppend", sessionId: conversationId, messageId: assistantMessage.id, chunk: text });
        },
        onToolEvent: (event) => {
          const update = applyToolEvent(streamState, event);
          if (!update) return;
          this.broadcast({
            type: "toolUpdate",
            sessionId: conversationId,
            messageId: assistantMessage.id,
            entry: update.entry,
            editedFiles: update.editedFiles
          });
        },
        onTerminalDelegate: async (delegate) => {
          this.broadcast({
            type: "log",
            message: `Running command locally: ${delegate.command.slice(0, 72)}${delegate.command.length > 72 ? "\u2026" : ""}`
          });
          const result = await runLocalTerminal(delegate);
          const complete = await apiFetch(`/api/ide/terminal/${encodeURIComponent(delegate.delegateId)}/complete`, {
            method: "POST",
            body: JSON.stringify(result)
          });
          if (!complete.ok) {
            const errText = await complete.text().catch(() => complete.statusText);
            throw new Error(errText || "Failed to report terminal output to API");
          }
        }
      };
      const useLocalCopilot = body.provider === "copilot" && readSettings().copilotModelsEnabled && await listCopilotLmModels().then((m) => m.some((x) => x.modelId === body.model)).catch(() => false);
      const copilotAttachments = useLocalCopilot ? body.documentIds.map((id) => this.attachmentBytes.get(id)).filter((entry) => !!entry) : [];
      const response = useLocalCopilot ? await streamCopilotChat({
        modelId: body.model,
        history: (messages ?? []).filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content })),
        prompt: body.content,
        toolsEnabled: body.toolsEnabled,
        attachments: copilotAttachments,
        onToken: handlers.onToken,
        onToolEvent: handlers.onToolEvent,
        signal: abort.signal
      }).then((r) => {
        if (r.skippedAttachments.length) {
          const names = r.skippedAttachments.map((a) => a.name).join(", ");
          this.broadcast({ type: "log", message: `Copilot model ignored unsupported attachments: ${names}.` });
        }
        return { assistantMessage: { id: assistantMessage.id, content: r.content } };
      }) : await streamChat(body, handlers, abort.signal);
      const finalConversation = "conversation" in response ? response.conversation : void 0;
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
        conversationId,
        completedAt: Date.now()
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
          completedAt: Date.now()
        });
      } else {
        this.broadcast({
          type: "messageError",
          sessionId: conversationId,
          messageId: assistantMessage.id,
          error: msg,
          completedAt: Date.now()
        });
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
  async assignConversationToProject(conv) {
    const conversationId = typeof conv === "string" ? conv : conv.id;
    const existing = typeof conv === "string" ? this.conversations.get(conv) : conv;
    if (this.project.source === "none") return existing ?? null;
    await this.ensureProjectFolder();
    if (!this.projectFolderId) return existing ?? null;
    const folderName = this.projectFolder?.name ?? projectFolderName(this.project);
    const projectTag = projectConversationTag(this.project);
    const tags = [.../* @__PURE__ */ new Set([...existing?.tags ?? [], projectTag])];
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
  async createSessionConversation(firstMessage, overrides = {}) {
    try {
      const title = deriveTitle(firstMessage);
      let conv = await createConversation(title);
      const settings = readSettings();
      const allowedAgentIds = overrides.allowedAgentIds?.length ? overrides.allowedAgentIds : resolveAllowedAgentIds(this.catalog.agents, settings.defaultAllowedAgentIds);
      const patch = {};
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
  async revealFile(relativePath) {
    const root = vscode6.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      this.broadcast({ type: "log", message: "No workspace folder open." });
      return;
    }
    const target = vscode6.Uri.joinPath(root, relativePath.replace(/^\/+/, ""));
    try {
      const doc = await vscode6.workspace.openTextDocument(target);
      await vscode6.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      this.broadcast({ type: "log", message: `Could not open ${relativePath}: ${err instanceof Error ? err.message : err}` });
    }
  }
  async undoEdit(relativePath) {
    const root = vscode6.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.broadcast({ type: "log", message: "No workspace folder open." });
      return;
    }
    const clean = relativePath.replace(/^\/+/, "");
    await new Promise((resolve2, reject) => {
      (0, import_node_child_process2.execFile)("git", ["checkout", "--", clean], { cwd: root, timeout: 15e3, windowsHide: true }, (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve2();
      });
    }).then(async () => {
      await this.revealFile(clean);
      this.broadcast({ type: "log", message: `Reverted ${clean} to last git state.`, severity: "info" });
    }).catch((err) => {
      this.broadcast({ type: "log", message: `Undo failed for ${clean}: ${err instanceof Error ? err.message : err}` });
    });
  }
  async writeGeneratedTasks(text) {
    const feature = this.store.getActiveFeature();
    if (!feature?.tasksDirUri) return 0;
    const written = await this.writeTaskContractsForFeature(feature.id, feature.tasksDirUri, text);
    if (written > 0) {
      await this.store.refresh();
      const updated = this.store.getFeature(feature.id);
      if (updated?.tasksDirUri) {
        await writeTextFile(
          vscode6.Uri.joinPath(updated.tasksDirUri, "index.md"),
          regenerateTasksIndex(updated.tasks)
        );
      }
    }
    return written;
  }
  async writeTaskContractsForFeature(featureId, tasksDirUri, text) {
    let written = 0;
    for (const block of extractTaskBlocks(text)) {
      const probe = vscode6.Uri.joinPath(tasksDirUri, "_probe.md");
      const task = parseTaskContract(
        featureId,
        probe,
        block.startsWith("---") ? block : `---
${block}
---
`
      );
      if (!task) continue;
      task.filePath = vscode6.Uri.joinPath(
        tasksDirUri,
        `${task.id}-${task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.md`
      );
      await writeTaskContract(task);
      written++;
    }
    return written;
  }
  async generatePipeline(sessionId, featureName) {
    const session = this.findSession(sessionId);
    if (!session) {
      this.broadcast({ type: "log", message: "Pipeline generation: session not found." });
      return;
    }
    const folder = vscode6.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.broadcast({ type: "log", message: "Open a workspace folder to scaffold a feature." });
      return;
    }
    if (!session.remote || !session.conversationId) {
      this.broadcast({
        type: "log",
        message: "Send at least one interview message before generating the pipeline."
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
    let root;
    try {
      root = await scaffoldFeature(folder, featureName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[chat.pipeline.scaffold] ${msg}`);
      this.broadcast({ type: "log", message: `Failed to scaffold feature: ${msg}` });
      return;
    }
    const slug = root.path.split("/").pop() ?? featureName;
    const tasksDirUri = vscode6.Uri.joinPath(root, "tasks");
    const requirementsUri = vscode6.Uri.joinPath(root, "requirements.md");
    const designUri = vscode6.Uri.joinPath(root, "design.md");
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
    const userMessage = {
      id: `local:user:${randomId()}`,
      conversationId,
      role: "user",
      content: userPrompt,
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
    const body = {
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
      maxAgentSpawns: this.catalog.maxAgentSpawns
    };
    const abort = new AbortController();
    const streamStartedAt = Date.now();
    const streamState = {
      abort,
      messageId: assistantMessage.id,
      startedAt: streamStartedAt,
      tools: /* @__PURE__ */ new Map(),
      edits: /* @__PURE__ */ new Map()
    };
    this.streams.set(conversationId, streamState);
    this.broadcast({
      type: "messageStart",
      sessionId: conversationId,
      messageId: assistantMessage.id,
      startedAt: streamStartedAt
    });
    let buffer = "";
    try {
      const handlers = {
        onToken: (text) => {
          buffer += text;
          assistantMessage.content = buffer;
          this.broadcast({
            type: "messageAppend",
            sessionId: conversationId,
            messageId: assistantMessage.id,
            chunk: text
          });
        },
        onToolEvent: (event) => {
          const update = applyToolEvent(streamState, event);
          if (!update) return;
          this.broadcast({
            type: "toolUpdate",
            sessionId: conversationId,
            messageId: assistantMessage.id,
            entry: update.entry,
            editedFiles: update.editedFiles
          });
        }
      };
      const useLocalCopilot = body.provider === "copilot" && readSettings().copilotModelsEnabled && await listCopilotLmModels().then((m) => m.some((x) => x.modelId === body.model)).catch(() => false);
      const response = useLocalCopilot ? await streamCopilotChat({
        modelId: body.model,
        history: (messages ?? []).filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content })),
        prompt: body.content,
        toolsEnabled: body.toolsEnabled,
        onToken: handlers.onToken,
        onToolEvent: handlers.onToolEvent,
        signal: abort.signal
      }).then((r) => ({ assistantMessage: { id: assistantMessage.id, content: r.content } })) : await streamChat(body, handlers, abort.signal);
      const finalConversation = response.conversation;
      if (finalConversation) this.conversations.set(finalConversation.id, finalConversation);
      if (response.assistantMessage?.id) assistantMessage.id = response.assistantMessage.id;
      if (response.assistantMessage?.content) {
        assistantMessage.content = response.assistantMessage.content;
        buffer = assistantMessage.content;
      }
      let taskCount = 0;
      try {
        const sections = parsePipelineSections(buffer);
        await writeTextFile(requirementsUri, `# Requirements

${sections.requirements}
`);
        await writeTextFile(designUri, `# Design

${sections.design}
`);
        taskCount = await this.writeTaskContractsForFeature(slug, tasksDirUri, buffer);
        this.store.setActiveFeature(slug);
        await this.context.workspaceState.update("liberide.activeFeatureId", slug);
        await this.store.refresh();
        const updated = this.store.getFeature(slug);
        if (updated?.tasksDirUri) {
          await writeTextFile(
            vscode6.Uri.joinPath(updated.tasksDirUri, "index.md"),
            regenerateTasksIndex(updated.tasks)
          );
        }
        const note = `

_Scaffolded feature **${featureName}** with **${taskCount}** task${taskCount === 1 ? "" : "s"}. [[OPEN_PIPELINE]]_`;
        assistantMessage.content += note;
        this.broadcast({
          type: "messageAppend",
          sessionId: conversationId,
          messageId: assistantMessage.id,
          chunk: note
        });
        this.broadcast({
          type: "messageComplete",
          sessionId: conversationId,
          messageId: assistantMessage.id,
          conversationId,
          completedAt: Date.now()
        });
        void this.refreshSingleConversation(conversationId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`[chat.pipeline.write] ${msg}`);
        const note = `

_Failed to scaffold pipeline files: ${msg}_`;
        assistantMessage.content += note;
        this.broadcast({
          type: "messageAppend",
          sessionId: conversationId,
          messageId: assistantMessage.id,
          chunk: note
        });
        this.broadcast({
          type: "messageComplete",
          sessionId: conversationId,
          messageId: assistantMessage.id,
          conversationId,
          completedAt: Date.now()
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
          chunk: note
        });
        this.broadcast({
          type: "messageComplete",
          sessionId: conversationId,
          messageId: assistantMessage.id,
          conversationId,
          completedAt: Date.now()
        });
      } else {
        this.broadcast({
          type: "messageError",
          sessionId: conversationId,
          messageId: assistantMessage.id,
          error: msg,
          completedAt: Date.now()
        });
      }
    } finally {
      this.streams.delete(conversationId);
    }
  }
  async copilotGithubLogin() {
    try {
      const session = await vscode6.authentication.getSession("github", ["read:user"], { createIfNone: true });
      if (!session?.accessToken) throw new Error("GitHub authentication did not return an access token.");
      await apiFetch("/api/copilot/link/ide", {
        method: "POST",
        body: JSON.stringify({ accessToken: session.accessToken })
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
  renderHtml(webview) {
    const scriptUri = webview.asWebviewUri(vscode6.Uri.joinPath(this.context.extensionUri, "media", "chat.js"));
    const styleUri = webview.asWebviewUri(vscode6.Uri.joinPath(this.context.extensionUri, "media", "webview.css"));
    const mermaidUri = webview.asWebviewUri(vscode6.Uri.joinPath(this.context.extensionUri, "media", "mermaid.js"));
    const nonce = randomNonce2();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `connect-src ${webview.cspSource}`
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
function parsePipelineSections(buffer) {
  const lines = buffer.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && !/^\s*#\s+/.test(lines[i])) i++;
  const sections = /* @__PURE__ */ new Map();
  let currentKey = null;
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
    sections.get(currentKey).push(line);
  }
  const trim = (lines2) => (lines2 ?? []).join("\n").replace(/^\s+|\s+$/g, "");
  const requirements = trim(sections.get("requirements"));
  const design = trim(sections.get("design"));
  if (!requirements && !design) {
    throw new Error("Generated output did not contain # Requirements or # Design sections.");
  }
  return { requirements, design };
}
function deriveTitle(text) {
  const firstLine = text.replace(/\s+/g, " ").trim();
  if (!firstLine) return "New chat";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}\u2026` : firstLine;
}
function applyToolEvent(stream, event) {
  const now = Date.now();
  const existing = stream.tools.get(event.id);
  if (!existing) {
    const entry = {
      id: event.id,
      name: event.name,
      arguments: event.arguments ?? {},
      activityKind: toolActivityKind(event.name),
      summary: summarizeTool(event.name, event.arguments ?? {}),
      startedAt: event.createdAt ? Date.parse(event.createdAt) || now : now,
      status: "running"
    };
    stream.tools.set(event.id, entry);
    recordFileEdit(stream.edits, event.name, event.arguments ?? {}, event.result);
    return { entry, editedFiles: [...stream.edits.values()] };
  }
  existing.completedAt = now;
  existing.activityKind = existing.activityKind ?? toolActivityKind(existing.name);
  if (event.result !== void 0) {
    existing.result = event.result;
    existing.status = looksLikeToolError(event.result) ? "error" : "complete";
    if (existing.status === "error") existing.error = event.result.slice(0, 300);
    recordFileEdit(stream.edits, event.name, event.arguments ?? {}, event.result);
  }
  return { entry: existing, editedFiles: [...stream.edits.values()] };
}
function summarizeTool(name, args) {
  const path2 = typeof args.path === "string" ? args.path : void 0;
  switch (name) {
    case "ide_write_file":
      return path2 ? `Wrote \`${path2}\`` : "Wrote file";
    case "ide_edit_file":
      return path2 ? `Edited \`${path2}\`` : "Edited file";
    case "ide_read_file":
      return path2 ? `Read \`${path2}\`` : "Read file";
    case "ide_list_directory":
      return path2 ? `Listed \`${path2}\`` : "Listed directory";
    case "ide_search_code":
      return typeof args.query === "string" ? `Searched for "${truncate2(args.query, 40)}"` : "Searched code";
    case "ide_run_command":
    case "terminal_run":
      return typeof args.command === "string" ? `Ran \`${truncate2(args.command, 48)}\`` : "Ran command";
    default:
      return humanizeToolName(name);
  }
}
function humanizeToolName(name) {
  return name.replace(/^ide_/, "").replace(/_/g, " ");
}
function truncate2(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}\u2026` : value;
}
function looksLikeToolError(result) {
  const trimmed = result.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.error === true || parsed.success === false) return true;
    } catch {
    }
  }
  return /^(error|failed|denied)/i.test(trimmed);
}
function recordFileEdit(edits, name, args, result) {
  if (name !== "ide_write_file" && name !== "ide_edit_file") return;
  const path2 = typeof args.path === "string" ? args.path : void 0;
  if (!path2) return;
  const current = edits.get(path2) ?? { path: path2, writes: 0, edits: 0, additions: 0, deletions: 0 };
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
      const oldText = typeof edit.oldText === "string" ? edit.oldText : "";
      const newText = typeof edit.newText === "string" ? edit.newText : "";
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
  edits.set(path2, current);
}
function parseEditStatsFromResult(result) {
  const match = result.match(/(\+|\u002B)(\d+).*?(-|\u2212)(\d+)/);
  if (!match) return null;
  return { additions: Number(match[2]) || 0, deletions: Number(match[4]) || 0 };
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
var vscode7 = __toESM(require("vscode"));
var SpecStore = class {
  constructor(output) {
    this.output = output;
  }
  changeEmitter = new vscode7.EventEmitter();
  onDidChange = this.changeEmitter.event;
  features = /* @__PURE__ */ new Map();
  watcher;
  promptWatcher;
  activeFeatureId;
  refreshTimer;
  refreshInProgress = false;
  refreshQueued = false;
  scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = void 0;
      void this.refresh();
    }, 300);
  }
  async initialize(context) {
    this.activeFeatureId = context.workspaceState.get("liberide.activeFeatureId");
    this.watcher = vscode7.workspace.createFileSystemWatcher("**//.liberide/specs/**/*.md");
    this.watcher.onDidCreate(() => this.scheduleRefresh());
    this.watcher.onDidChange(() => this.scheduleRefresh());
    this.watcher.onDidDelete(() => this.scheduleRefresh());
    context.subscriptions.push(this.watcher);
    this.promptWatcher = vscode7.workspace.createFileSystemWatcher("**/.chatllm/**/*.md");
    const syncPrompts = () => {
      const root = vscode7.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      void fetch(`${process.env.CHATLLM_API_ORIGIN ?? "http://127.0.0.1:3000"}/api/skills/import-from-workspace`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootPath: root })
      }).catch(() => void 0);
    };
    this.promptWatcher.onDidCreate(syncPrompts);
    this.promptWatcher.onDidChange(syncPrompts);
    this.promptWatcher.onDidDelete(syncPrompts);
    context.subscriptions.push(this.promptWatcher);
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
    if (this.refreshInProgress) {
      this.refreshQueued = true;
      return;
    }
    this.refreshInProgress = true;
    try {
      this.features.clear();
      for (const folder of vscode7.workspace.workspaceFolders ?? []) {
        const root = vscode7.Uri.joinPath(folder.uri, ".liberide", "specs");
        try {
          for (const [name, type] of await vscode7.workspace.fs.readDirectory(root)) {
            if (type === vscode7.FileType.Directory) {
              const feature = await this.loadFeature(root, name);
              if (feature) this.features.set(feature.id, feature);
            }
          }
        } catch {
        }
      }
      this.changeEmitter.fire();
    } finally {
      this.refreshInProgress = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }
  async loadFeature(specsRoot, id) {
    const rootUri = vscode7.Uri.joinPath(specsRoot, id);
    const featureMdUri = vscode7.Uri.joinPath(rootUri, "feature.md");
    const requirementsUri = vscode7.Uri.joinPath(rootUri, "requirements.md");
    const designUri = vscode7.Uri.joinPath(rootUri, "design.md");
    const tasksDirUri = vscode7.Uri.joinPath(rootUri, "tasks");
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
      for (const [fileName, fileType] of await vscode7.workspace.fs.readDirectory(tasksDirUri)) {
        if (fileType !== vscode7.FileType.File || !/^T-\d+.*\.md$/i.test(fileName)) continue;
        const filePath = vscode7.Uri.joinPath(tasksDirUri, fileName);
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
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.watcher?.dispose();
    this.promptWatcher?.dispose();
    this.changeEmitter.dispose();
  }
};

// src/theme-bridge.ts
var vscode8 = __toESM(require("vscode"));
var NEXUS_TO_VSCODE2 = {
  "default:light": "Light Modern",
  "default:dark": "Dark Modern",
  "cursor:light": "Light 2026",
  "cursor:dark": "Dark 2026",
  "github:light": "Light+",
  "github:dark": "Dark+",
  // Nord doesn't ship its own built-in theme; the published color +
  // tokenColor overrides repaint the workbench and syntax to Nord.
  "nord:light": "Light Modern",
  "nord:dark": "Dark Modern"
};
var VSCODE_TO_NEXUS2 = {
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
  let lastTokenOverridesKey;
  async function applyTheme(themeId) {
    if (!themeId) return;
    lastApplied = themeId;
    await vscode8.workspace.getConfiguration("workbench").update("colorTheme", themeId, vscode8.ConfigurationTarget.Global);
  }
  async function applyColorOverrides(overrides) {
    if (!overrides || Object.keys(overrides).length === 0) return;
    const fingerprint = JSON.stringify(overrides);
    if (fingerprint === lastOverridesKey) return;
    lastOverridesKey = fingerprint;
    const config = vscode8.workspace.getConfiguration("workbench");
    const existing = config.get("colorCustomizations") ?? {};
    const next = { ...overrides };
    for (const [key, value] of Object.entries(existing)) {
      if (key.startsWith("[") && key.endsWith("]")) next[key] = value;
    }
    await config.update("colorCustomizations", next, vscode8.ConfigurationTarget.Global);
  }
  async function applyTokenColorOverrides(overrides) {
    if (!overrides || !overrides.textMateRules || overrides.textMateRules.length === 0) return;
    const fingerprint = JSON.stringify(overrides);
    if (fingerprint === lastTokenOverridesKey) return;
    lastTokenOverridesKey = fingerprint;
    const config = vscode8.workspace.getConfiguration("editor");
    const existing = config.get("tokenColorCustomizations") ?? {};
    const next = {
      textMateRules: overrides.textMateRules,
      semanticHighlighting: overrides.semanticHighlighting ?? true
    };
    if (overrides.semanticTokenColors) {
      next.semanticTokenColors = overrides.semanticTokenColors;
    }
    for (const [key, value] of Object.entries(existing)) {
      if (key.startsWith("[") && key.endsWith("]")) next[key] = value;
    }
    await config.update("tokenColorCustomizations", next, vscode8.ConfigurationTarget.Global);
  }
  async function publishTheme() {
    const themeId = vscode8.workspace.getConfiguration("workbench").get("colorTheme");
    if (!themeId || themeId === lastApplied) {
      lastApplied = void 0;
      return;
    }
    const mapped = VSCODE_TO_NEXUS2[themeId];
    if (!mapped) return;
    await apiFetch("/api/theme", {
      method: "PUT",
      body: JSON.stringify({ kind: "name", family: mapped.family, mode: mapped.mode, vsCodeThemeId: themeId, source: "vscode" })
    }).catch((error) => output.appendLine(`Theme publish error: ${error instanceof Error ? error.message : String(error)}`));
  }
  let retryDelay = 1e3;
  const MAX_RETRY_DELAY = 3e4;
  function connect() {
    if (disposed) return;
    ws = new WebSocket(`${apiOrigin.replace(/^http/, "ws")}/api/theme/stream`);
    ws.addEventListener("open", () => {
      retryDelay = 1e3;
    });
    ws.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data));
      if (payload.type !== "theme" || payload.snapshot?.source === "vscode") return;
      const snapshot = payload.snapshot;
      const themeId = snapshot?.vsCodeThemeId ?? NEXUS_TO_VSCODE2[`${snapshot?.family}:${snapshot?.mode}`];
      void applyTheme(themeId).then(() => applyColorOverrides(snapshot?.colorOverrides)).then(() => applyTokenColorOverrides(snapshot?.tokenColorOverrides));
    });
    ws.addEventListener("close", () => {
      const delay = retryDelay;
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
      setTimeout(connect, delay);
    });
  }
  const envTheme = NEXUS_TO_VSCODE2[`${process.env.LIBERVOX_THEME_FAMILY}:${process.env.LIBERVOX_THEME_MODE === "system" ? "dark" : process.env.LIBERVOX_THEME_MODE}`];
  void applyTheme(envTheme);
  const listener = vscode8.workspace.onDidChangeConfiguration((event) => {
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
var vscode9 = __toESM(require("vscode"));
var MAX_COMPLETED_RUNS = 20;
var RunsTreeProvider = class {
  constructor(writeback) {
    this.writeback = writeback;
  }
  emitter = new vscode9.EventEmitter();
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
      if (event.type === "done" && event.status) {
        run.status = event.status;
        run.dispose?.();
        run.dispose = void 0;
        const completed = [...this.runs.entries()].filter(([, r]) => r.status !== "running");
        if (completed.length > MAX_COMPLETED_RUNS) {
          const [oldestId] = completed[0];
          this.runs.delete(oldestId);
        }
      }
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
      const tree2 = new vscode9.TreeItem(item.run.label, vscode9.TreeItemCollapsibleState.Expanded);
      tree2.description = item.run.status;
      tree2.contextValue = "run";
      tree2.iconPath = new vscode9.ThemeIcon(item.run.status === "running" ? "loading~spin" : "run-all");
      return tree2;
    }
    const tree = new vscode9.TreeItem(item.nodeId);
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
var vscode10 = __toESM(require("vscode"));
var SpecsTreeProvider = class {
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
    if (item.kind === "feature") {
      const tree2 = new vscode10.TreeItem(item.feature.name, vscode10.TreeItemCollapsibleState.Expanded);
      tree2.description = item.feature.status;
      tree2.contextValue = "feature";
      tree2.iconPath = new vscode10.ThemeIcon("folder");
      tree2.command = { command: "liberide.setActiveFeature", title: "Set Active", arguments: [item.feature.id] };
      return tree2;
    }
    const tree = new vscode10.TreeItem(item.label);
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
      f.tasksDirUri && { kind: "file", label: `tasks/index.md (${f.tasks.length})`, uri: vscode10.Uri.joinPath(f.tasksDirUri, "index.md") }
    ].filter(Boolean);
  }
};

// src/views/tasksTree.ts
var vscode11 = __toESM(require("vscode"));
var TasksTreeProvider = class {
  constructor(store2) {
    this.store = store2;
    store2.onDidChange(() => this.refresh());
  }
  emitter = new vscode11.EventEmitter();
  onDidChangeTreeData = this.emitter.event;
  refresh() {
    this.emitter.fire(void 0);
  }
  getTreeItem(item) {
    if (item.kind === "group") return new vscode11.TreeItem(item.label, vscode11.TreeItemCollapsibleState.Expanded);
    const tree = new vscode11.TreeItem(`${item.task.id}: ${item.task.title}`);
    tree.description = item.task.status;
    tree.contextValue = "task";
    tree.command = { command: "liberide.openTask", title: "Open Task", arguments: [{ kind: "task", featureId: item.featureId, task: { id: item.task.id } }] };
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
  const output = vscode12.window.createOutputChannel("LiberIDE");
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
  pipeline = new LiberidePipelineController(context, store, output, runsTree);
  chat = new LiberideChatPanelController(context, store, output);
  context.subscriptions.push(
    output,
    store,
    pipeline,
    chat,
    vscode12.window.registerWebviewViewProvider(LiberidePipelineController.viewType, pipeline, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode12.window.registerWebviewViewProvider(LiberideChatPanelController.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode12.window.registerTreeDataProvider("liberide.specs", specsTree),
    vscode12.window.registerTreeDataProvider("liberide.tasks", tasksTree),
    vscode12.window.registerTreeDataProvider("liberide.runs", runsTree),
    createThemeBridge(output),
    statusBar(),
    ...commands4(context, specsTree, tasksTree, runsTree)
  );
}
function commands4(context, specsTree, tasksTree, runsTree) {
  function safe(fn) {
    return (...args) => {
      fn(...args).catch((err) => {
        void vscode12.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      });
    };
  }
  return [
    vscode12.commands.registerCommand("liberide.openChat", () => chat.show()),
    vscode12.commands.registerCommand("liberide.newChat", safe(async () => {
      chat.show();
      await chat.newSession();
    })),
    vscode12.commands.registerCommand("liberide.openSettings", () => chat.openSettings()),
    vscode12.commands.registerCommand("liberide.openChatHistory", () => chat.openChatHistory()),
    vscode12.commands.registerCommand("liberide.renameChat", safe(async () => {
      await chat.renameActiveChat();
    })),
    vscode12.commands.registerCommand("liberide.openPipeline", () => pipeline.show()),
    vscode12.commands.registerCommand("liberide.refreshSpecs", safe(async () => {
      await store.refresh();
      specsTree.refresh();
    })),
    vscode12.commands.registerCommand("liberide.refreshTasks", safe(async () => {
      await store.refresh();
      tasksTree.refresh();
    })),
    vscode12.commands.registerCommand("liberide.refreshRuns", () => runsTree.refresh()),
    vscode12.commands.registerCommand("liberide.scaffoldFeature", safe(async () => {
      const folder = vscode12.workspace.workspaceFolders?.[0];
      const name = await vscode12.window.showInputBox({ prompt: "Feature name" });
      if (!folder || !name) return;
      const root = await scaffoldFeature(folder, name);
      const id = root.path.split("/").pop() ?? name;
      store.setActiveFeature(id);
      await context.workspaceState.update("liberide.activeFeatureId", id);
      await store.refresh();
      specsTree.refresh();
    })),
    vscode12.commands.registerCommand("liberide.setActiveFeature", safe(async (id) => {
      store.setActiveFeature(id);
      await context.workspaceState.update("liberide.activeFeatureId", id);
      tasksTree.refresh();
    })),
    vscode12.commands.registerCommand("liberide.openTask", safe(async (arg) => {
      const task = arg && store.getTask(arg.featureId, arg.task.id);
      if (task) await vscode12.window.showTextDocument(task.filePath);
    })),
    vscode12.commands.registerCommand("liberide.runTask", safe(async (arg) => {
      const feature = arg && store.getFeature(arg.featureId);
      if (!feature || !arg) return;
      await pipeline.dispatch(feature.id, [arg.task.id]);
    })),
    vscode12.commands.registerCommand("liberide.markTaskReady", safe(async (arg) => {
      const task = arg && store.getTask(arg.featureId, arg.task.id);
      if (task) await updateTaskStatus(task.filePath, "ready");
      await store.refresh();
    })),
    vscode12.commands.registerCommand("liberide.dispatchFeature", safe(async () => {
      const feature = store.getActiveFeature();
      if (!feature) return;
      await pipeline.dispatch(feature.id);
    })),
    vscode12.commands.registerCommand("liberide.regenerateTasksIndex", safe(async () => {
      const feature = store.getActiveFeature();
      if (feature?.tasksDirUri) await writeTextFile(vscode12.Uri.joinPath(feature.tasksDirUri, "index.md"), regenerateTasksIndex(feature.tasks));
    })),
    vscode12.commands.registerCommand("liberide.cancelRun", safe(async (arg) => {
      const graphId = typeof arg === "string" ? arg : arg?.run?.graphId;
      if (!graphId) {
        void vscode12.window.showInformationMessage("Select an active run from the Agent Runs view to cancel it.");
        return;
      }
      await pipeline.cancel(graphId);
    }))
  ];
}
function statusBar() {
  const item = vscode12.window.createStatusBarItem(vscode12.StatusBarAlignment.Left, 100);
  item.text = "$(comment-discussion) LiberIDE";
  item.tooltip = "Open LiberIDE chat";
  item.command = "liberide.openChat";
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
