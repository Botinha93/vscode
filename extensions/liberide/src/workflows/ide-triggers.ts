import * as vscode from "vscode";
import * as path from "node:path";
import { apiFetch } from "../api";
import { activeWorkspaceFolder } from "../ide-delegate/context";

/** One entry of `GET /api/workflows/triggers/ide`. */
export interface IdeWorkflowTrigger {
  pipelineId: string;
  pipelineName: string;
  triggerId: string;
  command: string;
  name: string;
}

/** The subset of WorkflowPipelineRun the command reports. */
interface WorkflowRunResult {
  id: string;
  pipelineName?: string;
  status: string;
  output?: string;
  error?: string;
}

async function readJsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let message = body;
    try {
      message = (JSON.parse(body) as { error?: string }).error ?? body;
    } catch {
      // plain-text error
    }
    throw new Error(`${res.status} ${res.statusText}${message ? ` — ${message.slice(0, 300)}` : ""}`);
  }
  return (await res.json()) as T;
}

export async function listIdeWorkflowTriggers(): Promise<IdeWorkflowTrigger[]> {
  return readJsonOrThrow<IdeWorkflowTrigger[]>(await apiFetch("/api/workflows/triggers/ide"));
}

/**
 * Folder context sent as the trigger payload: where the user is working.
 * Paths only, never file contents or the selection's text.
 */
export function ideWorkflowPayload(): Record<string, unknown> {
  const folder = activeWorkspaceFolder();
  const editor = vscode.window.activeTextEditor;
  const doc = editor?.document;
  const activeFile = folder && doc?.uri.scheme === "file" && folder.uri.scheme === "file"
    ? path.relative(folder.uri.fsPath, doc.uri.fsPath).replace(/\\/g, "/")
    : undefined;
  return {
    source: "liberide",
    ...(folder ? { projectPath: folder.uri.fsPath, folderName: folder.name } : {}),
    ...(activeFile && !activeFile.startsWith("..") ? { activeFile, languageId: doc?.languageId } : {}),
    ...(activeFile && !activeFile.startsWith("..") && editor && !editor.selection.isEmpty
      ? { selection: { startLine: editor.selection.start.line + 1, endLine: editor.selection.end.line + 1 } }
      : {}),
  };
}

/** "LiberIDE: Run Workflow…": pick an IDE-triggerable workflow and run it with the active folder's context. */
export async function runIdeWorkflowCommand(output: vscode.OutputChannel): Promise<void> {
  const triggers = await listIdeWorkflowTriggers();
  if (!triggers.length) {
    void vscode.window.showInformationMessage("No workflows have an IDE command trigger. Add one to a workflow in the LiberIDE app.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    triggers.map((trigger) => ({
      label: trigger.name || trigger.command,
      description: trigger.pipelineName,
      detail: trigger.command,
      trigger,
    })),
    { title: "Run Workflow", placeHolder: "Choose a workflow to run", matchOnDescription: true, matchOnDetail: true },
  );
  if (!picked) return;
  const input = await vscode.window.showInputBox({
    title: `Run ${picked.trigger.pipelineName}`,
    prompt: "Input for the workflow (optional)",
    placeHolder: picked.trigger.command,
  });
  if (input === undefined) return;

  const payload = ideWorkflowPayload();
  output.appendLine(`[workflow] ${picked.trigger.pipelineName}: starting (${picked.trigger.command})`);
  output.show(true);
  const run = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Running ${picked.trigger.pipelineName}…`, cancellable: true },
    async (_progress, token) => {
      const abort = new AbortController();
      const subscription = token.onCancellationRequested(() => abort.abort());
      try {
        return await readJsonOrThrow<WorkflowRunResult>(await apiFetch("/api/workflows/triggers/ide/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: picked.trigger.command, input: input.trim() || undefined, payload }),
          signal: abort.signal,
        }));
      } finally {
        subscription.dispose();
      }
    },
  ).then((result) => result, (err: unknown) => {
    const message = err instanceof Error ? (err.name === "AbortError" ? "stopped waiting (the run continues on the server)" : err.message) : String(err);
    output.appendLine(`[workflow] ${picked.trigger.pipelineName}: ${message}`);
    if (!(err instanceof Error && err.name === "AbortError")) void vscode.window.showErrorMessage(`Workflow failed: ${message}`);
    return undefined;
  });
  if (!run) return;
  output.appendLine(`[workflow] ${run.pipelineName ?? picked.trigger.pipelineName}: ${run.status} (run ${run.id})`);
  if (run.output) output.appendLine(run.output);
  if (run.error) output.appendLine(`error: ${run.error}`);
  const summary = `Workflow ${run.pipelineName ?? picked.trigger.pipelineName}: ${run.status}`;
  if (run.status === "failed" || run.error) void vscode.window.showErrorMessage(summary, "Show Output").then((choice) => choice && output.show());
  else void vscode.window.showInformationMessage(summary, "Show Output").then((choice) => choice && output.show());
}
