import * as vscode from "vscode";
import { extractSectionIds, parseBlockerItems, parseDocumentationItems, parseFeatureStatus, parseTaskContract, type BlockerItem, type DocumentationItem, type FeatureSpec, type TaskContract } from "./schema";
import { readTextFile } from "./writer";

/**
 * Everything under `.liberide/specs` in any workspace folder. Directories are
 * matched too: when a whole feature folder is created or deleted at once
 * (git checkout, `rm -r`, an external agent), the file watcher may report only
 * the folder event and drop the child `.md` events, so a `*.md`-only glob would
 * leave the Specs tree stale.
 */
export const SPEC_WATCH_GLOB = "**/.liberide/specs/**";

export class SpecStore implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private features = new Map<string, FeatureSpec>();
  private watcher?: vscode.FileSystemWatcher;
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
    this.watcher = vscode.workspace.createFileSystemWatcher(SPEC_WATCH_GLOB);
    this.watcher.onDidCreate(() => this.scheduleRefresh());
    this.watcher.onDidChange(() => this.scheduleRefresh());
    this.watcher.onDidDelete(() => this.scheduleRefresh());
    context.subscriptions.push(this.watcher);
    // Workspace prompt files are not auto-imported into the server's skill
    // registry: that import is a manager action and must never register
    // repository content as a trusted source behind the user's back.
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
    const documentation = await this.readDocumentation(vscode.Uri.joinPath(rootUri, "documentation.md"));
    const blockers = await this.readBlockers(vscode.Uri.joinPath(rootUri, "blockers.md"));
    return {
      id, name, status, rootUri, featureMdUri, requirementsUri, designUri, tasksDirUri,
      requirementIds, designIds, tasks,
      ...(documentation.length ? { documentation } : {}),
      ...(blockers.length ? { blockers } : {}),
    };
  }

  private async readIds(uri: vscode.Uri, prefix: string): Promise<string[]> {
    try { return extractSectionIds(await readTextFile(uri), prefix); } catch { return []; }
  }

  private async readDocumentation(uri: vscode.Uri): Promise<DocumentationItem[]> {
    try { return parseDocumentationItems(await readTextFile(uri)); } catch { return []; }
  }

  private async readBlockers(uri: vscode.Uri): Promise<BlockerItem[]> {
    try { return parseBlockerItems(await readTextFile(uri)); } catch { return []; }
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.watcher?.dispose();
    this.changeEmitter.dispose();
  }
}
