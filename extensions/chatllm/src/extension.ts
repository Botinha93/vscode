import * as vscode from "vscode";
import { initApiFromContext } from "./api";
import { cancelExecutionGraph } from "./dispatch/client";
import { ChatllmPipelineController } from "./panel/panel";
import { ChatllmChatPanelController } from "./chat/chat-panel";
import { scaffoldFeature, regenerateTasksIndex, updateTaskStatus, writeTextFile } from "./spec/writer";
import { SpecStore } from "./spec/store";
import { createThemeBridge } from "./theme-bridge";
import { RunsTreeProvider } from "./views/runsTree";
import { SpecsTreeProvider } from "./views/specsTree";
import { TasksTreeProvider } from "./views/tasksTree";

let store: SpecStore;
let pipeline: ChatllmPipelineController;
let chat: ChatllmChatPanelController;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initApiFromContext(context);
  const output = vscode.window.createOutputChannel("Chatllm");
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

  pipeline = new ChatllmPipelineController(context, store, output);
  chat = new ChatllmChatPanelController(context, store, output);

  context.subscriptions.push(
    output,
    store,
    pipeline,
    chat,
    vscode.window.registerWebviewViewProvider(ChatllmPipelineController.viewType, pipeline, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(ChatllmChatPanelController.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerTreeDataProvider("chatllm.specs", specsTree),
    vscode.window.registerTreeDataProvider("chatllm.tasks", tasksTree),
    vscode.window.registerTreeDataProvider("chatllm.runs", runsTree),
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
    vscode.commands.registerCommand("chatllm.openChat", () => chat.show()),
    vscode.commands.registerCommand("chatllm.newChat", async () => {
      chat.show();
      await chat.newSession();
    }),
    vscode.commands.registerCommand("chatllm.openSettings", () => chat.openSettings()),
    vscode.commands.registerCommand("chatllm.openPipeline", () => pipeline.show()),
    vscode.commands.registerCommand("chatllm.refreshSpecs", async () => { await store.refresh(); specsTree.refresh(); }),
    vscode.commands.registerCommand("chatllm.refreshTasks", async () => { await store.refresh(); tasksTree.refresh(); }),
    vscode.commands.registerCommand("chatllm.refreshRuns", () => runsTree.refresh()),
    vscode.commands.registerCommand("chatllm.scaffoldFeature", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const name = await vscode.window.showInputBox({ prompt: "Feature name" });
      if (!folder || !name) return;
      const root = await scaffoldFeature(folder, name);
      const id = root.path.split("/").pop() ?? name;
      store.setActiveFeature(id);
      await context.workspaceState.update("chatllm.activeFeatureId", id);
      await store.refresh();
      specsTree.refresh();
    }),
    vscode.commands.registerCommand("chatllm.setActiveFeature", async (id: string) => {
      store.setActiveFeature(id);
      await context.workspaceState.update("chatllm.activeFeatureId", id);
      tasksTree.refresh();
    }),
    vscode.commands.registerCommand("chatllm.openTask", async (arg?: { featureId: string; task: { id: string } }) => {
      const task = arg && store.getTask(arg.featureId, arg.task.id);
      if (task) await vscode.window.showTextDocument(task.filePath);
    }),
    vscode.commands.registerCommand("chatllm.runTask", async (arg?: { featureId: string; task: { id: string } }) => {
      const feature = arg && store.getFeature(arg.featureId);
      if (!feature || !arg) return;
      await pipeline.dispatch(feature.id, [arg.task.id]);
    }),
    vscode.commands.registerCommand("chatllm.markTaskReady", async (arg?: { featureId: string; task: { id: string } }) => {
      const task = arg && store.getTask(arg.featureId, arg.task.id);
      if (task) await updateTaskStatus(task.filePath, "ready");
      await store.refresh();
    }),
    vscode.commands.registerCommand("chatllm.dispatchFeature", async () => {
      const feature = store.getActiveFeature();
      if (!feature) return;
      await pipeline.dispatch(feature.id);
    }),
    vscode.commands.registerCommand("chatllm.regenerateTasksIndex", async () => {
      const feature = store.getActiveFeature();
      if (feature?.tasksDirUri) await writeTextFile(vscode.Uri.joinPath(feature.tasksDirUri, "index.md"), regenerateTasksIndex(feature.tasks));
    }),
    vscode.commands.registerCommand("chatllm.cancelRun", async () => {
      const graphId = await vscode.window.showInputBox({ prompt: "Graph id to cancel" });
      if (graphId) await cancelExecutionGraph(graphId);
    }),
  ];
}

function statusBar(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.text = "$(comment-discussion) Chatllm";
  item.tooltip = "Open Chatllm chat";
  item.command = "chatllm.openChat";
  item.show();
  return item;
}

export function deactivate(): void {}
