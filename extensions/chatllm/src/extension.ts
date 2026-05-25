import * as vscode from "vscode";
import { registerChatParticipant } from "./chat/participant";
import { createThemeBridge } from "./theme-bridge";
import { SpecStore } from "./spec/store";
import { SpecsTreeProvider } from "./views/specsTree";
import { TasksTreeProvider } from "./views/tasksTree";
import { RunsTreeProvider } from "./views/runsTree";
import {
  scaffoldFeature,
  writeTextFile,
  updateTaskStatus,
  regenerateTasksIndex,
} from "./spec/writer";
import { dispatchFeature, cancelExecutionGraph } from "./dispatch/client";

const ACTIVITY_VIEW_ID = "workbench.view.extension.chatllm";

let specStore: SpecStore;
let runsProvider: RunsTreeProvider;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Chatllm");
  specStore = new SpecStore(output);
  await specStore.initialize(context);

  const specsTree = new SpecsTreeProvider(specStore);
  const tasksTree = new TasksTreeProvider(specStore);
  runsProvider = new RunsTreeProvider(output, async (featureId, taskId, status) => {
    const task = specStore.getTask(featureId, taskId);
    if (task) {
      await updateTaskStatus(task.filePath, status);
      await specStore.refresh();
      tasksTree.refresh();
    }
  });

  context.subscriptions.push(
    output,
    specStore,
    vscode.window.registerTreeDataProvider("chatllm.specs", specsTree),
    vscode.window.registerTreeDataProvider("chatllm.tasks", tasksTree),
    vscode.window.registerTreeDataProvider("chatllm.runs", runsProvider),
    registerChatParticipant(context, specStore, runsProvider, output),
    createThemeBridge(output),
    createStatusBarItem(),
    ...registerCommands(context, specsTree, tasksTree, output),
  );

  runsProvider.refresh();
  output.appendLine("Chatllm VS Code extension activated.");
}

function registerCommands(
  context: vscode.ExtensionContext,
  specsTree: SpecsTreeProvider,
  tasksTree: TasksTreeProvider,
  output: vscode.OutputChannel,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("chatllm.openChat", async () => {
      await vscode.commands.executeCommand("workbench.action.chat.open");
    }),
    vscode.commands.registerCommand("chatllm.openPanel", async () => {
      await vscode.commands.executeCommand(ACTIVITY_VIEW_ID);
    }),
    vscode.commands.registerCommand("chatllm.refreshSpecs", async () => {
      await specStore.refresh();
      specsTree.refresh();
    }),
    vscode.commands.registerCommand("chatllm.refreshTasks", async () => {
      await specStore.refresh();
      tasksTree.refresh();
    }),
    vscode.commands.registerCommand("chatllm.refreshRuns", () => {
      runsProvider.refresh();
    }),
    vscode.commands.registerCommand("chatllm.scaffoldFeature", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showErrorMessage("Open a workspace folder first.");
        return;
      }
      const name = await vscode.window.showInputBox({ prompt: "Feature name" });
      if (!name?.trim()) return;
      const root = await scaffoldFeature(folder, name.trim());
      await specStore.refresh();
      specStore.setActiveFeature(root.path.split("/").pop() ?? name);
      await context.workspaceState.update("chatllm.activeFeatureId", specStore.getActiveFeatureId());
      specsTree.refresh();
      void vscode.window.showInformationMessage(`Scaffolded spec at ${root.fsPath}`);
    }),
    vscode.commands.registerCommand(
      "chatllm.setActiveFeature",
      async (arg?: string | { kind: "feature"; feature: { id: string } }) => {
        const featureId = typeof arg === "string" ? arg : arg?.feature?.id;
        if (!featureId) return;
        specStore.setActiveFeature(featureId);
        await context.workspaceState.update("chatllm.activeFeatureId", featureId);
        tasksTree.refresh();
        void vscode.window.showInformationMessage(`Active spec: ${featureId}`);
      },
    ),
    vscode.commands.registerCommand("chatllm.openTask", async (arg?: TaskCommandArg) => {
      const ctx = resolveTaskArg(arg);
      if (!ctx) return;
      const task = specStore.getTask(ctx.featureId, ctx.taskId);
      if (task) await vscode.window.showTextDocument(task.filePath);
    }),
    vscode.commands.registerCommand("chatllm.runTask", async (arg?: TaskCommandArg) => {
      const ctx = resolveTaskArg(arg);
      if (!ctx) return;
      const feature = specStore.getFeature(ctx.featureId);
      if (!feature) return;
      try {
        const result = await dispatchFeature(feature, { taskIds: [ctx.taskId] });
        runsProvider.trackRun(result.graphId, feature.id, `${feature.name} / ${ctx.taskId}`, [ctx.taskId]);
        const task = specStore.getTask(ctx.featureId, ctx.taskId);
        if (task) await updateTaskStatus(task.filePath, "running");
        await specStore.refresh();
        tasksTree.refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(message);
      }
    }),
    vscode.commands.registerCommand("chatllm.markTaskReady", async (arg?: TaskCommandArg) => {
      const ctx = resolveTaskArg(arg);
      if (!ctx) return;
      const task = specStore.getTask(ctx.featureId, ctx.taskId);
      if (!task) return;
      await updateTaskStatus(task.filePath, "ready");
      await specStore.refresh();
      tasksTree.refresh();
    }),
    vscode.commands.registerCommand("chatllm.dispatchFeature", async () => {
      const feature = specStore.getActiveFeature();
      if (!feature) {
        void vscode.window.showErrorMessage("No active spec feature.");
        return;
      }
      try {
        const result = await dispatchFeature(feature);
        runsProvider.trackRun(
          result.graphId,
          feature.id,
          feature.name,
          feature.tasks.map((t) => t.id),
        );
        void vscode.window.showInformationMessage(`Dispatched ${feature.name} (${result.graphId})`);
        runsProvider.refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(message);
        output.appendLine(message);
      }
    }),
    vscode.commands.registerCommand("chatllm.regenerateTasksIndex", async () => {
      const feature = specStore.getActiveFeature();
      if (!feature?.tasksDirUri) return;
      const indexUri = vscode.Uri.joinPath(feature.tasksDirUri, "index.md");
      await writeTextFile(indexUri, regenerateTasksIndex(feature.tasks));
      void vscode.window.showInformationMessage("Regenerated tasks/index.md");
    }),
    vscode.commands.registerCommand("chatllm.cancelRun", async () => {
      const graphId = await vscode.window.showInputBox({ prompt: "Graph id to cancel" });
      if (!graphId) return;
      try {
        await cancelExecutionGraph(graphId);
        runsProvider.cancelRun(graphId);
        void vscode.window.showInformationMessage(`Cancelled ${graphId}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(message);
      }
    }),
    vscode.commands.registerCommand(
      "chatllm.writeGeneratedFile",
      async (uriString: string, content: string) => {
        const uri = vscode.Uri.parse(uriString);
        await writeTextFile(uri, content);
        await specStore.refresh();
        specsTree.refresh();
        await vscode.window.showTextDocument(uri);
      },
    ),
  ];
}

function createStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.text = "$(comment-discussion) Chatllm";
  item.tooltip = "Open Chatllm chat";
  item.command = "chatllm.openChat";
  item.show();
  return item;
}

type TaskCommandArg =
  | { kind: "task"; featureId: string; task: { id: string } }
  | [featureId: string, taskId: string];

function resolveTaskArg(arg?: TaskCommandArg): { featureId: string; taskId: string } | undefined {
  if (!arg) {
    const feature = specStore.getActiveFeature();
    const taskId = feature?.tasks.find((t) => t.status === "ready" || t.status === "pending")?.id;
    if (feature && taskId) return { featureId: feature.id, taskId };
    return undefined;
  }
  if (Array.isArray(arg)) return { featureId: arg[0], taskId: arg[1] };
  if (arg.kind === "task") return { featureId: arg.featureId, taskId: arg.task.id };
  return undefined;
}

export function deactivate(): void {}
