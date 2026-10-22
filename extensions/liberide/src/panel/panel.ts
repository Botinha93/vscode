import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { addFollowUp, cancelExecutionGraph, dispatchFeature, fetchGraphDetail, getGraphMetrics, getWorkingMemory, listGraphArtifacts, patchWorkingMemory, replayFromNode, resolveGraphApproval, resolveNodeApproval, retryGraph, subscribeExecutionGraphEvents, taskStatusFromEvent, type GraphArtifact, type GraphMetrics, type WorkingMemorySnapshot } from "../dispatch/client";
import { buildIdeContextPayload } from "../ide-delegate/context";
import { onSettingsChange, readSettings } from "../settings";
import { computeTaskReadiness, validateDag } from "../spec/dag";
import type { SpecStore } from "../spec/store";
import { scaffoldFeature } from "../spec/writer";
import { getApiOrigin } from "../api";
import { resolveContainedRelativePath } from "../ide-delegate/handlers/path-containment";
import type { FeatureSummary, PipelineHostToWebview, PipelineWebviewToHost, TaskSummary } from "./protocol";
import type { RunsTreeProvider } from "../views/runsTree";
import { featureConversation, resolveDispatchConversation, type ChatRunLink } from "../dispatch/conversation-link";

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
  /** The chat the pipeline was opened from: its dispatches report there. */
  private linkedConversationId?: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SpecStore,
    private readonly output: vscode.OutputChannel,
    private readonly runsTree: RunsTreeProvider,
    private readonly chat: ChatRunLink,
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

  /** Focus the pipeline; `conversationId`: the chat it was opened from (its dispatches report there). */
  show(conversationId?: string): void {
    if (conversationId) this.linkedConversationId = conversationId;
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
        case "cancelGraph": {
          const choice = await vscode.window.showWarningMessage(`Cancel ${message.label ?? message.graphId}?`, { modal: true }, "Cancel Run");
          if (choice === "Cancel Run") await this.cancel(message.graphId);
          break;
        }
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
          if (this.linkedConversationId) await this.chat.showConversation(this.linkedConversationId);
          else await vscode.commands.executeCommand("liberide.openChat");
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

  async dispatch(featureId: string, taskIds?: string[], conversationId?: string): Promise<void> {
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
    // Every run reports to a chat: the one the pipeline came from, the one
    // that generated the feature, the open one, or a new one.
    const chatId = resolveDispatchConversation({
      explicit: conversationId ?? this.linkedConversationId,
      feature: featureConversation(this.context.workspaceState, feature.id),
      active: this.chat.activeConversationId(),
    }) ?? await this.chat.ensureConversation(`Dispatch: ${feature.name}`);
    const ideContext = buildIdeContextPayload(chatId);
    const result = await dispatchFeature(feature, {
      conversationId: chatId,
      taskIds: selectedIds,
      ideContext: ideContext ? { ...ideContext } : undefined,
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
    this.subscribeToGraph(result.graphId);
    if (chatId) await this.chat.trackGraph(chatId, result.graphId);
    this.broadcast({ type: "operation", action: "dispatch", status: "success", message: `Dispatched ${startEvent.label}.` });
  }

  /**
   * Result or error of a run action: a note in the chat that owns the run,
   * else the pipeline's log (never the output channel or a popup).
   */
  private report(graphId: string, message: string, severity: "info" | "warning" | "error" = "info"): void {
    const conversationId = this.chat.conversationForGraph(graphId);
    if (conversationId) {
      this.chat.postNote(conversationId, message, severity);
      void this.chat.showConversation(conversationId);
      return;
    }
    this.broadcast({ type: "log", message, severity });
    this.show();
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
   * approval prompts, and disconnect surfacing (task files are written back by
   * the runs tree). Reused by
   * dispatch, retry, and replay. Replaces any prior subscription for the graph.
   */
  private subscribeToGraph(graphId: string): void {
    this.graphs.get(graphId)?.dispose();
    const dispose = subscribeExecutionGraphEvents(graphId, (event) => {
      if (this.disposed) return;
      // Approval gates are resolved by the server's node id.
      if (event.type === "node_status" && event.nodeId && event.status === "waiting_approval") {
        void this.promptApproval(graphId, event.nodeId);
      }
      // Task files are updated by the runs tree (trackRun); here only the webview.
      const update = taskStatusFromEvent(event, graphId);
      if (update) {
        const { taskId, status, error } = update;
        this.broadcast({ type: "graphNode", payload: { graphId, nodeId: taskId, status, ...(error ? { error } : {}) } });
        if (error) this.broadcast({ type: "log", message: `${taskId} failed: ${error}`, severity: "error" });
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
      this.subscribeToGraph(graphId);
      this.report(graphId, `Retrying run ${meta?.label ?? graphId}.`);
    } catch (err) {
      this.report(graphId, `Retry failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  /** Replay a node and its downstream dependents, re-attaching the event stream. */
  async replayFromNode(graphId: string, nodeId: string): Promise<void> {
    const meta = this.runsTree.getRunMeta(graphId);
    try {
      // The server replays by its own node id; the Runs view and task files know task ids.
      const serverNodeId = await this.resolveServerNodeId(graphId, nodeId);
      const count = await replayFromNode(graphId, serverNodeId);
      if (meta) this.runsTree.trackRun(graphId, meta.featureId, meta.label, meta.nodeIds);
      this.subscribeToGraph(graphId);
      this.report(graphId, `Replaying ${count} node(s) from ${nodeId}.`);
    } catch (err) {
      this.report(graphId, `Replay failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  /**
   * The server node id for a task id or node id: the Runs view's map, else
   * the graph's nodes (`<graphId>_<taskId>`, or the first node of a swarm task).
   */
  private async resolveServerNodeId(graphId: string, nodeId: string): Promise<string> {
    const mapped = this.runsTree.serverNodeIdFor(graphId, nodeId);
    if (mapped) return mapped;
    try {
      const { nodes } = await fetchGraphDetail(graphId);
      return pickServerNodeId(graphId, nodeId, nodes.map((n) => n.id)) ?? nodeId;
    } catch {
      return nodeId;
    }
  }

  /** A run's aggregated token/cost usage (totals + per-node breakdown), as a chat note. */
  async viewRunCost(graphId: string): Promise<void> {
    let metrics: Awaited<ReturnType<typeof getGraphMetrics>>;
    try {
      metrics = await getGraphMetrics(graphId);
    } catch (err) {
      this.report(graphId, `Failed to load run cost: ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }
    if (!metrics || metrics.callCount === 0) {
      this.report(graphId, "No usage recorded for this run yet.");
      return;
    }
    this.report(graphId, formatRunCost(metrics));
  }

  /** List a run's artifacts in a QuickPick and open the chosen one in an editor tab. */
  async viewArtifacts(graphId: string): Promise<void> {
    let artifacts: Awaited<ReturnType<typeof listGraphArtifacts>>;
    try {
      artifacts = await listGraphArtifacts(graphId);
    } catch (err) {
      this.report(graphId, `Failed to load artifacts: ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }
    if (artifacts.length === 0) {
      this.report(graphId, "This run has not produced any artifacts yet.");
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

  async inspectGraph(graphId: string, nodeId?: string): Promise<void> {
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
      this.report(graphId, `Failed to load working memory: ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }
    if (!memory) {
      this.report(graphId, "This run has no working memory yet.");
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
      this.report(graphId, `Added to the run's working memory: ${note.trim()}`);
    } catch (err) {
      this.report(graphId, `Failed to update working memory: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  /** Add a follow-up goal to a run. */
  async addFollowUp(graphId: string): Promise<void> {
    const goal = await vscode.window.showInputBox({ prompt: "Follow-up instruction for this run" });
    if (!goal?.trim()) return;
    try {
      await addFollowUp(graphId, goal.trim());
      this.report(graphId, `Follow-up queued: ${goal.trim()}`);
    } catch (err) {
      this.report(graphId, `Follow-up failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  /**
   * A node's detail (status, input, full error, output, its agents): in the
   * chat that owns the run, expanded there; else in the pipeline's inspector.
   */
  async showNodeDetail(graphId: string, nodeId: string): Promise<void> {
    if (await this.chat.revealGraphNode(graphId, nodeId)) return;
    this.show();
    await this.inspectGraph(graphId, nodeId);
  }

  /** Server push: a run waits on an approval (the chat's card covers runs that report to a chat). */
  async approvalPending(graphId: string, nodeId: string): Promise<void> {
    await this.promptApproval(graphId, nodeId);
  }

  /** Re-open the approval prompt on demand (Runs-tree "Resolve Approval" action). */
  async resolveApprovalForRun(graphId: string, nodeId: string): Promise<void> {
    // The chat's graph card has Approve/Reject on the waiting step.
    if (await this.chat.revealGraphNode(graphId, nodeId)) return;
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
    // Runs that report to a chat are approved from the card there.
    if (this.chat.conversationForGraph(graphId)) return;
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
      this.report(graphId, `Failed to submit approval: ${err instanceof Error ? err.message : String(err)}`, "error");
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
      // No remote images: model output could embed a URL that exfiltrates context.
      `img-src ${webview.cspSource} data: blob:`,
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
  return randomBytes(16).toString("hex");
}

/** A run's cost as a markdown note: totals, then one row per node. */
export function formatRunCost(metrics: GraphMetrics): string {
  const usd = (value: number) => (value ? `$${value.toFixed(4)}` : "n/a");
  const lines = [
    `**Run cost:** ${usd(metrics.estimatedCostUsd)} \u00b7 ${metrics.inputTokens} in / ${metrics.outputTokens} out tokens \u00b7 ${metrics.callCount} calls`,
  ];
  if (metrics.perNode.length) {
    lines.push("", "| Node | Cost | Tokens in/out |", "| --- | --- | --- |");
    for (const n of metrics.perNode) lines.push(`| ${n.title || n.nodeId} | ${usd(n.estimatedCostUsd)} | ${n.inputTokens}/${n.outputTokens} |`);
  }
  return lines.join("\n");
}

/**
 * The server's id for a node named by task id (`T-1`) or server id: an exact
 * match, `<graphId>_<id>`, or the first node of that swarm task (`<graphId>_<id>_…`).
 */
export function pickServerNodeId(graphId: string, nodeId: string, serverIds: string[]): string | undefined {
  if (serverIds.includes(nodeId)) return nodeId;
  const prefixed = `${graphId}_${nodeId}`;
  if (serverIds.includes(prefixed)) return prefixed;
  return serverIds.find((id) => id.startsWith(`${prefixed}_`));
}
