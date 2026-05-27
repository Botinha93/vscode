import * as vscode from "vscode";
import { groupTasksByStatus } from "../spec/dag";
import type { TaskContract } from "../spec/schema";
import type { SpecStore } from "../spec/store";

type Item = { kind: "group"; label: string; status: string } | { kind: "task"; featureId: string; task: TaskContract };

export class TasksTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly store: SpecStore) { store.onDidChange(() => this.refresh()); }
  refresh(): void { this.emitter.fire(undefined); }
  getTreeItem(item: Item): vscode.TreeItem {
    if (item.kind === "group") return new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.Expanded);
    const tree = new vscode.TreeItem(`${item.task.id}: ${item.task.title}`);
    tree.description = item.task.status;
    tree.contextValue = "task";
    tree.command = { command: "liberide.openTask", title: "Open Task", arguments: [{ kind: "task", featureId: item.featureId, task: { id: item.task.id } }] };
    return tree;
  }
  getChildren(item?: Item): Item[] {
    const feature = this.store.getActiveFeature();
    if (!feature) return [];
    if (!item) {
      const groups = groupTasksByStatus(feature.tasks);
      return (["running", "ready", "blocked", "pending", "failed", "completed"] as const)
        .filter((status) => groups[status].length)
        .map((status) => ({ kind: "group", status, label: `${status} (${groups[status].length})` }));
    }
    if (item.kind !== "group") return [];
    return (groupTasksByStatus(feature.tasks)[item.status as keyof ReturnType<typeof groupTasksByStatus>] ?? [])
      .map((task) => ({ kind: "task", featureId: feature.id, task }));
  }
}
