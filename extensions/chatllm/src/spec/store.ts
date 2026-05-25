import * as vscode from "vscode";
import {
  extractSectionIds,
  parseFeatureStatus,
  parseTaskContract,
  type FeatureSpec,
  type TaskContract,
} from "./schema";
import { readTextFile } from "./writer";

const SPECS_GLOB = "**/.chatllm/specs/**";

export class SpecStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private features = new Map<string, FeatureSpec>();
  private watcher: vscode.FileSystemWatcher | undefined;
  private activeFeatureId: string | undefined;
  private extensionContext: vscode.ExtensionContext | undefined;

  constructor(private readonly output: vscode.OutputChannel) {}

  async initialize(context: vscode.ExtensionContext): Promise<void> {
    this.extensionContext = context;
    this.activeFeatureId = context.workspaceState.get<string>("chatllm.activeFeatureId");
    this.watcher = vscode.workspace.createFileSystemWatcher(SPECS_GLOB);
    this.watcher.onDidCreate(() => void this.refresh());
    this.watcher.onDidChange(() => void this.refresh());
    this.watcher.onDidDelete(() => void this.refresh());
    context.subscriptions.push(this.watcher);
    await this.refresh();
  }

  getActiveFeatureId(): string | undefined {
    return this.activeFeatureId;
  }

  setActiveFeature(featureId: string): void {
    this.activeFeatureId = featureId;
  }

  getFeatures(): FeatureSpec[] {
    return [...this.features.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getFeature(id: string): FeatureSpec | undefined {
    return this.features.get(id);
  }

  getActiveFeature(): FeatureSpec | undefined {
    if (!this.activeFeatureId) return this.getFeatures()[0];
    return this.features.get(this.activeFeatureId) ?? this.getFeatures()[0];
  }

  getTask(featureId: string, taskId: string): TaskContract | undefined {
    return this.features.get(featureId)?.tasks.find((t) => t.id === taskId);
  }

  async refresh(): Promise<void> {
    this.features.clear();
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      this._onDidChange.fire();
      return;
    }

    for (const folder of folders) {
      const specsRoot = vscode.Uri.joinPath(folder.uri, ".chatllm", "specs");
      try {
        const entries = await vscode.workspace.fs.readDirectory(specsRoot);
        for (const [name, type] of entries) {
          if (type !== vscode.FileType.Directory) continue;
          const feature = await this.loadFeature(folder, specsRoot, name);
          if (feature) this.features.set(feature.id, feature);
        }
      } catch {
        // no specs dir
      }
    }

    if (this.activeFeatureId && !this.features.has(this.activeFeatureId)) {
      this.activeFeatureId = this.getFeatures()[0]?.id;
    }
    if (this.activeFeatureId && this.extensionContext) {
      await this.extensionContext.workspaceState.update("chatllm.activeFeatureId", this.activeFeatureId);
    }

    this._onDidChange.fire();
  }

  private async loadFeature(
    folder: vscode.WorkspaceFolder,
    specsRoot: vscode.Uri,
    dirName: string,
  ): Promise<FeatureSpec | undefined> {
    const rootUri = vscode.Uri.joinPath(specsRoot, dirName);
    const featureMdUri = vscode.Uri.joinPath(rootUri, "feature.md");
    const requirementsUri = vscode.Uri.joinPath(rootUri, "requirements.md");
    const designUri = vscode.Uri.joinPath(rootUri, "design.md");
    const tasksDirUri = vscode.Uri.joinPath(rootUri, "tasks");

    let status = "draft" as FeatureSpec["status"];
    let displayName = dirName;
    try {
      const featureMd = await readTextFile(featureMdUri);
      status = parseFeatureStatus(featureMd);
      const titleMatch = featureMd.match(/^#\s+(.+)$/m);
      if (titleMatch) displayName = titleMatch[1].trim();
    } catch {
      // optional feature.md
    }

    let requirementIds: string[] = [];
    let designIds: string[] = [];
    try {
      const reqMd = await readTextFile(requirementsUri);
      requirementIds = extractSectionIds(reqMd, "R");
    } catch {
      // optional
    }
    try {
      const desMd = await readTextFile(designUri);
      designIds = extractSectionIds(desMd, "D");
    } catch {
      // optional
    }

    const tasks: TaskContract[] = [];
    try {
      const taskEntries = await vscode.workspace.fs.readDirectory(tasksDirUri);
      for (const [fileName, fileType] of taskEntries) {
        if (fileType !== vscode.FileType.File) continue;
        if (!/^T-\d+/i.test(fileName) || !fileName.endsWith(".md")) continue;
        const filePath = vscode.Uri.joinPath(tasksDirUri, fileName);
        try {
          const raw = await readTextFile(filePath);
          const task = parseTaskContract(dirName, filePath, raw);
          if (task) tasks.push(task);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.output.appendLine(`Failed to parse task ${fileName}: ${message}`);
        }
      }
    } catch {
      // no tasks dir
    }

    tasks.sort((a, b) => a.id.localeCompare(b.id));

    return {
      id: dirName,
      name: displayName,
      status,
      rootUri,
      featureMdUri,
      requirementsUri,
      designUri,
      tasksDirUri,
      requirementIds,
      designIds,
      tasks,
    };
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChange.dispose();
  }
}
