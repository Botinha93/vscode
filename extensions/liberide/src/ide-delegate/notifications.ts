import * as vscode from "vscode";
import type { IdeNotificationMethod } from "@nexus/shared";
import type { IdeNotificationContext, IdeNotificationHandler } from "./stream";

export interface IdeNotificationHooks {
  /** Invoked when a run transitions to waiting_approval (server push). */
  onApprovalPending?: (
    params: { graphId?: string; nodeId?: string; title?: string },
    context: IdeNotificationContext,
  ) => void;
  /** Invoked when a run changes status (queued/running/finished/etc). */
  onRunStatus?: (
    params: { graphId?: string; status?: string },
    context: IdeNotificationContext,
  ) => void;
}

const FALLBACK_CLEAR_MS = 15_000;

/**
 * Owns the server→IDE notification handler and the "server-side fallback active"
 * status-bar indicator. The indicator appears when a tool runs server-side
 * instead of through the live IDE and clears automatically after a quiet period.
 */
export class IdeNotificationCenter implements vscode.Disposable {
  private readonly fallbackItem: vscode.StatusBarItem;
  private clearTimer: ReturnType<typeof setTimeout> | undefined;
  private warnedMutatingFallback = false;

  constructor(
    private readonly output?: vscode.OutputChannel,
    private readonly hooks: IdeNotificationHooks = {},
  ) {
    this.fallbackItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.fallbackItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }

  get handler(): IdeNotificationHandler {
    return (method, params, context) => this.dispatch(method, params, context);
  }

  private dispatch(
    method: IdeNotificationMethod,
    params: Record<string, unknown>,
    context: IdeNotificationContext,
  ): void {
    switch (method) {
      case "connected":
        // A fresh connection means the live IDE path is available again.
        this.clearFallback();
        break;
      case "tool.fallback":
        this.showFallback(params);
        break;
      case "approval.pending":
        this.hooks.onApprovalPending?.(
          {
            graphId: typeof params.graphId === "string" ? params.graphId : undefined,
            nodeId: typeof params.nodeId === "string" ? params.nodeId : undefined,
            title: typeof params.title === "string" ? params.title : undefined,
          },
          context,
        );
        break;
      case "run.status":
        this.hooks.onRunStatus?.(
          {
            graphId: typeof params.graphId === "string" ? params.graphId : undefined,
            status: typeof params.status === "string" ? params.status : undefined,
          },
          context,
        );
        break;
    }
  }

  private showFallback(params: Record<string, unknown>): void {
    const kind = typeof params.kind === "string" ? params.kind : "operation";
    const mutating = params.mutating === true;
    this.fallbackItem.text = "$(warning) LiberIDE: server fallback";
    this.fallbackItem.tooltip =
      `A LiberIDE tool (${kind}) ran on the server instead of your live IDE ` +
      `(reason: ${String(params.fallbackReason ?? "unknown")}).`;
    this.fallbackItem.show();

    if (mutating && !this.warnedMutatingFallback) {
      this.warnedMutatingFallback = true;
      void vscode.window.showWarningMessage(
        "LiberIDE: edits are being applied on the server, not in your live IDE. " +
          "Reconnect the extension to keep changes in-editor.",
      );
    }

    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = setTimeout(() => this.clearFallback(), FALLBACK_CLEAR_MS);
    this.output?.appendLine(`[notifications] fallback active for ${kind}`);
  }

  private clearFallback(): void {
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = undefined;
    }
    this.fallbackItem.hide();
  }

  dispose(): void {
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.fallbackItem.dispose();
  }
}
