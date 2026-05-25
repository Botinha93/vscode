import * as vscode from "vscode";
import type { SpecStore } from "../spec/store";
import type { FeatureSpec } from "../spec/schema";

type SpecTreeItem =
  | { kind: "feature"; feature: FeatureSpec }
  | { kind: "group"; featureId: string; label: string; group: "requirements" | "design" | "tasks" }
  | { kind: "file"; uri: vscode.Uri; label: string };

export class SpecsTreeProvider implements vscode.TreeDataProvider<SpecTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SpecTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: SpecStore) {
    store.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: SpecTreeItem): vscode.TreeItem {
    if (element.kind === "feature") {
      const item = new vscode.TreeItem(element.feature.name, vscode.TreeItemCollapsibleState.Expanded);
      item.description = element.feature.status;
      item.contextValue = "feature";
      item.iconPath = new vscode.ThemeIcon("folder");
      item.command = {
        command: "chatllm.setActiveFeature",
        title: "Set Active",
        arguments: [element.feature.id],
      };
      return item;
    }
    if (element.kind === "group") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon("folder");
      return item;
    }
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = element.uri;
    item.command = { command: "vscode.open", title: "Open", arguments: [element.uri] };
    item.iconPath = new vscode.ThemeIcon("file");
    return item;
  }

  getChildren(element?: SpecTreeItem): SpecTreeItem[] {
    if (!element) {
      return this.store.getFeatures().map((feature) => ({ kind: "feature" as const, feature }));
    }
    if (element.kind === "feature") {
      const f = element.feature;
      return [
        { kind: "group", featureId: f.id, label: "Requirements", group: "requirements" },
        { kind: "group", featureId: f.id, label: "Design", group: "design" },
        { kind: "group", featureId: f.id, label: "Tasks", group: "tasks" },
      ];
    }
    if (element.kind === "group") {
      const feature = this.store.getFeature(element.featureId);
      if (!feature) return [];
      if (element.group === "requirements" && feature.requirementsUri) {
        return [
          {
            kind: "file",
            uri: feature.requirementsUri,
            label: `requirements.md (${feature.requirementIds.length} sections)`,
          },
        ];
      }
      if (element.group === "design" && feature.designUri) {
        return [
          {
            kind: "file",
            uri: feature.designUri,
            label: `design.md (${feature.designIds.length} sections)`,
          },
        ];
      }
      if (element.group === "tasks" && feature.tasksDirUri) {
        const items: SpecTreeItem[] = [
          { kind: "file", uri: vscode.Uri.joinPath(feature.tasksDirUri, "index.md"), label: "index.md" },
        ];
        for (const task of feature.tasks) {
          items.push({
            kind: "file",
            uri: task.filePath,
            label: `${task.id} — ${task.title}`,
          });
        }
        return items;
      }
    }
    return [];
  }
}
