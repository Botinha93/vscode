import * as vscode from "vscode";
import { initApiFromContext } from "./api";
import { LiberidePipelineController } from "./panel/panel";
import { LiberideChatPanelController } from "./chat/chat-panel";
import { scaffoldFeature, regenerateTasksIndex, updateTaskStatus, writeTextFile } from "./spec/writer";
import { SpecStore } from "./spec/store";
import { createThemeBridge } from "./theme-bridge";
import { RunsTreeProvider } from "./views/runsTree";
import { SpecsTreeProvider } from "./views/specsTree";
import { TasksTreeProvider } from "./views/tasksTree";

let store: SpecStore;
let pipeline: LiberidePipelineController;
let chat: LiberideChatPanelController;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initApiFromContext(context);
  const output = vscode.window.createOutputChannel("LiberIDE");
  store = new SpecStore(output);
  await store.initialize(context);

  const specsTree = new SpecsTreeProvider(store);
  const tasksTree = new TasksTreeProvider(store);
  const runsTree = new RunsTreeProvider(async (featureId, taskId, status) => {
    const task = store.getTask(featureId, taskId);
    if (task) {
      await updateTaskStatus(task.filePath, status);
      await store.refresh();
    }
  });

  pipeline = new LiberidePipelineController(context, store, output, runsTree);
  chat = new LiberideChatPanelController(context, store, output);

  context.subscriptions.push(
    output,
    store,
    pipeline,
    chat,
    vscode.window.registerWebviewViewProvider(LiberidePipelineController.viewType, pipeline, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(LiberideChatPanelController.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerTreeDataProvider("liberide.specs", specsTree),
    vscode.window.registerTreeDataProvider("liberide.tasks", tasksTree),
    vscode.window.registerTreeDataProvider("liberide.runs", runsTree),
    createThemeBridge(output),
    statusBar(),
    ...commands(context, specsTree, tasksTree, runsTree),
  );
}

function commands(
  context: vscode.ExtensionContext,
  specsTree: SpecsTreeProvider,
  tasksTree: TasksTreeProvider,
  runsTree: RunsTreeProvider,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("liberide.openChat", () => chat.show()),
    vscode.commands.registerCommand("liberide.newChat", async () => {
      chat.show();
      await chat.newSession();
    }),
    vscode.commands.registerCommand("liberide.openSettings", () => chat.openSettings()),
    vscode.commands.registerCommand("liberide.openPipeline", () => pipeline.show()),
    vscode.commands.registerCommand("liberide.refreshSpecs", async () => { await store.refresh(); specsTree.refresh(); }),
    vscode.commands.registerCommand("liberide.refreshTasks", async () => { await store.refresh(); tasksTree.refresh(); }),
    vscode.commands.registerCommand("liberide.refreshRuns", () => runsTree.refresh()),
    vscode.commands.registerCommand("liberide.scaffoldFeature", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const name = await vscode.window.showInputBox({ prompt: "Feature name" });
      if (!folder || !name) return;
      const root = await scaffoldFeature(folder, name);
      const id = root.path.split("/").pop() ?? name;
      store.setActiveFeature(id);
      await context.workspaceState.update("liberide.activeFeatureId", id);
      await store.refresh();
      specsTree.refresh();
    }),
    vscode.commands.registerCommand("liberide.setActiveFeature", async (id: string) => {
      store.setActiveFeature(id);
      await context.workspaceState.update("liberide.activeFeatureId", id);
      tasksTree.refresh();
    }),
    vscode.commands.registerCommand("liberide.openTask", async (arg?: { featureId: string; task: { id: string } }) => {
      const task = arg && store.getTask(arg.featureId, arg.task.id);
      if (task) await vscode.window.showTextDocument(task.filePath);
    }),
    vscode.commands.registerCommand("liberide.runTask", async (arg?: { featureId: string; task: { id: string } }) => {
      const feature = arg && store.getFeature(arg.featureId);
      if (!feature || !arg) return;
      await pipeline.dispatch(feature.id, [arg.task.id]);
    }),
    vscode.commands.registerCommand("liberide.markTaskReady", async (arg?: { featureId: string; task: { id: string } }) => {
      const task = arg && store.getTask(arg.featureId, arg.task.id);
      if (task) await updateTaskStatus(task.filePath, "ready");
      await store.refresh();
    }),
    vscode.commands.registerCommand("liberide.dispatchFeature", async () => {
      const feature = store.getActiveFeature();
      if (!feature) return;
      await pipeline.dispatch(feature.id);
    }),
    vscode.commands.registerCommand("liberide.regenerateTasksIndex", async () => {
      const feature = store.getActiveFeature();
      if (feature?.tasksDirUri) await writeTextFile(vscode.Uri.joinPath(feature.tasksDirUri, "index.md"), regenerateTasksIndex(feature.tasks));
    }),
    vscode.commands.registerCommand("liberide.cancelRun", async (arg?: { kind?: string; run?: { graphId?: string } } | string) => {
      const graphId = typeof arg === "string" ? arg : arg?.run?.graphId;
      if (!graphId) {
        void vscode.window.showInformationMessage("Select an active run from the Agent Runs view to cancel it.");
        return;
      }
      await pipeline.cancel(graphId);
    }),
  ];
}

function statusBar(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.text = "$(comment-discussion) LiberIDE";
  item.tooltip = "Open LiberIDE chat";
  item.command = "liberide.openChat";
  item.show();
  return item;
}

export function deactivate(): void {}
