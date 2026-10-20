import * as vscode from "vscode";
import { getIntegrationSnapshot, getWebOrigin, initApiFromContext, listConversations, onIntegrationFileChanged } from "./api";
import { continueInBrowserUrl, onConversationOpenRequest, takeStartupConversationRequest } from "./chat/continuation";
import { LiberidePipelineController } from "./panel/panel";
import { LiberideChatPanelController } from "./chat/chat-panel";
import { scaffoldFeature, regenerateTasksIndex, updateTaskStatus, writeTextFile } from "./spec/writer";
import { SpecStore } from "./spec/store";
import { createThemeBridge } from "./theme-bridge";
import { RunsTreeProvider } from "./views/runsTree";
import { SpecsTreeProvider } from "./views/specsTree";
import { TasksTreeProvider } from "./views/tasksTree";
import { startIdeDelegateStream } from "./ide-delegate/stream";
import { disposeAgentTerminals } from "./terminal/agent-terminals";
import { runIdeWorkflowCommand } from "./workflows/ide-triggers";
import { initMachineIdentity } from "./ide-delegate/machine";
import { pairWithServerCommand } from "./pairing";

let store: SpecStore;
let pipeline: LiberidePipelineController;
let chat: LiberideChatPanelController;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(initApiFromContext(context));
  initMachineIdentity(context);
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
    startIdeDelegateStream(output),
    ...commands(context, specsTree, tasksTree, runsTree),
    vscode.commands.registerCommand("liberide.pairWithServer", () => {
      pairWithServerCommand(output).catch((err: unknown) => {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      });
    }),
    vscode.commands.registerCommand("liberide.runWorkflow", () => {
      runIdeWorkflowCommand(output).catch((err: unknown) => {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      });
    }),
    ...continuation(output),
  );
}

/** Conversations opened from the web app, and back: "Continue in Browser", "Open Conversation…". */
function continuation(output: vscode.OutputChannel): vscode.Disposable[] {
  const open = (conversationId: string) => {
    chat.openConversation(conversationId).catch((err: unknown) => {
      output.appendLine(`[continuation] ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const updateContext = () => {
    void vscode.commands.executeCommand("setContext", "liberide.hasWebOrigin", Boolean(getWebOrigin()));
  };
  const checkLaunchRequest = () => {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const conversationId = takeStartupConversationRequest(getIntegrationSnapshot(), folders);
    if (conversationId) open(conversationId);
  };
  const offRequests = onConversationOpenRequest(open);
  const offFile = onIntegrationFileChanged(() => {
    updateContext();
    checkLaunchRequest();
  });
  updateContext();
  checkLaunchRequest();

  return [
    { dispose: offRequests },
    { dispose: offFile },
    vscode.commands.registerCommand("liberide.continueInBrowser", async () => {
      const url = continueInBrowserUrl(getWebOrigin(), chat.activeConversationId());
      if (!url) {
        void vscode.window.showInformationMessage(getWebOrigin()
          ? "Open a saved conversation first."
          : "No web app address is known. Pair with the server (LiberIDE: Pair with Server…) or open LiberIDE from the desktop app.");
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand("liberide.openConversation", async () => {
      try {
        const conversations = (await listConversations()).filter((conversation) => !conversation.archived);
        const picked = await vscode.window.showQuickPick(
          conversations.slice(0, 50).map((conversation) => ({
            label: conversation.title || "Untitled",
            description: conversation.folder ?? undefined,
            detail: new Date(conversation.updatedAt).toLocaleString(),
            id: conversation.id,
          })),
          { placeHolder: "Open a conversation", matchOnDescription: true },
        );
        if (picked) open(picked.id);
      } catch (err) {
        void vscode.window.showErrorMessage(`Could not list conversations: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  ];
}

function commands(
  context: vscode.ExtensionContext,
  specsTree: SpecsTreeProvider,
  tasksTree: TasksTreeProvider,
  runsTree: RunsTreeProvider,
): vscode.Disposable[] {
  /** Wrap an async command handler so uncaught errors show a VS Code notification. */
  function safe<T extends unknown[]>(fn: (...args: T) => Promise<void>): (...args: T) => void {
    return (...args: T) => {
      fn(...args).catch((err: unknown) => {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      });
    };
  }

  return [
    vscode.commands.registerCommand("liberide.openChat", () => chat.show()),
    vscode.commands.registerCommand("liberide.newChat", safe(async () => {
      chat.show();
      await chat.newSession();
    })),
    vscode.commands.registerCommand("liberide.openSettings", () => chat.openSettings()),
    vscode.commands.registerCommand("liberide.openChatHistory", () => chat.openChatHistory()),
    vscode.commands.registerCommand("liberide.renameChat", safe(async () => {
      await chat.renameActiveChat();
    })),
    vscode.commands.registerCommand("liberide.openPipeline", () => pipeline.show()),
    vscode.commands.registerCommand("liberide.refreshSpecs", safe(async () => { await store.refresh(); specsTree.refresh(); })),
    vscode.commands.registerCommand("liberide.refreshTasks", safe(async () => { await store.refresh(); tasksTree.refresh(); })),
    vscode.commands.registerCommand("liberide.refreshRuns", () => runsTree.refresh()),
    vscode.commands.registerCommand("liberide.scaffoldFeature", safe(async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const name = await vscode.window.showInputBox({ prompt: "Feature name" });
      if (!folder || !name) return;
      const root = await scaffoldFeature(folder, name);
      const id = root.path.split("/").pop() ?? name;
      store.setActiveFeature(id);
      await context.workspaceState.update("liberide.activeFeatureId", id);
      await store.refresh();
      specsTree.refresh();
    })),
    vscode.commands.registerCommand("liberide.setActiveFeature", safe(async (id: string) => {
      store.setActiveFeature(id);
      await context.workspaceState.update("liberide.activeFeatureId", id);
      tasksTree.refresh();
    })),
    vscode.commands.registerCommand("liberide.openTask", safe(async (arg?: { featureId: string; task: { id: string } }) => {
      const task = arg && store.getTask(arg.featureId, arg.task.id);
      if (task) await vscode.window.showTextDocument(task.filePath);
    })),
    vscode.commands.registerCommand("liberide.runTask", safe(async (arg?: { featureId: string; task: { id: string } }) => {
      const feature = arg && store.getFeature(arg.featureId);
      if (!feature || !arg) return;
      await pipeline.dispatch(feature.id, [arg.task.id]);
    })),
    vscode.commands.registerCommand("liberide.markTaskReady", safe(async (arg?: { featureId: string; task: { id: string } }) => {
      const task = arg && store.getTask(arg.featureId, arg.task.id);
      if (task) await updateTaskStatus(task.filePath, "ready");
      await store.refresh();
    })),
    vscode.commands.registerCommand("liberide.dispatchFeature", safe(async () => {
      const feature = store.getActiveFeature();
      if (!feature) return;
      await pipeline.dispatch(feature.id);
    })),
    vscode.commands.registerCommand("liberide.regenerateTasksIndex", safe(async () => {
      const feature = store.getActiveFeature();
      if (feature?.tasksDirUri) await writeTextFile(vscode.Uri.joinPath(feature.tasksDirUri, "index.md"), regenerateTasksIndex(feature.tasks));
    })),
    vscode.commands.registerCommand("liberide.cancelRun", safe(async (arg?: { kind?: string; run?: { graphId?: string } } | string) => {
      const graphId = typeof arg === "string" ? arg : arg?.run?.graphId;
      if (!graphId) {
        void vscode.window.showInformationMessage("Select an active run from the Agent Runs view to cancel it.");
        return;
      }
      await pipeline.cancel(graphId);
    })),
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

export function deactivate(): void {
  // Agent terminals own child processes; don't leave them running.
  disposeAgentTerminals();
}
