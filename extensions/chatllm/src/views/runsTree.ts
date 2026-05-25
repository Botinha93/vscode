import * as vscode from "vscode";
import { apiFetch } from "../api";
import { subscribeExecutionGraphEvents, type ExecutionGraphEvent } from "../dispatch/client";
import type { TaskStatus } from "../spec/schema";

interface ActiveRun {
  graphId: string;
  featureId: string;
  featureName: string;
  status: string;
  nodeStatuses: Map<string, string>;
  unsubscribe?: () => void;
}

type RunTreeItem =
  | { kind: "run"; run: ActiveRun }
  | { kind: "node"; run: ActiveRun; nodeId: string; status: string };

export class RunsTreeProvider implements vscode.TreeDataProvider<RunTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RunTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private runs = new Map<string, ActiveRun>();

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly onTaskStatusWriteback?: (
      featureId: string,
      taskId: string,
      status: TaskStatus,
    ) => Promise<void>,
  ) {}

  refresh(): void {
    void this.loadRecentGraphs();
  }

  trackRun(graphId: string, featureId: string, featureName: string, nodeIds: string[]): void {
    const existing = this.runs.get(graphId);
    existing?.unsubscribe?.();

    const run: ActiveRun = {
      graphId,
      featureId,
      featureName,
      status: "running",
      nodeStatuses: new Map(nodeIds.map((id) => [id, "queued"])),
    };

    run.unsubscribe = subscribeExecutionGraphEvents(graphId, {
      onEvent: (event) => this.handleEvent(run, event),
      onError: (err) => this.output.appendLine(`Run ${graphId} stream error: ${err.message}`),
      onDone: () => {
        run.status = "completed";
        this._onDidChangeTreeData.fire(undefined);
      },
    });

    this.runs.set(graphId, run);
    this._onDidChangeTreeData.fire(undefined);
  }

  getActiveGraphIds(): string[] {
    return [...this.runs.keys()];
  }

  cancelRun(graphId: string): void {
    const run = this.runs.get(graphId);
    if (run) {
      run.unsubscribe?.();
      run.status = "cancelled";
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  private handleEvent(run: ActiveRun, event: ExecutionGraphEvent): void {
    if (event.type === "node_status" && event.nodeId && event.status) {
      run.nodeStatuses.set(event.nodeId, event.status);
      this.output.appendLine(`[${run.graphId}] ${event.nodeId}: ${event.status}`);
      const mapped = mapNodeStatusToTask(event.status);
      if (mapped) {
        void this.onTaskStatusWriteback?.(run.featureId, event.nodeId, mapped);
      }
    }
    if (event.type === "graph_status" || event.type === "done") {
      const status = event.status ?? (event.payload?.status as string | undefined);
      if (status === "completed" || status === "failed" || status === "cancelled") {
        run.status = status;
        run.unsubscribe?.();
      }
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  private async loadRecentGraphs(): Promise<void> {
    try {
      const response = await apiFetch("/api/execution-graphs?status=running&limit=10");
      if (!response.ok) return;
      const graphs = (await response.json()) as Array<{
        id: string;
        goal: string;
        status: string;
        metadata?: { specFeature?: string };
      }>;
      for (const graph of graphs) {
        if (!this.runs.has(graph.id) && graph.metadata?.specFeature) {
          this.trackRun(graph.id, graph.metadata.specFeature, graph.goal, []);
        }
      }
    } catch {
      // ignore
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: RunTreeItem): vscode.TreeItem {
    if (element.kind === "run") {
      const item = new vscode.TreeItem(
        element.run.featureName,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = element.run.status;
      item.iconPath = new vscode.ThemeIcon("run-all");
      return item;
    }
    const item = new vscode.TreeItem(element.nodeId, vscode.TreeItemCollapsibleState.None);
    item.description = element.status;
    item.iconPath = new vscode.ThemeIcon("circle-outline");
    return item;
  }

  getChildren(element?: RunTreeItem): RunTreeItem[] {
    if (!element) {
      if (this.runs.size === 0) {
        return [];
      }
      return [...this.runs.values()].map((run) => ({ kind: "run" as const, run }));
    }
    if (element.kind === "run") {
      return [...element.run.nodeStatuses.entries()].map(([nodeId, status]) => ({
        kind: "node" as const,
        run: element.run,
        nodeId,
        status,
      }));
    }
    return [];
  }
}

function mapNodeStatusToTask(nodeStatus: string): TaskStatus | undefined {
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
      return undefined;
  }
}
