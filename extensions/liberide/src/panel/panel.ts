import * as vscode from "vscode";
import { cancelExecutionGraph, dispatchFeature, subscribeExecutionGraphEvents } from "../dispatch/client";
import { onSettingsChange, readSettings } from "../settings";
import { computeTaskReadiness, validateDag } from "../spec/dag";
import type { SpecStore } from "../spec/store";
import { scaffoldFeature, updateTaskStatus } from "../spec/writer";
import { getApiOrigin } from "../api";
import type { FeatureSummary, PipelineHostToWebview, PipelineWebviewToHost, TaskSummary } from "./protocol";
import type { RunsTreeProvider } from "../views/runsTree";

interface ActiveGraph {
  graphId: string;
  dispose: () => void;
}

export class LiberidePipelineController implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "liberide.pipeline";

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly graphs = new Map<string, ActiveGraph>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SpecStore,
    private readonly output: vscode.OutputChannel,
    private readonly runsTree: RunsTreeProvider,
  ) {
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

  show(): void {
    void vscode.commands.executeCommand(`${LiberidePipelineController.viewType}.focus`);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const g of this.graphs.values()) g.dispose();
    this.graphs.clear();
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
    const sub = webview.onDidReceiveMessage((message: PipelineWebviewToHost) => {
      void this.handleMessage(webview, message);
    });
    this.disposables.push(sub);
  }

  private broadcast(message: PipelineHostToWebview): void {
    this.view?.webview.postMessage(message);
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

  private async handleMessage(webview: vscode.Webview, message: PipelineWebviewToHost): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          webview.postMessage({
            type: "init",
            settings: readSettings(),
            features: this.featureSummaries(),
            apiOrigin: getApiOrigin(),
          } satisfies PipelineHostToWebview);
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
          if (task) await vscode.window.showTextDocument(task.filePath);
          break;
        }
        case "openChat":
          await vscode.commands.executeCommand("liberide.openChat");
          break;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[pipeline] ${msg}`);
      this.broadcast({ type: "operation", action: message.type === "scaffoldFeature" ? "scaffold" : message.type === "cancelGraph" ? "cancel" : "dispatch", status: "error", message: msg });
      this.broadcast({ type: "log", message: msg, severity: "error" });
    }
  }

  private async scaffold(name: string): Promise<void> {
    this.broadcast({ type: "operation", action: "scaffold", status: "running" });
    const folder = vscode.workspace.workspaceFolders?.[0];
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

  async dispatch(featureId: string, taskIds?: string[]): Promise<void> {
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
        label: `${task.id} \u00b7 ${task.title}`,
        dependsOn: task.dependsOn,
      })),
    };
    this.broadcast({ type: "graphStart", payload: startEvent });
    this.runsTree.trackRun(result.graphId, feature.id, startEvent.label, tasks.map((task) => task.id));
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
    this.broadcast({ type: "operation", action: "dispatch", status: "success", message: `Dispatched ${startEvent.label}.` });
  }

  async cancel(graphId: string): Promise<void> {
    this.broadcast({ type: "operation", action: "cancel", status: "running" });
    await cancelExecutionGraph(graphId);
    this.graphs.get(graphId)?.dispose();
    this.graphs.delete(graphId);
    this.runsTree.cancelRun(graphId);
    this.broadcast({ type: "graphDone", payload: { graphId, status: "cancelled" } });
    this.broadcast({ type: "operation", action: "cancel", status: "success", message: `Cancelled ${graphId}.` });
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "pipeline.js"));
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
  <title>LiberIDE Pipeline</title>
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
