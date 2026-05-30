import * as vscode from "vscode";
import { extractSectionIds, parseFeatureStatus, parseTaskContract, type FeatureSpec, type TaskContract } from "./schema";
import { readTextFile } from "./writer";

export class SpecStore implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private features = new Map<string, FeatureSpec>();
  private watcher?: vscode.FileSystemWatcher;
  private promptWatcher?: vscode.FileSystemWatcher;
  private activeFeatureId?: string;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private refreshInProgress = false;
  private refreshQueued = false;

  constructor(private readonly output: vscode.OutputChannel) {}

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 300);
  }

  async initialize(context: vscode.ExtensionContext): Promise<void> {
    this.activeFeatureId = context.workspaceState.get("liberide.activeFeatureId");
    this.watcher = vscode.workspace.createFileSystemWatcher("**//.liberide/specs/**/*.md");
    this.watcher.onDidCreate(() => this.scheduleRefresh());
    this.watcher.onDidChange(() => this.scheduleRefresh());
    this.watcher.onDidDelete(() => this.scheduleRefresh());
    context.subscriptions.push(this.watcher);
    this.promptWatcher = vscode.workspace.createFileSystemWatcher("**/.chatllm/**/*.md");
    const syncPrompts = () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      void fetch(`${process.env.CHATLLM_API_ORIGIN ?? "http://127.0.0.1:3000"}/api/skills/import-from-workspace`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootPath: root }),
      }).catch(() => undefined);
    };
    this.promptWatcher.onDidCreate(syncPrompts);
    this.promptWatcher.onDidChange(syncPrompts);
    this.promptWatcher.onDidDelete(syncPrompts);
    context.subscriptions.push(this.promptWatcher);
    await this.refresh();
  }

  getFeatures(): FeatureSpec[] { return [...this.features.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  getFeature(id: string): FeatureSpec | undefined { return this.features.get(id); }
  getActiveFeature(): FeatureSpec | undefined { return this.activeFeatureId ? this.features.get(this.activeFeatureId) : this.getFeatures()[0]; }
  setActiveFeature(id: string): void { this.activeFeatureId = id; }
  getTask(featureId: string, taskId: string): TaskContract | undefined { return this.features.get(featureId)?.tasks.find((task) => task.id === taskId); }

  async refresh(): Promise<void> {
    if (this.refreshInProgress) {
      this.refreshQueued = true;
      return;
    }
    this.refreshInProgress = true;
    try {
      this.features.clear();
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const root = vscode.Uri.joinPath(folder.uri, ".liberide", "specs");
        try {
          for (const [name, type] of await vscode.workspace.fs.readDirectory(root)) {
            if (type === vscode.FileType.Directory) {
              const feature = await this.loadFeature(root, name);
              if (feature) this.features.set(feature.id, feature);
            }
          }
        } catch {
          // Workspace has no spec directory yet.
        }
      }
      this.changeEmitter.fire();
    } finally {
      this.refreshInProgress = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  private async loadFeature(specsRoot: vscode.Uri, id: string): Promise<FeatureSpec> {
    const rootUri = vscode.Uri.joinPath(specsRoot, id);
    const featureMdUri = vscode.Uri.joinPath(rootUri, "feature.md");
    const requirementsUri = vscode.Uri.joinPath(rootUri, "requirements.md");
    const designUri = vscode.Uri.joinPath(rootUri, "design.md");
    const tasksDirUri = vscode.Uri.joinPath(rootUri, "tasks");
    let name = id;
    let status: FeatureSpec["status"] = "draft";
    try {
      const featureMd = await readTextFile(featureMdUri);
      name = featureMd.match(/^#\s+(.+)$/m)?.[1]?.trim() || id;
      status = parseFeatureStatus(featureMd);
    } catch {
      this.output.appendLine(`Feature ${id} has no feature.md`);
    }
    const requirementIds = await this.readIds(requirementsUri, "R");
    const designIds = await this.readIds(designUri, "D");
    const tasks: TaskContract[] = [];
    try {
      for (const [fileName, fileType] of await vscode.workspace.fs.readDirectory(tasksDirUri)) {
        if (fileType !== vscode.FileType.File || !/^T-\d+.*\.md$/i.test(fileName)) continue;
        const filePath = vscode.Uri.joinPath(tasksDirUri, fileName);
        const task = parseTaskContract(id, filePath, await readTextFile(filePath));
        if (task) tasks.push(task);
      }
    } catch {
      // No tasks yet.
    }
    return { id, name, status, rootUri, featureMdUri, requirementsUri, designUri, tasksDirUri, requirementIds, designIds, tasks };
  }

  private async readIds(uri: vscode.Uri, prefix: string): Promise<string[]> {
    try { return extractSectionIds(await readTextFile(uri), prefix); } catch { return []; }
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.watcher?.dispose();
    this.promptWatcher?.dispose();
    this.changeEmitter.dispose();
  }
}
