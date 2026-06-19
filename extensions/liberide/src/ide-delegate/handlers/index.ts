import type { IdeDelegateKind, IdeDelegatePayload } from "../types";
import { delegateContext } from "./delegate-context";
import { handleOpenEditors, handleDirtyBuffers, handleActiveSelection } from "./editors";
import { handleDiagnostics } from "./diagnostics";
import {
  handleWorkspaceSymbols,
  handleDocumentSymbols,
  handleDefinition,
  handleReferences,
  handleHover,
} from "./lsp";
import { handleFindFiles } from "./files";
import { handleGitStatus, handleGitLog, handleGitDiff, handleGitBlame } from "./git";
import {
  handleTerminalSession,
  handleTerminalSessionOpen,
  handleTerminalSessionSend,
  handleTerminalSessionRead,
  handleTerminalSessionClose,
} from "./terminal-session";
import { handleTerminalRun } from "./terminal-run";
import {
  handleCodeActions,
  handleApplyCodeAction,
  handleRenameSymbol,
  handleFormatDocument,
  handleFormatRange,
} from "./refactor";
import { handleApplyWorkspaceEdit } from "./workspace-edit";
import { handleTasksList, handleTasksRun, handleTasksCancel, handleTasksStatus } from "./tasks";
import { handleTestsList, handleTestsRun, handleTestsStatus } from "./tests";
import { handleDebugStart, handleDebugStop, handleDebugList, handleDebugStackTrace } from "./debug";
import { handleNotebookRead, handleNotebookEdit, handleNotebookExecute } from "./notebook";
import { handleConfigRead, handleConfigWrite } from "./config";
import { handleExtensionsList } from "./extensions";
import { handleProblemsByOwner } from "./problems";
import { handleSemanticTokens } from "./semantic";

export async function dispatchIdeDelegate(request: IdeDelegatePayload): Promise<unknown> {
  return delegateContext.run({ root: request.target.projectPath }, () => dispatchIdeDelegateInner(request));
}

async function dispatchIdeDelegateInner(request: IdeDelegatePayload): Promise<unknown> {
  const { kind, payload } = request;
  switch (kind as IdeDelegateKind) {
    case "terminal.run":
      return handleTerminalRun({ ...payload, delegateId: request.delegateId, ...request.target });
    case "vscode.openEditors":
      return handleOpenEditors();
    case "vscode.dirtyBuffers":
      return handleDirtyBuffers(payload);
    case "vscode.activeSelection":
      return handleActiveSelection();
    case "vscode.diagnostics":
      return handleDiagnostics(payload);
    case "vscode.workspaceSymbols":
      return handleWorkspaceSymbols(payload);
    case "vscode.documentSymbols":
      return handleDocumentSymbols(payload);
    case "vscode.definition":
      return handleDefinition(payload);
    case "vscode.references":
      return handleReferences(payload);
    case "vscode.hover":
      return handleHover(payload);
    case "vscode.findFiles":
      return handleFindFiles(payload);
    case "vscode.git.status":
      return handleGitStatus();
    case "vscode.git.log":
      return handleGitLog(payload);
    case "vscode.git.diff":
      return handleGitDiff(payload);
    case "vscode.git.blame":
      return handleGitBlame(payload);
    case "vscode.terminalSession":
      return handleTerminalSession(payload);
    case "vscode.terminalSession.open":
      return handleTerminalSessionOpen(payload);
    case "vscode.terminalSession.send":
      return handleTerminalSessionSend(payload);
    case "vscode.terminalSession.read":
      return handleTerminalSessionRead(payload);
    case "vscode.terminalSession.close":
      return handleTerminalSessionClose(payload);
    case "vscode.codeActions":
      return handleCodeActions(payload);
    case "vscode.codeActions.apply":
      return handleApplyCodeAction(payload);
    case "vscode.rename":
      return handleRenameSymbol(payload);
    case "vscode.formatDocument":
      return handleFormatDocument(payload);
    case "vscode.formatRange":
      return handleFormatRange(payload);
    case "vscode.applyWorkspaceEdit":
      return handleApplyWorkspaceEdit(payload);
    case "vscode.tasks.list":
      return handleTasksList(payload);
    case "vscode.tasks.run":
      return handleTasksRun(payload);
    case "vscode.tasks.cancel":
      return handleTasksCancel(payload);
    case "vscode.tasks.status":
      return handleTasksStatus(payload);
    case "vscode.tests.list":
      return handleTestsList();
    case "vscode.tests.run":
      return handleTestsRun(payload);
    case "vscode.tests.status":
      return handleTestsStatus(payload);
    case "vscode.debug.start":
      return handleDebugStart(payload);
    case "vscode.debug.stop":
      return handleDebugStop();
    case "vscode.debug.list":
      return handleDebugList();
    case "vscode.debug.stackTrace":
      return handleDebugStackTrace(payload);
    case "vscode.notebook.read":
      return handleNotebookRead(payload);
    case "vscode.notebook.edit":
      return handleNotebookEdit(payload);
    case "vscode.notebook.execute":
      return handleNotebookExecute(payload);
    case "vscode.config.read":
      return handleConfigRead(payload);
    case "vscode.config.write":
      return handleConfigWrite(payload);
    case "vscode.extensions.list":
      return handleExtensionsList();
    case "vscode.problemsByOwner":
      return handleProblemsByOwner(payload);
    case "vscode.semanticTokens":
      return handleSemanticTokens(payload);
    default:
      throw new Error(`Unsupported IDE delegate kind: ${kind}`);
  }
}
