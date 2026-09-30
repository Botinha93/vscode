import * as vscode from "vscode";
import type { ConfiguredModel, ModelCapability, ToolCallEvent } from "./types";
import { PROVIDER_LABELS } from "./models";
import { apiFetch } from "../api";
import { activeWorkspaceFolder } from "../ide-delegate/context";

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

export interface CopilotAttachment {
  data: Uint8Array;
  mimeType: string;
  name: string;
}

function isImage(mime: string): boolean {
  return mime.toLowerCase().startsWith("image/");
}

function toLmMessages(history: Array<{ role: "user" | "assistant"; content: string }>): vscode.LanguageModelChatMessage[] {
  return history.map((m) =>
    m.role === "user"
      ? vscode.LanguageModelChatMessage.User(m.content)
      : vscode.LanguageModelChatMessage.Assistant(m.content),
  );
}

function buildUserMessage(prompt: string, attachments: CopilotAttachment[]): vscode.LanguageModelChatMessage {
  if (!attachments.length) return vscode.LanguageModelChatMessage.User(prompt);
  const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelDataPart> = [
    new vscode.LanguageModelTextPart(prompt),
  ];
  for (const attachment of attachments) {
    if (isImage(attachment.mimeType)) {
      parts.push(vscode.LanguageModelDataPart.image(attachment.data, attachment.mimeType));
    } else {
      parts.push(new vscode.LanguageModelDataPart(attachment.data, attachment.mimeType));
    }
  }
  return vscode.LanguageModelChatMessage.User(parts);
}

/** Tool rounds per turn; the last round is sent without tools to force an answer. */
const MAX_TOOL_ROUNDS = 12;
/** Tools that only make sense inside the server's own loop (spawning, plans, questions). */
const SERVER_LOOP_ONLY_TOOLS = new Set(["delegate", "discover_tools", "extend_graph", "update_plan", "ask_user"]);
const CATALOG_TTL_MS = 60_000;

interface CatalogEntry {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  execution?: { sideEffect?: string };
}

let catalogCache: { at: number; tools: vscode.LanguageModelChatTool[] } | undefined;

/**
 * The server's V2 tool catalog, rendered for vscode.lm. Names and schemas are
 * the public contract `/api/tools/invoke` accepts, so the model sees real
 * parameters and every call it makes can be executed.
 */
async function loadCatalogTools(): Promise<vscode.LanguageModelChatTool[]> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.tools;
  const response = await apiFetch("/api/tools/catalog?ide=true");
  if (!response.ok) throw new Error(`Could not load the tool catalog (${response.status})`);
  const data = (await response.json()) as { entries?: CatalogEntry[] };
  const tools = (data.entries ?? [])
    .filter((entry) => /^[\w-]{1,64}$/.test(entry.name))
    .filter((entry) => !SERVER_LOOP_ONLY_TOOLS.has(entry.name) && entry.execution?.sideEffect !== "control")
    .map((entry) => ({
      name: entry.name,
      description: entry.description ?? entry.name,
      inputSchema: entry.inputSchema ?? entry.parameters ?? { type: "object", properties: {} },
    }));
  catalogCache = { at: Date.now(), tools };
  return tools;
}

export async function streamCopilotChat(input: {
  modelId: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  prompt: string;
  toolsEnabled: boolean;
  attachments?: CopilotAttachment[];
  onToken: (token: string) => void;
  onToolEvent: (event: ToolCallEvent) => void;
  signal?: AbortSignal;
}): Promise<{ content: string; toolEvents: ToolCallEvent[]; skippedAttachments: CopilotAttachment[] }> {
  const [model] = await vscode.lm.selectChatModels({ vendor: "copilot", id: input.modelId });
  if (!model) throw new Error(`Copilot model not available: ${input.modelId}`);

  const toolEvents: ToolCallEvent[] = [];
  let content = "";

  const cancellation = new vscode.CancellationTokenSource();
  const onAbort = () => cancellation.cancel();
  if (input.signal?.aborted) cancellation.cancel();
  else input.signal?.addEventListener("abort", onAbort, { once: true });

  const modelCaps = capabilitiesFromLm(model);
  const usable: CopilotAttachment[] = [];
  const skippedAttachments: CopilotAttachment[] = [];
  for (const attachment of input.attachments ?? []) {
    if (isImage(attachment.mimeType) && modelCaps.includes("vision")) {
      usable.push(attachment);
    } else {
      skippedAttachments.push(attachment);
    }
  }

  const tools = input.toolsEnabled ? await loadCatalogTools() : [];
  const messages = [
    ...toLmMessages(input.history),
    buildUserMessage(input.prompt, usable),
  ];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const lastRound = round === MAX_TOOL_ROUNDS - 1;
      const roundTools = lastRound ? [] : tools;
      const response = await model.sendRequest(
        messages,
        roundTools.length ? { tools: roundTools, toolMode: vscode.LanguageModelChatToolMode.Auto } : {},
        cancellation.token,
      );

      let roundText = "";
      const calls: vscode.LanguageModelToolCallPart[] = [];
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          roundText += part.value;
          content += part.value;
          input.onToken(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          calls.push(part);
        }
      }
      if (!calls.length) break;
      if (lastRound) {
        // No tools were offered this round; never execute calls the model emits anyway.
        content += "\n\n_[Stopped after the maximum number of tool rounds.]_";
        break;
      }

      // The assistant turn carries its text and every call; the next user
      // turn carries one result per call, matched by callId.
      messages.push(vscode.LanguageModelChatMessage.Assistant([
        ...(roundText ? [new vscode.LanguageModelTextPart(roundText)] : []),
        ...calls,
      ]));
      const results: vscode.LanguageModelToolResultPart[] = [];
      for (const call of calls) {
        if (input.signal?.aborted) throw new Error("Cancelled");
        const args = (call.input ?? {}) as Record<string, unknown>;
        const event: ToolCallEvent = { id: call.callId, name: call.name, arguments: args, createdAt: new Date().toISOString() };
        toolEvents.push(event);
        input.onToolEvent(event);
        const result = await invokeBackendTool({ name: call.name, arguments: args }, input.signal);
        const done: ToolCallEvent = { ...event, result };
        toolEvents.push(done);
        input.onToolEvent(done);
        results.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(result || "(empty result)")]));
      }
      messages.push(vscode.LanguageModelChatMessage.User(results));
    }
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    cancellation.dispose();
  }

  return { content, toolEvents, skippedAttachments };
}

function buildIdeContextForInvoke(): Record<string, unknown> | undefined {
  const folder = activeWorkspaceFolder();
  if (!folder) return undefined;
  // The server rebuilds and verifies this context from the caller's connected
  // IDE socket; only the session and folder identify it.
  return {
    sessionId: `vscode-${folder.name}`,
    projectPath: folder.uri.fsPath,
    mode: "desktop",
    terminalExecutor: "client",
  };
}

/**
 * Run one tool through the backend. Failures are returned as the tool result
 * so the model can recover (fix arguments, try another tool) instead of the
 * whole turn aborting.
 */
async function invokeBackendTool(body: { name: string; arguments: Record<string, unknown> }, signal?: AbortSignal): Promise<string> {
  try {
    const response = await apiFetch("/api/tools/invoke", {
      method: "POST",
      body: JSON.stringify({ ...body, ideContext: buildIdeContextForInvoke() }),
      signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      return JSON.stringify({ error: true, status: response.status, message: text || response.statusText });
    }
    const event = (await response.json()) as ToolCallEvent;
    return typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? null);
  } catch (err) {
    if (signal?.aborted) throw err;
    return JSON.stringify({ error: true, message: err instanceof Error ? err.message : String(err) });
  }
}
