import * as vscode from "vscode";
import { fetchConfig } from "../api";
import { dispatchFeature } from "../dispatch/client";
import { computeTaskReadiness, validateDag } from "../spec/dag";
import { parseTaskContract } from "../spec/schema";
import type { SpecStore } from "../spec/store";
import { readTextFile, regenerateTasksIndex, writeTaskContract, writeTextFile } from "../spec/writer";
import type { RunsTreeProvider } from "../views/runsTree";
import { extractTaskBlocks, SPEC_SYSTEM_PROMPTS } from "./commands";
import { streamChat } from "./stream-client";
import type { AppConfig, ChatRequest, Provider } from "./types";

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  store: SpecStore,
  runs: RunsTreeProvider,
): vscode.Disposable {
  if (!vscode.chat?.createChatParticipant) return { dispose() {} };
  const participant = vscode.chat.createChatParticipant("chatllm.chatllm", async (request, _ctx, stream, token) => {
    try {
      await handleRequest(context, store, runs, request, stream, token);
    } catch (error) {
      stream.markdown(`**Error:** ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  participant.iconPath = new vscode.ThemeIcon("comment-discussion");
  return participant;
}

async function handleRequest(
  context: vscode.ExtensionContext,
  store: SpecStore,
  runs: RunsTreeProvider,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  if (request.command === "status") return status(store, stream);
  if (request.command === "dispatch") return dispatch(context, store, runs, stream);
  if (request.command === "run") return runTask(context, store, runs, request.prompt, stream);

  const config = await fetchConfig().catch(() => ({} as AppConfig));
  const model = config.configuredModels?.find((m) => m.capability === "chat") ?? config.configuredModels?.[0];
  const body: ChatRequest = {
    conversationId: context.workspaceState.get("chatllm.conversationId"),
    provider: (model?.provider ?? "openai") as Provider,
    model: model?.model ?? "gpt-4o-mini",
    modelSelection: "auto",
    chatMode: request.command === "design" || request.command === "tasks" ? "agent" : "normal",
    content: await buildPrompt(store, request),
    systemPrompt: request.command ? SPEC_SYSTEM_PROMPTS[request.command] : undefined,
    skillIds: [],
    documentIds: [],
    useRag: false,
    toolsEnabled: request.command === "design" || request.command === "tasks",
    mcpServerIds: [],
    agentIds: [],
    maxAgentSpawns: 3,
  };
  const abort = new AbortController();
  const sub = token.onCancellationRequested(() => abort.abort());
  let fullText = "";
  try {
    const response = await streamChat(body, {
      onToken(chunk) { fullText += chunk; stream.markdown(chunk); },
      onToolEvent(event) { stream.progress(`Tool: ${event.name}`); },
    }, abort.signal);
    if (response.conversation?.id) await context.workspaceState.update("chatllm.conversationId", response.conversation.id);
  } finally {
    sub.dispose();
  }
  if (request.command === "tasks") await writeGeneratedTasks(store, fullText, stream);
}

async function buildPrompt(store: SpecStore, request: vscode.ChatRequest): Promise<string> {
  const feature = store.getActiveFeature();
  const parts = [request.prompt];
  if (request.command === "design" && feature?.requirementsUri) parts.unshift(await readTextFile(feature.requirementsUri));
  if (request.command === "tasks" && feature?.requirementsUri) parts.unshift(await readTextFile(feature.requirementsUri));
  if (request.command === "tasks" && feature?.designUri) parts.unshift(await readTextFile(feature.designUri));
  return parts.join("\n\n---\n\n");
}

function status(store: SpecStore, stream: vscode.ChatResponseStream): void {
  const feature = store.getActiveFeature();
  if (!feature) return stream.markdown("No spec features found.");
  const ready = computeTaskReadiness(feature.tasks);
  stream.markdown(["## " + feature.name, `Status: **${feature.status}**`, ...feature.tasks.map((task) => `- ${task.id}: ${task.status}${ready.get(task.id)?.blockedBy.length ? " (blocked)" : ""}`)].join("\n"));
}

async function dispatch(context: vscode.ExtensionContext, store: SpecStore, runs: RunsTreeProvider, stream: vscode.ChatResponseStream): Promise<void> {
  const feature = store.getActiveFeature();
  if (!feature) return stream.markdown("No active feature.");
  const validation = validateDag(feature.tasks);
  if (!validation.ok) return stream.markdown(`Cannot dispatch: ${validation.error}`);
  const result = await dispatchFeature(feature, { conversationId: context.workspaceState.get("chatllm.conversationId") });
  runs.trackRun(result.graphId, feature.id, feature.name, validation.order);
  stream.markdown(`Dispatched **${feature.name}** as graph \`${result.graphId}\`.`);
}

async function runTask(context: vscode.ExtensionContext, store: SpecStore, runs: RunsTreeProvider, prompt: string, stream: vscode.ChatResponseStream): Promise<void> {
  const feature = store.getActiveFeature();
  const taskId = prompt.match(/T-\d+/i)?.[0].toUpperCase();
  if (!feature || !taskId) return stream.markdown("Usage: `@chatllm /run T-001`");
  const result = await dispatchFeature(feature, { conversationId: context.workspaceState.get("chatllm.conversationId"), taskIds: [taskId] });
  runs.trackRun(result.graphId, feature.id, `${feature.name} / ${taskId}`, [taskId]);
  stream.markdown(`Started **${taskId}** as graph \`${result.graphId}\`.`);
}

async function writeGeneratedTasks(store: SpecStore, text: string, stream: vscode.ChatResponseStream): Promise<void> {
  const feature = store.getActiveFeature();
  if (!feature?.tasksDirUri) return;
  const written: string[] = [];
  for (const block of extractTaskBlocks(text)) {
    const probe = vscode.Uri.joinPath(feature.tasksDirUri, "_probe.md");
    const task = parseTaskContract(feature.id, probe, block.startsWith("---") ? block : `---\n${block}\n---\n`);
    if (!task) continue;
    task.filePath = vscode.Uri.joinPath(feature.tasksDirUri, `${task.id}-${task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.md`);
    await writeTaskContract(task);
    written.push(task.id);
  }
  await store.refresh();
  const updated = store.getFeature(feature.id);
  if (updated?.tasksDirUri) await writeTextFile(vscode.Uri.joinPath(updated.tasksDirUri, "index.md"), regenerateTasksIndex(updated.tasks));
  if (written.length) stream.markdown(`\n\nWrote task files: ${written.join(", ")}`);
}
