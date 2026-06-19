import * as vscode from "vscode";
import { extractSectionIds, parseBlockerItems, parseDocumentationItems, parseFeatureStatus, parseTaskContract, type BlockerItem, type DocumentationItem, type FeatureSpec, type TaskContract } from "./schema";
import { readTextFile } from "./writer";
import { apiFetch } from "../api";

const REFRESH_TIMEOUT_MS = 15_000;

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
  private promptSyncTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly output: vscode.OutputChannel) {}

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 300);
  }

  /** Debounced workspace-prompt import; logs failures instead of swallowing them. */
  private schedulePromptSync(): void {
    if (this.promptSyncTimer) clearTimeout(this.promptSyncTimer);
    this.promptSyncTimer = setTimeout(() => {
      this.promptSyncTimer = undefined;
      const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      if (roots.length === 0) return;
      void (async () => {
        for (const rootPath of roots) {
          try {
            const res = await apiFetch("/api/skills/import-from-workspace", {
              method: "POST",
              body: JSON.stringify({ rootPath }),
            });
            if (!res.ok) {
              this.output.appendLine(`[spec.prompts] import-from-workspace failed (${rootPath}): ${res.status} ${res.statusText}`);
            }
          } catch (err) {
            this.output.appendLine(`[spec.prompts] import-from-workspace error (${rootPath}): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      })();
    }, 500);
  }

  async initialize(context: vscode.ExtensionContext): Promise<void> {
    this.activeFeatureId = context.workspaceState.get("liberide.activeFeatureId");
    this.watcher = vscode.workspace.createFileSystemWatcher("**//.liberide/specs/**/*.md");
    this.watcher.onDidCreate(() => this.scheduleRefresh());
    this.watcher.onDidChange(() => this.scheduleRefresh());
    this.watcher.onDidDelete(() => this.scheduleRefresh());
    context.subscriptions.push(this.watcher);
    this.promptWatcher = vscode.workspace.createFileSystemWatcher("**/.chatllm/**/*.md");
    const syncPrompts = () => this.schedulePromptSync();
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
      await Promise.race([
        this.runRefreshBody(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("refresh timeout")), REFRESH_TIMEOUT_MS);
        }),
      ]);
      this.changeEmitter.fire();
    } catch (err) {
      if (err instanceof Error && err.message === "refresh timeout") {
        this.output.appendLine(`[spec.refresh] timed out after ${REFRESH_TIMEOUT_MS}ms; refreshInProgress reset`);
      } else {
        this.output.appendLine(`[spec.refresh] error: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      this.refreshInProgress = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  private async runRefreshBody(): Promise<void> {
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
    if (this.promptSyncTimer) clearTimeout(this.promptSyncTimer);
    this.watcher?.dispose();
    this.promptWatcher?.dispose();
    this.changeEmitter.dispose();
  }
}
