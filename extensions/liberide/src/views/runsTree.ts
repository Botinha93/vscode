import * as vscode from "vscode";
import { subscribeExecutionGraphEvents } from "../dispatch/client";
import type { TaskStatus } from "../spec/schema";

type Run = { graphId: string; featureId: string; label: string; status: string; nodes: Map<string, string>; dispose?: () => void };
type Item = { kind: "run"; run: Run } | { kind: "node"; nodeId: string; status: string };

const MAX_COMPLETED_RUNS = 20;

export class RunsTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private runs = new Map<string, Run>();

  constructor(private readonly writeback?: (featureId: string, taskId: string, status: TaskStatus) => Promise<void>) {}

  refresh(): void { this.emitter.fire(undefined); }
  trackRun(graphId: string, featureId: string, label: string, nodeIds: string[]): void {
    const run: Run = { graphId, featureId, label, status: "running", nodes: new Map(nodeIds.map((id) => [id, "queued"])) };
    run.dispose = subscribeExecutionGraphEvents(graphId, (event) => {
      if (event.type === "node_status" && event.nodeId && event.status) {
        run.nodes.set(event.nodeId, event.status);
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
      this.refresh();
    });
    this.runs.set(graphId, run);
    this.refresh();
  }
  cancelRun(graphId: string): void { this.runs.get(graphId)?.dispose?.(); this.runs.delete(graphId); this.refresh(); }
  getTreeItem(item: Item): vscode.TreeItem {
    if (item.kind === "run") {
      const tree = new vscode.TreeItem(item.run.label, vscode.TreeItemCollapsibleState.Expanded);
      tree.description = item.run.status;
      tree.contextValue = "run";
      tree.iconPath = new vscode.ThemeIcon(item.run.status === "running" ? "loading~spin" : "run-all");
      return tree;
    }
    const tree = new vscode.TreeItem(item.nodeId);
    tree.description = item.status;
    return tree;
  }
  getChildren(item?: Item): Item[] {
    if (!item) return [...this.runs.values()].map((run) => ({ kind: "run", run }));
    if (item.kind === "run") return [...item.run.nodes.entries()].map(([nodeId, status]) => ({ kind: "node", nodeId, status }));
    return [];
  }
}

function mapStatus(status: string): TaskStatus | undefined {
  if (status === "running" || status === "completed" || status === "failed" || status === "blocked") return status;
  return undefined;
}
