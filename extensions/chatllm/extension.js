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
var vscode8 = __toESM(require("vscode"));

// src/chat/participant.ts
var vscode2 = __toESM(require("vscode"));

// src/api.ts
function getApiOrigin() {
  return (process.env.CHATLLM_API_ORIGIN || "").replace(/\/$/, "");
}
function getAuthToken() {
  return process.env.CHATLLM_AUTH_TOKEN || "";
}
function authHeaders(extra) {
  const headers = {
    "Content-Type": "application/json",
    ...extra
  };
  const token = getAuthToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}
async function apiFetch(path, init) {
  const origin = getApiOrigin();
  if (!origin) {
    throw new Error("CHATLLM_API_ORIGIN is not set.");
  }
  const url = path.startsWith("http") ? path : `${origin}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      ...authHeaders(),
      ...init?.headers
    }
  });
}
async function fetchConfig() {
  const response = await apiFetch("/api/config");
  if (!response.ok) {
    throw new Error(`Failed to load config (${response.status})`);
  }
  return response.json();
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

// src/chat/commands.ts
var SPEC_SYSTEM_PROMPTS = {
  spec: `You are helping create feature requirements in EARS style.
Output markdown with ## R-N section headers. Each section must include:
- User story (As a ... I want ... so that ...)
- Acceptance criteria using WHEN/IF/THEN language
Reference only what the user asked for. Do not invent tasks yet.`,
  design: `You are helping create design.md from existing requirements.
Each ## D-N section must reference requirement ids (R-*) it implements.
Include architecture decisions, component boundaries, data flow, and file-level hints.
Do not generate task files.`,
  tasks: `You are generating development task contracts for a feature.
For EACH task, output a separate fenced block:

\`\`\`task
---
id: T-001
title: Short title
status: pending
requirement_refs: [R-1]
design_refs: [D-1]
depends_on: []
produces_context:
  - id: context-key
    summary: What downstream tasks receive
expected_files:
  - path/to/file.ts
architecture_hints: |
  Brief implementation notes
acceptance:
  - Observable criterion
agent: coding
---
Task body with step-by-step instructions.
\`\`\`

Rules:
- Tasks must trace to requirement_refs and design_refs
- depends_on forms a DAG (no cycles)
- Each task is a full contract: expected_files + acceptance + architecture_hints
- Order tasks so dependencies come first`,
  dispatch: `You are about to dispatch tasks. Summarize the plan and warn about blocked or invalid tasks.
Do not rewrite task files unless asked.`,
  status: `Summarize the current spec: feature status, task counts by status, ready vs blocked tasks, and any active runs.`
};
function extractTaskBlocks(content) {
  const blocks = [];
  const re = /```task\s*([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(content)) !== null) {
    blocks.push(m[1].trim());
  }
  return blocks;
}

// src/spec/schema.ts
var TASK_STATUSES = /* @__PURE__ */ new Set(["pending", "ready", "running", "completed", "blocked", "failed"]);
var FEATURE_STATUSES = /* @__PURE__ */ new Set(["draft", "design", "tasks", "dispatching", "done"]);
function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === "string");
}
function asProducesContext(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === "object" && v !== null).map((v) => ({
    id: String(v.id ?? ""),
    summary: String(v.summary ?? "")
  })).filter((e) => e.id.length > 0);
}
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      try {
        value = JSON.parse(value.replace(/'/g, '"'));
      } catch {
        value = value.slice(1, -1).split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
      }
    }
    if (value === "true") value = true;
    if (value === "false") value = false;
    data[key] = value;
  }
  return { data, body: match[2] };
}
function parseTaskContract(featureId, filePath, raw) {
  const { data, body } = parseFrontmatter(raw);
  const id = String(data.id ?? "").trim();
  const title = String(data.title ?? "").trim();
  if (!id || !title) return void 0;
  const statusRaw = String(data.status ?? "pending").trim();
  const status = TASK_STATUSES.has(statusRaw) ? statusRaw : "pending";
  return {
    id,
    title,
    status,
    requirementRefs: asStringArray(data.requirement_refs ?? data.requirementRefs),
    designRefs: asStringArray(data.design_refs ?? data.designRefs),
    dependsOn: asStringArray(data.depends_on ?? data.dependsOn),
    producesContext: asProducesContext(data.produces_context ?? data.producesContext),
    expectedFiles: asStringArray(data.expected_files ?? data.expectedFiles),
    architectureHints: String(data.architecture_hints ?? data.architectureHints ?? ""),
    acceptance: asStringArray(data.acceptance),
    agent: String(data.agent ?? "coding").trim() || "coding",
    body: body.trim(),
    filePath,
    featureId
  };
}
function parseFeatureStatus(raw) {
  const match = raw.match(/status:\s*(\w+)/i);
  const status = match?.[1] ?? "draft";
  return FEATURE_STATUSES.has(status) ? status : "draft";
}
function extractSectionIds(markdown, prefix) {
  const ids = [];
  const re = new RegExp(`^##\\s+(${prefix}-[\\w.-]+)`, "gim");
  let m;
  while ((m = re.exec(markdown)) !== null) {
    ids.push(m[1]);
  }
  return ids;
}
function serializeTaskFrontmatter(task) {
  const lines = [
    "---",
    `id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `requirement_refs: ${JSON.stringify(task.requirementRefs)}`,
    `design_refs: ${JSON.stringify(task.designRefs)}`,
    `depends_on: ${JSON.stringify(task.dependsOn)}`,
    `produces_context:`,
    ...task.producesContext.map((p) => `  - id: ${p.id}
    summary: ${p.summary}`),
    `expected_files: ${JSON.stringify(task.expectedFiles)}`,
    "architecture_hints: |",
    ...task.architectureHints.split("\n").map((l) => `  ${l}`),
    `acceptance: ${JSON.stringify(task.acceptance)}`,
    `agent: ${task.agent}`,
    "---",
    "",
    task.body
  ];
  return lines.join("\n");
}

// src/spec/writer.ts
var vscode = __toESM(require("vscode"));
async function readTextFile(uri) {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString("utf8");
}
async function writeTextFile(uri, content) {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
}
async function updateTaskStatus(uri, status) {
  const raw = await readTextFile(uri);
  const { data, body } = parseFrontmatter(raw);
  data.status = status;
  const lines = [
    "---",
    ...Object.entries(data).map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: ${JSON.stringify(v)}`;
      if (typeof v === "string" && v.includes("\n")) return `${k}: |
${v.split("\n").map((l) => `  ${l}`).join("\n")}`;
      return `${k}: ${v}`;
    }),
    "---",
    "",
    body
  ];
  await writeTextFile(uri, lines.join("\n"));
}
async function writeTaskContract(task) {
  await writeTextFile(task.filePath, serializeTaskFrontmatter(task));
}
async function scaffoldFeature(workspaceFolder, featureName) {
  const slug = featureName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const root = vscode.Uri.joinPath(workspaceFolder.uri, ".chatllm", "specs", slug);
  await vscode.workspace.fs.createDirectory(root);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, "tasks"));
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, "runs"));
  await writeTextFile(vscode.Uri.joinPath(root, "runs", ".gitignore"), "*\n!.gitignore\n");
  const featureMd = `# ${featureName}

status: draft

Brief description of the feature.
`;
  await writeTextFile(vscode.Uri.joinPath(root, "feature.md"), featureMd);
  const requirementsMd = `# Requirements

## R-1 Overview

**User story:** As a user, I want ...

**Acceptance criteria:**
- WHEN ... THEN ...
`;
  await writeTextFile(vscode.Uri.joinPath(root, "requirements.md"), requirementsMd);
  const designMd = `# Design

## D-1 Architecture

Describe how R-1 is implemented.
`;
  await writeTextFile(vscode.Uri.joinPath(root, "design.md"), designMd);
  const indexMd = `# Tasks

| ID | Title | Status | Depends on | Requirements | Design |
|----|-------|--------|------------|--------------|--------|
`;
  await writeTextFile(vscode.Uri.joinPath(root, "tasks", "index.md"), indexMd);
  return root;
}
function regenerateTasksIndex(tasks) {
  const header = `# Tasks

| ID | Title | Status | Depends on | Requirements | Design |
|----|-------|--------|------------|--------------|--------|
`;
  const rows = tasks.map(
    (t) => `| ${t.id} | ${t.title} | ${t.status} | ${t.dependsOn.join(", ") || "\u2014"} | ${t.requirementRefs.join(", ") || "\u2014"} | ${t.designRefs.join(", ") || "\u2014"} |`
  ).join("\n");
  return `${header}${rows}
`;
}

// src/spec/dag.ts
function validateDag(tasks) {
  const ids = new Set(tasks.map((t) => t.id));
  const adjacency = /* @__PURE__ */ new Map();
  const indegree = /* @__PURE__ */ new Map();
  for (const task of tasks) {
    adjacency.set(task.id, []);
    indegree.set(task.id, 0);
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        return { ok: false, order: [], error: `Task ${task.id} depends on unknown task ${dep}` };
      }
      if (dep === task.id) {
        return { ok: false, order: [], error: `Task ${task.id} cannot depend on itself` };
      }
      adjacency.get(dep)?.push(task.id);
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
    }
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  if (queue.length === 0 && tasks.length > 0) {
    return { ok: false, order: [], error: "Task graph has no root nodes (possible cycle)" };
  }
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const updated = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, updated);
      if (updated === 0) queue.push(next);
    }
  }
  if (order.length !== tasks.length) {
    return { ok: false, order: [], error: "Task dependencies contain a cycle" };
  }
  return { ok: true, order };
}
function topoSortTasks(tasks) {
  const validation = validateDag(tasks);
  if (!validation.ok) throw new Error(validation.error ?? "Invalid task DAG");
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return validation.order.map((id) => byId.get(id)).filter((t) => Boolean(t));
}
function computeTaskReadiness(tasks) {
  const statusById = new Map(tasks.map((t) => [t.id, t.status]));
  const result = /* @__PURE__ */ new Map();
  for (const task of tasks) {
    const blockedBy = task.dependsOn.filter((dep) => statusById.get(dep) !== "completed");
    const depsSatisfied = blockedBy.length === 0;
    const ready = depsSatisfied && (task.status === "pending" || task.status === "ready") && task.status !== "completed";
    result.set(task.id, { ready, blockedBy });
  }
  return result;
}
function effectiveStatus(task, readiness) {
  if (task.status === "running" || task.status === "completed" || task.status === "failed") {
    return task.status;
  }
  const info = readiness.get(task.id);
  if (!info) return task.status;
  if (!info.ready && info.blockedBy.length > 0) return "blocked";
  if (info.ready && task.status === "pending") return "ready";
  return task.status;
}
function groupTasksByStatus(tasks) {
  const readiness = computeTaskReadiness(tasks);
  const groups = {
    running: [],
    ready: [],
    blocked: [],
    pending: [],
    completed: [],
    failed: []
  };
  for (const task of tasks) {
    const status = effectiveStatus(task, readiness);
    groups[status].push(task);
  }
  return groups;
}

// src/dispatch/client.ts
function buildDispatchNodes(feature, tasks) {
  const taskList = tasks ?? feature.tasks;
  const validation = validateDag(taskList);
  if (!validation.ok) throw new Error(validation.error);
  const sorted = topoSortTasks(taskList);
  return sorted.map((task) => ({
    id: task.id,
    type: "IMPLEMENT",
    title: task.title,
    inputSummary: buildTaskInputSummary(feature, task),
    dependsOn: task.dependsOn,
    metadata: {
      taskId: task.id,
      featureId: feature.id,
      agent: task.agent,
      producesContext: task.producesContext
    },
    agent: task.agent,
    expectedFiles: task.expectedFiles,
    acceptance: task.acceptance,
    requirementRefs: task.requirementRefs,
    designRefs: task.designRefs,
    producesContext: task.producesContext
  }));
}
function buildTaskInputSummary(feature, task) {
  const parts = [
    `# Task ${task.id}: ${task.title}`,
    "",
    `Feature: ${feature.name}`,
    "",
    "## Requirement refs",
    task.requirementRefs.length ? task.requirementRefs.join(", ") : "(none)",
    "",
    "## Design refs",
    task.designRefs.length ? task.designRefs.join(", ") : "(none)",
    ""
  ];
  if (task.architectureHints.trim()) {
    parts.push("## Architecture hints", task.architectureHints.trim(), "");
  }
  if (task.body.trim()) {
    parts.push("## Instructions", task.body.trim(), "");
  }
  if (task.producesContext.length) {
    parts.push(
      "## Produces context (for downstream tasks)",
      ...task.producesContext.map((p) => `- **${p.id}**: ${p.summary}`),
      ""
    );
  }
  return parts.join("\n").slice(0, 2e3);
}
async function dispatchFeature(feature, options = {}) {
  const tasks = options.taskIds?.length ? feature.tasks.filter((t) => options.taskIds.includes(t.id)) : feature.tasks;
  if (!tasks.length) throw new Error("No tasks to dispatch.");
  const nodes = buildDispatchNodes(feature, tasks);
  const response = await apiFetch("/api/specs/dispatch", {
    method: "POST",
    body: JSON.stringify({
      feature: feature.id,
      goal: `Spec dispatch: ${feature.name}`,
      conversationId: options.conversationId,
      priority: "FOREGROUND",
      nodes
    })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error ?? `Dispatch failed (${response.status})`);
  }
  return response.json();
}
async function cancelExecutionGraph(graphId) {
  const response = await apiFetch(`/api/execution-graphs/${graphId}/cancel`, { method: "POST" });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error ?? `Cancel failed (${response.status})`);
  }
}
function subscribeExecutionGraphEvents(graphId, handlers) {
  const origin = getApiOrigin();
  if (!origin) {
    handlers.onError?.(new Error("CHATLLM_API_ORIGIN is not set."));
    return () => {
    };
  }
  const token = process.env.CHATLLM_AUTH_TOKEN || "";
  const url = new URL(`${origin}/api/execution-graphs/${graphId}/events/stream`);
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch(url.toString(), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal
      });
      if (!response.ok || !response.body) {
        throw new Error(`Event stream failed (${response.status})`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const eventLine = part.match(/^event: (.+)$/m)?.[1];
          const dataLine = part.match(/^data: (.+)$/m)?.[1];
          if (!eventLine || !dataLine) continue;
          const data = JSON.parse(dataLine);
          const nodeId = typeof data.nodeId === "string" ? data.nodeId : typeof data.node?.id === "string" ? data.node.id : void 0;
          handlers.onEvent?.({
            type: eventLine,
            graphId,
            nodeId,
            status: typeof data.status === "string" ? data.status : void 0,
            message: typeof data.message === "string" ? data.message : void 0,
            payload: data
          });
        }
        if (done) break;
      }
      handlers.onDone?.();
    } catch (err) {
      if (err.name !== "AbortError") {
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  })();
  return () => controller.abort();
}

// src/chat/participant.ts
var PARTICIPANT_ID = "chatllm.chatllm";
function registerChatParticipant(context2, store, runsProvider2, output) {
  if (!vscode2.chat?.createChatParticipant) {
    output.appendLine("vscode.chat.createChatParticipant is not available in this host.");
    return { dispose: () => {
    } };
  }
  const handler = async (request, chatContext, stream, token) => {
    try {
      await handleChatRequest(context2, store, runsProvider2, request, chatContext, stream, token, output);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stream.markdown(`**Error:** ${message}`);
    }
  };
  const participant = vscode2.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = new vscode2.ThemeIcon("comment-discussion");
  return participant;
}
async function handleChatRequest(context2, store, runsProvider2, request, chatContext, stream, token, output) {
  const command = request.command;
  if (command === "status") {
    await handleStatusCommand(store, stream);
    return;
  }
  if (command === "dispatch") {
    await handleDispatchCommand(context2, store, runsProvider2, request, stream, output);
    return;
  }
  if (command === "run") {
    await handleRunCommand(context2, store, runsProvider2, request, stream, output);
    return;
  }
  const config = await fetchConfig().catch(() => ({}));
  const preferred = config.configuredModels?.find((m) => m.capability === "chat") ?? config.configuredModels?.[0];
  const provider = preferred?.provider ?? "openai";
  const model = preferred?.model ?? "gpt-4o-mini";
  const conversationId = context2.workspaceState.get("chatllm.conversationId");
  let systemPrompt;
  let userContent = buildPromptWithReferences(request);
  if (command === "spec") {
    systemPrompt = SPEC_SYSTEM_PROMPTS.spec;
    const featureName = request.prompt.trim() || "new-feature";
    userContent = `Create requirements for feature: ${featureName}

${userContent}`;
  } else if (command === "design") {
    systemPrompt = SPEC_SYSTEM_PROMPTS.design;
    const feature = store.getActiveFeature();
    if (feature?.requirementsUri) {
      const req = await readTextFile(feature.requirementsUri);
      userContent = `Requirements:

${req}

---

User request:
${userContent}`;
    }
  } else if (command === "tasks") {
    systemPrompt = SPEC_SYSTEM_PROMPTS.tasks;
    const feature = store.getActiveFeature();
    if (feature) {
      const parts = [userContent];
      if (feature.requirementsUri) {
        parts.unshift(`Requirements:

${await readTextFile(feature.requirementsUri)}`);
      }
      if (feature.designUri) {
        parts.unshift(`Design:

${await readTextFile(feature.designUri)}`);
      }
      userContent = parts.join("\n\n---\n\n");
    }
  } else if (command) {
    systemPrompt = SPEC_SYSTEM_PROMPTS[command];
  }
  const body = {
    conversationId,
    provider,
    model,
    modelSelection: "auto",
    chatMode: command === "tasks" || command === "design" ? "agent" : "normal",
    content: userContent,
    systemPrompt,
    skillIds: [],
    documentIds: [],
    useRag: false,
    toolsEnabled: command === "tasks" || command === "design",
    mcpServerIds: [],
    agentIds: [],
    maxAgentSpawns: 3
  };
  stream.progress("Thinking\u2026");
  let fullText = "";
  const abortController = new AbortController();
  const cancellationListener = token.onCancellationRequested(() => abortController.abort());
  let response;
  try {
    response = await streamChat(
      body,
      {
        onToken: (tokenStr) => {
          fullText += tokenStr;
          stream.markdown(tokenStr);
        },
        onToolEvent: (event) => {
          stream.progress(`Tool: ${event.name}`);
        }
      },
      abortController.signal
    );
  } finally {
    cancellationListener.dispose();
  }
  if (response.conversation?.id) {
    await context2.workspaceState.update("chatllm.conversationId", response.conversation.id);
  }
  if (command === "spec") {
    await offerWriteRequirements(store, request, fullText, stream);
  } else if (command === "design") {
    await offerWriteDesign(store, fullText, stream);
  } else if (command === "tasks") {
    await offerWriteTasks(store, fullText, stream, output);
  }
}
function buildPromptWithReferences(request) {
  const parts = [request.prompt];
  for (const ref of request.references) {
    const value = ref.value;
    if (typeof value === "string") {
      parts.push(`

[Reference ${ref.id}]
${value}`);
    } else if (value instanceof vscode2.Uri) {
      parts.push(`

[File ${ref.id}]: ${value.fsPath}`);
    } else if (value && typeof value === "object" && "uri" in value) {
      const loc = value;
      parts.push(`

[Location ${ref.id}]: ${loc.uri.fsPath}:${loc.range.start.line}`);
    }
  }
  return parts.join("");
}
async function handleStatusCommand(store, stream) {
  const feature = store.getActiveFeature();
  if (!feature) {
    stream.markdown("No spec features found. Run **Scaffold Spec Feature** or use `@chatllm /spec`.");
    return;
  }
  const readiness = computeTaskReadiness(feature.tasks);
  const lines = [
    `## ${feature.name}`,
    `Status: **${feature.status}**`,
    `Tasks: ${feature.tasks.length}`,
    ""
  ];
  for (const task of feature.tasks) {
    const eff = effectiveStatus(task, readiness);
    const blocked = readiness.get(task.id)?.blockedBy ?? [];
    lines.push(`- **${task.id}** (${eff})${blocked.length ? ` \u2014 blocked by ${blocked.join(", ")}` : ""}`);
  }
  stream.markdown(lines.join("\n"));
}
async function handleDispatchCommand(context2, store, runsProvider2, request, stream, output) {
  const feature = resolveFeatureFromPrompt(store, request.prompt);
  if (!feature) {
    stream.markdown("No feature found. Create `.chatllm/specs/<feature>/` first.");
    return;
  }
  const validation = validateDag(feature.tasks);
  if (!validation.ok) {
    stream.markdown(`**Cannot dispatch:** ${validation.error}`);
    return;
  }
  stream.progress("Dispatching task graph\u2026");
  const conversationId = context2.workspaceState.get("chatllm.conversationId");
  const result = await dispatchFeature(feature, { conversationId });
  runsProvider2.trackRun(
    result.graphId,
    feature.id,
    feature.name,
    validation.order
  );
  output.appendLine(`Dispatched spec ${feature.id} \u2192 graph ${result.graphId}`);
  stream.markdown(
    `Dispatched **${feature.name}** (${validation.order.length} tasks in order).

Graph: \`${result.graphId}\`

Watch progress in **Agent Runs**.`
  );
}
async function handleRunCommand(context2, store, runsProvider2, request, stream, output) {
  const taskIdMatch = request.prompt.match(/T-\d+/i);
  const taskId = taskIdMatch?.[0]?.toUpperCase();
  const feature = store.getActiveFeature();
  if (!feature || !taskId) {
    stream.markdown("Usage: `@chatllm /run T-001`");
    return;
  }
  const task = store.getTask(feature.id, taskId);
  if (!task) {
    stream.markdown(`Task ${taskId} not found in ${feature.id}.`);
    return;
  }
  const readiness = computeTaskReadiness(feature.tasks);
  const info = readiness.get(taskId);
  if (info && !info.ready) {
    stream.markdown(`Task **${taskId}** is blocked by: ${info.blockedBy.join(", ")}`);
    return;
  }
  stream.progress(`Running ${taskId}\u2026`);
  const conversationId = context2.workspaceState.get("chatllm.conversationId");
  const result = await dispatchFeature(feature, { conversationId, taskIds: [taskId] });
  runsProvider2.trackRun(result.graphId, feature.id, `${feature.name} / ${taskId}`, [taskId]);
  output.appendLine(`Dispatched task ${taskId} \u2192 graph ${result.graphId}`);
  stream.markdown(`Started task **${taskId}**. Graph: \`${result.graphId}\``);
}
function resolveFeatureFromPrompt(store, prompt) {
  const slug = prompt.trim().split(/\s+/)[0];
  if (slug) {
    const byId = store.getFeature(slug);
    if (byId) return byId;
  }
  return store.getActiveFeature();
}
async function offerWriteRequirements(store, request, content, stream) {
  const folder = vscode2.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const slug = request.prompt.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "new-feature";
  const uri = vscode2.Uri.joinPath(folder.uri, ".chatllm", "specs", slug, "requirements.md");
  stream.button({
    command: "chatllm.writeGeneratedFile",
    title: "Save requirements.md",
    arguments: [uri.toString(), content]
  });
  void store.refresh();
}
async function offerWriteDesign(store, content, stream) {
  const feature = store.getActiveFeature();
  if (!feature?.designUri) return;
  stream.button({
    command: "chatllm.writeGeneratedFile",
    title: "Save design.md",
    arguments: [feature.designUri.toString(), content]
  });
}
async function offerWriteTasks(store, content, stream, output) {
  const feature = store.getActiveFeature();
  if (!feature?.tasksDirUri) {
    stream.markdown("No active feature with a tasks/ directory.");
    return;
  }
  const blocks = extractTaskBlocks(content);
  if (!blocks.length) {
    stream.markdown("No ```task blocks found in the response. Ask the model to use the task fence format.");
    return;
  }
  const written = [];
  for (const block of blocks) {
    const wrapped = block.startsWith("---") ? block : `---
${block}
---
`;
    const probeUri = vscode2.Uri.joinPath(feature.tasksDirUri, "_probe.md");
    const parsed = parseTaskContract(feature.id, probeUri, wrapped);
    if (!parsed) continue;
    const slug = parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    parsed.filePath = vscode2.Uri.joinPath(feature.tasksDirUri, `${parsed.id}-${slug}.md`);
    await writeTaskContract(parsed);
    written.push(parsed.id);
  }
  await store.refresh();
  const updated = store.getFeature(feature.id);
  if (updated?.tasksDirUri) {
    const indexUri = vscode2.Uri.joinPath(updated.tasksDirUri, "index.md");
    await writeTextFile(indexUri, regenerateTasksIndex(updated.tasks));
  }
  stream.markdown(`Wrote **${written.length}** task file(s): ${written.join(", ")}`);
  output.appendLine(`Wrote tasks: ${written.join(", ")}`);
}

// src/theme-bridge.ts
var vscode3 = __toESM(require("vscode"));
var CHATLLM_TO_VSCODE = {
  "default:light": "Light Modern",
  "default:dark": "Dark Modern",
  "cursor:light": "Light 2026",
  "cursor:dark": "Dark 2026",
  "github:light": "Light+",
  "github:dark": "Dark+",
  "codex:light": "Quiet Light",
  "codex:dark": "Monokai Dimmed",
  "professional:light": "Visual Studio Light",
  "professional:dark": "Visual Studio Dark",
  "clean:light": "Quiet Light",
  "clean:dark": "Dark Modern",
  "gray-blue:light": "Light Modern",
  "gray-blue:dark": "Tomorrow Night Blue",
  "aurora:light": "Light Modern",
  "aurora:dark": "Dark Modern",
  "midnight:light": "Solarized Light",
  "midnight:dark": "Abyss"
};
var VSCODE_TO_CHATLLM = {
  "Light Modern": { family: "default", mode: "light" },
  "Dark Modern": { family: "default", mode: "dark" },
  "Light+": { family: "github", mode: "light" },
  "Dark+": { family: "github", mode: "dark" },
  "Light 2026": { family: "cursor", mode: "light" },
  "Dark 2026": { family: "cursor", mode: "dark" },
  "Visual Studio Light": { family: "professional", mode: "light" },
  "Visual Studio Dark": { family: "professional", mode: "dark" },
  "Quiet Light": { family: "codex", mode: "light" },
  "Monokai Dimmed": { family: "codex", mode: "dark" },
  "Monokai": { family: "codex", mode: "dark" },
  "Tomorrow Night Blue": { family: "gray-blue", mode: "dark" },
  "Solarized Light": { family: "midnight", mode: "light" },
  "Solarized Dark": { family: "midnight", mode: "dark" },
  "Abyss": { family: "midnight", mode: "dark" },
  "Kimbie Dark": { family: "midnight", mode: "dark" },
  Red: { family: "midnight", mode: "dark" },
  "Default Light Modern": { family: "default", mode: "light" },
  "Default Dark Modern": { family: "default", mode: "dark" },
  "Default Light+": { family: "github", mode: "light" },
  "Default Dark+": { family: "github", mode: "dark" },
  "GitHub Dark Default": { family: "github", mode: "dark" },
  "GitHub Light Default": { family: "github", mode: "light" }
};
function createThemeBridge(output) {
  const apiOrigin = getApiOrigin();
  if (!apiOrigin) {
    output.appendLine("Theme sync disabled: CHATLLM_API_ORIGIN is not set.");
    return { dispose: () => {
    } };
  }
  let lastAppliedFromRemote = null;
  let lastPublishedThemeId = null;
  let ws = null;
  let wsClosed = false;
  let reconnectTimer = null;
  let reconnectDelayMs = 1e3;
  function vsCodeThemeIdFromEnv() {
    const family = process.env.CHATLLM_THEME_FAMILY;
    const mode = process.env.CHATLLM_THEME_MODE;
    if (!family || !mode) return null;
    const effective = mode === "system" ? "dark" : mode;
    return CHATLLM_TO_VSCODE[`${family}:${effective}`] || null;
  }
  async function applyThemeId(themeId, fromRemote) {
    if (!themeId) return;
    const config = vscode3.workspace.getConfiguration("workbench");
    const current = config.get("colorTheme");
    if (current === themeId) return;
    if (fromRemote) lastAppliedFromRemote = themeId;
    try {
      await config.update("colorTheme", themeId, vscode3.ConfigurationTarget.Global);
      output.appendLine(`Applied VS Code theme '${themeId}'${fromRemote ? " (from Chatllm)" : ""}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`Failed to apply VS Code theme '${themeId}': ${message}`);
    }
  }
  async function publishCurrentTheme() {
    const config = vscode3.workspace.getConfiguration("workbench");
    const themeId = config.get("colorTheme");
    if (!themeId) return;
    if (themeId === lastAppliedFromRemote) {
      lastAppliedFromRemote = null;
      lastPublishedThemeId = themeId;
      return;
    }
    if (themeId === lastPublishedThemeId) return;
    const mapped = VSCODE_TO_CHATLLM[themeId];
    if (!mapped) {
      output.appendLine(
        `No Chatllm mapping for VS Code theme '${themeId}'; the Chatllm window will keep its current theme.`
      );
      return;
    }
    const snapshot = {
      kind: "name",
      family: mapped.family,
      mode: mapped.mode,
      vsCodeThemeId: themeId,
      source: "vscode"
    };
    try {
      const response = await apiFetch("/api/theme", {
        method: "PUT",
        body: JSON.stringify(snapshot)
      });
      if (!response.ok) {
        output.appendLine(`Theme publish failed (${response.status}): ${await response.text().catch(() => "")}`);
        return;
      }
      lastPublishedThemeId = themeId;
      output.appendLine(`Published VS Code theme '${themeId}' \u2192 Chatllm (${mapped.family}/${mapped.mode}).`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`Theme publish error: ${message}`);
    }
  }
  function connectStream() {
    if (wsClosed) return;
    const wsUrl = `${apiOrigin.replace(/^http/, "ws")}/api/theme/stream`;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`Theme stream connect failed: ${message}`);
      scheduleReconnect();
      return;
    }
    ws.addEventListener("open", () => {
      reconnectDelayMs = 1e3;
    });
    ws.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (!payload || payload.type !== "theme" || !payload.snapshot) return;
      const snapshot = payload.snapshot;
      if (snapshot.source === "vscode") return;
      if (snapshot.kind === "name") {
        const themeId = snapshot.vsCodeThemeId || CHATLLM_TO_VSCODE[`${snapshot.family}:${snapshot.mode === "system" ? "dark" : snapshot.mode}`];
        void applyThemeId(themeId, true);
      }
    });
    ws.addEventListener("close", () => {
      ws = null;
      scheduleReconnect();
    });
    ws.addEventListener("error", () => {
    });
  }
  function scheduleReconnect() {
    if (wsClosed || reconnectTimer) return;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 3e4);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectStream();
    }, delay);
  }
  const initialThemeId = vsCodeThemeIdFromEnv();
  if (initialThemeId) void applyThemeId(initialThemeId, true);
  const configListener = vscode3.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("workbench.colorTheme")) {
      void publishCurrentTheme();
    }
  });
  connectStream();
  void publishCurrentTheme();
  return {
    dispose() {
      wsClosed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
        }
        ws = null;
      }
      configListener.dispose();
    }
  };
}

// src/spec/store.ts
var vscode4 = __toESM(require("vscode"));
var SPECS_GLOB = "**/.chatllm/specs/**";
var SpecStore = class {
  constructor(output) {
    this.output = output;
  }
  _onDidChange = new vscode4.EventEmitter();
  onDidChange = this._onDidChange.event;
  features = /* @__PURE__ */ new Map();
  watcher;
  activeFeatureId;
  extensionContext;
  async initialize(context2) {
    this.extensionContext = context2;
    this.activeFeatureId = context2.workspaceState.get("chatllm.activeFeatureId");
    this.watcher = vscode4.workspace.createFileSystemWatcher(SPECS_GLOB);
    this.watcher.onDidCreate(() => void this.refresh());
    this.watcher.onDidChange(() => void this.refresh());
    this.watcher.onDidDelete(() => void this.refresh());
    context2.subscriptions.push(this.watcher);
    await this.refresh();
  }
  getActiveFeatureId() {
    return this.activeFeatureId;
  }
  setActiveFeature(featureId) {
    this.activeFeatureId = featureId;
  }
  getFeatures() {
    return [...this.features.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  getFeature(id) {
    return this.features.get(id);
  }
  getActiveFeature() {
    if (!this.activeFeatureId) return this.getFeatures()[0];
    return this.features.get(this.activeFeatureId) ?? this.getFeatures()[0];
  }
  getTask(featureId, taskId) {
    return this.features.get(featureId)?.tasks.find((t) => t.id === taskId);
  }
  async refresh() {
    this.features.clear();
    const folders = vscode4.workspace.workspaceFolders;
    if (!folders?.length) {
      this._onDidChange.fire();
      return;
    }
    for (const folder of folders) {
      const specsRoot = vscode4.Uri.joinPath(folder.uri, ".chatllm", "specs");
      try {
        const entries = await vscode4.workspace.fs.readDirectory(specsRoot);
        for (const [name, type] of entries) {
          if (type !== vscode4.FileType.Directory) continue;
          const feature = await this.loadFeature(folder, specsRoot, name);
          if (feature) this.features.set(feature.id, feature);
        }
      } catch {
      }
    }
    if (this.activeFeatureId && !this.features.has(this.activeFeatureId)) {
      this.activeFeatureId = this.getFeatures()[0]?.id;
    }
    if (this.activeFeatureId) {
      await context.workspaceState.update("chatllm.activeFeatureId", this.activeFeatureId);
    }
    this._onDidChange.fire();
  }
  async loadFeature(folder, specsRoot, dirName) {
    const rootUri = vscode4.Uri.joinPath(specsRoot, dirName);
    const featureMdUri = vscode4.Uri.joinPath(rootUri, "feature.md");
    const requirementsUri = vscode4.Uri.joinPath(rootUri, "requirements.md");
    const designUri = vscode4.Uri.joinPath(rootUri, "design.md");
    const tasksDirUri = vscode4.Uri.joinPath(rootUri, "tasks");
    let status = "draft";
    let displayName = dirName;
    try {
      const featureMd = await readTextFile(featureMdUri);
      status = parseFeatureStatus(featureMd);
      const titleMatch = featureMd.match(/^#\s+(.+)$/m);
      if (titleMatch) displayName = titleMatch[1].trim();
    } catch {
    }
    let requirementIds = [];
    let designIds = [];
    try {
      const reqMd = await readTextFile(requirementsUri);
      requirementIds = extractSectionIds(reqMd, "R");
    } catch {
    }
    try {
      const desMd = await readTextFile(designUri);
      designIds = extractSectionIds(desMd, "D");
    } catch {
    }
    const tasks = [];
    try {
      const taskEntries = await vscode4.workspace.fs.readDirectory(tasksDirUri);
      for (const [fileName, fileType] of taskEntries) {
        if (fileType !== vscode4.FileType.File) continue;
        if (!/^T-\d+/i.test(fileName) || !fileName.endsWith(".md")) continue;
        const filePath = vscode4.Uri.joinPath(tasksDirUri, fileName);
        try {
          const raw = await readTextFile(filePath);
          const task = parseTaskContract(dirName, filePath, raw);
          if (task) tasks.push(task);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.output.appendLine(`Failed to parse task ${fileName}: ${message}`);
        }
      }
    } catch {
    }
    tasks.sort((a, b) => a.id.localeCompare(b.id));
    return {
      id: dirName,
      name: displayName,
      status,
      rootUri,
      featureMdUri,
      requirementsUri,
      designUri,
      tasksDirUri,
      requirementIds,
      designIds,
      tasks
    };
  }
  dispose() {
    this.watcher?.dispose();
    this._onDidChange.dispose();
  }
};

// src/views/specsTree.ts
var vscode5 = __toESM(require("vscode"));
var SpecsTreeProvider = class {
  constructor(store) {
    this.store = store;
    store.onDidChange(() => this._onDidChangeTreeData.fire(void 0));
  }
  _onDidChangeTreeData = new vscode5.EventEmitter();
  onDidChangeTreeData = this._onDidChangeTreeData.event;
  refresh() {
    this._onDidChangeTreeData.fire(void 0);
  }
  getTreeItem(element) {
    if (element.kind === "feature") {
      const item2 = new vscode5.TreeItem(element.feature.name, vscode5.TreeItemCollapsibleState.Expanded);
      item2.description = element.feature.status;
      item2.contextValue = "feature";
      item2.iconPath = new vscode5.ThemeIcon("folder");
      item2.command = {
        command: "chatllm.setActiveFeature",
        title: "Set Active",
        arguments: [element.feature.id]
      };
      return item2;
    }
    if (element.kind === "group") {
      const item2 = new vscode5.TreeItem(element.label, vscode5.TreeItemCollapsibleState.Collapsed);
      item2.iconPath = new vscode5.ThemeIcon("folder");
      return item2;
    }
    const item = new vscode5.TreeItem(element.label, vscode5.TreeItemCollapsibleState.None);
    item.resourceUri = element.uri;
    item.command = { command: "vscode.open", title: "Open", arguments: [element.uri] };
    item.iconPath = new vscode5.ThemeIcon("file");
    return item;
  }
  getChildren(element) {
    if (!element) {
      return this.store.getFeatures().map((feature) => ({ kind: "feature", feature }));
    }
    if (element.kind === "feature") {
      const f = element.feature;
      return [
        { kind: "group", featureId: f.id, label: "Requirements", group: "requirements" },
        { kind: "group", featureId: f.id, label: "Design", group: "design" },
        { kind: "group", featureId: f.id, label: "Tasks", group: "tasks" }
      ];
    }
    if (element.kind === "group") {
      const feature = this.store.getFeature(element.featureId);
      if (!feature) return [];
      if (element.group === "requirements" && feature.requirementsUri) {
        return [
          {
            kind: "file",
            uri: feature.requirementsUri,
            label: `requirements.md (${feature.requirementIds.length} sections)`
          }
        ];
      }
      if (element.group === "design" && feature.designUri) {
        return [
          {
            kind: "file",
            uri: feature.designUri,
            label: `design.md (${feature.designIds.length} sections)`
          }
        ];
      }
      if (element.group === "tasks" && feature.tasksDirUri) {
        const items = [
          { kind: "file", uri: vscode5.Uri.joinPath(feature.tasksDirUri, "index.md"), label: "index.md" }
        ];
        for (const task of feature.tasks) {
          items.push({
            kind: "file",
            uri: task.filePath,
            label: `${task.id} \u2014 ${task.title}`
          });
        }
        return items;
      }
    }
    return [];
  }
};

// src/views/tasksTree.ts
var vscode6 = __toESM(require("vscode"));
var TasksTreeProvider = class {
  constructor(store) {
    this.store = store;
    store.onDidChange(() => this._onDidChangeTreeData.fire(void 0));
  }
  _onDidChangeTreeData = new vscode6.EventEmitter();
  onDidChangeTreeData = this._onDidChangeTreeData.event;
  refresh() {
    this._onDidChangeTreeData.fire(void 0);
  }
  getTreeItem(element) {
    if (element.kind === "statusGroup") {
      const item2 = new vscode6.TreeItem(element.label, vscode6.TreeItemCollapsibleState.Expanded);
      item2.iconPath = new vscode6.ThemeIcon("folder");
      return item2;
    }
    const readiness = computeTaskReadiness(
      this.store.getFeature(element.featureId)?.tasks ?? []
    );
    const status = effectiveStatus(element.task, readiness);
    const blocked = readiness.get(element.task.id)?.blockedBy ?? [];
    const item = new vscode6.TreeItem(
      `${element.task.id}: ${element.task.title}`,
      vscode6.TreeItemCollapsibleState.None
    );
    item.description = blocked.length ? `blocked by ${blocked.join(", ")}` : status;
    item.contextValue = "task";
    item.iconPath = statusIcon(status);
    item.command = {
      command: "chatllm.openTask",
      title: "Open Task",
      arguments: [element.featureId, element.task.id]
    };
    return item;
  }
  getChildren(element) {
    const feature = this.store.getActiveFeature();
    if (!feature) {
      return [{ kind: "statusGroup", label: "No active feature \u2014 scaffold a spec", status: "none" }];
    }
    if (!element) {
      const groups = groupTasksByStatus(feature.tasks);
      const order = ["running", "ready", "blocked", "pending", "failed", "completed"];
      return order.filter((k) => groups[k].length > 0).map((k) => ({
        kind: "statusGroup",
        label: `${capitalize(k)} (${groups[k].length})`,
        status: k
      }));
    }
    if (element.kind === "statusGroup") {
      const groups = groupTasksByStatus(feature.tasks);
      const tasks = groups[element.status] ?? [];
      return tasks.map((task) => ({ kind: "task", task, featureId: feature.id }));
    }
    return [];
  }
};
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function statusIcon(status) {
  switch (status) {
    case "running":
      return new vscode6.ThemeIcon("sync~spin");
    case "completed":
      return new vscode6.ThemeIcon("check");
    case "failed":
      return new vscode6.ThemeIcon("error");
    case "blocked":
      return new vscode6.ThemeIcon("lock");
    case "ready":
      return new vscode6.ThemeIcon("debug-start");
    default:
      return new vscode6.ThemeIcon("circle-outline");
  }
}

// src/views/runsTree.ts
var vscode7 = __toESM(require("vscode"));
var RunsTreeProvider = class {
  constructor(output, onTaskStatusWriteback) {
    this.output = output;
    this.onTaskStatusWriteback = onTaskStatusWriteback;
  }
  _onDidChangeTreeData = new vscode7.EventEmitter();
  onDidChangeTreeData = this._onDidChangeTreeData.event;
  runs = /* @__PURE__ */ new Map();
  refresh() {
    void this.loadRecentGraphs();
  }
  trackRun(graphId, featureId, featureName, nodeIds) {
    const existing = this.runs.get(graphId);
    existing?.unsubscribe?.();
    const run = {
      graphId,
      featureId,
      featureName,
      status: "running",
      nodeStatuses: new Map(nodeIds.map((id) => [id, "queued"]))
    };
    run.unsubscribe = subscribeExecutionGraphEvents(graphId, {
      onEvent: (event) => this.handleEvent(run, event),
      onError: (err) => this.output.appendLine(`Run ${graphId} stream error: ${err.message}`),
      onDone: () => {
        run.status = "completed";
        this._onDidChangeTreeData.fire(void 0);
      }
    });
    this.runs.set(graphId, run);
    this._onDidChangeTreeData.fire(void 0);
  }
  getActiveGraphIds() {
    return [...this.runs.keys()];
  }
  cancelRun(graphId) {
    const run = this.runs.get(graphId);
    if (run) {
      run.unsubscribe?.();
      run.status = "cancelled";
      this._onDidChangeTreeData.fire(void 0);
    }
  }
  handleEvent(run, event) {
    if (event.type === "node_status" && event.nodeId && event.status) {
      run.nodeStatuses.set(event.nodeId, event.status);
      this.output.appendLine(`[${run.graphId}] ${event.nodeId}: ${event.status}`);
      const mapped = mapNodeStatusToTask(event.status);
      if (mapped) {
        void this.onTaskStatusWriteback?.(run.featureId, event.nodeId, mapped);
      }
    }
    if (event.type === "graph_status" || event.type === "done") {
      const status = event.status ?? event.payload?.status;
      if (status === "completed" || status === "failed" || status === "cancelled") {
        run.status = status;
        run.unsubscribe?.();
      }
    }
    this._onDidChangeTreeData.fire(void 0);
  }
  async loadRecentGraphs() {
    try {
      const response = await apiFetch("/api/execution-graphs?status=running&limit=10");
      if (!response.ok) return;
      const graphs = await response.json();
      for (const graph of graphs) {
        if (!this.runs.has(graph.id) && graph.metadata?.specFeature) {
          this.trackRun(graph.id, graph.metadata.specFeature, graph.goal, []);
        }
      }
    } catch {
    }
    this._onDidChangeTreeData.fire(void 0);
  }
  getTreeItem(element) {
    if (element.kind === "run") {
      const item2 = new vscode7.TreeItem(
        element.run.featureName,
        vscode7.TreeItemCollapsibleState.Expanded
      );
      item2.description = element.run.status;
      item2.iconPath = new vscode7.ThemeIcon("run-all");
      return item2;
    }
    const item = new vscode7.TreeItem(element.nodeId, vscode7.TreeItemCollapsibleState.None);
    item.description = element.status;
    item.iconPath = new vscode7.ThemeIcon("circle-outline");
    return item;
  }
  getChildren(element) {
    if (!element) {
      if (this.runs.size === 0) {
        return [];
      }
      return [...this.runs.values()].map((run) => ({ kind: "run", run }));
    }
    if (element.kind === "run") {
      return [...element.run.nodeStatuses.entries()].map(([nodeId, status]) => ({
        kind: "node",
        run: element.run,
        nodeId,
        status
      }));
    }
    return [];
  }
};
function mapNodeStatusToTask(nodeStatus) {
  switch (nodeStatus) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "queued":
    case "blocked":
      return "blocked";
    default:
      return void 0;
  }
}

// src/extension.ts
var ACTIVITY_VIEW_ID = "workbench.view.extension.chatllm";
var specStore;
var runsProvider;
async function activate(context2) {
  const output = vscode8.window.createOutputChannel("Chatllm");
  specStore = new SpecStore(output);
  await specStore.initialize(context2);
  const specsTree = new SpecsTreeProvider(specStore);
  const tasksTree = new TasksTreeProvider(specStore);
  runsProvider = new RunsTreeProvider(output, async (featureId, taskId, status) => {
    const task = specStore.getTask(featureId, taskId);
    if (task) {
      await updateTaskStatus(task.filePath, status);
      await specStore.refresh();
      tasksTree.refresh();
    }
  });
  context2.subscriptions.push(
    output,
    specStore,
    vscode8.window.registerTreeDataProvider("chatllm.specs", specsTree),
    vscode8.window.registerTreeDataProvider("chatllm.tasks", tasksTree),
    vscode8.window.registerTreeDataProvider("chatllm.runs", runsProvider),
    registerChatParticipant(context2, specStore, runsProvider, output),
    createThemeBridge(output),
    createStatusBarItem(),
    ...registerCommands(context2, specsTree, tasksTree, output)
  );
  runsProvider.refresh();
  output.appendLine("Chatllm VS Code extension activated.");
}
function registerCommands(context2, specsTree, tasksTree, output) {
  return [
    vscode8.commands.registerCommand("chatllm.openChat", async () => {
      await vscode8.commands.executeCommand("workbench.action.chat.open");
    }),
    vscode8.commands.registerCommand("chatllm.openPanel", async () => {
      await vscode8.commands.executeCommand(ACTIVITY_VIEW_ID);
    }),
    vscode8.commands.registerCommand("chatllm.refreshSpecs", async () => {
      await specStore.refresh();
      specsTree.refresh();
    }),
    vscode8.commands.registerCommand("chatllm.refreshTasks", async () => {
      await specStore.refresh();
      tasksTree.refresh();
    }),
    vscode8.commands.registerCommand("chatllm.refreshRuns", () => {
      runsProvider.refresh();
    }),
    vscode8.commands.registerCommand("chatllm.scaffoldFeature", async () => {
      const folder = vscode8.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode8.window.showErrorMessage("Open a workspace folder first.");
        return;
      }
      const name = await vscode8.window.showInputBox({ prompt: "Feature name" });
      if (!name?.trim()) return;
      const root = await scaffoldFeature(folder, name.trim());
      await specStore.refresh();
      specStore.setActiveFeature(root.path.split("/").pop() ?? name);
      await context2.workspaceState.update("chatllm.activeFeatureId", specStore.getActiveFeatureId());
      specsTree.refresh();
      void vscode8.window.showInformationMessage(`Scaffolded spec at ${root.fsPath}`);
    }),
    vscode8.commands.registerCommand(
      "chatllm.setActiveFeature",
      async (arg) => {
        const featureId = typeof arg === "string" ? arg : arg?.feature?.id;
        if (!featureId) return;
        specStore.setActiveFeature(featureId);
        await context2.workspaceState.update("chatllm.activeFeatureId", featureId);
        tasksTree.refresh();
        void vscode8.window.showInformationMessage(`Active spec: ${featureId}`);
      }
    ),
    vscode8.commands.registerCommand("chatllm.openTask", async (arg) => {
      const ctx = resolveTaskArg(arg);
      if (!ctx) return;
      const task = specStore.getTask(ctx.featureId, ctx.taskId);
      if (task) await vscode8.window.showTextDocument(task.filePath);
    }),
    vscode8.commands.registerCommand("chatllm.runTask", async (arg) => {
      const ctx = resolveTaskArg(arg);
      if (!ctx) return;
      const feature = specStore.getFeature(ctx.featureId);
      if (!feature) return;
      try {
        const result = await dispatchFeature(feature, { taskIds: [ctx.taskId] });
        runsProvider.trackRun(result.graphId, feature.id, `${feature.name} / ${ctx.taskId}`, [ctx.taskId]);
        const task = specStore.getTask(ctx.featureId, ctx.taskId);
        if (task) await updateTaskStatus(task.filePath, "running");
        await specStore.refresh();
        tasksTree.refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode8.window.showErrorMessage(message);
      }
    }),
    vscode8.commands.registerCommand("chatllm.markTaskReady", async (arg) => {
      const ctx = resolveTaskArg(arg);
      if (!ctx) return;
      const task = specStore.getTask(ctx.featureId, ctx.taskId);
      if (!task) return;
      await updateTaskStatus(task.filePath, "ready");
      await specStore.refresh();
      tasksTree.refresh();
    }),
    vscode8.commands.registerCommand("chatllm.dispatchFeature", async () => {
      const feature = specStore.getActiveFeature();
      if (!feature) {
        void vscode8.window.showErrorMessage("No active spec feature.");
        return;
      }
      try {
        const result = await dispatchFeature(feature);
        runsProvider.trackRun(
          result.graphId,
          feature.id,
          feature.name,
          feature.tasks.map((t) => t.id)
        );
        void vscode8.window.showInformationMessage(`Dispatched ${feature.name} (${result.graphId})`);
        runsProvider.refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode8.window.showErrorMessage(message);
        output.appendLine(message);
      }
    }),
    vscode8.commands.registerCommand("chatllm.regenerateTasksIndex", async () => {
      const feature = specStore.getActiveFeature();
      if (!feature?.tasksDirUri) return;
      const indexUri = vscode8.Uri.joinPath(feature.tasksDirUri, "index.md");
      await writeTextFile(indexUri, regenerateTasksIndex(feature.tasks));
      void vscode8.window.showInformationMessage("Regenerated tasks/index.md");
    }),
    vscode8.commands.registerCommand("chatllm.cancelRun", async () => {
      const graphId = await vscode8.window.showInputBox({ prompt: "Graph id to cancel" });
      if (!graphId) return;
      try {
        await cancelExecutionGraph(graphId);
        runsProvider.cancelRun(graphId);
        void vscode8.window.showInformationMessage(`Cancelled ${graphId}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode8.window.showErrorMessage(message);
      }
    }),
    vscode8.commands.registerCommand(
      "chatllm.writeGeneratedFile",
      async (uriString, content) => {
        const uri = vscode8.Uri.parse(uriString);
        await writeTextFile(uri, content);
        await specStore.refresh();
        specsTree.refresh();
        await vscode8.window.showTextDocument(uri);
      }
    )
  ];
}
function createStatusBarItem() {
  const item = vscode8.window.createStatusBarItem(vscode8.StatusBarAlignment.Left, 100);
  item.text = "$(comment-discussion) Chatllm";
  item.tooltip = "Open Chatllm chat";
  item.command = "chatllm.openChat";
  item.show();
  return item;
}
function resolveTaskArg(arg) {
  if (!arg) {
    const feature = specStore.getActiveFeature();
    const taskId = feature?.tasks.find((t) => t.status === "ready" || t.status === "pending")?.id;
    if (feature && taskId) return { featureId: feature.id, taskId };
    return void 0;
  }
  if (Array.isArray(arg)) return { featureId: arg[0], taskId: arg[1] };
  if (arg.kind === "task") return { featureId: arg.featureId, taskId: arg.task.id };
  return void 0;
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
