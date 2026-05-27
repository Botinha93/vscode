import * as vscode from "vscode";
import type { FeatureSpec } from "../spec/schema";
import type { SpecStore } from "../spec/store";

type Item =
  | { kind: "feature"; feature: FeatureSpec }
  | { kind: "file"; label: string; uri: vscode.Uri };

export class SpecsTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly store: SpecStore) { store.onDidChange(() => this.refresh()); }
  refresh(): void { this.emitter.fire(undefined); }
  getTreeItem(item: Item): vscode.TreeItem {
    if (item.kind === "feature") {
      const tree = new vscode.TreeItem(item.feature.name, vscode.TreeItemCollapsibleState.Expanded);
      tree.description = item.feature.status;
      tree.contextValue = "feature";
      tree.iconPath = new vscode.ThemeIcon("folder");
      tree.command = { command: "liberide.setActiveFeature", title: "Set Active", arguments: [item.feature.id] };
      return tree;
    }
    const tree = new vscode.TreeItem(item.label);
    tree.resourceUri = item.uri;
    tree.command = { command: "vscode.open", title: "Open", arguments: [item.uri] };
    return tree;
  }
  getChildren(item?: Item): Item[] {
    if (!item) return this.store.getFeatures().map((feature) => ({ kind: "feature", feature }));
    if (item.kind !== "feature") return [];
    const f = item.feature;
    return [
      f.requirementsUri && { kind: "file" as const, label: `requirements.md (${f.requirementIds.length})`, uri: f.requirementsUri },
      f.designUri && { kind: "file" as const, label: `design.md (${f.designIds.length})`, uri: f.designUri },
      f.tasksDirUri && { kind: "file" as const, label: `tasks/index.md (${f.tasks.length})`, uri: vscode.Uri.joinPath(f.tasksDirUri, "index.md") },
    ].filter(Boolean) as Item[];
  }
}
