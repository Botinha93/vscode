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

export async function dispatchIdeDelegate(request: IdeDelegatePayload): Promise<unknown> {
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
    default:
      throw new Error(`Unsupported IDE delegate kind: ${kind}`);
  }
}
