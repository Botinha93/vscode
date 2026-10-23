import * as vscode from "vscode";
import { createAuthHandoff, getIntegrationSnapshot, getWebOrigin, initApiFromContext, listConversations, onIntegrationFileChanged, probeBackend, setConfiguredApiOrigin, type BackendReachability } from "./api";
import { continueInBrowserUrl, onConversationOpenRequest, resolveContinueInBrowserUrl, takeStartupConversationRequest } from "./chat/continuation";
import { LiberidePipelineController } from "./panel/panel";
import { LiberideChatPanelController } from "./chat/chat-panel";
import { scaffoldFeature, regenerateTasksIndex, updateTaskStatus, writeTextFile } from "./spec/writer";
import { SpecStore } from "./spec/store";
import { createThemeBridge } from "./theme-bridge";
import { RunsTreeProvider } from "./views/runsTree";
import { SpecsTreeProvider } from "./views/specsTree";
import { TasksTreeProvider } from "./views/tasksTree";
import { ApprovalsTreeProvider } from "./views/approvalsTree";
import { McpTreeProvider } from "./views/mcpTree";
import { revokeApprovalGrant, setMcpServerEnabledForUser } from "./api";
import { startIdeDelegateStream } from "./ide-delegate/stream";
import { disposeAgentTerminals } from "./terminal/agent-terminals";
import { runIdeWorkflowCommand } from "./workflows/ide-triggers";
import { initMachineIdentity } from "./ide-delegate/machine";
import { pairWithServerCommand } from "./pairing";
import { IdeNotificationCenter } from "./ide-delegate/notifications";
import { setActiveProjectFolder } from "./project/identity";
import { refreshIdeIdentity } from "./ide-delegate/identity";
import { refreshWorkspaceIntelligence } from "./workspace/intelligence";

let store: SpecStore;
let pipeline: LiberidePipelineController;
let chat: LiberideChatPanelController;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const liberideConfig = vscode.workspace.getConfiguration("liberide");
  setConfiguredApiOrigin(liberideConfig.get<string>("apiOrigin"));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration("liberide.apiOrigin")) {
      setConfiguredApiOrigin(vscode.workspace.getConfiguration("liberide").get<string>("apiOrigin"));
    }
  }));
  context.subscriptions.push(initApiFromContext(context));
  initMachineIdentity(context);
  const output = vscode.window.createOutputChannel("LiberIDE");
  void refreshIdeIdentity((message) => output.appendLine(`[identity] ${message}`));
  void refreshWorkspaceIntelligence(output);
  store = new SpecStore(output);
  await store.initialize(context);

  const specsTree = new SpecsTreeProvider(store);
  const tasksTree = new TasksTreeProvider(store);
  const runsTree = new RunsTreeProvider(async (featureId, taskId, status, error) => {
    const task = store.getTask(featureId, taskId);
    if (task) {
      await updateTaskStatus(task.filePath, status, error);
      await store.refresh();
    }
  });

  const approvalsTree = new ApprovalsTreeProvider((message) => output.appendLine(message));
  const mcpTree = new McpTreeProvider((message) => output.appendLine(message));

  chat = new LiberideChatPanelController(context, store, output);
  pipeline = new LiberidePipelineController(context, store, output, runsTree, chat);

  const notificationCenter = new IdeNotificationCenter(output, {
    onApprovalPending: ({ graphId, nodeId }) => {
      if (graphId && nodeId) void pipeline.approvalPending(graphId, nodeId);
      approvalsTree.refresh();
    },
    onRunStatus: () => {
      runsTree.refresh();
      approvalsTree.refresh();
    },
  });

  context.subscriptions.push(
    output,
    store,
    pipeline,
    chat,
    notificationCenter,
    vscode.window.registerWebviewViewProvider(LiberidePipelineController.viewType, pipeline, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(LiberideChatPanelController.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerTreeDataProvider("liberide.specs", specsTree),
    vscode.window.registerTreeDataProvider("liberide.tasks", tasksTree),
    vscode.window.registerTreeDataProvider("liberide.runs", runsTree),
    vscode.window.registerTreeDataProvider("liberide.approvals", approvalsTree),
    vscode.window.registerTreeDataProvider("liberide.mcp", mcpTree),
    createThemeBridge(output),
    connectionStatus(output),
    startIdeDelegateStream(output, notificationCenter.handler),
    ...commands(context, specsTree, tasksTree, runsTree, approvalsTree, mcpTree),
    vscode.commands.registerCommand("liberide.pairWithServer", () => {
      pairWithServerCommand(output).catch((err: unknown) => {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      });
    }),
    vscode.commands.registerCommand("liberide.runWorkflow", () => {
      runIdeWorkflowCommand(output, chat).catch((err: unknown) => {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      });
    }),
    ...continuation(output),
  );

  approvalsTree.refresh();
  mcpTree.refresh();
  runsTree.refresh();
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
      const conversationId = chat.activeConversationId();
      const url = continueInBrowserUrl(getWebOrigin(), conversationId);
      if (!url || !conversationId) {
        void vscode.window.showInformationMessage(getWebOrigin()
          ? "Open a saved conversation first."
          : "No web app address is known. Pair with the server (LiberIDE: Pair with Server…) or open LiberIDE from the desktop app.");
        return;
      }
      // A one-time sign-in link, so a browser without a session lands in the conversation.
      await vscode.env.openExternal(vscode.Uri.parse(await resolveContinueInBrowserUrl(url, conversationId, createAuthHandoff)));
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
  approvalsTree: ApprovalsTreeProvider,
  mcpTree: McpTreeProvider,
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
    vscode.commands.registerCommand("liberide.attachSelection", safe(async () => { chat.show(); await chat.attachSelection(); })),
    vscode.commands.registerCommand("liberide.attachActiveFile", safe(async () => { chat.show(); await chat.attachActiveFile(); })),
    vscode.commands.registerCommand("liberide.attachFileToChat", safe(async () => { chat.show(); await chat.attachFilePick(); })),
    vscode.commands.registerCommand("liberide.attachTerminalOutput", safe(async () => { chat.show(); await chat.attachTerminalOutput(); })),
    vscode.commands.registerCommand("liberide.attachGitDiff", safe(async () => { chat.show(); await chat.attachGitDiff(); })),
    vscode.commands.registerCommand("liberide.newChat", safe(async () => {
      chat.show();
      await chat.newSession();
    })),
    vscode.commands.registerCommand("liberide.openSettings", () => chat.openSettings()),
    vscode.commands.registerCommand("liberide.openChatHistory", () => chat.openChatHistory()),
    vscode.commands.registerCommand("liberide.renameChat", safe(async () => {
      await chat.renameActiveChat();
    })),
    // From a chat (Open pipeline): that chat receives the pipeline's runs.
    vscode.commands.registerCommand("liberide.openPipeline", (arg?: { conversationId?: string }) => pipeline.show(arg?.conversationId ?? chat.activeConversationId())),
    vscode.commands.registerCommand("liberide.refreshSpecs", safe(async () => { await store.refresh(); specsTree.refresh(); })),
    vscode.commands.registerCommand("liberide.refreshTasks", safe(async () => { await store.refresh(); tasksTree.refresh(); })),
    vscode.commands.registerCommand("liberide.refreshRuns", () => runsTree.refresh()),
    vscode.commands.registerCommand("liberide.refreshApprovals", () => approvalsTree.refresh()),
    vscode.commands.registerCommand("liberide.revokeApprovalGrant", safe(async (arg?: unknown) => {
      const grantId = ApprovalsTreeProvider.grantIdOf(arg);
      if (!grantId) {
        void vscode.window.showInformationMessage("Select an active grant in the Approvals view to revoke it.");
        return;
      }
      await revokeApprovalGrant(grantId);
      approvalsTree.refresh();
    })),
    vscode.commands.registerCommand("liberide.selectActiveProject", safe(async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length < 2) {
        void vscode.window.showInformationMessage("Open a multi-root workspace to switch the active LiberIDE project.");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
        { title: "Select active LiberIDE project", placeHolder: "Chat, specs, and dispatch bind to this folder" },
      );
      if (!pick) return;
      setActiveProjectFolder(pick.folder);
      await chat.reloadProject();
      void vscode.window.showInformationMessage(`LiberIDE active project: ${pick.label}`);
    })),
    vscode.commands.registerCommand("liberide.refreshMcpServers", () => mcpTree.refresh()),
    vscode.commands.registerCommand("liberide.enableMcpServer", safe(async (arg?: unknown) => {
      const server = McpTreeProvider.serverOf(arg);
      if (!server) return;
      await setMcpServerEnabledForUser(server.id, true);
      mcpTree.refresh();
    })),
    vscode.commands.registerCommand("liberide.disableMcpServer", safe(async (arg?: unknown) => {
      const server = McpTreeProvider.serverOf(arg);
      if (!server) return;
      await setMcpServerEnabledForUser(server.id, false);
      mcpTree.refresh();
    })),
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
    vscode.commands.registerCommand("liberide.resolveApproval", safe(async (arg?: { run?: { graphId?: string } } | string) => {
      const graphId = typeof arg === "string" ? arg : arg?.run?.graphId;
      if (!graphId) {
        void vscode.window.showInformationMessage("Select a run awaiting approval from the Agent Runs view.");
        return;
      }
      const nodeId = runsTree.getWaitingNodeId(graphId);
      if (!nodeId) {
        void vscode.window.showInformationMessage("That run is not awaiting approval.");
        return;
      }
      await pipeline.resolveApprovalForRun(graphId, nodeId);
    })),
    vscode.commands.registerCommand("liberide.retryRun", safe(async (arg?: { run?: { graphId?: string } } | string) => {
      const graphId = typeof arg === "string" ? arg : arg?.run?.graphId;
      if (!graphId) {
        void vscode.window.showInformationMessage("Select a finished run from the Agent Runs view to retry.");
        return;
      }
      await pipeline.retryRun(graphId);
    })),
    vscode.commands.registerCommand("liberide.replayFromNode", safe(async (arg?: { graphId?: string; nodeId?: string; serverNodeId?: string }) => {
      if (!arg?.graphId || !arg?.nodeId) {
        void vscode.window.showInformationMessage("Select a node in the Agent Runs view to replay from.");
        return;
      }
      // Runs-view items carry the task id as `nodeId` and the server's id as `serverNodeId`.
      await pipeline.replayFromNode(arg.graphId, arg.serverNodeId ?? arg.nodeId);
    })),
    vscode.commands.registerCommand("liberide.showNodeDetail", safe(async (arg?: { graphId?: string; nodeId?: string }) => {
      if (!arg?.graphId || !arg?.nodeId) return;
      await pipeline.showNodeDetail(arg.graphId, arg.nodeId);
    })),
    vscode.commands.registerCommand("liberide.viewArtifacts", safe(async (arg?: { run?: { graphId?: string } } | string) => {
      const graphId = typeof arg === "string" ? arg : arg?.run?.graphId;
      if (!graphId) {
        void vscode.window.showInformationMessage("Select a run from the Agent Runs view to view its artifacts.");
        return;
      }
      await pipeline.viewArtifacts(graphId);
    })),
    vscode.commands.registerCommand("liberide.viewWorkingMemory", safe(async (arg?: { run?: { graphId?: string } } | string) => {
      const graphId = typeof arg === "string" ? arg : arg?.run?.graphId;
      if (!graphId) {
        void vscode.window.showInformationMessage("Select a run from the Agent Runs view to inspect its working memory.");
        return;
      }
      await pipeline.viewWorkingMemory(graphId);
    })),
    vscode.commands.registerCommand("liberide.addWorkingMemoryNote", safe(async (arg?: { run?: { graphId?: string } } | string) => {
      const graphId = typeof arg === "string" ? arg : arg?.run?.graphId;
      if (graphId) await pipeline.addWorkingMemoryNote(graphId);
    })),
    vscode.commands.registerCommand("liberide.addFollowUp", safe(async (arg?: { run?: { graphId?: string } } | string) => {
      const graphId = typeof arg === "string" ? arg : arg?.run?.graphId;
      if (graphId) await pipeline.addFollowUp(graphId);
    })),
    vscode.commands.registerCommand("liberide.viewRunCost", safe(async (arg?: { run?: { graphId?: string } } | string) => {
      const graphId = typeof arg === "string" ? arg : arg?.run?.graphId;
      if (!graphId) {
        void vscode.window.showInformationMessage("Select a run from the Agent Runs view to view its cost.");
        return;
      }
      await pipeline.viewRunCost(graphId);
    })),
  ];
}

/**
 * Status-bar connection indicator. Probes the backend on activation and on
 * demand, surfaces unconfigured/unauthorized/unreachable states (instead of
 * letting the first chat fail with a generic error), and offers an actionable
 * re-check command.
 */
function connectionStatus(output: vscode.OutputChannel): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const warningBg = new vscode.ThemeColor("statusBarItem.warningBackground");
  let warned = false;

  const apply = (state: BackendReachability): void => {
    if (state === "ok") {
      item.text = "$(comment-discussion) LiberIDE";
      item.tooltip = "LiberIDE connected — open chat";
      item.command = "liberide.openChat";
      item.backgroundColor = undefined;
    } else {
      const label = state === "unconfigured" ? "not connected" : state === "unauthorized" ? "sign in" : "offline";
      const icon = state === "unauthorized" ? "$(key)" : "$(debug-disconnect)";
      item.text = `${icon} LiberIDE: ${label}`;
      item.tooltip = "LiberIDE backend unavailable — click to check connection";
      item.command = "liberide.checkConnection";
      item.backgroundColor = warningBg;
    }
    item.show();
  };

  const refresh = async (notify: boolean): Promise<void> => {
    item.text = "$(loading~spin) LiberIDE";
    item.show();
    const state = await probeBackend();
    apply(state);
    if (state === "ok" || !notify || warned) return;
    warned = true;
    const message =
      state === "unconfigured"
        ? "LiberIDE backend is not configured. Set liberide.apiOrigin and pair this machine, or provide launch credentials or a libervox-integration.json."
        : state === "unauthorized"
          ? "LiberIDE could not authenticate with the backend (token missing or expired)."
          : "LiberIDE backend is unreachable.";
    const pick = await vscode.window.showWarningMessage(message, "Details", "Retry");
    if (pick === "Details") output.show(true);
    else if (pick === "Retry") void refresh(true);
  };

  const cmd = vscode.commands.registerCommand("liberide.checkConnection", () => {
    warned = false;
    void refresh(true);
  });

  void refresh(true);
  return vscode.Disposable.from(item, cmd);
}

export function deactivate(): void {
  // Agent terminals own child processes; don't leave them running.
  disposeAgentTerminals();
}
