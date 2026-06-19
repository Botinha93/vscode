import * as vscode from "vscode";
import { addFollowUp, cancelExecutionGraph, dispatchFeature, fetchGraphDetail, getGraphMetrics, getWorkingMemory, listGraphArtifacts, patchWorkingMemory, replayFromNode, resolveGraphApproval, resolveNodeApproval, retryGraph, subscribeExecutionGraphEvents, type GraphArtifact, type WorkingMemorySnapshot } from "../dispatch/client";
import { buildIdeContextPayload } from "../ide-delegate/context";
import { onSettingsChange, readSettings } from "../settings";
import { computeTaskReadiness, validateDag } from "../spec/dag";
import type { SpecStore } from "../spec/store";
import { scaffoldFeature, updateTaskStatus } from "../spec/writer";
import { getApiOrigin } from "../api";
import { resolveContainedRelativePath } from "../ide-delegate/handlers/path-containment";
import type { FeatureSummary, PipelineHostToWebview, PipelineWebviewToHost, TaskSummary } from "./protocol";
import type { RunsTreeProvider } from "../views/runsTree";

interface ActiveGraph {
  graphId: string;
  dispose: () => void;
}

export class LiberidePipelineController implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "liberide.pipeline";

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly graphs = new Map<string, ActiveGraph>();
  /** Dedup approval prompts per `${graphId}:${nodeId}` (SSE replays node_status on reconnect). */
  private readonly promptedApprovals = new Set<string>();
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SpecStore,
    private readonly output: vscode.OutputChannel,
    private readonly runsTree: RunsTreeProvider,
  ) {
    this.disposables.push(
      onSettingsChange((settings) => this.broadcast({ type: "settings", settings })),
      this.store.onDidChange(() => this.broadcastFeatures()),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.bindWebview(view.webview);
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
      // Cancel all active graph subscriptions — the user closed the panel so
      // there is no longer a recipient for SSE events.
      for (const g of this.graphs.values()) g.dispose();
      this.graphs.clear();
    });
  }

  show(): void {
    void vscode.commands.executeCommand(`${LiberidePipelineController.viewType}.focus`);
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables) d.dispose();
    for (const g of this.graphs.values()) g.dispose();
    this.graphs.clear();
  }

  private webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        vscode.Uri.joinPath(this.context.extensionUri, "resources"),
      ],
    };
  }

  private bindWebview(webview: vscode.Webview): void {
    webview.options = this.webviewOptions();
    webview.html = this.renderHtml(webview);
    const sub = webview.onDidReceiveMessage((message: PipelineWebviewToHost) => {
      void this.handleMessage(webview, message);
    });
    this.disposables.push(sub);
  }

  private broadcast(message: PipelineHostToWebview): void {
    if (this.disposed) return;
    this.view?.webview.postMessage(message);
  }

  private broadcastFeatures(): void {
    const features = this.featureSummaries();
    const active = this.store.getActiveFeature();
    const readiness = active ? computeTaskReadiness(active.tasks) : undefined;
    this.broadcast({
      type: "features",
      features,
      activeFeature: active
        ? { id: active.id, tasks: active.tasks.map((t) => this.taskSummary(t, readiness?.get(t.id)?.blockedBy ?? [])) }
        : undefined,
    });
  }

  private featureSummaries(): FeatureSummary[] {
    const active = this.store.getActiveFeature();
    return this.store.getFeatures().map((feature) => ({
      id: feature.id,
      name: feature.name,
      status: feature.status,
      requirementCount: feature.requirementIds.length,
      designCount: feature.designIds.length,
      taskCount: feature.tasks.length,
      active: feature.id === active?.id,
    }));
  }

  private taskSummary(
    task: { id: string; title: string; status: string; dependsOn: string[]; agent: string },
    blockedBy: string[],
  ): TaskSummary {
    // Surface an effective `blocked` status for the pre-dispatch DAG when a
    // pending task is waiting on incomplete upstream tasks.
    const status = blockedBy.length > 0 && task.status === "pending" ? "blocked" : task.status;
    return { id: task.id, title: task.title, status, dependsOn: task.dependsOn, agent: task.agent, blockedBy };
  }

  private async handleMessage(webview: vscode.Webview, message: PipelineWebviewToHost): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          webview.postMessage({
            type: "init",
            settings: readSettings(),
            features: this.featureSummaries(),
            apiOrigin: getApiOrigin(),
          } satisfies PipelineHostToWebview);
          this.broadcastFeatures();
          break;
        case "setActiveFeature":
          this.store.setActiveFeature(message.featureId);
          await this.context.workspaceState.update("liberide.activeFeatureId", message.featureId);
          this.broadcastFeatures();
          break;
        case "scaffoldFeature":
          await this.scaffold(message.name);
          break;
        case "dispatchFeature":
          await this.dispatch(message.featureId, message.taskIds);
          break;
        case "cancelGraph":
          await this.cancel(message.graphId);
          break;
        case "inspectRun":
        case "refreshInspector":
          await this.inspectGraph(message.graphId, message.nodeId);
          break;
        case "resolveApproval":
          await resolveGraphApproval(message.graphId, message.approvalId, message.status, message.response);
          await this.inspectGraph(message.graphId);
          break;
        case "openArtifact":
          await this.openArtifactById(message.graphId, message.artifactId);
          break;
        case "openDiff":
          await this.openWorkspaceFile(message.path);
          break;
        case "revertEditedFile":
          await this.revertFile(message.path);
          break;
        case "openTask": {
          const task = this.store.getTask(message.featureId, message.taskId);
          if (task) await vscode.window.showTextDocument(task.filePath);
          break;
        }
        case "openChat":
          await vscode.commands.executeCommand("liberide.openChat");
          break;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[pipeline] ${msg}`);
      this.broadcast({ type: "operation", action: message.type === "scaffoldFeature" ? "scaffold" : message.type === "cancelGraph" ? "cancel" : "dispatch", status: "error", message: msg });
      this.broadcast({ type: "log", message: msg, severity: "error" });
    }
  }

  private async scaffold(name: string): Promise<void> {
    this.broadcast({ type: "operation", action: "scaffold", status: "running" });
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      const message = "Open a workspace folder to scaffold a feature.";
      this.broadcast({ type: "operation", action: "scaffold", status: "error", message });
      this.broadcast({ type: "log", message, severity: "warning" });
      return;
    }
    const root = await scaffoldFeature(folder, name);
    const id = root.path.split("/").pop() ?? name;
    this.store.setActiveFeature(id);
    await this.context.workspaceState.update("liberide.activeFeatureId", id);
    await this.store.refresh();
    this.broadcast({ type: "operation", action: "scaffold", status: "success", message: `Created ${name}.` });
  }

  async dispatch(featureId: string, taskIds?: string[]): Promise<void> {
    this.broadcast({ type: "operation", action: "dispatch", status: "running" });
    const feature = this.store.getFeature(featureId);
    if (!feature) {
      const message = `Unknown feature ${featureId}`;
      this.broadcast({ type: "operation", action: "dispatch", status: "error", message });
      this.broadcast({ type: "log", message, severity: "error" });
      return;
    }
    const candidateTasks = taskIds?.length ? feature.tasks.filter((t) => taskIds.includes(t.id)) : feature.tasks;
    const settings = readSettings();

    let selectedIds = candidateTasks.map((t) => t.id);
    if (!settings.dispatchSkipPreview) {
      const confirmed = await this.previewDispatchPlan(feature, candidateTasks);
      if (!confirmed) {
        this.broadcast({ type: "operation", action: "dispatch", status: "success", message: "Dispatch cancelled." });
        this.broadcast({ type: "log", message: "Dispatch cancelled.", severity: "info" });
        return;
      }
      selectedIds = confirmed;
    }

    const tasks = feature.tasks.filter((t) => selectedIds.includes(t.id));
    if (tasks.length === 0) {
      const message = "No tasks selected to dispatch.";
      this.broadcast({ type: "operation", action: "dispatch", status: "error", message });
      this.broadcast({ type: "log", message, severity: "warning" });
      return;
    }
    const validation = validateDag(tasks);
    if (!validation.ok) {
      const message = `Cannot dispatch: ${validation.error}`;
      this.broadcast({ type: "operation", action: "dispatch", status: "error", message });
      this.broadcast({ type: "log", message, severity: "warning" });
      return;
    }
    const readiness = computeTaskReadiness(feature.tasks);
    const result = await dispatchFeature(feature, {
      taskIds: selectedIds,
      ideContext: buildIdeContextPayload(),
      swarm: settings.swarm,
      isolation: settings.isolation,
    });
    const startEvent = {
      graphId: result.graphId,
      featureId: feature.id,
      label: taskIds?.length ? `${feature.name} / ${taskIds.join(", ")}` : feature.name,
      nodes: tasks.map((task) => ({
        id: task.id,
        label: `${task.id} \u00b7 ${task.title}`,
        dependsOn: task.dependsOn,
        parallelKey: task.agent,
      })),
    };
    this.broadcast({ type: "graphStart", payload: startEvent });
    this.runsTree.trackRun(result.graphId, feature.id, startEvent.label, tasks.map((task) => task.id));
    for (const task of tasks) {
      const ready = readiness.get(task.id);
      this.broadcast({
        type: "graphNode",
        payload: { graphId: result.graphId, nodeId: task.id, status: ready?.blockedBy.length ? "blocked" : "queued" },
      });
    }
    this.subscribeToGraph(result.graphId, feature.id);
    this.broadcast({ type: "operation", action: "dispatch", status: "success", message: `Dispatched ${startEvent.label}.` });
  }

  /**
   * Show a plan preview before queuing a dispatch: a multi-select QuickPick of
   * the tasks (all pre-selected) so the user can deselect tasks, confirm, or
   * cancel. Returns the selected task ids, or undefined when cancelled.
   * Bypassed when `liberide.dispatch.skipPreview` is enabled.
   */
  private async previewDispatchPlan(
    feature: { name: string; tasks: Array<{ id: string; title: string; agent?: string; dependsOn: string[] }> },
    candidateTasks: Array<{ id: string; title: string; agent?: string; dependsOn: string[] }>,
  ): Promise<string[] | undefined> {
    const items: Array<vscode.QuickPickItem & { taskId: string }> = candidateTasks.map((task) => ({
      taskId: task.id,
      label: `${task.id} · ${task.title}`,
      description: task.agent ? `agent: ${task.agent}` : undefined,
      detail: task.dependsOn.length ? `depends on: ${task.dependsOn.join(", ")}` : "no dependencies",
      picked: true,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      title: `Dispatch plan — ${feature.name} (${candidateTasks.length} task${candidateTasks.length === 1 ? "" : "s"})`,
      placeHolder: "Review the plan. Deselect tasks to exclude, confirm to dispatch, or press Esc to cancel.",
      canPickMany: true,
      ignoreFocusOut: true,
    });

    if (!picked) return undefined;
    return picked.map((item) => item.taskId);
  }

  /**
   * Subscribe to an execution graph's event stream and bridge it to the webview,
   * task-file writeback, approval prompts, and disconnect surfacing. Reused by
   * dispatch, retry, and replay. Replaces any prior subscription for the graph.
   */
  private subscribeToGraph(graphId: string, featureId: string): void {
    this.graphs.get(graphId)?.dispose();
    const dispose = subscribeExecutionGraphEvents(graphId, (event) => {
      if (this.disposed) return;
      if (event.type === "node_status" && event.nodeId && event.status) {
        if (event.status === "waiting_approval") {
          void this.promptApproval(graphId, event.nodeId);
        }
        const mapped = mapStatus(event.status);
        if (mapped) {
          const task = this.store.getTask(featureId, event.nodeId);
          if (task) {
            void updateTaskStatus(task.filePath, mapped).then(() => {
              if (!this.disposed) void this.store.refresh();
            });
          }
        }
        this.broadcast({ type: "graphNode", payload: { graphId, nodeId: event.nodeId, status: event.status } });
      }
      if (event.type === "done" && event.status) {
        this.broadcast({ type: "graphDone", payload: { graphId, status: event.status } });
        this.graphs.get(graphId)?.dispose();
        this.graphs.delete(graphId);
      }
    }, {
      log: (message) => this.output.appendLine(`[pipeline.sse] ${message}`),
      onDisconnect: () => {
        if (this.disposed) return;
        // Stream gave up after retries — surface a disconnected state instead of a frozen run.
        this.broadcast({ type: "graphDone", payload: { graphId, status: "disconnected" } });
        this.broadcast({ type: "log", message: `Lost connection to run ${graphId}; it may still be running on the server.`, severity: "warning" });
      },
    });
    this.graphs.set(graphId, { graphId, dispose });
  }

  /** Retry a failed/cancelled run: re-queues failed nodes and re-attaches the event stream. */
  async retryRun(graphId: string): Promise<void> {
    const meta = this.runsTree.getRunMeta(graphId);
    try {
      await retryGraph(graphId);
      if (meta) this.runsTree.trackRun(graphId, meta.featureId, meta.label, meta.nodeIds);
      this.subscribeToGraph(graphId, meta?.featureId ?? "");
      this.broadcast({ type: "log", message: `Retrying run ${graphId}.`, severity: "info" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[pipeline.retry] ${msg}`);
      void vscode.window.showErrorMessage(`Retry failed: ${msg}`);
    }
  }

  /** Replay a node and its downstream dependents, re-attaching the event stream. */
  async replayFromNode(graphId: string, nodeId: string): Promise<void> {
    const meta = this.runsTree.getRunMeta(graphId);
    try {
      const count = await replayFromNode(graphId, nodeId);
      if (meta) this.runsTree.trackRun(graphId, meta.featureId, meta.label, meta.nodeIds);
      this.subscribeToGraph(graphId, meta?.featureId ?? "");
      this.broadcast({ type: "log", message: `Replaying ${count} node(s) from ${nodeId}.`, severity: "info" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[pipeline.replay] ${msg}`);
      void vscode.window.showErrorMessage(`Replay failed: ${msg}`);
    }
  }

  /** Show a run's aggregated token/cost usage (totals + per-node breakdown). */
  async viewRunCost(graphId: string): Promise<void> {
    let metrics: Awaited<ReturnType<typeof getGraphMetrics>>;
    try {
      metrics = await getGraphMetrics(graphId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[pipeline.cost] ${msg}`);
      void vscode.window.showErrorMessage(`Failed to load run cost: ${msg}`);
      return;
    }
    if (!metrics || metrics.callCount === 0) {
      void vscode.window.showInformationMessage("No usage recorded for this run yet.");
      return;
    }
    const cost = metrics.estimatedCostUsd ? `$${metrics.estimatedCostUsd.toFixed(4)}` : "n/a";
    void vscode.window.showInformationMessage(
      `Run cost: ${cost} · ${metrics.inputTokens} in / ${metrics.outputTokens} out tokens · ${metrics.callCount} calls`,
    );
    this.output.appendLine(`\n── Cost for run ${graphId} ──`);
    this.output.appendLine(`Total: ${cost} · ${metrics.inputTokens} in / ${metrics.outputTokens} out · ${metrics.callCount} calls`);
    for (const n of metrics.perNode) {
      const c = n.estimatedCostUsd ? `$${n.estimatedCostUsd.toFixed(4)}` : "n/a";
      this.output.appendLine(`  ${n.nodeId} (${n.title}): ${c} · ${n.inputTokens}/${n.outputTokens} tok`);
    }
    this.output.show(true);
  }

  /** List a run's artifacts in a QuickPick and open the chosen one in an editor tab. */
  async viewArtifacts(graphId: string): Promise<void> {
    let artifacts: Awaited<ReturnType<typeof listGraphArtifacts>>;
    try {
      artifacts = await listGraphArtifacts(graphId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[pipeline.artifacts] ${msg}`);
      void vscode.window.showErrorMessage(`Failed to load artifacts: ${msg}`);
      return;
    }
    if (artifacts.length === 0) {
      void vscode.window.showInformationMessage("This run has not produced any artifacts yet.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      artifacts.map((a) => ({ label: a.title || a.path || a.id, description: `${a.kind}${a.path ? ` · ${a.path}` : ""}`, artifact: a })),
      { placeHolder: "Open an artifact produced by this run" },
    );
    if (!pick) return;
    const doc = await vscode.workspace.openTextDocument({
      content: pick.artifact.content ?? "",
      language: languageForArtifact(pick.artifact.path, pick.artifact.kind),
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  private async inspectGraph(graphId: string, nodeId?: string): Promise<void> {
    try {
      const [detail, artifacts, metrics, workingMemory] = await Promise.all([
        fetchGraphDetail(graphId),
        listGraphArtifacts(graphId).catch(() => []),
        getGraphMetrics(graphId).catch(() => null),
        getWorkingMemory(graphId).catch(() => null),
      ]);
      this.broadcast({
        type: "graphInspector",
        payload: {
          graphId,
          nodeId,
          detail,
          artifacts,
          metrics,
          workingMemory,
          verification: workingMemory?.verificationHistory ?? [],
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[pipeline.inspect] ${msg}`);
      this.broadcast({ type: "log", message: `Failed to inspect run: ${msg}`, severity: "error" });
    }
  }

  private async openArtifactById(graphId: string, artifactId: string): Promise<void> {
    const artifact = (await listGraphArtifacts(graphId)).find((a) => a.id === artifactId);
    if (!artifact) {
      void vscode.window.showInformationMessage(`Artifact not found: ${artifactId}`);
      return;
    }
    await this.openArtifactDocument(artifact);
  }

  private async openArtifactDocument(artifact: GraphArtifact): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({
      content: artifact.content ?? "",
      language: languageForArtifact(artifact.path, artifact.kind),
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  private async revertFile(filePath: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    const clean = filePath.replace(/^\/+/, "");
    const absolute = resolveContainedRelativePath(root, clean);
    const { execFile } = await import("node:child_process");

    const run = (args: string[]): Promise<{ code: number; stderr: string }> =>
      new Promise((resolve) => {
        execFile("git", args, { cwd: root, timeout: 15_000, windowsHide: true }, (err, _stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
          resolve({ code, stderr: stderr || (err instanceof Error ? err.message : "") });
        });
      });

    // Determine whether git tracks this path. Untracked paths can't be reverted
    // with `git checkout --` (gap #15); for those, an agent-created file's
    // pre-edit state is "absent", so reverting means deleting it.
    const tracked = (await run(["ls-files", "--error-unmatch", "--", clean])).code === 0;
    if (tracked) {
      const result = await run(["checkout", "--", clean]);
      if (result.code !== 0) throw new Error(result.stderr || `git checkout failed for ${clean}`);
      this.broadcast({ type: "log", message: `Reverted ${clean}.`, severity: "info" });
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `${clean} is not tracked by git. Reverting will delete this agent-created file.`,
      { modal: true },
      "Delete",
    );
    if (choice !== "Delete") {
      this.broadcast({ type: "log", message: `Revert cancelled for ${clean}.`, severity: "info" });
      return;
    }
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(absolute), { useTrash: true });
      this.broadcast({ type: "log", message: `Reverted (deleted untracked) ${clean}.`, severity: "info" });
    } catch (err) {
      throw new Error(`Failed to delete ${clean}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async openWorkspaceFile(filePath: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    const clean = filePath.replace(/^\/+/, "");
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(resolveContainedRelativePath(root, clean)));
  }

  /** Open a run's working memory (accumulated agent context) as a rendered markdown tab. */
  async viewWorkingMemory(graphId: string): Promise<void> {
    let memory: Awaited<ReturnType<typeof getWorkingMemory>>;
    try {
      memory = await getWorkingMemory(graphId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[pipeline.memory] ${msg}`);
      void vscode.window.showErrorMessage(`Failed to load working memory: ${msg}`);
      return;
    }
    if (!memory) {
      void vscode.window.showInformationMessage("This run has no working memory yet.");
      return;
    }
    const doc = await vscode.workspace.openTextDocument({
      content: renderWorkingMemory(memory),
      language: "markdown",
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /** Append a user-supplied assumption/context note to a run's working memory. */
  async addWorkingMemoryNote(graphId: string): Promise<void> {
    const note = await vscode.window.showInputBox({ prompt: "Add an assumption / context note for the agents" });
    if (!note?.trim()) return;
    try {
      const memory = await getWorkingMemory(graphId);
      const assumptions = [...(memory?.assumptions ?? []), note.trim()];
      await patchWorkingMemory(graphId, { assumptions });
      this.broadcast({ type: "log", message: "Added context to working memory.", severity: "info" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[pipeline.memory] ${msg}`);
      void vscode.window.showErrorMessage(`Failed to update working memory: ${msg}`);
    }
  }

  /** Add a follow-up goal to a run. */
  async addFollowUp(graphId: string): Promise<void> {
    const goal = await vscode.window.showInputBox({ prompt: "Follow-up instruction for this run" });
    if (!goal?.trim()) return;
    try {
      await addFollowUp(graphId, goal.trim());
      this.broadcast({ type: "log", message: "Follow-up queued.", severity: "info" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[pipeline.followup] ${msg}`);
      void vscode.window.showErrorMessage(`Follow-up failed: ${msg}`);
    }
  }

  /** Show a node's status, summary, and error in the output channel (trace inspection). */
  async showNodeDetail(graphId: string, nodeId: string): Promise<void> {
    try {
      const { nodes } = await fetchGraphDetail(graphId);
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) {
        void vscode.window.showInformationMessage(`No detail for node ${nodeId}.`);
        return;
      }
      this.output.appendLine("");
      this.output.appendLine(`── Node ${node.id} (${node.type}) — ${node.status} ──`);
      this.output.appendLine(node.title);
      if (node.inputSummary) this.output.appendLine(`Input: ${node.inputSummary}`);
      if (node.error) this.output.appendLine(`Error: ${node.error}`);
      try {
        const metrics = await getGraphMetrics(graphId);
        const nodeCost = metrics?.perNode.find((n) => n.nodeId === nodeId);
        if (nodeCost) {
          const c = nodeCost.estimatedCostUsd ? `$${nodeCost.estimatedCostUsd.toFixed(4)}` : "n/a";
          this.output.appendLine(`Cost: ${c} · ${nodeCost.inputTokens}/${nodeCost.outputTokens} tokens`);
        }
      } catch {
        // metrics are best-effort in node detail
      }
      this.output.show(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[pipeline.nodeDetail] ${msg}`);
      void vscode.window.showErrorMessage(`Failed to load node detail: ${msg}`);
    }
  }

  /** Re-open the approval prompt on demand (Runs-tree "Resolve Approval" action). */
  async resolveApprovalForRun(graphId: string, nodeId: string): Promise<void> {
    this.promptedApprovals.delete(`${graphId}:${nodeId}`);
    await this.promptApproval(graphId, nodeId);
  }

  /**
   * Prompt the user to approve/reject a graph-native APPROVAL node (the swarm
   * blocker gate). Deduped per node since the SSE stream replays node_status on
   * reconnect. Resolves via the node-approval endpoint and advances the run.
   */
  private async promptApproval(graphId: string, nodeId: string): Promise<void> {
    if (this.disposed) return;
    const key = `${graphId}:${nodeId}`;
    if (this.promptedApprovals.has(key)) return;
    this.promptedApprovals.add(key);

    let title = "Approval required";
    let detail = "";
    try {
      const { nodes } = await fetchGraphDetail(graphId);
      const node = nodes.find((n) => n.id === nodeId);
      if (node && node.status !== "waiting_approval") {
        // Already resolved elsewhere (e.g. another window) — drop the prompt.
        this.promptedApprovals.delete(key);
        return;
      }
      if (node) {
        title = node.title || title;
        detail = node.inputSummary ?? "";
      }
    } catch (err) {
      this.output.appendLine(`[pipeline.approval] detail fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (this.disposed) return;

    const message = `LiberIDE run needs approval — ${title}${detail ? `: ${detail}` : ""}`;
    const choice = await vscode.window.showWarningMessage(message, { modal: false }, "Approve", "Reject");
    if (!choice) {
      // Dismissed without choosing — allow a future event to re-prompt.
      this.promptedApprovals.delete(key);
      return;
    }
    const decision = choice === "Approve" ? "approved" : "rejected";
    let note: string | undefined;
    if (decision === "rejected") {
      note = await vscode.window.showInputBox({ prompt: "Reason for rejection (optional)" }) || undefined;
    }
    if (this.disposed) return;
    try {
      await resolveNodeApproval(graphId, nodeId, decision, note);
      this.broadcast({ type: "log", message: `Approval ${decision} for ${nodeId}.`, severity: "info" });
    } catch (err) {
      this.promptedApprovals.delete(key);
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[pipeline.approval] ${msg}`);
      void vscode.window.showErrorMessage(`Failed to submit approval: ${msg}`);
    }
  }

  async cancel(graphId: string): Promise<void> {
    this.broadcast({ type: "operation", action: "cancel", status: "running" });
    await cancelExecutionGraph(graphId);
    this.graphs.get(graphId)?.dispose();
    this.graphs.delete(graphId);
    this.runsTree.cancelRun(graphId);
    this.broadcast({ type: "graphDone", payload: { graphId, status: "cancelled" } });
    this.broadcast({ type: "operation", action: "cancel", status: "success", message: `Cancelled ${graphId}.` });
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "pipeline.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.css"));
    const nonce = randomNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `connect-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>LiberIDE Pipeline</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function mapStatus(status: string): "running" | "completed" | "failed" | "blocked" | undefined {
  if (status === "running" || status === "completed" || status === "failed" || status === "blocked") return status;
  return undefined;
}

const ARTIFACT_LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
  py: "python", json: "json", md: "markdown", diff: "diff", patch: "diff",
  yaml: "yaml", yml: "yaml", sh: "shellscript", sql: "sql", go: "go", rs: "rust",
  java: "java", html: "html", css: "css", toml: "toml", xml: "xml",
};

/** Render a working-memory snapshot as readable markdown for an editor tab. */
function renderWorkingMemory(m: WorkingMemorySnapshot): string {
  const list = (items: string[]): string => (items.length ? items.map((i) => `- ${i}`).join("\n") : "_(none)_");
  const lines = [
    `# Working Memory`,
    ``,
    `**Goal:** ${m.activeGoal || "_(none)_"}`,
    `**Updated:** ${m.updatedAt}`,
    ``,
    `## Active files`,
    list(m.activeFiles),
    ``,
    `## Active tasks`,
    list(m.activeTasks),
    ``,
    `## Blockers`,
    list(m.blockers),
    ``,
    `## Assumptions`,
    list(m.assumptions),
    ``,
    `## Next actions`,
    list(m.nextActions),
  ];
  if (m.recentFailures.length) {
    lines.push(``, `## Recent failures`, ...m.recentFailures.map((f) => `- ${f.nodeTitle ?? "node"}: ${f.error ?? ""}`));
  }
  if (m.verificationHistory.length) {
    lines.push(``, `## Verification history`, ...m.verificationHistory.map((v) => `- ${v.nodeTitle ?? "node"}: ${v.passed ? "passed" : "failed"}`));
  }
  if (m.currentPlan) {
    lines.push(``, `## Current plan`, ``, m.currentPlan);
  }
  return `${lines.join("\n")}\n`;
}

/** Infer a VS Code language id for an artifact from its path extension, then its kind. */
function languageForArtifact(path?: string, kind?: string): string {
  const ext = path?.split(".").pop()?.toLowerCase();
  if (ext && ARTIFACT_LANG_BY_EXT[ext]) return ARTIFACT_LANG_BY_EXT[ext];
  const k = (kind ?? "").toLowerCase();
  if (k.includes("patch") || k.includes("diff")) return "diff";
  return "markdown"; // plan-document, research-report, summary, notes default to markdown
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
