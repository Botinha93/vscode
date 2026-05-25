import * as vscode from "vscode";
import { cancelExecutionGraph, dispatchFeature, subscribeExecutionGraphEvents } from "../dispatch/client";
import { SPEC_SYSTEM_PROMPTS } from "../chat/commands";
import { streamChat } from "../chat/stream-client";
import { onSettingsChange, readSettings, settingsToChatRequest, writeSetting, type ChatllmSettings } from "../settings";
import { computeTaskReadiness, validateDag } from "../spec/dag";
import { parseTaskContract } from "../spec/schema";
import type { SpecStore } from "../spec/store";
import { readTextFile, regenerateTasksIndex, scaffoldFeature, updateTaskStatus, writeTaskContract, writeTextFile } from "../spec/writer";
import { getApiOrigin } from "../api";
import { extractTaskBlocks } from "../chat/commands";
import type { FeatureSummary, HostToWebview, Tab, TaskSummary, WebviewToHost } from "./protocol";

interface ActiveGraph {
  graphId: string;
  dispose: () => void;
}

export class ChatllmPanelController implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "chatllm.panel";

  private view?: vscode.WebviewView;
  private editorPanel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly graphs = new Map<string, ActiveGraph>();
  private chatAbort?: AbortController;
  private conversationId?: string;
  private activeTab: Tab = "chat";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SpecStore,
    private readonly output: vscode.OutputChannel,
  ) {
    this.conversationId = context.workspaceState.get("chatllm.conversationId");
    this.disposables.push(
      onSettingsChange((settings) => this.broadcast({ type: "settings", settings })),
      this.store.onDidChange(() => this.broadcastFeatures()),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.bindWebview(view.webview);
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  showAsPanel(tab: Tab = "chat"): void {
    this.activeTab = tab;
    if (this.editorPanel) {
      this.editorPanel.reveal();
      this.editorPanel.webview.postMessage({ type: "tab", tab } satisfies HostToWebview);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      ChatllmPanelController.viewType,
      "Chatllm",
      vscode.ViewColumn.Active,
      this.webviewOptions(),
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "chatllm.svg");
    panel.onDidDispose(() => {
      if (this.editorPanel === panel) this.editorPanel = undefined;
    });
    this.editorPanel = panel;
    this.bindWebview(panel.webview);
  }

  focusView(tab: Tab = "chat"): void {
    this.activeTab = tab;
    void vscode.commands.executeCommand("chatllm.panel.focus").then(() => {
      this.broadcast({ type: "tab", tab });
    });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const g of this.graphs.values()) g.dispose();
    this.graphs.clear();
    this.chatAbort?.abort();
    this.editorPanel?.dispose();
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
    const sub = webview.onDidReceiveMessage((message: WebviewToHost) => {
      void this.handleMessage(webview, message);
    });
    this.disposables.push(sub);
  }

  private broadcast(message: HostToWebview): void {
    this.view?.webview.postMessage(message);
    this.editorPanel?.webview.postMessage(message);
  }

  private broadcastFeatures(): void {
    const features = this.featureSummaries();
    const active = this.store.getActiveFeature();
    this.broadcast({
      type: "features",
      features,
      activeFeature: active
        ? { id: active.id, tasks: active.tasks.map((t) => this.taskSummary(t)) }
        : undefined,
    });
  }

  private featureSummaries(): FeatureSummary[] {
    const active = this.store.getActiveFeature();
    return this.store.getFeatures().map((feature) => ({
      id: feature.id,
      name: feature.name,
      status: feature.status,
      requirementCount: feature.requirementIds.length,
      designCount: feature.designIds.length,
      taskCount: feature.tasks.length,
      active: feature.id === active?.id,
    }));
  }

  private taskSummary(task: { id: string; title: string; status: string; dependsOn: string[]; agent: string }): TaskSummary {
    return { id: task.id, title: task.title, status: task.status, dependsOn: task.dependsOn, agent: task.agent };
  }

  private async handleMessage(webview: vscode.Webview, message: WebviewToHost): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          webview.postMessage({
            type: "init",
            settings: readSettings(),
            features: this.featureSummaries(),
            activeTab: this.activeTab,
            apiOrigin: getApiOrigin(),
          } satisfies HostToWebview);
          this.broadcastFeatures();
          break;
        case "switchTab":
          this.activeTab = message.tab;
          break;
        case "sendChat":
          await this.sendChat(message.content, message.command);
          break;
        case "cancelChat":
          this.chatAbort?.abort();
          break;
        case "updateSetting":
          await writeSetting(message.key, message.value as ChatllmSettings[typeof message.key]);
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
          if (task) await vscode.window.showTextDocument(task.filePath);
          break;
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[panel] ${msg}`);
      this.broadcast({ type: "log", message: msg });
    }
  }

  private async sendChat(content: string, command?: "spec" | "design" | "tasks"): Promise<void> {
    const settings = readSettings();
    const prompt = await this.composePrompt(content, command);
    const body = settingsToChatRequest(settings, prompt, this.conversationId);
    if (command) {
      body.systemPrompt = SPEC_SYSTEM_PROMPTS[command];
      body.chatMode = command === "design" || command === "tasks" ? "agent" : body.chatMode;
      body.toolsEnabled = command === "design" || command === "tasks" ? true : body.toolsEnabled;
    }

    this.chatAbort?.abort();
    const abort = new AbortController();
    this.chatAbort = abort;
    let buffer = "";
    try {
      const response = await streamChat(
        body,
        {
          onToken: (token) => {
            buffer += token;
            this.broadcast({ type: "chatToken", token });
          },
          onToolEvent: (event) => {
            this.broadcast({ type: "chatToolEvent", name: event.name, arguments: event.arguments });
          },
        },
        abort.signal,
      );
      if (response.conversation?.id) {
        this.conversationId = response.conversation.id;
        await this.context.workspaceState.update("chatllm.conversationId", response.conversation.id);
      }
      this.broadcast({ type: "chatDone", conversationId: response.conversation?.id });
      if (command === "tasks") await this.writeGeneratedTasks(buffer);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.broadcast({ type: "chatError", error: msg });
    } finally {
      if (this.chatAbort === abort) this.chatAbort = undefined;
    }
  }

  private async composePrompt(content: string, command?: "spec" | "design" | "tasks"): Promise<string> {
    const feature = this.store.getActiveFeature();
    const parts = [content];
    if (command === "design" && feature?.requirementsUri) parts.unshift(await readTextFile(feature.requirementsUri));
    if (command === "tasks" && feature?.requirementsUri) parts.unshift(await readTextFile(feature.requirementsUri));
    if (command === "tasks" && feature?.designUri) parts.unshift(await readTextFile(feature.designUri));
    return parts.join("\n\n---\n\n");
  }

  private async writeGeneratedTasks(text: string): Promise<void> {
    const feature = this.store.getActiveFeature();
    if (!feature?.tasksDirUri) return;
    for (const block of extractTaskBlocks(text)) {
      const probe = vscode.Uri.joinPath(feature.tasksDirUri, "_probe.md");
      const task = parseTaskContract(feature.id, probe, block.startsWith("---") ? block : `---\n${block}\n---\n`);
      if (!task) continue;
      task.filePath = vscode.Uri.joinPath(
        feature.tasksDirUri,
        `${task.id}-${task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.md`,
      );
      await writeTaskContract(task);
    }
    await this.store.refresh();
    const updated = this.store.getFeature(feature.id);
    if (updated?.tasksDirUri) {
      await writeTextFile(vscode.Uri.joinPath(updated.tasksDirUri, "index.md"), regenerateTasksIndex(updated.tasks));
    }
  }

  private async scaffold(name: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
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

  async dispatch(featureId: string, taskIds?: string[]): Promise<void> {
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
    const result = await dispatchFeature(feature, { conversationId: this.conversationId, taskIds });
    const startEvent = {
      graphId: result.graphId,
      featureId: feature.id,
      label: taskIds?.length ? `${feature.name} / ${taskIds.join(", ")}` : feature.name,
      nodes: tasks.map((task) => ({
        id: task.id,
        label: `${task.id} · ${task.title}`,
        dependsOn: task.dependsOn,
      })),
    };
    this.broadcast({ type: "graphStart", payload: startEvent });
    for (const task of tasks) {
      const ready = readiness.get(task.id);
      this.broadcast({
        type: "graphNode",
        payload: { graphId: result.graphId, nodeId: task.id, status: ready?.blockedBy.length ? "blocked" : "queued" },
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

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.js"));
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
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function mapStatus(status: string): "running" | "completed" | "failed" | "blocked" | undefined {
  if (status === "running" || status === "completed" || status === "failed" || status === "blocked") return status;
  return undefined;
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
