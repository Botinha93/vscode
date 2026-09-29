import type { IdeDelegateKind, IdeDelegatePayload } from "../types";
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
import { handleTerminalSession } from "./terminal-session";
import { handleTerminalRun } from "./terminal-run";
import {
  handleCodeActions,
  handleApplyCodeAction,
  handleRenameSymbol,
  handleFormatDocument,
  handleFormatRange,
} from "./refactor";
import { handleApplyWorkspaceEdit } from "./workspace-edit";
import { handleTasksList, handleTasksRun, handleTasksCancel } from "./tasks";
import { handleTestsList, handleTestsRun, handleTestsStatus } from "./tests";
import { handleDebugStart, handleDebugStop, handleDebugList, handleDebugStackTrace } from "./debug";
import { handleNotebookRead, handleNotebookEdit, handleNotebookExecute } from "./notebook";
import { handleConfigRead, handleConfigWrite } from "./config";
import { handleExtensionsList } from "./extensions";
import { handleProblemsByOwner } from "./problems";
import { handleSemanticTokens } from "./semantic";
import { handleFsDelete, handleFsList, handleFsRead, handleFsRename, handleFsSearch, handleFsStat, handleFsWrite } from "./fs";
import * as vscode from "vscode";

/**
 * Kinds that execute code or change the workspace. Restricted Mode (an
 * untrusted folder) only allows reads; everything here needs a trusted folder.
 */
const TRUST_REQUIRED_KINDS: ReadonlySet<IdeDelegateKind> = new Set<IdeDelegateKind>([
  "terminal.run",
  "vscode.terminalSession",
  "vscode.tasks.run",
  "vscode.tests.run",
  "vscode.debug.start",
  "vscode.notebook.execute",
  "vscode.notebook.edit",
  "vscode.codeActions.apply",
  "vscode.rename",
  "vscode.formatDocument",
  "vscode.formatRange",
  "vscode.applyWorkspaceEdit",
  "vscode.config.write",
  "vscode.fs.write",
  "vscode.fs.delete",
  "vscode.fs.rename",
]);

export async function dispatchIdeDelegate(request: IdeDelegatePayload): Promise<unknown> {
  const { kind, payload } = request;
  const root = request.target.projectPath;
  if (TRUST_REQUIRED_KINDS.has(kind) && !vscode.workspace.isTrusted) {
    throw new Error(`'${kind}' is blocked: this workspace is not trusted (Restricted Mode). Trust the folder in VS Code to allow it.`);
  }
  switch (kind as IdeDelegateKind) {
    case "terminal.run":
      return handleTerminalRun({ ...payload, delegateId: request.delegateId, ...request.target }, request.signal);
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
      return handleGitStatus(root);
    case "vscode.git.log":
      return handleGitLog(root, payload);
    case "vscode.git.diff":
      return handleGitDiff(root, payload);
    case "vscode.git.blame":
      return handleGitBlame(root, payload);
    case "vscode.fs.stat":
      return handleFsStat(root, payload);
    case "vscode.fs.read":
      return handleFsRead(root, payload);
    case "vscode.fs.write":
      return handleFsWrite(root, payload);
    case "vscode.fs.delete":
      return handleFsDelete(root, payload);
    case "vscode.fs.rename":
      return handleFsRename(root, payload);
    case "vscode.fs.list":
      return handleFsList(root, payload);
    case "vscode.fs.search":
      return handleFsSearch(root, payload);
    case "vscode.terminalSession":
      return handleTerminalSession(payload);
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
