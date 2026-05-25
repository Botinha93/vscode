import * as vscode from "vscode";
import { fetchConfig } from "../api";
import { streamChat } from "./stream-client";
import type { ChatRequest, Provider } from "./types";
import { SPEC_SYSTEM_PROMPTS, extractTaskBlocks } from "./commands";
import type { SpecStore } from "../spec/store";
import { parseTaskContract } from "../spec/schema";
import { writeTaskContract, writeTextFile, regenerateTasksIndex, readTextFile } from "../spec/writer";
import { dispatchFeature } from "../dispatch/client";
import { validateDag, computeTaskReadiness, effectiveStatus } from "../spec/dag";
import type { RunsTreeProvider } from "../views/runsTree";

const PARTICIPANT_ID = "chatllm.chatllm";

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  store: SpecStore,
  runsProvider: RunsTreeProvider,
  output: vscode.OutputChannel,
): vscode.Disposable {
  if (!vscode.chat?.createChatParticipant) {
    output.appendLine("vscode.chat.createChatParticipant is not available in this host.");
    return { dispose: () => {} };
  }

  const handler: vscode.ChatRequestHandler = async (
    request,
    chatContext,
    stream,
    token,
  ) => {
    try {
      await handleChatRequest(context, store, runsProvider, request, chatContext, stream, token, output);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stream.markdown(`**Error:** ${message}`);
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = new vscode.ThemeIcon("comment-discussion");

  return participant;
}

async function handleChatRequest(
  context: vscode.ExtensionContext,
  store: SpecStore,
  runsProvider: RunsTreeProvider,
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  output: vscode.OutputChannel,
): Promise<void> {
  const command = request.command;

  if (command === "status") {
    await handleStatusCommand(store, stream);
    return;
  }

  if (command === "dispatch") {
    await handleDispatchCommand(context, store, runsProvider, request, stream, output);
    return;
  }

  if (command === "run") {
    await handleRunCommand(context, store, runsProvider, request, stream, output);
    return;
  }

  const config = await fetchConfig().catch(() => ({} as import("./types").AppConfig));
  const preferred =
    config.configuredModels?.find((m) => m.capability === "chat") ?? config.configuredModels?.[0];
  const provider = (preferred?.provider ?? "openai") as Provider;
  const model = preferred?.model ?? "gpt-4o-mini";
  const conversationId = context.workspaceState.get<string>("chatllm.conversationId");

  let systemPrompt: string | undefined;
  let userContent = buildPromptWithReferences(request);

  if (command === "spec") {
    systemPrompt = SPEC_SYSTEM_PROMPTS.spec;
    const featureName = request.prompt.trim() || "new-feature";
    userContent = `Create requirements for feature: ${featureName}\n\n${userContent}`;
  } else if (command === "design") {
    systemPrompt = SPEC_SYSTEM_PROMPTS.design;
    const feature = store.getActiveFeature();
    if (feature?.requirementsUri) {
      const req = await readTextFile(feature.requirementsUri);
      userContent = `Requirements:\n\n${req}\n\n---\n\nUser request:\n${userContent}`;
    }
  } else if (command === "tasks") {
    systemPrompt = SPEC_SYSTEM_PROMPTS.tasks;
    const feature = store.getActiveFeature();
    if (feature) {
      const parts = [userContent];
      if (feature.requirementsUri) {
        parts.unshift(`Requirements:\n\n${await readTextFile(feature.requirementsUri)}`);
      }
      if (feature.designUri) {
        parts.unshift(`Design:\n\n${await readTextFile(feature.designUri)}`);
      }
      userContent = parts.join("\n\n---\n\n");
    }
  } else if (command) {
    systemPrompt = SPEC_SYSTEM_PROMPTS[command];
  }

  const body: ChatRequest = {
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
    maxAgentSpawns: 3,
  };

  stream.progress("Thinking…");
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
        },
      },
      abortController.signal,
    );
  } finally {
    cancellationListener.dispose();
  }

  if (response.conversation?.id) {
    await context.workspaceState.update("chatllm.conversationId", response.conversation.id);
  }

  if (command === "spec") {
    await offerWriteRequirements(store, request, fullText, stream);
  } else if (command === "design") {
    await offerWriteDesign(store, fullText, stream);
  } else if (command === "tasks") {
    await offerWriteTasks(store, fullText, stream, output);
  }
}

function buildPromptWithReferences(request: vscode.ChatRequest): string {
  const parts = [request.prompt];
  for (const ref of request.references) {
    const value = ref.value;
    if (typeof value === "string") {
      parts.push(`\n\n[Reference ${ref.id}]\n${value}`);
    } else if (value instanceof vscode.Uri) {
      parts.push(`\n\n[File ${ref.id}]: ${value.fsPath}`);
    } else if (value && typeof value === "object" && "uri" in value) {
      const loc = value as vscode.Location;
      parts.push(`\n\n[Location ${ref.id}]: ${loc.uri.fsPath}:${loc.range.start.line}`);
    }
  }
  return parts.join("");
}

async function handleStatusCommand(store: SpecStore, stream: vscode.ChatResponseStream): Promise<void> {
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
    "",
  ];
  for (const task of feature.tasks) {
    const eff = effectiveStatus(task, readiness);
    const blocked = readiness.get(task.id)?.blockedBy ?? [];
    lines.push(`- **${task.id}** (${eff})${blocked.length ? ` — blocked by ${blocked.join(", ")}` : ""}`);
  }
  stream.markdown(lines.join("\n"));
}

async function handleDispatchCommand(
  context: vscode.ExtensionContext,
  store: SpecStore,
  runsProvider: RunsTreeProvider,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  output: vscode.OutputChannel,
): Promise<void> {
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

  stream.progress("Dispatching task graph…");
  const conversationId = context.workspaceState.get<string>("chatllm.conversationId");
  const result = await dispatchFeature(feature, { conversationId });
  runsProvider.trackRun(
    result.graphId,
    feature.id,
    feature.name,
    validation.order,
  );
  output.appendLine(`Dispatched spec ${feature.id} → graph ${result.graphId}`);
  stream.markdown(
    `Dispatched **${feature.name}** (${validation.order.length} tasks in order).\n\nGraph: \`${result.graphId}\`\n\nWatch progress in **Agent Runs**.`,
  );
}

async function handleRunCommand(
  context: vscode.ExtensionContext,
  store: SpecStore,
  runsProvider: RunsTreeProvider,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  output: vscode.OutputChannel,
): Promise<void> {
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

  stream.progress(`Running ${taskId}…`);
  const conversationId = context.workspaceState.get<string>("chatllm.conversationId");
  const result = await dispatchFeature(feature, { conversationId, taskIds: [taskId] });
  runsProvider.trackRun(result.graphId, feature.id, `${feature.name} / ${taskId}`, [taskId]);
  output.appendLine(`Dispatched task ${taskId} → graph ${result.graphId}`);
  stream.markdown(`Started task **${taskId}**. Graph: \`${result.graphId}\``);
}

function resolveFeatureFromPrompt(store: SpecStore, prompt: string) {
  const slug = prompt.trim().split(/\s+/)[0];
  if (slug) {
    const byId = store.getFeature(slug);
    if (byId) return byId;
  }
  return store.getActiveFeature();
}

async function offerWriteRequirements(
  store: SpecStore,
  request: vscode.ChatRequest,
  content: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  const slug =
    request.prompt.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "new-feature";
  const uri = vscode.Uri.joinPath(folder.uri, ".chatllm", "specs", slug, "requirements.md");

  stream.button({
    command: "chatllm.writeGeneratedFile",
    title: "Save requirements.md",
    arguments: [uri.toString(), content],
  });
  void store.refresh();
}

async function offerWriteDesign(
  store: SpecStore,
  content: string,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const feature = store.getActiveFeature();
  if (!feature?.designUri) return;
  stream.button({
    command: "chatllm.writeGeneratedFile",
    title: "Save design.md",
    arguments: [feature.designUri.toString(), content],
  });
}

async function offerWriteTasks(
  store: SpecStore,
  content: string,
  stream: vscode.ChatResponseStream,
  output: vscode.OutputChannel,
): Promise<void> {
  const feature = store.getActiveFeature();
  if (!feature?.tasksDirUri) {
    stream.markdown("No active feature with a tasks/ directory.");
    return;
  }

  const blocks = extractTaskBlocks(content);
  if (!blocks.length) {
    stream.markdown("No \`\`\`task blocks found in the response. Ask the model to use the task fence format.");
    return;
  }

  const written: string[] = [];
  for (const block of blocks) {
    const wrapped = block.startsWith("---") ? block : `---\n${block}\n---\n`;
    const probeUri = vscode.Uri.joinPath(feature.tasksDirUri!, "_probe.md");
    const parsed = parseTaskContract(feature.id, probeUri, wrapped);
    if (!parsed) continue;
    const slug = parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    parsed.filePath = vscode.Uri.joinPath(feature.tasksDirUri!, `${parsed.id}-${slug}.md`);
    await writeTaskContract(parsed);
    written.push(parsed.id);
  }

  await store.refresh();
  const updated = store.getFeature(feature.id);
  if (updated?.tasksDirUri) {
    const indexUri = vscode.Uri.joinPath(updated.tasksDirUri, "index.md");
    await writeTextFile(indexUri, regenerateTasksIndex(updated.tasks));
  }

  stream.markdown(`Wrote **${written.length}** task file(s): ${written.join(", ")}`);
  output.appendLine(`Wrote tasks: ${written.join(", ")}`);
}
