import * as vscode from "vscode";
import { onSettingsChange, readSettings, writeSetting, type ChatllmSettings } from "../settings";
import { ALL_PROVIDERS, listKnownModels, describeModel } from "./models";
import { SPEC_SYSTEM_PROMPTS, extractTaskBlocks } from "./commands";
import { streamChat } from "./stream-client";
import type { ChatRequest, Provider } from "./types";
import { parseTaskContract } from "../spec/schema";
import type { SpecStore } from "../spec/store";
import { regenerateTasksIndex, writeTaskContract, writeTextFile } from "../spec/writer";
import type {
  ChatHostToWebview,
  ChatMessage,
  ChatOverrides,
  ChatSession,
  ChatWebviewToHost,
  ProviderModelGroup,
  SessionSummary,
} from "./chat-protocol";

const STORAGE_KEY = "chatllm.chat.sessions";
const ACTIVE_KEY = "chatllm.chat.activeSession";

interface ActiveStream {
  abort: AbortController;
  messageId: string;
}

export class ChatllmChatPanelController implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "chatllm.chat";

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private sessions = new Map<string, ChatSession>();
  private activeSessionId: string | null = null;
  private readonly streams = new Map<string, ActiveStream>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SpecStore,
    private readonly output: vscode.OutputChannel,
  ) {
    this.loadSessions();
    this.disposables.push(
      onSettingsChange((settings) => this.broadcast({ type: "settings", settings })),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.bindWebview(view.webview);
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  show(): void {
    void vscode.commands.executeCommand(`${ChatllmChatPanelController.viewType}.focus`);
  }

  async newSession(): Promise<ChatSession> {
    const session = this.createSession();
    this.activeSessionId = session.id;
    await this.persist();
    this.broadcastSessions();
    this.broadcastActiveSession();
    return session;
  }

  openSettings(): void {
    this.show();
    this.broadcast({ type: "openSettings" });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const s of this.streams.values()) s.abort.abort();
    this.streams.clear();
  }

  private webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        vscode.Uri.joinPath(this.context.extensionUri, "resources"),
      ],
    };
  }

  private bindWebview(webview: vscode.Webview): void {
    webview.options = this.webviewOptions();
    webview.html = this.renderHtml(webview);
    const sub = webview.onDidReceiveMessage((message: ChatWebviewToHost) => {
      void this.handleMessage(message);
    });
    this.disposables.push(sub);
  }

  private loadSessions(): void {
    const raw = this.context.workspaceState.get<ChatSession[]>(STORAGE_KEY, []);
    this.sessions.clear();
    for (const s of raw) {
      this.sessions.set(s.id, this.normalizeSession(s));
    }
    this.activeSessionId = this.context.workspaceState.get<string | null>(ACTIVE_KEY, null);
    if (this.activeSessionId && !this.sessions.has(this.activeSessionId)) {
      this.activeSessionId = null;
    }
  }

  private normalizeSession(session: ChatSession): ChatSession {
    return {
      ...session,
      messages: session.messages.map((m) => ({
        ...m,
        status: m.status === "streaming" || m.status === "pending" ? "complete" : (m.status ?? "complete"),
      })),
      overrides: session.overrides ?? {},
    };
  }

  private async persist(): Promise<void> {
    const list = Array.from(this.sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    await this.context.workspaceState.update(STORAGE_KEY, list);
    await this.context.workspaceState.update(ACTIVE_KEY, this.activeSessionId);
  }

  private createSession(): ChatSession {
    const now = Date.now();
    const session: ChatSession = {
      id: randomId(),
      title: "New chat",
      messages: [],
      overrides: {},
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private getOrCreateActive(): ChatSession {
    if (this.activeSessionId) {
      const s = this.sessions.get(this.activeSessionId);
      if (s) return s;
    }
    const created = this.createSession();
    this.activeSessionId = created.id;
    return created;
  }

  private sessionSummaries(): SessionSummary[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
        overrides: s.overrides,
      }));
  }

  private modelCatalog(): ProviderModelGroup[] {
    return ALL_PROVIDERS.map((provider) => ({
      provider,
      label: providerLabel(provider),
      models: listKnownModels(provider).map((m) => ({
        provider,
        modelId: m.id,
        name: m.name,
        detail: m.detail,
      })),
    }));
  }

  private broadcast(message: ChatHostToWebview): void {
    this.view?.webview.postMessage(message);
  }

  private broadcastSessions(): void {
    this.broadcast({
      type: "sessions",
      sessions: this.sessionSummaries(),
      activeSessionId: this.activeSessionId,
    });
  }

  private broadcastActiveSession(): void {
    const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : null;
    if (session) this.broadcast({ type: "session", session });
  }

  private async handleMessage(message: ChatWebviewToHost): Promise<void> {
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
          await writeSetting(message.key as keyof ChatllmSettings, message.value as ChatllmSettings[keyof ChatllmSettings]);
          break;
        case "openSettings":
          this.broadcast({ type: "openSettings" });
          break;
        case "openPipeline":
          await vscode.commands.executeCommand("chatllm.openPipeline");
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[chat] ${msg}`);
      this.broadcast({ type: "log", message: msg });
    }
  }

  private async sendInit(): Promise<void> {
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
      modelCatalog: this.modelCatalog(),
    });
  }

  private detectCommand(content: string): { command?: "spec" | "design" | "tasks"; rest: string } {
    const trimmed = content.trimStart();
    const match = trimmed.match(/^\/(spec|design|tasks)(\s|$)/);
    if (!match) return { rest: content };
    return {
      command: match[1] as "spec" | "design" | "tasks",
      rest: trimmed.slice(match[0].length).trimStart(),
    };
  }

  private async sendChat(sessionId: string, content: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (this.streams.has(sessionId)) {
      this.broadcast({ type: "log", message: "A response is already streaming for this chat." });
      return;
    }

    const settings = readSettings();
    const { command, rest } = this.detectCommand(content);
    const userMessage: ChatMessage = {
      id: randomId(),
      role: "user",
      content: content,
      createdAt: Date.now(),
      status: "complete",
    };
    session.messages.push(userMessage);
    if (session.messages.length === 1) {
      session.title = deriveTitle(content);
    }
    session.updatedAt = Date.now();
    this.broadcastActiveSession();
    this.broadcastSessions();

    const assistant: ChatMessage = {
      id: randomId(),
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      status: "streaming",
    };
    session.messages.push(assistant);
    this.broadcastActiveSession();

    const provider: Provider = session.overrides.provider ?? settings.provider;
    const model: string = session.overrides.model ?? settings.model;
    const chatMode = session.overrides.chatMode ?? settings.chatMode;
    const useRag = session.overrides.useRag ?? settings.useRag;
    const toolsEnabled = session.overrides.toolsEnabled ?? settings.toolsEnabled;

    const body: ChatRequest = {
      conversationId: session.conversationId,
      provider,
      model,
      modelSelection: settings.modelSelection,
      chatMode: command ? (command === "spec" ? "normal" : "agent") : chatMode,
      content: rest || content,
      systemPrompt: command ? SPEC_SYSTEM_PROMPTS[command] : settings.systemPrompt || undefined,
      skillIds: settings.skillIds,
      documentIds: settings.documentIds,
      useRag,
      toolsEnabled: command ? (command === "spec" ? toolsEnabled : true) : toolsEnabled,
      mcpServerIds: settings.mcpServerIds,
      agentIds: settings.agentIds,
      maxAgentSpawns: settings.maxAgentSpawns,
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
              arguments: event.arguments ?? {},
            });
          },
        },
        abort.signal,
      );
      if (response.conversation?.id) session.conversationId = response.conversation.id;
      assistant.status = "complete";
      assistant.content = buffer;
      session.updatedAt = Date.now();

      if (command === "tasks" && buffer) {
        try {
          const written = await this.writeGeneratedTasks(buffer);
          if (written > 0) {
            const note = `\n\n_Wrote **${written}** task contract${written === 1 ? "" : "s"} for the active feature. Run **Chatllm: Dispatch Feature Tasks** to execute them._`;
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
        conversationId: session.conversationId,
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

  private async writeGeneratedTasks(text: string): Promise<number> {
    const feature = this.store.getActiveFeature();
    if (!feature?.tasksDirUri) return 0;
    let written = 0;
    for (const block of extractTaskBlocks(text)) {
      const probe = vscode.Uri.joinPath(feature.tasksDirUri, "_probe.md");
      const task = parseTaskContract(feature.id, probe, block.startsWith("---") ? block : `---\n${block}\n---\n`);
      if (!task) continue;
      task.filePath = vscode.Uri.joinPath(
        feature.tasksDirUri,
        `${task.id}-${task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.md`,
      );
      await writeTaskContract(task);
      written++;
    }
    if (written > 0) {
      await this.store.refresh();
      const updated = this.store.getFeature(feature.id);
      if (updated?.tasksDirUri) {
        await writeTextFile(
          vscode.Uri.joinPath(updated.tasksDirUri, "index.md"),
          regenerateTasksIndex(updated.tasks),
        );
      }
    }
    return written;
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "chat.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.css"));
    const nonce = randomNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `connect-src ${webview.cspSource}`,
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
}

function providerLabel(provider: Provider): string {
  switch (provider) {
    case "openai": return "OpenAI";
    case "openrouter": return "OpenRouter";
    case "google": return "Google";
    case "ollama": return "Ollama";
    case "llamacpp": return "llama.cpp";
    case "lmstudio": return "LM Studio";
    case "custom": return "Custom";
  }
}

function deriveTitle(text: string): string {
  const firstLine = text.replace(/\s+/g, " ").trim();
  if (!firstLine) return "New chat";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}\u2026` : firstLine;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export { describeModel };
