import * as vscode from "vscode";
import type { SpecStore } from "../spec/store";
import type { TaskContract } from "../spec/schema";
import { effectiveStatus, groupTasksByStatus, computeTaskReadiness } from "../spec/dag";

type TaskTreeItem =
  | { kind: "statusGroup"; label: string; status: string }
  | { kind: "task"; task: TaskContract; featureId: string };

export class TasksTreeProvider implements vscode.TreeDataProvider<TaskTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TaskTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: SpecStore) {
    store.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TaskTreeItem): vscode.TreeItem {
    if (element.kind === "statusGroup") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon("folder");
      return item;
    }
    const readiness = computeTaskReadiness(
      this.store.getFeature(element.featureId)?.tasks ?? [],
    );
    const status = effectiveStatus(element.task, readiness);
    const blocked = readiness.get(element.task.id)?.blockedBy ?? [];
    const item = new vscode.TreeItem(
      `${element.task.id}: ${element.task.title}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = blocked.length ? `blocked by ${blocked.join(", ")}` : status;
    item.contextValue = "task";
    item.iconPath = statusIcon(status);
    item.command = {
      command: "chatllm.openTask",
      title: "Open Task",
      arguments: [element.featureId, element.task.id],
    };
    return item;
  }

  getChildren(element?: TaskTreeItem): TaskTreeItem[] {
    const feature = this.store.getActiveFeature();
    if (!feature) {
      return [{ kind: "statusGroup", label: "No active feature — scaffold a spec", status: "none" }];
    }
    if (!element) {
      const groups = groupTasksByStatus(feature.tasks);
      const order: Array<keyof typeof groups> = ["running", "ready", "blocked", "pending", "failed", "completed"];
      return order
        .filter((k) => groups[k].length > 0)
        .map((k) => ({
          kind: "statusGroup" as const,
          label: `${capitalize(k)} (${groups[k].length})`,
          status: k,
        }));
    }
    if (element.kind === "statusGroup") {
      const groups = groupTasksByStatus(feature.tasks);
      const tasks = groups[element.status as keyof typeof groups] ?? [];
      return tasks.map((task) => ({ kind: "task" as const, task, featureId: feature.id }));
    }
    return [];
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function statusIcon(status: string): vscode.ThemeIcon {
  switch (status) {
    case "running":
      return new vscode.ThemeIcon("sync~spin");
    case "completed":
      return new vscode.ThemeIcon("check");
    case "failed":
      return new vscode.ThemeIcon("error");
    case "blocked":
      return new vscode.ThemeIcon("lock");
    case "ready":
      return new vscode.ThemeIcon("debug-start");
    default:
      return new vscode.ThemeIcon("circle-outline");
  }
}
