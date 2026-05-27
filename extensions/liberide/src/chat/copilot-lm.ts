import * as vscode from "vscode";
import type { ConfiguredModel, ModelCapability, ToolCallEvent } from "./types";
import { PROVIDER_LABELS } from "./models";
import { apiFetch } from "../api";

export async function listCopilotLmModels(): Promise<ConfiguredModel[]> {
  const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  const now = new Date().toISOString();
  return models.map((m) => ({
    id: `lm:copilot:${m.id}`,
    provider: "copilot",
    modelId: m.id,
    displayName: m.name || `${PROVIDER_LABELS.copilot} · ${m.id}`,
    description: m.family ? `${m.family}${m.version ? ` · ${m.version}` : ""}` : undefined,
    capabilities: capabilitiesFromLm(m),
    apiKeyConfigured: true,
    contextWindow: m.maxInputTokens,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }));
}

function capabilitiesFromLm(model: vscode.LanguageModelChat): ModelCapability[] {
  const caps = new Set<ModelCapability>(["chat", "tools"]);
  const id = `${model.vendor}/${model.family}/${model.id}`.toLowerCase();
  if (id.includes("vision") || id.includes("vl") || id.includes("4o")) caps.add("vision");
  if (id.includes("code") || id.includes("coder")) caps.add("code");
  if (model.maxInputTokens && model.maxInputTokens >= 128_000) caps.add("long-context");
  return [...caps];
}

function toLmMessages(history: Array<{ role: "user" | "assistant"; content: string }>): vscode.LanguageModelChatMessage[] {
  return history.map((m) =>
    m.role === "user"
      ? vscode.LanguageModelChatMessage.User(m.content)
      : vscode.LanguageModelChatMessage.Assistant(m.content),
  );
}

export async function streamCopilotChat(input: {
  modelId: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  prompt: string;
  toolsEnabled: boolean;
  onToken: (token: string) => void;
  onToolEvent: (event: ToolCallEvent) => void;
  signal?: AbortSignal;
}): Promise<{ content: string; toolEvents: ToolCallEvent[] }> {
  const [model] = await vscode.lm.selectChatModels({ vendor: "copilot", id: input.modelId });
  if (!model) throw new Error(`Copilot model not available: ${input.modelId}`);

  const toolEvents: ToolCallEvent[] = [];
  let content = "";

  const cancellation = new vscode.CancellationTokenSource();
  if (input.signal) {
    if (input.signal.aborted) cancellation.cancel();
    else input.signal.addEventListener("abort", () => cancellation.cancel(), { once: true });
  }

  const tools = input.toolsEnabled ? await buildToolStubs() : [];
  const messages = [
    ...toLmMessages(input.history),
    vscode.LanguageModelChatMessage.User(input.prompt),
  ];

  const runOnce = async (): Promise<vscode.LanguageModelChatResponse> => {
    return model.sendRequest(messages, { tools, toolMode: vscode.LanguageModelChatToolMode.Auto }, cancellation.token);
  };

  let response = await runOnce();
  for await (const part of response.stream) {
    if (typeof part === "string") continue;
    if ((part as any).type === "text") {
      const text = (part as vscode.LanguageModelTextPart).value;
      content += text;
      input.onToken(text);
      continue;
    }
    if ((part as any).type === "tool_call") {
      const call = part as vscode.LanguageModelToolCallPart;
      const event: ToolCallEvent = {
        id: call.callId,
        name: call.name,
        arguments: call.input as Record<string, unknown>,
        createdAt: new Date().toISOString(),
      };
      toolEvents.push(event);
      input.onToolEvent(event);

      const result = await invokeBackendTool({
        name: call.name,
        arguments: call.input as Record<string, unknown>,
      });

      const done: ToolCallEvent = { ...event, result: result.result ?? JSON.stringify(result), createdAt: event.createdAt };
      toolEvents.push(done);
      input.onToolEvent(done);

      messages.push(vscode.LanguageModelChatMessage.Assistant([call]));
      messages.push(vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(call.callId, result.result ?? "")]));
      response = await runOnce();
    }
  }

  // If any tool calls happened, the visible text is in the final response too.
  if (!content) {
    for await (const token of response.text) {
      content += token;
      input.onToken(token);
    }
  }

  return { content, toolEvents };
}

async function buildToolStubs(): Promise<vscode.LanguageModelChatTool[]> {
  // We intentionally don't mirror all server-side schemas here.
  // The backend is the source of truth; tools are executed via /api/tools/invoke.
  // Provide a minimal tool list so models can request them by name.
  const names = [
    "ide_read_file",
    "ide_edit_file",
    "ide_write_file",
    "ide_list_directory",
    "ide_search_code",
    "ide_run_command",
  ];
  return names.map((name) => ({
    name,
    description: `Invoke ${name} via ChatLLM backend`,
    inputSchema: { type: "object" },
  }));
}

async function invokeBackendTool(body: { name: string; arguments: Record<string, unknown> }): Promise<{ result?: string }> {
  const response = await apiFetch("/api/tools/invoke", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.text().catch(() => response.statusText);
    throw new Error(err || response.statusText);
  }
  const event = (await response.json()) as ToolCallEvent;
  return { result: event.result };
}

