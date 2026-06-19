import * as vscode from "vscode";
import type { ExecutionGraph } from "@nexus/shared";
import { subscribeExecutionGraphEvents } from "../dispatch/client";
import { listExecutionGraphs } from "../api";
import type { TaskStatus } from "../spec/schema";

type Run = { graphId: string; featureId: string; label: string; status: string; nodes: Map<string, string>; waitingNodeId?: string; dispose?: () => void };
type Item =
  | { kind: "run"; run: Run }
  | { kind: "node"; graphId: string; nodeId: string; status: string }
  | { kind: "section"; section: "background" }
  | { kind: "bgRun"; graph: ExecutionGraph }
  | { kind: "info"; label: string; icon?: string };

const MAX_COMPLETED_RUNS = 20;
const MAX_BACKGROUND_RUNS = 25;

export class RunsTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private runs = new Map<string, Run>();
  private backgroundRuns: ExecutionGraph[] = [];
  private backgroundError: string | undefined;

  constructor(private readonly writeback?: (featureId: string, taskId: string, status: TaskStatus) => Promise<void>) {}

  refresh(): void {
    void this.reloadBackgroundRuns();
  }

  /** Lightweight redraw without hitting the network (used for local SSE updates). */
  private fireChange(): void {
    this.emitter.fire(undefined);
  }

  /** Fetch recent server-side runs (web/swarm/scheduled) not tracked locally. */
  private async reloadBackgroundRuns(): Promise<void> {
    try {
      const graphs = await listExecutionGraphs({ limit: MAX_BACKGROUND_RUNS });
      this.backgroundRuns = graphs.filter((g) => !this.runs.has(g.id));
      this.backgroundError = undefined;
    } catch (err) {
      this.backgroundError = err instanceof Error ? err.message : String(err);
    }
    this.emitter.fire(undefined);
  }
  trackRun(graphId: string, featureId: string, label: string, nodeIds: string[]): void {
    const run: Run = { graphId, featureId, label, status: "running", nodes: new Map(nodeIds.map((id) => [id, "queued"])) };
    run.dispose = subscribeExecutionGraphEvents(graphId, (event) => {
      if (event.type === "node_status" && event.nodeId && event.status) {
        run.nodes.set(event.nodeId, event.status);
        if (event.status === "waiting_approval") {
          run.waitingNodeId = event.nodeId;
          run.status = "waiting approval";
        } else if (run.waitingNodeId === event.nodeId) {
          run.waitingNodeId = undefined;
          if (run.status === "waiting approval") run.status = "running";
        }
        const mapped = mapStatus(event.status);
        if (mapped) void this.writeback?.(featureId, event.nodeId, mapped);
      }
      if (event.type === "done" && event.status) {
        run.status = event.status;
        // Tear down the SSE subscription — no more events will arrive.
        run.dispose?.();
        run.dispose = undefined;
        // Prune oldest completed runs if the map is at capacity.
        const completed = [...this.runs.entries()].filter(([, r]) => r.status !== "running");
        if (completed.length > MAX_COMPLETED_RUNS) {
          const [oldestId] = completed[0];
          this.runs.delete(oldestId);
        }
      }
      this.fireChange();
    }, {
      onDisconnect: () => {
        // Stream gave up after retries — surface it instead of a frozen run.
        if (run.status === "running") run.status = "disconnected";
        this.fireChange();
      },
    });
    this.runs.set(graphId, run);
    this.fireChange();
  }
  cancelRun(graphId: string): void { this.runs.get(graphId)?.dispose?.(); this.runs.delete(graphId); this.fireChange(); }
  /** The node id awaiting approval for a run, if any (used by the resolve-approval command). */
  getWaitingNodeId(graphId: string): string | undefined { return this.runs.get(graphId)?.waitingNodeId; }
  /** Run metadata used to re-establish a subscription on retry/replay. */
  getRunMeta(graphId: string): { featureId: string; label: string; nodeIds: string[] } | undefined {
    const run = this.runs.get(graphId);
    return run ? { featureId: run.featureId, label: run.label, nodeIds: [...run.nodes.keys()] } : undefined;
  }
  getTreeItem(item: Item): vscode.TreeItem {
    if (item.kind === "run") {
      const tree = new vscode.TreeItem(item.run.label, vscode.TreeItemCollapsibleState.Expanded);
      const total = item.run.nodes.size;
      const completed = [...item.run.nodes.values()].filter((s) => s === "completed").length;
      tree.description = total > 0 ? `${item.run.status} · ${completed}/${total}` : item.run.status;
      const terminal = ["completed", "failed", "cancelled", "disconnected"].includes(item.run.status);
      tree.contextValue = item.run.waitingNodeId ? "run-waiting" : terminal ? "run-terminal" : "run";
      const icon = item.run.waitingNodeId ? "person"
        : item.run.status === "running" ? "loading~spin"
        : item.run.status === "disconnected" ? "debug-disconnect"
        : item.run.status === "failed" ? "error"
        : "run-all";
      tree.iconPath = new vscode.ThemeIcon(icon);
      return tree;
    }
    if (item.kind === "section") {
      const tree = new vscode.TreeItem("Background Runs", vscode.TreeItemCollapsibleState.Collapsed);
      tree.contextValue = "runs-section-background";
      tree.tooltip = "Server-side runs (web, swarm, scheduled) not started from this IDE.";
      tree.iconPath = new vscode.ThemeIcon("server-process");
      return tree;
    }
    if (item.kind === "bgRun") {
      const tree = new vscode.TreeItem(item.graph.goal || item.graph.id);
      tree.description = `${item.graph.status} · ${item.graph.mode}`;
      tree.tooltip = `${item.graph.id}\n${new Date(item.graph.createdAt).toLocaleString()}`;
      tree.contextValue = "bg-run";
      const icon = item.graph.status === "running" ? "loading~spin"
        : item.graph.status === "waiting_approval" ? "person"
        : item.graph.status === "failed" ? "error"
        : item.graph.status === "completed" ? "pass"
        : "circle-outline";
      tree.iconPath = new vscode.ThemeIcon(icon);
      tree.command = { command: "liberide.openPipeline", title: "Open Pipeline" };
      return tree;
    }
    if (item.kind === "info") {
      const tree = new vscode.TreeItem(item.label);
      if (item.icon) tree.iconPath = new vscode.ThemeIcon(item.icon);
      return tree;
    }
    const tree = new vscode.TreeItem(item.nodeId);
    tree.description = item.status;
    tree.contextValue = "node";
    tree.command = {
      command: "liberide.showNodeDetail",
      title: "Show Node Detail",
      arguments: [{ graphId: item.graphId, nodeId: item.nodeId }],
    };
    return tree;
  }
  getChildren(item?: Item): Item[] {
    if (!item) {
      const local: Item[] = [...this.runs.values()].map((run) => ({ kind: "run", run }));
      return [...local, { kind: "section", section: "background" }];
    }
    if (item.kind === "run") return [...item.run.nodes.entries()].map(([nodeId, status]) => ({ kind: "node", graphId: item.run.graphId, nodeId, status }));
    if (item.kind === "section") {
      if (this.backgroundError) return [{ kind: "info", label: `Failed to load: ${this.backgroundError}`, icon: "error" }];
      if (this.backgroundRuns.length === 0) return [{ kind: "info", label: "No background runs", icon: "circle-slash" }];
      return this.backgroundRuns.map((graph) => ({ kind: "bgRun", graph }));
    }
    return [];
  }
}

function mapStatus(status: string): TaskStatus | undefined {
  if (status === "running" || status === "completed" || status === "failed" || status === "blocked") return status;
  return undefined;
}
